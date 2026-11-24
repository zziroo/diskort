import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CHANNEL_NAME_MAX_LENGTH,
  hasPermission,
  Permission,
  TEXT_CHANNEL_PERMISSIONS,
  VOICE_CHANNEL_PERMISSIONS,
  type PermissionOverwrite,
  type User,
} from '@diskort/shared';
import { removeAccount } from '../accounts.js';
import { afterPermissionChange, forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { createInviteSchema } from './guilds.js';

const channelName = z
  .string()
  .trim()
  .min(1, 'Kanal adı boş olamaz.')
  .max(CHANNEL_NAME_MAX_LENGTH, `Kanal adı en fazla ${CHANNEL_NAME_MAX_LENGTH} karakter olabilir.`);

const createChannelSchema = z.object({
  name: channelName,
  type: z.enum(['voice', 'text']),
});

const channelOrderSchema = z.object({ channelIds: z.array(z.string().min(1).max(64)).max(1000) });

const RESET_CODE_TTL_MS = 24 * 3_600_000;

const overwriteSchema = z.object({
  roleId: z.string().min(1).max(64),
  allow: z.number().int().min(0),
  deny: z.number().int().min(0),
});

const updateChannelSchema = z.object({
  name: channelName.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  overwrites: z.array(overwriteSchema).max(100).optional(),
});

/**
 * Hesap yönetimi (hesap yöneticilerine: users.is_admin; kısmen hesap yardımcılarına: users.is_account_helper)
 * ve kanallar. Hesaplar ve hesap yöneticiliği tüm sunuculardan bağımsızdır: hesap daveti yalnızca hesap
 * açtırır, şifre sıfırlama ve hesap silme hesabın kendisine dokunur. Bir hesap yöneticisi başka bir hesap
 * yöneticisinin şifresini sıfırlayamaz, hesabını silemez (önce yöneticiliği alınmalı).
 *
 * Hesap yardımcısı yalnızca: hesap daveti oluşturur ve listeler, kendi oluşturduğu daveti siler, sıradan
 * hesaplara (yönetici, yardımcı, sunucu sahibi ya da sunucu yöneticisi olmayan) ve kendine sıfırlama kodu üretir. Hesap silemez, rol atayamaz; yardımcılığı
 * yalnızca hesap yöneticisi verip alır, böylece korunan bir hedefi sıradan hâle getiremez.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, attachments, permissions } = ctx;
  const canManageAccount = (targetId: string): boolean => !permissions.isInstanceAdmin(targetId);
  /** Hesap bir sunucunun sahibi ya da bir sunucuda Yönetici (ADMINISTRATOR) yetkisi taşıyor mu */
  const holdsGuildPower = (userId: string): boolean =>
    store.ownedGuildIds(userId).length > 0 ||
    [...permissions.guildsOf(userId)].some((guildId) => permissions.canInGuild(guildId, userId, Permission.ADMINISTRATOR));
  /**
   * Sıfırlama kodunu engelleyen neden (null: üretilebilir). Kendine her zaman; yönetici yönetici olmayana;
   * yardımcı yalnızca sıradan hesaplara: yönetici, yardımcı, sunucu sahibi ya da sunucu yöneticisi olmayan
   * (kodu alan hesabı, dolayısıyla onun sunucusunu ele geçirebilir).
   */
  const resetBlockedReason = (actorId: string, targetId: string): string | null => {
    if (targetId === actorId) return null;
    if (!canManageAccount(targetId)) return 'Başka bir hesap yöneticisinin şifresini sıfırlayamazsın.';
    if (permissions.isInstanceAdmin(actorId)) return null;
    if (permissions.isAccountHelper(targetId)) return 'Başka bir hesap yardımcısının şifresini sıfırlayamazsın.';
    if (holdsGuildPower(targetId)) {
      return 'Sunucu sahibi ya da sunucu yöneticisi olan hesabı yalnızca hesap yöneticisi sıfırlayabilir.';
    }
    return null;
  };

  // ---------- Hesap davetleri (sunucuya katılmadan yalnızca hesap açtırır) ----------

  app.get('/api/invites', { preHandler: auth.requireAccountHelper }, async () => store.listAccountInvites());

  // Davet oluşturan created_by olarak kaydedilir (yardımcınınki de; davet listesinde görünür)
  app.post('/api/invites', { preHandler: auth.requireAccountHelper }, async (req, reply) => {
    const body = parseBody(createInviteSchema, req.body, reply);
    if (!body) return reply;
    const invite = store.createInvite({
      guildId: null,
      createdBy: req.user.id,
      maxUses: body.maxUses ?? null,
      expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 3_600_000 : null,
    });
    return reply.code(201).send(invite);
  });

  // Yönetici her hesap davetini, yardımcı yalnızca kendi oluşturduğunu siler
  app.delete<{ Params: { code: string } }>('/api/invites/:code', { preHandler: auth.requireAccountHelper }, async (req, reply) => {
    const invite = store.getInvite(req.params.code);
    if (!invite || invite.guildId !== null) return sendError(reply, 404, 'not_found', 'Davet bulunamadı.');
    if (!permissions.isInstanceAdmin(req.user.id) && invite.createdBy !== req.user.id) {
      return forbidden(reply, 'Yalnızca kendi oluşturduğun daveti silebilirsin.');
    }
    store.deleteInvite(invite.code);
    return reply.code(204).send();
  });

  // ---------- Hesaplar ----------

  // Şifresini unutan kişi için tek kullanımlık, 24 saat geçerli sıfırlama kodu. Kodu alan hesabı ele
  // geçirebileceğinden yalnızca hesap yöneticileri (kendilerinden aşağıdakiler için) ve hesap yardımcıları
  // (sıradan hesaplar için) üretebilir. Üreten reset_codes.created_by olarak kaydedilir.
  app.post<{ Params: { id: string } }>(
    '/api/users/:id/reset-code',
    { preHandler: auth.requireAccountHelper },
    async (req, reply) => {
      const target = store.getUser(req.params.id);
      if (!target) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
      const blocked = resetBlockedReason(req.user.id, target.id);
      if (blocked) return forbidden(reply, blocked);
      return store.createResetCode(target.id, req.user.id, RESET_CODE_TTL_MS);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: auth.requireInstanceAdmin }, async (req, reply) => {
    const id = req.params.id;
    if (id === req.user.id) return sendError(reply, 400, 'self_delete', 'Kendi hesabını buradan silemezsin.');
    if (!store.getUser(id)) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (!canManageAccount(id)) {
      return forbidden(reply, 'Başka bir hesap yöneticisinin hesabını silemezsin; önce yöneticiliğini al.');
    }
    if (store.ownedGuildIds(id).length > 0) {
      return sendError(reply, 400, 'owner', 'Bu kişi bir sunucunun sahibi; önce sahipliği devretmeli ya da sunucuyu silmeli.');
    }
    await removeAccount(ctx, id, 'Hesabın bir yönetici tarafından silindi.');
    return reply.code(204).send();
  });

  /**
   * Tüm hesaplar (sıfırlama kodu, hesap silme, yönetici ve yardımcı ekleme için). Yardımcıya yalnızca
   * listede gereken alanlar gider (kimlik, ad, avatar, rol bayrakları); afiş, giriş sesi, tema gitmez.
   */
  app.get('/api/users', { preHandler: auth.requireAccountHelper }, async (req) => {
    const users = store.listUsers();
    if (permissions.isInstanceAdmin(req.user.id)) return users;
    return users.map(
      (u): User => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarColor: u.avatarColor,
        avatarUrl: u.avatarUrl ?? null,
        isAdmin: u.isAdmin,
        isAccountHelper: u.isAccountHelper === true,
      }),
    );
  });

  // ---------- Hesap yöneticileri ----------

  app.get('/api/admins', { preHandler: auth.requireInstanceAdmin }, async () => store.listAdmins());

  app.put<{ Params: { id: string } }>('/api/admins/:id', { preHandler: auth.requireInstanceAdmin }, async (req, reply) => {
    const result = store.setAdmin(req.params.id, true);
    if (result === 'not_found') return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    const user = store.getUser(req.params.id)!;
    if (result === 'ok') gateway.sendUserUpdate(user);
    return user;
  });

  app.delete<{ Params: { id: string } }>('/api/admins/:id', { preHandler: auth.requireInstanceAdmin }, async (req, reply) => {
    const result = store.setAdmin(req.params.id, false);
    if (result === 'not_found') return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (result === 'last_admin') {
      return sendError(reply, 400, 'last_admin', 'Son hesap yöneticisinin yöneticiliği alınamaz.');
    }
    if (result === 'ok') gateway.sendUserUpdate(store.getUser(req.params.id)!);
    return reply.code(204).send();
  });

  // ---------- Hesap yardımcıları (yalnızca hesap yöneticisi atar ve alır) ----------

  app.put<{ Params: { id: string } }>('/api/helpers/:id', { preHandler: auth.requireInstanceAdmin }, async (req, reply) => {
    const result = store.setAccountHelper(req.params.id, true);
    if (result === 'not_found') return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (result === 'admin') {
      return sendError(reply, 400, 'is_admin', 'Hesap yöneticisi zaten bu işleri yapabilir; yardımcı yapılamaz.');
    }
    const user = store.getUser(req.params.id)!;
    if (result === 'ok') gateway.sendUserUpdate(user);
    return user;
  });

  app.delete<{ Params: { id: string } }>('/api/helpers/:id', { preHandler: auth.requireInstanceAdmin }, async (req, reply) => {
    const result = store.setAccountHelper(req.params.id, false);
    if (result === 'not_found') return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (result === 'ok') gateway.sendUserUpdate(store.getUser(req.params.id)!);
    return reply.code(204).send();
  });

  // ---------- Kanallar ----------

  /** Kullanıcının tüm sunucularda görebildiği kanallar */
  app.get('/api/channels', { preHandler: auth.requireUser }, async (req) =>
    [...permissions.guildsOf(req.user.id)].flatMap((guildId) => permissions.visibleChannels(guildId, req.user.id)),
  );

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/channels',
    { preHandler: auth.requireMember },
    async (req) => permissions.visibleChannels(req.params.guildId, req.user.id),
  );

  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/channels',
    { preHandler: auth.requireGuildPermission(Permission.MANAGE_CHANNELS) },
    async (req, reply) => {
      const body = parseBody(createChannelSchema, req.body, reply);
      if (!body) return reply;
      const channel = store.createChannel(req.params.guildId, body.name, body.type);
      gateway.dispatchChannel(channel.id, { t: 'CHANNEL_CREATE', d: channel });
      return reply.code(201).send(channel);
    },
  );

  // Kanalların sırası (sürükle-bırak). İstemci görebildiği kanalların hepsini yeni sırasıyla gönderir;
  // göremediği kanallar listedeki yerlerini korur (görünen kanalların boşaltığı yerlere yeni sıra
  // yerleşir). Yeri değişen her kanalda KANALLARI_YÖNET yetkisi gerekir. Sonra tüm kanallar 0'dan
  // yeniden numaralanır; konumu değişenler için CHANNEL_UPDATE yayınlanır.
  app.put<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/channels/order',
    { preHandler: auth.requireMember },
    async (req, reply) => {
      const body = parseBody(channelOrderSchema, req.body, reply);
      if (!body) return reply;
      const { guildId } = req.params;
      const actorId = req.user.id;
      const all = store.listChannels(guildId);
      const visible = all.filter((c) => permissions.canView(actorId, c));
      const ids = new Set(body.channelIds);
      if (
        ids.size !== body.channelIds.length ||
        ids.size !== visible.length ||
        visible.some((c) => !ids.has(c.id))
      ) {
        return sendError(reply, 400, 'invalid_body', 'Sıralamada görebildiğin tüm kanallar birer kez bulunmalı.');
      }
      const byId = new Map(visible.map((c) => [c.id, c]));
      // Görünenler arasında yeri değişenler: onlarda yönetme yetkisi gerekir
      const moved = body.channelIds.filter((id, i) => visible[i]!.id !== id);
      if (moved.length === 0) return visible;
      if (moved.some((id) => !permissions.can(actorId, Permission.MANAGE_CHANNELS, byId.get(id)!))) {
        return forbidden(reply, 'Kanalları düzenleme yetkin yok.');
      }
      let next = 0;
      const order = all.map((c) => (byId.has(c.id) ? body.channelIds[next++]! : c.id));
      const before = new Map(all.map((c) => [c.id, c.position]));
      store.setChannelOrder(guildId, order);
      order.forEach((id, i) => {
        if (before.get(id) !== i) gateway.dispatchChannel(id, { t: 'CHANNEL_UPDATE', d: store.getChannel(id)! });
      });
      return permissions.visibleChannels(guildId, actorId);
    },
  );

  app.patch<{ Params: { id: string } }>('/api/channels/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(updateChannelSchema, req.body, reply);
    if (!body) return reply;
    const channel = store.getChannel(req.params.id);
    if (!channel || !permissions.canView(req.user.id, channel)) {
      return sendError(reply, 404, 'not_found', 'Kanal bulunamadı.');
    }
    const guildId = channel.guildId;
    const actorPerms = permissions.inChannel(req.user.id, channel);
    if ((body.name !== undefined || body.position !== undefined) && !hasPermission(actorPerms, Permission.MANAGE_CHANNELS)) {
      return forbidden(reply, 'Kanalları düzenleme yetkin yok.');
    }

    let overwrites: PermissionOverwrite[] | null = null;
    if (body.overwrites) {
      if (!hasPermission(actorPerms, Permission.MANAGE_ROLES)) return forbidden(reply, 'Kanal izinlerini düzenleme yetkin yok.');
      const allowed = channel.type === 'text' ? TEXT_CHANNEL_PERMISSIONS : VOICE_CHANNEL_PERMISSIONS;
      // Yalnızca bu sunucunun rolleri
      const roles = Object.fromEntries(store.guildRoles(guildId).map((r) => [r.id, r]));
      const next = new Map<string, PermissionOverwrite>();
      for (const o of body.overwrites) {
        if (!roles[o.roleId]) return sendError(reply, 400, 'invalid_role', 'Rol bulunamadı.');
        if (o.allow & o.deny) return sendError(reply, 400, 'invalid_body', 'Bir yetki aynı anda hem verilip hem engellenemez.');
        next.set(o.roleId, { roleId: o.roleId, allow: o.allow & allowed, deny: o.deny & allowed });
      }
      const isAdmin = permissions.canInGuild(guildId, req.user.id, Permission.ADMINISTRATOR);
      const current = new Map(channel.overwrites.map((o) => [o.roleId, o]));
      for (const roleId of new Set([...current.keys(), ...next.keys()])) {
        const a = current.get(roleId) ?? { allow: 0, deny: 0 };
        const b = next.get(roleId) ?? { allow: 0, deny: 0 };
        const changed = (a.allow ^ b.allow) | (a.deny ^ b.deny);
        if (changed === 0) continue;
        const role = roles[roleId];
        // Hiyerarşi: yalnızca kendi en üst rolünün altındaki rollerin (ve @everyone'ın) izinleri
        if (!role || !permissions.roleIsBelow(guildId, req.user.id, role)) {
          return forbidden(reply, `"${role?.name ?? 'Silinmiş rol'}" rolünün kanal izinlerini değiştiremezsin.`);
        }
        // Kendinde olmayan bir yetkiyi veremez/engelleyemez
        if (!isAdmin && (changed & ~actorPerms) !== 0) {
          return forbidden(reply, 'Kendinde olmayan bir yetkiyi verip engelleyemezsin.');
        }
      }
      overwrites = [...next.values()];
    }

    const before = gateway.visibility();
    if (body.name !== undefined || body.position !== undefined) {
      store.updateChannel(channel.id, { name: body.name, position: body.position });
    }
    if (overwrites) {
      store.setChannelOverwrites(channel.id, overwrites);
      await afterPermissionChange(ctx, before, [channel.id]);
    } else {
      gateway.dispatchChannel(channel.id, { t: 'CHANNEL_UPDATE', d: store.getChannel(channel.id)! });
    }
    return store.getChannel(channel.id);
  });

  app.delete<{ Params: { id: string } }>('/api/channels/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const id = req.params.id;
    const channel = store.getChannel(id);
    if (!channel || !permissions.canView(req.user.id, channel)) {
      return sendError(reply, 404, 'not_found', 'Kanal bulunamadı.');
    }
    if (!permissions.can(req.user.id, Permission.MANAGE_CHANNELS, channel)) return forbidden(reply, 'Kanalları silme yetkin yok.');
    // Silinmeden önce kanalı görebilenler haber alır (ses durumlarının silinmesi de)
    const viewers = permissions.viewersOf(channel, gateway.connectedUserIds());
    ctx.voice.leaveChannel(id);
    const files = store.channelAttachmentIds(id);
    store.deleteChannel(id);
    await attachments.remove(files);
    await ctx.livekit.closeChannelRoom(id);
    gateway.sendToUsers(viewers, { t: 'CHANNEL_DELETE', d: { id, guildId: channel.guildId } });
    return reply.code(204).send();
  });
}
