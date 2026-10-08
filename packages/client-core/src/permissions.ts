import {
  ALL_PERMISSIONS,
  basePermissions,
  channelPermissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  dmPermissions,
  hasPermission,
  hoistedRole,
  memberColor,
  outranks,
  Permission,
  roleIsBelow,
  sortRoles,
  type PermissionContext,
  type PermissionOverwrite,
  type Role,
  type User,
} from '@diskort/shared';
import { useGuild, type GuildState, type GuildStore } from './guild';
import { PERMISSION_GROUPS, type PermissionInfo } from './permissionInfo';
import { useSession } from './session';

// Yetkiler sunucudakiyle aynı kodla hesaplanır (@diskort/shared). İstemci bunları yalnızca yapılamayacak
// işleri gizlemek/kapatmak için kullanır; asıl denetim sunucudadır.

type PermissionState = Pick<GuildStore, 'guild' | 'roles' | 'users' | 'channels'> &
  Partial<Pick<GuildStore, 'dms' | 'guilds' | 'channelGuild' | 'reachable' | 'blockedIds'>>;

let cached: { guild: GuildStore['guild']; roles: GuildStore['roles']; ctx: PermissionContext } | null = null;

/** Yetki hesaplaması için bağlam (aynı durum için aynı nesne) */
export function permissionContext(s: Pick<GuildStore, 'guild' | 'roles'>): PermissionContext {
  if (cached && cached.guild === s.guild && cached.roles === s.roles) return cached.ctx;
  const ctx: PermissionContext = { guildId: s.guild?.id ?? '', ownerId: s.guild?.ownerId ?? null, roles: s.roles };
  cached = { guild: s.guild, roles: s.roles, ctx };
  return ctx;
}

export const rolesOf = (s: Pick<GuildStore, 'users'>, userId: string): readonly string[] => s.users[userId]?.roles ?? [];

const guildContexts = new WeakMap<Record<string, Role>, PermissionContext>();

/** Seçili olmayan bir sunucunun yetki bağlamı (aynı roller için aynı nesne) */
function contextOf(g: GuildState): PermissionContext {
  const cachedCtx = guildContexts.get(g.roles);
  if (cachedCtx && cachedCtx.guildId === g.guild.id && cachedCtx.ownerId === g.guild.ownerId) return cachedCtx;
  const ctx: PermissionContext = { guildId: g.guild.id, ownerId: g.guild.ownerId, roles: g.roles };
  guildContexts.set(g.roles, ctx);
  return ctx;
}

/** Bir sunucudaki yetkiler (seçili olmasa da): kanal verilirse o kanalda, verilmezse sunucu genelinde */
export function permissionsInGuild(g: GuildState | undefined, userId: string | undefined, channelId?: string): number {
  if (!g || !userId) return 0;
  const member = g.members[userId];
  if (!member || member.removed) return 0;
  const ctx = contextOf(g);
  if (channelId === undefined) return basePermissions(ctx, userId, member.roles);
  const channel = g.channels.find((c) => c.id === channelId);
  return channel ? channelPermissions(ctx, userId, member.roles, channel) : 0;
}

/** Sunucu rolleri göndermiyorsa (çok eski sunucu) yöneticilik bayrağına göre tahmin */
function legacyPermissions(s: PermissionState, userId: string): number {
  return s.users[userId]?.isAdmin ? ALL_PERMISSIONS : DEFAULT_EVERYONE_PERMISSIONS;
}

/**
 * Kullanıcının yetkileri: kanal verilirse o kanalda (kanal görünmüyorsa 0), verilmezse sunucu genelinde.
 * Direkt mesaj konuşmasında roller uygulanmaz: katılımcıların sabit yetkileri (bkz. dmPermissions).
 */
export function permissionsOf(s: PermissionState, userId: string | undefined, channelId?: string): number {
  if (!userId) return 0;
  if (channelId !== undefined) {
    const dm = s.dms?.[channelId];
    // Bire bir konuşmada karşı tarafla ortak sunucu ve arkadaşlık kalmadıysa ya da engel varsa (kendi engelin ya da sunucunun
    // bildirdiği salt okunur durum) yazılamaz, aranamaz. Arama yetkisi (CONNECT/SPEAK/STREAM) buradan okunur.
    if (dm) {
      return dmPermissions(
        dm,
        userId,
        (id) => id === userId || (s.reachable ? Boolean(s.reachable[id]) : s.users[id]?.removed === false),
        (id) => Boolean(s.blockedIds?.[id]),
      );
    }
    // Seçili olmayan bir sunucunun kanalı (ör. bağlı olunan ses kanalı): o sunucunun verisiyle
    const guildId = s.channelGuild?.[channelId];
    if (guildId && guildId !== s.guild?.id && s.guilds) return permissionsInGuild(s.guilds[guildId], userId, channelId);
  }
  if (!s.guild) return 0;
  const user = s.users[userId];
  if (user?.removed) return 0;
  const channel = channelId === undefined ? undefined : s.channels.find((c) => c.id === channelId);
  if (channelId !== undefined && !channel) return 0;
  if (Object.keys(s.roles).length === 0) return legacyPermissions(s, userId);
  const ctx = permissionContext(s);
  const roles = rolesOf(s, userId);
  return channel ? channelPermissions(ctx, userId, roles, channel) : basePermissions(ctx, userId, roles);
}

export function can(s: PermissionState, userId: string | undefined, flag: number, channelId?: string): boolean {
  return hasPermission(permissionsOf(s, userId, channelId), flag);
}

/** Oturumdaki kullanıcının yetkileri (değişince yeniden çizer) */
export function usePermissions(channelId?: string): number {
  const selfId = useSession((s) => s.user?.id);
  return useGuild((s) => permissionsOf(s, selfId, channelId));
}

/** Oturumdaki kullanıcının bu yetkisi var mı (kanal verilirse o kanalda) */
export function useCan(flag: number, channelId?: string): boolean {
  const selfId = useSession((s) => s.user?.id);
  return useGuild((s) => can(s, selfId, flag, channelId));
}

export function isOwner(s: Pick<GuildStore, 'guild'>, userId: string | undefined): boolean {
  return userId !== undefined && s.guild?.ownerId === userId;
}

/** Hiyerarşi: actor, target üyeyi yönetebilir mi (sahip herkesi; kimse sahibi ve kendini değil) */
export function outranksUser(s: PermissionState, actorId: string | undefined, targetId: string): boolean {
  if (!actorId) return false;
  return outranks(permissionContext(s), { id: actorId, roles: rolesOf(s, actorId) }, { id: targetId, roles: rolesOf(s, targetId) });
}

/** Hiyerarşi: rol, kullanıcının en üst rolünün altında mı (sahip için hepsi) */
export function roleIsBelowFor(s: PermissionState, actorId: string | undefined, role: Pick<Role, 'position'>): boolean {
  if (!actorId) return false;
  return roleIsBelow(permissionContext(s), { id: actorId, roles: rolesOf(s, actorId) }, role);
}

/** Rolü düzenleyebilir/verebilir mi: MANAGE_ROLES ve rol kendi en üst rolünün altında */
export function canManageRole(s: PermissionState, actorId: string | undefined, role: Pick<Role, 'position'>): boolean {
  return can(s, actorId, Permission.MANAGE_ROLES) && roleIsBelowFor(s, actorId, role);
}

/**
 * Üyeye bu rolü verip alabilir mi (sunucudaki kuralla aynı): rol yönetilebilir, üye kendisi ya da
 * kendisinden aşağıda, rolde actor'ün sahip olmadığı yetki yok.
 */
export function canAssignRole(s: PermissionState, actorId: string | undefined, targetId: string, role: Role): boolean {
  if (!actorId || !s.guild || role.id === s.guild.id || !canManageRole(s, actorId, role)) return false;
  if (targetId !== actorId && !outranksUser(s, actorId, targetId)) return false;
  return (role.permissions & ~permissionsOf(s, actorId)) === 0;
}

/** Roller yukarıdan aşağı (@everyone en sonda) */
export function sortedRoles(s: Pick<GuildStore, 'roles'>): Role[] {
  return sortRoles(Object.values(s.roles));
}

/** Kullanıcının adının rengi: renkli rollerinden en üsttekinin rengi */
export function memberColorOf(s: Pick<GuildStore, 'guild' | 'roles' | 'users'>, userId: string | null | undefined): string | null {
  if (!userId) return null;
  return memberColor(permissionContext(s), rolesOf(s, userId));
}

/** Kullanıcının adının rengi (rol rengi yoksa null: varsayılan renk kullanılır) */
export function useMemberColor(userId: string | null | undefined): string | null {
  return useGuild((s) => memberColorOf(s, userId));
}

export interface MemberGroup {
  /** Rol kimliği ya da 'online' / 'offline' */
  id: string;
  title: string;
  members: User[];
}

/**
 * Üye listesi (Discord gibi): çevrimiçi üyeler ayrı gösterilen en üst rollerine göre gruplanır, kalan
 * çevrimiçiler "Çevrimiçi", diğerleri "Çevrimdışı" grubundadır. Boş gruplar yoktur.
 */
export function memberGroups(s: Pick<GuildStore, 'guild' | 'roles' | 'users' | 'online'>): MemberGroup[] {
  const ctx = permissionContext(s);
  const byName = (a: User, b: User): number => a.displayName.localeCompare(b.displayName, 'tr');
  const hoisted = new Map<string, User[]>();
  const online: User[] = [];
  const offline: User[] = [];
  for (const user of Object.values(s.users)) {
    if (user.removed) continue;
    if (!s.online[user.id]) {
      offline.push(user);
      continue;
    }
    const role = hoistedRole(ctx, user.roles ?? []);
    if (!role) online.push(user);
    else hoisted.set(role.id, [...(hoisted.get(role.id) ?? []), user]);
  }
  const groups: MemberGroup[] = sortRoles(Object.values(s.roles))
    .filter((r) => hoisted.has(r.id))
    .map((r) => ({ id: r.id, title: r.name, members: hoisted.get(r.id)!.sort(byName) }));
  if (online.length) groups.push({ id: 'online', title: 'Çevrimiçi', members: online.sort(byName) });
  if (offline.length) groups.push({ id: 'offline', title: 'Çevrimdışı', members: offline.sort(byName) });
  return groups;
}

/**
 * Kanal panelinin üye listesi: memberGroups gibi, ama yalnızca kanalı görebilen üyeler (Discord gibi;
 * özel kanalda rolü/izni olmayanlar listelenmez). Sonuç yalnızca gösterim içindir.
 */
export function channelMemberGroups(
  s: Pick<GuildStore, 'guild' | 'roles' | 'users' | 'online' | 'channels'>,
  channelId: string,
): MemberGroup[] {
  const users: GuildStore['users'] = {};
  for (const user of Object.values(s.users)) {
    if (can(s, user.id, Permission.VIEW_CHANNEL, channelId)) users[user.id] = user;
  }
  return memberGroups({ ...s, users });
}

// ---------- Rol düzenleme ve etkin yetkiler ----------

/**
 * Rol düzenleme ekranında bir yetkinin bu rol için anlamı. Yetkiler birleşir (Discord gibi: @everyone +
 * üyenin rolleri); bu yüzden bir rolde kapatmak, yetkiyi başka yerden alanları kısıtlamaz:
 * - 'administrator': rolde Yönetici açık, diğer her yetki zaten var;
 * - 'everyone': @everyone rolünde açık, herkeste zaten var (kısıtlamak için @everyone'da kapatılmalı);
 * - 'role': rolün kendi ayarı geçerli.
 * @everyone rolünün kendisi için her zaman 'role'.
 */
export type RolePermissionSource = 'role' | 'administrator' | 'everyone';

export function rolePermissionSource(
  role: { permissions: number; isEveryone: boolean },
  everyonePermissions: number,
  flag: number,
): RolePermissionSource {
  if (role.isEveryone) return 'role';
  if (flag !== Permission.ADMINISTRATOR && hasPermission(role.permissions, Permission.ADMINISTRATOR)) {
    return 'administrator';
  }
  if (hasPermission(everyonePermissions, flag) || hasPermission(everyonePermissions, Permission.ADMINISTRATOR)) {
    return 'everyone';
  }
  return 'role';
}

/** Üyenin bir yetkisi ve onu veren roller (@everyone dahil, yukarıdan aşağı) */
export interface PermissionGrant {
  info: PermissionInfo;
  roles: Role[];
}

export interface EffectivePermissions {
  /**
   * Her yetkiye sahip ve kanal izinlerinden etkilenmez: 'owner' sunucunun sahibi, 'administrator' Yönetici
   * yetkili bir rolü (ya da @everyone'da Yönetici) var. null: yalnızca `granted` içindekiler.
   */
  all: 'owner' | 'administrator' | null;
  /** Rollerinden gelen yetkiler, rol ekranındaki sırayla (kanal izinleri hesaba katılmaz) */
  granted: PermissionGrant[];
}

const NO_GRANTS: EffectivePermissions = { all: null, granted: [] };

/** Üyenin sunucu genelindeki etkin yetkileri ve her birinin kaynağı (üye yönetiminde gösterilir) */
export function effectivePermissions(
  s: Pick<GuildStore, 'guild' | 'roles' | 'users'>,
  userId: string,
): EffectivePermissions {
  const user = s.users[userId];
  if (!s.guild || !user || user.removed) return NO_GRANTS;
  const everyone = s.roles[s.guild.id];
  const held = sortRoles(
    [...rolesOf(s, userId).map((id) => s.roles[id]), everyone].filter((r): r is Role => r !== undefined),
  );
  const granted = PERMISSION_GROUPS.flatMap((g) => g.permissions)
    .map((info) => ({ info, roles: held.filter((r) => hasPermission(r.permissions, info.flag)) }))
    .filter((g) => g.roles.length > 0);
  const all = isOwner(s, userId)
    ? 'owner'
    : granted.some((g) => g.info.flag === Permission.ADMINISTRATOR)
      ? 'administrator'
      : null;
  return { all, granted };
}

// ---------- Kanal izinleri (düzenleme ekranı) ----------

/** Bir rolün kanaldaki bir yetki için durumu: izin ver / varsayılan (rolden gelir) / engelle */
export type OverwriteState = 'allow' | 'inherit' | 'deny';

export function overwriteState(overwrite: Pick<PermissionOverwrite, 'allow' | 'deny'> | undefined, flag: number): OverwriteState {
  if (!overwrite) return 'inherit';
  if (hasPermission(overwrite.allow, flag)) return 'allow';
  if (hasPermission(overwrite.deny, flag)) return 'deny';
  return 'inherit';
}

/** Kanal izinleri listesinde bir rolün bir yetkisini değiştirir (boşalan izin listeden çıkar) */
export function setOverwriteState(
  overwrites: readonly PermissionOverwrite[],
  roleId: string,
  flag: number,
  state: OverwriteState,
): PermissionOverwrite[] {
  const current = overwrites.find((o) => o.roleId === roleId) ?? { roleId, allow: 0, deny: 0 };
  const next: PermissionOverwrite = {
    roleId,
    allow: state === 'allow' ? current.allow | flag : current.allow & ~flag,
    deny: state === 'deny' ? current.deny | flag : current.deny & ~flag,
  };
  const rest = overwrites.filter((o) => o.roleId !== roleId);
  return next.allow === 0 && next.deny === 0 ? rest : [...rest, next];
}
