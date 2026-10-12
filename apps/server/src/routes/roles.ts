import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  MAX_ROLES,
  ROLE_COLOR_PATTERN,
  ROLE_NAME_MAX_LENGTH,
  Permission,
  sortRoles,
  type Role,
} from '@diskort/shared';
import { afterPermissionChange, forbidden, parseBody, sendError, type AppContext } from '../context.js';

const roleName = z
  .string()
  .trim()
  .min(1, 'Rol adı boş olamaz.')
  .max(ROLE_NAME_MAX_LENGTH, `Rol adı en fazla ${ROLE_NAME_MAX_LENGTH} karakter olabilir.`)
  // everyone/here adlı rol @everyone/@here yayınlarıyla karışırdı (Türkçe I/İ/ı dahil büyük/küçük duyarsız)
  .refine((n) => !['everyone', 'here'].includes(n.replace(/^@/, '').replace(/[Iİı]/g, 'i').toLowerCase()), {
    message: '"everyone" ve "here" rol adı olarak kullanılamaz.',
  });
const roleColor = z
  .string()
  .regex(ROLE_COLOR_PATTERN, 'Geçersiz renk.')
  .transform((c) => c.toLowerCase())
  .nullable();
const permissionBits = z.number().int().min(0).max(ALL_PERMISSIONS);

const createRoleSchema = z.object({
  name: roleName,
  color: roleColor.optional(),
  hoist: z.boolean().optional(),
  permissions: permissionBits.optional(),
});
const updateRoleSchema = z.object({
  name: roleName.optional(),
  color: roleColor.optional(),
  hoist: z.boolean().optional(),
  permissions: permissionBits.optional(),
});
const reorderSchema = z.object({ roleIds: z.array(z.string().min(1).max(64)).max(MAX_ROLES) });

type GuildParams = { guildId: string };

/** Kullanıcının o sunucuda sahip olmadığı yetkiler (yöneticide hiç yok) */
function lackingBits(ctx: AppContext, guildId: string, userId: string, bits: number): number {
  return bits & ~ctx.permissions.base(guildId, userId);
}

/**
 * `actor`, `target` üyeye bu rolü verip alabilir mi; veremiyorsa nedeni. Kurallar (Discord gibi): MANAGE_ROLES,
 * rol actor'ün en üst rolünün altında, rolde actor'ün sahip olmadığı yetki yok (yetkisini aşan birini
 * yaratamasın). Hedefin seviyesine bakılmaz: aynı seviyedeki (ya da üstteki) üyeye de alt bir rol verilebilir
 * (2026-10-12 kararı; eskiden hedef kendinden aşağıda olmalıydı, aynı roldeki arkadaşlar birbirine rol veremiyordu).
 */
export function canAssignRole(ctx: AppContext, guildId: string, actorId: string, targetId: string, role: Role): string | null {
  const { permissions } = ctx;
  if (!permissions.canInGuild(guildId, actorId, Permission.MANAGE_ROLES)) return 'Rolleri yönetme yetkin yok.';
  if (role.id === guildId) return '@everyone rolü verilip alınamaz.';
  if (!permissions.roleIsBelow(guildId, actorId, role)) return `"${role.name}" rolü senin en üst rolünden aşağıda değil.`;
  if (lackingBits(ctx, guildId, actorId, role.permissions) !== 0) return 'Kendinde olmayan yetkileri içeren bir rolü veremezsin.';
  return null;
}

/** Üyeye rol verir/alır ve sonuçlarını yayar (üyelik bilgisi, kanal görünümü, ses izinleri). */
export async function setMemberRole(
  ctx: AppContext,
  guildId: string,
  userId: string,
  roleId: string,
  add: boolean,
): Promise<void> {
  const before = ctx.gateway.visibility();
  const changed = add ? ctx.store.addMemberRole(userId, roleId) : ctx.store.removeMemberRole(userId, roleId);
  if (!changed) return;
  ctx.gateway.announceMember(guildId, userId);
  await afterPermissionChange(ctx, before);
}

/** Roller ve üyelerin rolleri; hepsi sunucu (guild) başınadır. */
export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, permissions } = ctx;
  const manageRoles = auth.requireGuildPermission(Permission.MANAGE_ROLES);

  const allRoles = (guildId: string): Role[] => sortRoles(store.guildRoles(guildId));
  const broadcastRoles = (guildId: string): void =>
    gateway.sendToGuild(guildId, { t: 'ROLES_UPDATE', d: { guildId, roles: allRoles(guildId) } });
  /** Yoldaki rol bu sunucunun rolüyse */
  const guildRole = (guildId: string, roleId: string, reply: FastifyReply): Role | null => {
    const role = store.getRole(roleId);
    if (!role || role.guildId !== guildId) {
      void sendError(reply, 404, 'not_found', 'Rol bulunamadı.');
      return null;
    }
    const { guildId: _guild, ...rest } = role;
    return rest;
  };

  // ---------- Roller ----------

  app.get<{ Params: GuildParams }>('/api/guilds/:guildId/roles', { preHandler: auth.requireMember }, async (req) =>
    allRoles(req.params.guildId),
  );

  app.post<{ Params: GuildParams }>('/api/guilds/:guildId/roles', { preHandler: manageRoles }, async (req, reply) => {
    const { guildId } = req.params;
    const body = parseBody(createRoleSchema, req.body, reply);
    if (!body) return reply;
    if (store.guildRoles(guildId).length > MAX_ROLES) {
      return sendError(reply, 400, 'too_many_roles', `En fazla ${MAX_ROLES} rol oluşturulabilir.`);
    }
    const bits = body.permissions ?? 0;
    if (lackingBits(ctx, guildId, req.user.id, bits) !== 0) return forbidden(reply, 'Kendinde olmayan bir yetkiyi veremezsin.');
    const role = store.createRole(guildId, {
      name: body.name,
      color: body.color ?? null,
      hoist: body.hoist ?? false,
      permissions: bits,
    });
    broadcastRoles(guildId);
    return reply.code(201).send(role);
  });

  app.patch<{ Params: GuildParams & { id: string } }>(
    '/api/guilds/:guildId/roles/:id',
    { preHandler: manageRoles },
    async (req, reply) => {
      const { guildId } = req.params;
      const body = parseBody(updateRoleSchema, req.body, reply);
      if (!body) return reply;
      const role = guildRole(guildId, req.params.id, reply);
      if (!role) return reply;
      if (!permissions.roleIsBelow(guildId, req.user.id, role)) {
        return forbidden(reply, 'Yalnızca senin en üst rolünden aşağıdaki rolleri düzenleyebilirsin.');
      }
      const everyone = role.id === guildId;
      if (everyone && (body.name !== undefined || body.color !== undefined || body.hoist !== undefined)) {
        return sendError(reply, 400, 'invalid_body', '@everyone rolünün yalnızca yetkileri değiştirilebilir.');
      }
      const permissionsChanged = body.permissions !== undefined && body.permissions !== role.permissions;
      if (permissionsChanged && lackingBits(ctx, guildId, req.user.id, role.permissions ^ body.permissions!) !== 0) {
        return forbidden(reply, 'Kendinde olmayan bir yetkiyi verip alamazsın.');
      }
      const before = gateway.visibility();
      const updated = store.updateRole(role.id, body)!;
      broadcastRoles(guildId);
      if (permissionsChanged) {
        await afterPermissionChange(ctx, before);
      }
      return updated;
    },
  );

  app.delete<{ Params: GuildParams & { id: string } }>(
    '/api/guilds/:guildId/roles/:id',
    { preHandler: manageRoles },
    async (req, reply) => {
      const { guildId } = req.params;
      const role = guildRole(guildId, req.params.id, reply);
      if (!role) return reply;
      if (role.id === guildId) return sendError(reply, 400, 'invalid_role', '@everyone rolü silinemez.');
      if (!permissions.roleIsBelow(guildId, req.user.id, role)) {
        return forbidden(reply, 'Yalnızca senin en üst rolünden aşağıdaki rolleri silebilirsin.');
      }
      const holders = store.listMembers(guildId).filter((m) => m.roles.includes(role.id));
      // Rolün kanal izinleri de silinir: o kanalları görmeye devam edenler güncel hâlini almalı
      const channels = store
        .listChannels(guildId)
        .filter((c) => c.overwrites.some((o) => o.roleId === role.id))
        .map((c) => c.id);
      const before = gateway.visibility();
      store.deleteRole(guildId, role.id);
      broadcastRoles(guildId);
      for (const member of holders) gateway.announceMember(guildId, member.userId);
      await afterPermissionChange(ctx, before, channels);
      return reply.code(204).send();
    },
  );

  // Rollerin sırası (yukarıdan aşağı). Yalnızca kendi en üst rolünün altındaki roller yer değiştirebilir
  // ve hiçbiri onun üstüne çıkamaz.
  app.put<{ Params: GuildParams }>('/api/guilds/:guildId/roles/order', { preHandler: manageRoles }, async (req, reply) => {
    const { guildId } = req.params;
    const body = parseBody(reorderSchema, req.body, reply);
    if (!body) return reply;
    const current = store.guildRoles(guildId).filter((r) => r.id !== guildId);
    const roles = new Map(current.map((r) => [r.id, r]));
    const ids = new Set(body.roleIds);
    if (ids.size !== body.roleIds.length || ids.size !== current.length || current.some((r) => !ids.has(r.id))) {
      return sendError(reply, 400, 'invalid_body', 'Sıralamada tüm roller birer kez bulunmalı.');
    }
    const highest = permissions.highest(guildId, req.user.id);
    for (const [i, id] of body.roleIds.entries()) {
      const role = roles.get(id)!;
      const position = body.roleIds.length - i;
      if (position !== role.position && (role.position >= highest || position >= highest)) {
        return forbidden(reply, 'Yalnızca senin en üst rolünden aşağıdaki rollerin sırası değişebilir.');
      }
    }
    store.setRoleOrder(guildId, body.roleIds);
    broadcastRoles(guildId);
    return allRoles(guildId);
  });

  // ---------- Üyelerin rolleri ----------

  const memberRole = async (
    params: GuildParams & { userId: string; roleId: string },
    actorId: string,
    add: boolean,
    reply: FastifyReply,
  ) => {
    const { guildId } = params;
    if (!permissions.isMember(guildId, params.userId)) return sendError(reply, 404, 'not_found', 'Üye bulunamadı.');
    const role = guildRole(guildId, params.roleId, reply);
    if (!role) return reply;
    const denied = canAssignRole(ctx, guildId, actorId, params.userId, role);
    if (denied) return forbidden(reply, denied);
    await setMemberRole(ctx, guildId, params.userId, role.id, add);
    return store.getMember(guildId, params.userId);
  };

  app.put<{ Params: GuildParams & { userId: string; roleId: string } }>(
    '/api/guilds/:guildId/members/:userId/roles/:roleId',
    { preHandler: manageRoles },
    async (req, reply) => memberRole(req.params, req.user.id, true, reply),
  );

  app.delete<{ Params: GuildParams & { userId: string; roleId: string } }>(
    '/api/guilds/:guildId/members/:userId/roles/:roleId',
    { preHandler: manageRoles },
    async (req, reply) => memberRole(req.params, req.user.id, false, reply),
  );
}
