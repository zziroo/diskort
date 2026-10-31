import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission, SOUNDBOARD_NAME_MAX, soundboardCooldownMs, type GuildSound } from '@diskort/shared';
import { UploadError } from '../attachments.js';
import { forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { normalizeEmoji } from '../emoji.js';
import { parseRange } from '../fileInfo.js';
import { parseIntroDuration, parseIntroStart } from '../introSounds.js';
import { SOUND_HASH } from '../soundboard.js';
import { createRateLimiter } from './messages.js';

const LIMIT_MESSAGE = 'Ses panelini çok sık değiştiriyorsun, biraz bekle.';
const NOT_FOUND = 'Ses bulunamadı.';
/** Bekleme kayıtları bu sayıyı aşınca süresi geçenler atılır (bellek sınırsız büyümesin) */
const BUSY_MAX_KEYS = 10_000;

type GuildParams = { guildId: string };
type SoundParams = { guildId: string; soundId: string };

const playSchema = z.object({
  guildId: z.string().min(1).max(64),
  soundId: z.string().min(1).max(64),
});

/** Ses adı: kırpılmış 1..SOUNDBOARD_NAME_MAX karakter; geçersizse null */
export function parseSoundName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Sekme ve satır sonu önce boşluğa iner; kalan kontrol (\p{Cc}) ve biçim (\p{Cf}: sıfır genişlikli, yön
  // işaretleri) karakterleri silinir. Emojiyi oluşturanlar kalır: birleştirici (U+200D) ve bayrak etiketleri
  // (U+E0020..E007F). Uzunluk temizlikten sonra ölçülür; yalnız birleştiriciden oluşan ad boş sayılır.
  const name = value
    .replace(/\s+/g, ' ')
    .replace(/(?![\u200D\u{E0020}-\u{E007F}])[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  if (name.replace(/[\u200D\u{E0020}-\u{E007F}\s]/gu, '').length === 0) return null;
  return name.length <= SOUNDBOARD_NAME_MAX ? name : null;
}

/** Emoji: boş ya da verilmemişse null (emoji yok); tek emoji değilse undefined (geçersiz) */
export function parseSoundEmoji(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  return normalizeEmoji(value) ?? undefined;
}

/**
 * Sunucuların ses paneli (bkz. docs/ses-paneli.md). Liste üyelere açık; yükleme, yeniden adlandırma ve silme
 * MANAGE_SOUNDBOARD ister (silmeyi hesap yöneticisi de yapabilir: moderasyon). Dosya giriş sesi gibi
 * kimliksiz ve süresiz önbelleklenebilir sunulur (adres içerik özetini taşır). Çalma, bulunulan ses
 * kanalındaki herkese SOUNDBOARD_PLAY olayı olarak gider; sesin kendisi sunucudan geçmez, her istemci
 * dosyayı adresinden alır.
 */
export function registerSoundboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, permissions, voice, soundboard } = ctx;
  // Yükleme ve silme birlikte sayılır
  const allowChange = createRateLimiter(10, 10 * 60_000);
  // Çalma: kullanıcının yeni ses çalabileceği an (ms). Kullanıcıya bağlıdır, kanal değiştirince sıfırlanmaz;
  // farklı kişilerin sesleri üst üste binebilir.
  const busyUntil = new Map<string, number>();

  app.get<{ Params: GuildParams }>('/api/guilds/:guildId/sounds', { preHandler: auth.requireMember }, async (req) => ({
    sounds: store.listSounds(req.params.guildId),
  }));

  // Gövde ham sestir (giriş sesindeki gibi); boyut sınırını SoundboardService uygular.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    scope.post<{ Params: GuildParams; Querystring: { name?: string; emoji?: string; start?: string; duration?: string } }>(
      '/api/guilds/:guildId/sounds',
      {
        onRequest: auth.requireGuildPermission(Permission.MANAGE_SOUNDBOARD),
        // Hata yanıtında okunmamış gövde boşuna okunmasın: bağlantı yanıttan sonra kapanır
        onSend: async (_req, reply, payload) => {
          if (reply.statusCode !== 201) void reply.header('Connection', 'close');
          return payload;
        },
      },
      async (req, reply) => {
        const name = parseSoundName(req.query.name);
        if (name === null) return sendError(reply, 400, 'invalid_name', `Ses adı 1-${SOUNDBOARD_NAME_MAX} karakter olmalı.`);
        const emoji = parseSoundEmoji(req.query.emoji);
        if (emoji === undefined) return sendError(reply, 400, 'invalid_emoji', 'Yalnızca tek bir emoji seçilebilir.');
        const start = parseIntroStart(req.query.start);
        if (start === null) return sendError(reply, 400, 'invalid_start', 'Başlangıç noktası geçersiz.');
        const duration = parseIntroDuration(req.query.duration);
        if (duration === null) return sendError(reply, 400, 'invalid_duration', 'Süre geçersiz.');
        if (!allowChange(req.user.id)) return sendError(reply, 429, 'rate_limited', LIMIT_MESSAGE);
        const length = req.headers['content-length'];
        const body = (req.body as Readable | undefined) ?? req.raw;
        const size = length !== undefined && /^\d+$/.test(length) ? Number(length) : null;
        try {
          const sound = await soundboard.upload(req.params.guildId, req.user.id, body, size, {
            name,
            emoji,
            startSec: start,
            durationSec: duration,
          });
          gateway.sendToGuild(sound.guildId, { t: 'GUILD_SOUND_CREATE', d: { sound } });
          return reply.code(201).send({ sound });
        } catch (err) {
          if (err instanceof UploadError) return sendError(reply, err.status, err.code, err.message);
          throw err;
        }
      },
    );
  });

  app.patch<{ Params: SoundParams; Body: { name?: unknown; emoji?: unknown } }>(
    '/api/guilds/:guildId/sounds/:soundId',
    { preHandler: auth.requireGuildPermission(Permission.MANAGE_SOUNDBOARD) },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; emoji?: unknown };
      const patch: { name?: string; emoji?: string | null } = {};
      if (body.name !== undefined) {
        const name = parseSoundName(body.name);
        if (name === null) return sendError(reply, 400, 'invalid_name', `Ses adı 1-${SOUNDBOARD_NAME_MAX} karakter olmalı.`);
        patch.name = name;
      }
      if (body.emoji !== undefined) {
        const emoji = parseSoundEmoji(body.emoji);
        if (emoji === undefined) return sendError(reply, 400, 'invalid_emoji', 'Yalnızca tek bir emoji seçilebilir.');
        patch.emoji = emoji;
      }
      const sound = soundboard.rename(req.params.guildId, req.params.soundId, patch);
      if (!sound) return sendError(reply, 404, 'not_found', NOT_FOUND);
      gateway.sendToGuild(sound.guildId, { t: 'GUILD_SOUND_UPDATE', d: { sound } });
      return { sound };
    },
  );

  // MANAGE_SOUNDBOARD ya da hesap yöneticisi (uygunsuz sesi kaldırma; yönetici üye olmasa da silebilir).
  // Üye olmayan ve yönetici olmayan 404 alır (sunucunun varlığı sızmasın).
  app.delete<{ Params: SoundParams }>(
    '/api/guilds/:guildId/sounds/:soundId',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const { guildId, soundId } = req.params;
      if (!permissions.isInstanceAdmin(req.user.id)) {
        if (!permissions.isMember(guildId, req.user.id)) return sendError(reply, 404, 'not_found', 'Sunucu bulunamadı.');
        if (!permissions.canInGuild(guildId, req.user.id, Permission.MANAGE_SOUNDBOARD)) return forbidden(reply);
      }
      if (!allowChange(req.user.id)) return sendError(reply, 429, 'rate_limited', LIMIT_MESSAGE);
      const sound = await soundboard.remove(guildId, soundId);
      if (!sound) return sendError(reply, 404, 'not_found', NOT_FOUND);
      gateway.sendToGuild(guildId, { t: 'GUILD_SOUND_DELETE', d: { guildId, soundId } });
      return reply.code(204).send();
    },
  );

  // Kimliksiz sunum: yalnızca o sunucunun bir sesine ait özetler; silinen sesin adresi 404 döner. Oynatıcılar
  // Range isteği gönderebildiğinden tek aralıklı istekler 206 ile yanıtlanır.
  app.get<{ Params: { guildId: string; file: string } }>(
    '/api/sounds/:guildId/:file',
    async (req: FastifyRequest<{ Params: { guildId: string; file: string } }>, reply: FastifyReply) => {
      const hash = req.params.file.endsWith('.mp3') ? req.params.file.slice(0, -4) : '';
      if (!SOUND_HASH.test(hash) || store.guildSoundOf(hash) !== req.params.guildId) {
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      const file = soundboard.pathOf(hash);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) return sendError(reply, 404, 'not_found', NOT_FOUND);

      const etag = `"${hash}"`;
      void reply
        // Kullanıcı içeriği: ortak önbelleklerde (CDN) tutulmaz, silinen ses oralarda kalmasın
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', etag)
        .header('Accept-Ranges', 'bytes')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'cross-origin');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      void reply.header('Content-Type', 'audio/mpeg');

      const range = parseRange(req.headers.range, stat.size);
      if (range.kind === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
      }
      if (range.kind === 'range') {
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(fs.createReadStream(file, { start: range.start, end: range.end }));
      }
      return reply.header('Content-Length', stat.size).send(fs.createReadStream(file));
    },
  );

  // Çalma: bulunulan sunucu ses kanalındaki herkese (çalan dahil) olay. Ses, kullanıcının üyesi olduğu
  // herhangi bir sunucunun olabilir; olay tam nesneyi taşıdığından kanaldakiler o sunucuda olmasa da çalar.
  app.post('/api/voice/soundboard/play', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(playSchema, req.body, reply);
    if (!body) return reply;
    const userId = req.user.id;
    const state = voice.get(userId);
    if (!state) return sendError(reply, 409, 'not_in_voice', 'Bir ses kanalında değilsin.');
    const channelId = state.channelId;
    if (permissions.isDm(channelId) || !permissions.guildOf(channelId)) {
      return sendError(reply, 400, 'not_guild_voice', 'Ses paneli yalnızca sunucu ses kanallarında kullanılabilir.');
    }
    if (!permissions.can(userId, Permission.SPEAK, channelId) || state.serverMute || state.serverDeaf || state.selfDeaf) {
      return sendError(reply, 403, 'muted', 'Susturulmuşken ya da sağırken ses çalamazsın.');
    }
    const sound: GuildSound | null = permissions.isMember(body.guildId, userId) ? store.getSound(body.soundId, body.guildId) : null;
    if (!sound) return sendError(reply, 404, 'unknown_sound', NOT_FOUND);
    const now = Date.now();
    // Reddedilen istek beklemeyi uzatmaz
    if (now < (busyUntil.get(userId) ?? 0)) {
      return sendError(reply, 429, 'rate_limited', 'Sesin bitmeden yeni ses çalamazsın.');
    }
    if (busyUntil.size >= BUSY_MAX_KEYS) {
      for (const [id, until] of busyUntil) if (until <= now) busyUntil.delete(id);
    }
    busyUntil.set(userId, now + soundboardCooldownMs(sound.durationMs));
    gateway.sendToUsers(voice.membersOf(channelId), {
      t: 'SOUNDBOARD_PLAY',
      d: { channelId, guildId: sound.guildId, userId, sound },
    });
    return reply.code(204).send();
  });
}
