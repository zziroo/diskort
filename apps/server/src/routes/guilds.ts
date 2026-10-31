import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BAN_REASON_MAX_LENGTH,
  GUILD_NAME_MAX_LENGTH,
  MAX_GUILDS_PER_USER,
  MAX_OWNED_GUILDS,
  Permission,
  type AcceptInviteResponse,
  type Ban,
  type InvitePreview,
} from '@diskort/shared';
import { UploadError } from '../attachments.js';
import { AVATAR_HASH } from '../avatars.js';
import { afterPermissionChange, forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { createRateLimiter } from './messages.js';

const guildName = z
  .string()
  .trim()
  .min(1, 'Sunucu adı boş olamaz.')
  .max(GUILD_NAME_MAX_LENGTH, `Sunucu adı en fazla ${GUILD_NAME_MAX_LENGTH} karakter olabilir.`);
const createGuildSchema = z.object({ name: guildName });
const updateGuildSchema = z.object({
  name: guildName.optional(),
  ownerId: z.string().min(1).max(64).optional(),
});
export const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  expiresInHours: z.number().min(1).max(24 * 365).nullable().optional(),
});
const banSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(BAN_REASON_MAX_LENGTH, `Sebep en fazla ${BAN_REASON_MAX_LENGTH} karakter olabilir.`)
    .optional(),
});
const voiceSchema = z.object({
  mute: z.boolean().optional(),
  deaf: z.boolean().optional(),
  channelId: z.string().min(1).max(64).nullable().optional(),
});

type GuildParams = { guildId: string };

/**
 * Sunucular (guild): kurma, ayarlar, simge, silme, ayrılma; davetler; üyeleri atma, yasaklama ve sesli
 * sohbette yönetme. Üyesi olunmayan sunucunun her ucu "yok" (404) döner.
 */
export function registerGuildRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, permissions, moderation, voice, avatars, attachments, soundboard } = ctx;
  const allowCreate = createRateLimiter(5, 10 * 60_000);
  const allowIcon = createRateLimiter(10, 10 * 60_000);
  const allowJoin = createRateLimiter(20, 10 * 60_000);
  const allowPreview = createRateLimiter(60, 60_000);

  /** Ana sunucunun bellekteki kopyası (ctx.guild) güncel kalsın */
  const refreshPrimary = (guildId: string): void => {
    if (guildId === ctx.guild.id) Object.assign(ctx.guild, store.getGuild(guildId));
  };

  // ---------- Sunucular ----------

  app.get('/api/guilds', { preHandler: auth.requireUser }, async (req) =>
    store.userGuildIds(req.user.id).map((id) => store.getGuild(id)!),
  );

  app.post('/api/guilds', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(createGuildSchema, req.body, reply);
    if (!body) return reply;
    if (store.ownedGuildIds(req.user.id).length >= MAX_OWNED_GUILDS) {
      return sendError(reply, 400, 'too_many_guilds', `En fazla ${MAX_OWNED_GUILDS} sunucu kurabilirsin.`);
    }
    if (store.userGuildIds(req.user.id).length >= MAX_GUILDS_PER_USER) {
      return sendError(reply, 400, 'too_many_guilds', `En fazla ${MAX_GUILDS_PER_USER} sunucuya üye olabilirsin.`);
    }
    if (!allowCreate(req.user.id)) {
      return sendError(reply, 429, 'rate_limited', 'Çok hızlı sunucu kuruyorsun, biraz bekle.');
    }
    const guild = store.createGuild(req.user.id, body.name);
    gateway.announceJoin(guild.id, req.user.id);
    return reply.code(201).send(gateway.guildData(guild.id, req.user.id));
  });

  app.get<{ Params: GuildParams }>('/api/guilds/:guildId', { preHandler: auth.requireMember }, async (req) =>
    gateway.guildData(req.params.guildId, req.user.id),
  );

  app.patch<{ Params: GuildParams }>('/api/guilds/:guildId', { preHandler: auth.requireMember }, async (req, reply) => {
    const { guildId } = req.params;
    const body = parseBody(updateGuildSchema, req.body, reply);
    if (!body) return reply;
    if (body.name !== undefined && !permissions.canInGuild(guildId, req.user.id, Permission.MANAGE_GUILD)) {
      return forbidden(reply, 'Sunucuyu yönetme yetkin yok.');
    }
    const previousOwner = store.getGuild(guildId)!.ownerId;
    if (body.ownerId !== undefined && body.ownerId !== previousOwner) {
      if (req.user.id !== previousOwner) return forbidden(reply, 'Sahipliği yalnızca sunucunun sahibi devredebilir.');
      if (!permissions.isMember(guildId, body.ownerId)) return sendError(reply, 404, 'not_found', 'Üye bulunamadı.');
    }
    const before = gateway.visibility();
    const guild = store.updateGuild(guildId, body)!;
    refreshPrimary(guildId);
    gateway.sendToGuild(guildId, { t: 'GUILD_UPDATE', d: guild });
    if (guild.ownerId !== previousOwner) {
      await afterPermissionChange(ctx, before);
    }
    return guild;
  });

  // Sunucuyu yalnızca sahibi siler; ana sunucu (ilk kurulan) silinemez.
  app.delete<{ Params: GuildParams }>('/api/guilds/:guildId', { preHandler: auth.requireMember }, async (req, reply) => {
    const { guildId } = req.params;
    if (!permissions.isOwner(guildId, req.user.id)) return forbidden(reply, 'Sunucuyu yalnızca sahibi silebilir.');
    if (guildId === permissions.primaryGuildId) {
      return sendError(reply, 400, 'primary_guild', 'Ana sunucu silinemez.');
    }
    const members = store.guildMemberIds(guildId);
    const channels = store.listChannels(guildId);
    // Sesteki herkes çıkarılır (kanal silinirken olduğu gibi)
    for (const channel of channels) {
      if (channel.type !== 'voice') continue;
      voice.leaveChannel(channel.id);
      await ctx.livekit.closeChannelRoom(channel.id);
    }
    const result = store.deleteGuild(guildId);
    if (!result) return sendError(reply, 404, 'not_found', 'Sunucu bulunamadı.');
    gateway.sendToUsers(members, { t: 'GUILD_DELETE', d: { id: guildId, reason: 'Sunucu silindi.' } });
    await attachments.remove(result.files);
    await avatars.removeDeletedIcon(result.icon).catch(() => undefined);
    await soundboard.removeDeleted(result.sounds).catch(() => undefined);
    return reply.code(204).send();
  });

  // Sunucudan ayrılmak (sahip ayrılamaz: önce sahipliği devretmeli ya da sunucuyu silmeli)
  app.delete<{ Params: GuildParams }>(
    '/api/guilds/:guildId/members/me',
    { preHandler: auth.requireMember },
    async (req, reply) => {
      const { guildId } = req.params;
      if (permissions.isOwner(guildId, req.user.id)) {
        return sendError(
          reply,
          400,
          'owner',
          'Sunucunun sahibi ayrılamaz. Önce sahipliği başka birine devret ya da sunucuyu sil.',
        );
      }
      await moderation.disconnectFromGuild(guildId, req.user.id);
      store.removeMember(guildId, req.user.id);
      // Ortak sunucusu kalmayanla bire bir DM araması da biter (konuşma salt okunur oldu)
      void moderation.enforceDmCalls();
      gateway.announceLeave(guildId, req.user.id);
      return reply.code(204).send();
    },
  );

  // ---------- Simge ----------

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    scope.post<{ Params: GuildParams }>(
      '/api/guilds/:guildId/icon',
      {
        onRequest: auth.requireGuildPermission(Permission.MANAGE_GUILD),
        // Hata yanıtında okunmamış gövde boşuna okunmasın: bağlantı yanıttan sonra kapanır
        onSend: async (_req, reply, payload) => {
          if (reply.statusCode !== 200) void reply.header('Connection', 'close');
          return payload;
        },
      },
      async (req, reply) => {
        if (!allowIcon(req.user.id)) {
          return sendError(reply, 429, 'rate_limited', 'Sunucu simgesini çok sık değiştiriyorsun, biraz bekle.');
        }
        const length = req.headers['content-length'];
        try {
          const guild = await avatars.uploadGuildIcon(
            req.params.guildId,
            (req.body as Readable | undefined) ?? req.raw,
            length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
          );
          refreshPrimary(guild.id);
          gateway.sendToGuild(guild.id, { t: 'GUILD_UPDATE', d: guild });
          return guild;
        } catch (err) {
          if (err instanceof UploadError) return sendError(reply, err.status, err.code, err.message);
          throw err;
        }
      },
    );
  });

  app.delete<{ Params: GuildParams }>(
    '/api/guilds/:guildId/icon',
    { preHandler: auth.requireGuildPermission(Permission.MANAGE_GUILD) },
    async (req, reply) => {
      const guild = await avatars.removeGuildIcon(req.params.guildId);
      if (!guild) return sendError(reply, 404, 'not_found', 'Sunucu bulunamadı.');
      refreshPrimary(guild.id);
      gateway.sendToGuild(guild.id, { t: 'GUILD_UPDATE', d: guild });
      return guild;
    },
  );

  // Simgeler, profil fotoğrafları gibi kimlik doğrulamasız sunulur; yalnızca şu anki simge (eskisi 404)
  app.get<{ Params: { guildId: string; file: string } }>('/api/guild-icons/:guildId/:file', async (req, reply) => {
    const hash = req.params.file.endsWith('.webp') ? req.params.file.slice(0, -5) : '';
    if (!AVATAR_HASH.test(hash) || store.getGuildIconHash(req.params.guildId) !== hash) {
      return sendError(reply, 404, 'not_found', 'Sunucu simgesi bulunamadı.');
    }
    const file = avatars.pathOf(hash);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) return sendError(reply, 404, 'not_found', 'Sunucu simgesi bulunamadı.');
    const etag = `"${hash}"`;
    void reply
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('Content-Type', 'image/webp').header('Content-Length', stat.size).send(fs.createReadStream(file));
  });

  // ---------- Davetler ----------
  // Davet oluşturmak CREATE_INVITE ister (varsayılan olarak herkeste); kişi kendi davetlerini görür ve
  // siler. MANAGE_INVITES yetkilisi tüm davetleri görür ve siler.

  const canCreateInvite = (guildId: string, userId: string): boolean =>
    permissions.canInGuild(guildId, userId, Permission.CREATE_INVITE) ||
    permissions.canInGuild(guildId, userId, Permission.MANAGE_INVITES);

  app.get<{ Params: GuildParams }>('/api/guilds/:guildId/invites', { preHandler: auth.requireMember }, async (req, reply) => {
    const { guildId } = req.params;
    if (permissions.canInGuild(guildId, req.user.id, Permission.MANAGE_INVITES)) return store.listInvites(guildId);
    if (canCreateInvite(guildId, req.user.id)) return store.listInvites(guildId, req.user.id);
    return forbidden(reply, 'Davetleri görme yetkin yok.');
  });

  app.post<{ Params: GuildParams }>('/api/guilds/:guildId/invites', { preHandler: auth.requireMember }, async (req, reply) => {
    const { guildId } = req.params;
    if (!canCreateInvite(guildId, req.user.id)) return forbidden(reply, 'Bu sunucuya davet oluşturma yetkin yok.');
    const body = parseBody(createInviteSchema, req.body, reply);
    if (!body) return reply;
    const invite = store.createInvite({
      guildId,
      createdBy: req.user.id,
      maxUses: body.maxUses ?? null,
      expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 3_600_000 : null,
    });
    return reply.code(201).send(invite);
  });

  app.delete<{ Params: GuildParams & { code: string } }>(
    '/api/guilds/:guildId/invites/:code',
    { preHandler: auth.requireMember },
    async (req, reply) => {
      const { guildId } = req.params;
      const invite = store.getInvite(req.params.code);
      if (!invite || invite.guildId !== guildId) return sendError(reply, 404, 'not_found', 'Davet bulunamadı.');
      const own = invite.createdBy === req.user.id && canCreateInvite(guildId, req.user.id);
      if (!own && !permissions.canInGuild(guildId, req.user.id, Permission.MANAGE_INVITES)) {
        return forbidden(reply, 'Bu daveti silemezsin.');
      }
      store.deleteInvite(invite.code);
      return reply.code(204).send();
    },
  );

  // Davet bağlantısının önizlemesi: giriş gerekmez (indirme sayfası ve katılma ekranı gösterir)
  app.get<{ Params: { code: string } }>('/api/invites/:code', async (req, reply) => {
    if (!allowPreview(req.ip)) return sendError(reply, 429, 'rate_limited', 'Çok fazla deneme. Biraz bekle.');
    const check = store.checkInvite(req.params.code);
    if (!check.ok) return sendError(reply, 404, 'invalid_invite', check.reason);
    const guild = check.invite.guild_id ? store.getGuild(check.invite.guild_id) : null;
    const preview: InvitePreview = {
      code: check.invite.code,
      guild: guild ? { id: guild.id, name: guild.name, iconUrl: guild.iconUrl ?? null } : null,
      memberCount: guild ? store.memberCount(guild.id) : 0,
      expiresAt: check.invite.expires_at,
    };
    void reply.header('Cache-Control', 'no-store');
    return preview;
  });

  // Davet koduyla sunucuya katılmak (ya da ayrıldığı/atıldığı sunucuya dönmek)
  app.post<{ Params: { code: string } }>('/api/invites/:code/accept', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!allowJoin(req.user.id)) return sendError(reply, 429, 'rate_limited', 'Çok fazla deneme. Biraz bekle.');
    const result = store.joinWithInvite(req.params.code, req.user.id);
    if (!result.ok) {
      const status = result.reason === 'banned' ? 403 : result.reason === 'invite' ? 404 : 400;
      return sendError(reply, status, result.reason === 'invite' ? 'invalid_invite' : result.reason, result.message);
    }
    if (!result.alreadyMember) {
      gateway.announceJoin(result.guildId, req.user.id);
    }
    const response: AcceptInviteResponse = { guild: store.getGuild(result.guildId)!, alreadyMember: result.alreadyMember };
    return response;
  });

  // ---------- Üyeler ----------

  app.get<{ Params: GuildParams }>('/api/guilds/:guildId/members', { preHandler: auth.requireMember }, async (req) =>
    store.listMembers(req.params.guildId),
  );

  // Atma ve yasaklama: hesap ve mesajları kalır, o sunucudaki rolleri silinir; sunucu kişinin listesinden
  // kalkar. Atılan yeni bir davetle geri dönebilir; yasaklanan yasak kalkana kadar dönemez.
  const removeMember = async (
    guildId: string,
    actorId: string,
    targetId: string,
    ban: { reason: string | null } | null,
    reply: FastifyReply,
  ) => {
    if (targetId === actorId) return sendError(reply, 400, 'self', 'Kendini atamaz ya da yasaklayamazsın.');
    const status = store.memberStatus(guildId, targetId);
    if (status === 'none') return sendError(reply, 404, 'not_found', 'Üye bulunamadı.');
    if (!ban && status !== 'member') return sendError(reply, 400, 'not_member', 'Bu kullanıcı zaten üye değil.');
    if (status === 'banned') return sendError(reply, 400, 'already_banned', 'Bu kullanıcı zaten yasaklı.');
    if (!permissions.outranks(guildId, actorId, targetId)) {
      return forbidden(reply, 'En üst rolü seninkinden aşağıda olmayan birini atamaz ya da yasaklayamazsın.');
    }
    await moderation.disconnectFromGuild(guildId, targetId);
    store.removeMember(guildId, targetId, ban);
    void moderation.enforceDmCalls();
    if (status === 'member') {
      const guildName = store.getGuild(guildId)?.name ?? 'sunucu';
      gateway.announceLeave(
        guildId,
        targetId,
        ban ? `"${guildName}" sunucusundan yasaklandın.` : `"${guildName}" sunucusundan çıkarıldın.`,
      );
    }
    return reply.code(204).send();
  };

  app.delete<{ Params: GuildParams & { userId: string } }>(
    '/api/guilds/:guildId/members/:userId',
    { preHandler: auth.requireGuildPermission(Permission.KICK_MEMBERS) },
    async (req, reply) => removeMember(req.params.guildId, req.user.id, req.params.userId, null, reply),
  );

  app.put<{ Params: GuildParams & { userId: string } }>(
    '/api/guilds/:guildId/bans/:userId',
    { preHandler: auth.requireGuildPermission(Permission.BAN_MEMBERS) },
    async (req, reply) => {
      const body = parseBody(banSchema, req.body, reply);
      if (!body) return reply;
      return removeMember(req.params.guildId, req.user.id, req.params.userId, { reason: body.reason || null }, reply);
    },
  );

  app.get<{ Params: GuildParams }>(
    '/api/guilds/:guildId/bans',
    { preHandler: auth.requireGuildPermission(Permission.BAN_MEMBERS) },
    async (req): Promise<Ban[]> => store.listBans(req.params.guildId),
  );

  app.delete<{ Params: GuildParams & { userId: string } }>(
    '/api/guilds/:guildId/bans/:userId',
    { preHandler: auth.requireGuildPermission(Permission.BAN_MEMBERS) },
    async (req, reply) => {
      if (!store.unban(req.params.guildId, req.params.userId)) {
        return sendError(reply, 404, 'not_found', 'Yasaklı kullanıcı bulunamadı.');
      }
      return reply.code(204).send();
    },
  );

  // ---------- Sesli sohbette yönetim ----------
  // Sunucuda susturma/sağırlaştırma (o sunucuda kalıcı), başka kanala taşıma, sesten çıkarma. Yetkiler
  // üyenin bulunduğu kanalda aranır (bu sunucuda seste değilse sunucu genelinde). Discord'daki gibi rol
  // hiyerarşisine bakılmaz (aynı roldekiler birbirini taşıyabilir). Taşıma yalnızca aynı sunucunun kanalları arasında.

  app.patch<{ Params: GuildParams & { userId: string } }>(
    '/api/guilds/:guildId/members/:userId/voice',
    { preHandler: auth.requireMember },
    async (req, reply) => {
      const { guildId } = req.params;
      const body = parseBody(voiceSchema, req.body, reply);
      if (!body) return reply;
      const actorId = req.user.id;
      const targetId = req.params.userId;
      if (!permissions.isMember(guildId, targetId)) return sendError(reply, 404, 'not_found', 'Üye bulunamadı.');
      const current = voice.get(targetId);
      const state = current && permissions.guildOf(current.channelId) === guildId ? current : undefined;
      const can = (flag: number, channelId = state?.channelId): boolean =>
        channelId ? permissions.can(actorId, flag, channelId) : permissions.canInGuild(guildId, actorId, flag);
      if (body.mute !== undefined && !can(Permission.MUTE_MEMBERS)) return forbidden(reply, 'Üyeleri susturma yetkin yok.');
      if (body.deaf !== undefined && !can(Permission.DEAFEN_MEMBERS)) {
        return forbidden(reply, 'Üyeleri sağırlaştırma yetkin yok.');
      }
      if (body.channelId !== undefined) {
        if (!state) return sendError(reply, 400, 'not_in_voice', 'Kullanıcı bu sunucuda bir ses kanalında değil.');
        if (!can(Permission.MOVE_MEMBERS)) return forbidden(reply, 'Üyeleri taşıma yetkin yok.');
        if (body.channelId !== null) {
          const dest = store.getChannel(body.channelId);
          if (!dest || dest.guildId !== guildId || dest.type !== 'voice' || !permissions.canView(actorId, dest)) {
            return sendError(reply, 404, 'not_found', 'Ses kanalı bulunamadı.');
          }
          if (!can(Permission.MOVE_MEMBERS, dest.id)) return forbidden(reply, 'O kanala üye taşıma yetkin yok.');
          if (!moderation.canConnect(targetId, dest.id)) return forbidden(reply, 'Bu üye o kanala bağlanamaz.');
        }
      }

      if (body.mute !== undefined || body.deaf !== undefined) {
        const flags = store.serverVoiceFlags(guildId, targetId);
        await moderation.setServerFlags(guildId, targetId, {
          serverMute: body.mute ?? flags.serverMute,
          serverDeaf: body.deaf ?? flags.serverDeaf,
        });
      }
      if (body.channelId === null) await moderation.disconnect(targetId);
      else if (body.channelId !== undefined) moderation.move(targetId, body.channelId);
      return reply.code(204).send();
    },
  );
}
