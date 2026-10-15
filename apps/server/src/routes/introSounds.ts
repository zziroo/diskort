import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UploadError } from '../attachments.js';
import { sendError, type AppContext } from '../context.js';
import { INTRO_SOUND_HASH, parseIntroDuration, parseIntroStart } from '../introSounds.js';
import { createRateLimiter } from './messages.js';

const LIMIT_MESSAGE = 'Giriş sesini çok sık değiştiriyorsun, biraz bekle.';
const NOT_FOUND = 'Giriş sesi bulunamadı.';

/**
 * Kişisel giriş sesleri. Kullanıcı yalnızca kendininkini yükler (POST /api/me/intro-sound?start=<sn>&duration=<sn>, gövde ham
 * ses dosyası) ya da kaldırır; değişiklik USER_UPDATE ile onu görebilenlere iletilir. Hesap yöneticisi
 * herhangi birininkini kaldırabilir (DELETE /api/users/:id/intro-sound). Ses, oynatıcılar jeton
 * gönderemediği için kimlik doğrulamasız sunulur; adres içerik özetini taşıdığından süresiz önbelleklenebilir.
 */
export function registerIntroSoundRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, introSounds } = ctx;
  // Yükleme ve kaldırma birlikte sayılır
  const allow = createRateLimiter(5, 10 * 60_000);

  // Gövde ham sestir (profil fotoğrafındaki gibi); boyut sınırını IntroSoundService uygular.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    scope.post<{ Querystring: { start?: string; duration?: string } }>(
      '/api/me/intro-sound',
      {
        onRequest: auth.requireUser,
        // Hata yanıtında okunmamış gövde boşuna okunmasın: bağlantı yanıttan sonra kapanır
        onSend: async (_req, reply, payload) => {
          if (reply.statusCode !== 200) void reply.header('Connection', 'close');
          return payload;
        },
      },
      async (req, reply) => {
        const start = parseIntroStart(req.query.start);
        if (start === null) return sendError(reply, 400, 'invalid_start', 'Başlangıç noktası geçersiz.');
        const duration = parseIntroDuration(req.query.duration);
        if (duration === null) return sendError(reply, 400, 'invalid_duration', 'Süre geçersiz.');
        if (!allow(req.user.id)) return sendError(reply, 429, 'rate_limited', LIMIT_MESSAGE);
        const length = req.headers['content-length'];
        const body = (req.body as Readable | undefined) ?? req.raw;
        const size = length !== undefined && /^\d+$/.test(length) ? Number(length) : null;
        try {
          const user = await introSounds.upload(req.user.id, body, size, start, duration);
          gateway.sendUserUpdate(user);
          return user;
        } catch (err) {
          if (err instanceof UploadError) return sendError(reply, err.status, err.code, err.message);
          throw err;
        }
      },
    );
  });

  app.delete('/api/me/intro-sound', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!allow(req.user.id)) return sendError(reply, 429, 'rate_limited', LIMIT_MESSAGE);
    const user = await introSounds.remove(req.user.id);
    if (!user) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    gateway.sendUserUpdate(user);
    return user;
  });

  // Hesap yöneticisi (moderasyon): uygunsuz giriş sesini kaldırır
  app.delete<{ Params: { id: string } }>(
    '/api/users/:id/intro-sound',
    { preHandler: auth.requireInstanceAdmin },
    async (req, reply) => {
      const user = await introSounds.remove(req.params.id);
      if (!user) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
      gateway.sendUserUpdate(user);
      return user;
    },
  );

  // Yalnızca kullanıcının şu anki sesi sunulur; eskisinin adresi (dosya silindiği için) 404 döner. expo-audio
  // gibi oynatıcılar Range isteği gönderebildiğinden tek aralıklı istekler 206 ile yanıtlanır.
  app.get<{ Params: { userId: string; file: string } }>(
    '/api/intro-sounds/:userId/:file',
    async (req: FastifyRequest<{ Params: { userId: string; file: string } }>, reply: FastifyReply) => {
      const hash = req.params.file.endsWith('.mp3') ? req.params.file.slice(0, -4) : '';
      const current = store.getIntroSoundHash(req.params.userId);
      if (!INTRO_SOUND_HASH.test(hash) || current !== hash) return sendError(reply, 404, 'not_found', NOT_FOUND);
      const file = introSounds.pathOf(hash);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) return sendError(reply, 404, 'not_found', NOT_FOUND);

      const etag = `"${hash}"`;
      void reply
        // Kullanıcı içeriği: ortak önbelleklerde (CDN) tutulmaz, kaldırılan ses oralarda kalmasın
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', etag)
        .header('Accept-Ranges', 'bytes')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'cross-origin');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      void reply.header('Content-Type', 'audio/mpeg');

      const range = parseRange(req.headers.range, stat.size);
      if (range === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
      }
      if (range) {
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(fs.createReadStream(file, { start: range.start, end: range.end }));
      }
      return reply.header('Content-Length', stat.size).send(fs.createReadStream(file));
    },
  );
}

/**
 * Tek aralıklı "bytes=a-b", "bytes=a-" ya da "bytes=-n" başlığını çözer. Başlık yoksa ya da birden çok aralık
 * isteniyorsa null (bütün dosya gönderilir); karşılanamayan aralıkta 'invalid' (416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match as unknown as [string, string, string];
  if (from === '' && to === '') return null;
  let start: number;
  let end: number;
  if (from === '') {
    // Son n bayt
    const n = Number(to);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
