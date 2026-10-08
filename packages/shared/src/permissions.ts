// Roller ve yetkiler (Discord modeli, küçük bir arkadaş grubuna göre sadeleştirilmiş).
// Hesaplama sunucuda ve istemcilerde aynı kodla yapılır: sunucu uygular, istemci yalnızca arayüzde
// yapılamayacak işleri gizler.

/**
 * Yetki bitleri. Değerler kalıcıdır (veritabanında ve istemcilerde saklanır); var olan bir bitin
 * anlamı değiştirilmez, yeni yetki yeni bit alır. 31 bitin altında kalınır (JS bit işlemleri 32 bit işaretli).
 */
export const Permission = {
  // Genel
  /** Her yetki; kanal izinlerini de aşar */
  ADMINISTRATOR: 1 << 0,
  /** Sunucunun adını ve simgesini değiştirmek */
  MANAGE_GUILD: 1 << 1,
  /** Kendinden aşağıdaki rolleri düzenlemek, üyelere vermek; kanal izinlerini düzenlemek */
  MANAGE_ROLES: 1 << 2,
  /** Kanal oluşturmak, düzenlemek, silmek */
  MANAGE_CHANNELS: 1 << 3,
  /** Herkesin oluşturduğu davetleri görmek ve silmek (davet oluşturmayı da kapsar; bkz. CREATE_INVITE) */
  MANAGE_INVITES: 1 << 4,
  KICK_MEMBERS: 1 << 5,
  BAN_MEMBERS: 1 << 6,
  // Metin
  VIEW_CHANNEL: 1 << 7,
  SEND_MESSAGES: 1 << 8,
  ATTACH_FILES: 1 << 9,
  /** Yeni tepki eklemek (var olan tepkiye katılmak her zaman serbest) */
  ADD_REACTIONS: 1 << 10,
  /** Başkalarının mesajlarını silmek */
  MANAGE_MESSAGES: 1 << 11,
  /** @everyone ile herkese, @here ile çevrimiçi olanlara bildirim göndermek */
  MENTION_EVERYONE: 1 << 12,
  // Ses
  CONNECT: 1 << 13,
  SPEAK: 1 << 14,
  /** Ekran paylaşmak */
  STREAM: 1 << 15,
  MUTE_MEMBERS: 1 << 16,
  DEAFEN_MEMBERS: 1 << 17,
  /** Üyeyi başka ses kanalına taşımak ya da sesten çıkarmak */
  MOVE_MEMBERS: 1 << 18,
  /** Sunucuya davet kodu oluşturmak (kendi davetlerini görmek ve silmek); tümünü yönetmek MANAGE_INVITES */
  CREATE_INVITE: 1 << 19,
  /**
   * Mesajları kanala sabitlemek ve sabitlemeyi kaldırmak (Discord'da MANAGE_MESSAGES'in parçasıydı; burada
   * ayrı bir yetki). Varsayılan olarak @everyone'da kapalıdır; göç 18 MANAGE_MESSAGES yetkili rollere verir.
   * Direkt mesajlarda her katılımcı sabitleyebilir.
   */
  PIN_MESSAGES: 1 << 20,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = (1 << 21) - 1;

/** Kanal izinleriyle değiştirilebilen metin kanalı yetkileri */
export const TEXT_CHANNEL_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.MANAGE_MESSAGES |
  Permission.PIN_MESSAGES |
  Permission.MENTION_EVERYONE;

/** Kanal izinleriyle değiştirilebilen ses kanalı yetkileri */
export const VOICE_CHANNEL_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM |
  Permission.MUTE_MEMBERS |
  Permission.DEAFEN_MEMBERS |
  Permission.MOVE_MEMBERS;

const VOICE_ONLY = VOICE_CHANNEL_PERMISSIONS & ~Permission.VIEW_CHANNEL;
const TEXT_ONLY = TEXT_CHANNEL_PERMISSIONS & ~Permission.VIEW_CHANNEL;

/**
 * @everyone rolünün varsayılan yetkileri: rollerden önce herkesin yapabildiği her şey (mesaj, dosya,
 * tepki, ses, ekran paylaşımı), @everyone bahsetmesi ve sunucuya davet oluşturmak.
 */
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.CREATE_INVITE |
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.MENTION_EVERYONE |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM;

export interface Role {
  /** @everyone rolünün kimliği topluluğun (guild) kimliğidir */
  id: string;
  name: string;
  /** "#rrggbb"; null: renksiz (ad varsayılan renkte görünür) */
  color: string | null;
  /** Sıra: büyük olan üsttedir. @everyone her zaman 0 */
  position: number;
  /** Üye listesinde ayrı grup olarak gösterilir */
  hoist: boolean;
  permissions: number;
}

/** Bir rolün bir kanaldaki izin değişikliği: allow bitleri verilir, deny bitleri alınır */
export interface PermissionOverwrite {
  roleId: string;
  allow: number;
  deny: number;
}

/** Yetki hesaplaması için topluluğun rolleri ve sahibi */
export interface PermissionContext {
  /** @everyone rolünün kimliği (= topluluk kimliği) */
  guildId: string;
  ownerId: string | null;
  roles: Readonly<Record<string, Role>>;
}

export const hasPermission = (permissions: number, flag: number): boolean => (permissions & flag) === flag;

/** Rol rengi için geçerli biçim */
export const ROLE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const ROLE_NAME_MAX_LENGTH = 32;
/** Topluluktaki en fazla rol sayısı (@everyone hariç) */
export const MAX_ROLES = 50;

/**
 * Sunucu genelindeki yetkiler: @everyone + üyenin rolleri. Sahip ve ADMINISTRATOR yetkisi olan her şeye
 * sahiptir.
 */
export function basePermissions(ctx: PermissionContext, userId: string, roleIds: readonly string[]): number {
  if (ctx.ownerId !== null && userId === ctx.ownerId) return ALL_PERMISSIONS;
  let permissions = ctx.roles[ctx.guildId]?.permissions ?? 0;
  for (const id of roleIds) permissions |= ctx.roles[id]?.permissions ?? 0;
  return hasPermission(permissions, Permission.ADMINISTRATOR) ? ALL_PERMISSIONS : permissions;
}

/**
 * Bir kanaldaki yetkiler (Discord sırası): temel yetkiler → @everyone kanal izni → üyenin rollerinin
 * kanal izinleri (izin verme, engellemeye üstün gelir). Sonra örtük kurallar: kanalı göremeyen hiçbir
 * şey yapamaz; mesaj gönderemeyen dosya ekleyemez, herkesten bahsedemez; bağlanamayan ses yetkilerini
 * kullanamaz.
 */
export function channelPermissions(
  ctx: PermissionContext,
  userId: string,
  roleIds: readonly string[],
  channel: { type: 'text' | 'voice'; overwrites?: readonly PermissionOverwrite[] },
): number {
  const base = basePermissions(ctx, userId, roleIds);
  if (hasPermission(base, Permission.ADMINISTRATOR)) return ALL_PERMISSIONS;

  let permissions = base;
  const overwrites = channel.overwrites ?? [];
  const everyone = overwrites.find((o) => o.roleId === ctx.guildId);
  if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
  let allow = 0;
  let deny = 0;
  for (const o of overwrites) {
    if (o.roleId !== ctx.guildId && roleIds.includes(o.roleId)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  permissions = (permissions & ~deny) | allow;

  if (!hasPermission(permissions, Permission.VIEW_CHANNEL)) return 0;
  if (channel.type === 'text') {
    permissions &= ~VOICE_ONLY;
    if (!hasPermission(permissions, Permission.SEND_MESSAGES)) {
      permissions &= ~(Permission.ATTACH_FILES | Permission.MENTION_EVERYONE);
    }
  } else {
    permissions &= ~TEXT_ONLY;
    if (!hasPermission(permissions, Permission.CONNECT)) permissions &= ~VOICE_ONLY;
  }
  return permissions;
}

/**
 * Direkt mesaj katılımcılarının yetkileri (başkalarının mesajlarını silmek ve @everyone yok). Her katılımcı
 * mesaj sabitleyebilir (Discord gibi). Sesli arama ve ekran paylaşımı da her katılımcıya açıktır (sunucuda
 * susturma DM'de yoktur); salt okunur konuşmada (bkz. dmPermissions) arama da yapılamaz.
 */
export const DM_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.PIN_MESSAGES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM;

/**
 * Direkt mesaj konuşmasındaki yetkiler. Roller, kanal izinleri, sahiplik ve ADMINISTRATOR uygulanmaz:
 * katılımcı olmayan (yönetici de olsa) hiçbir şey göremez. Üye olmayan (atılan/yasaklanan) katılımcının
 * yetkisi yoktur. Bire bir konuşma salt okunur olur (geçmiş okunur; mesaj, tepki, arama yok): karşı tarafa
 * artık ulaşılamıyorsa (`isMember`: ortak sunucu ya da arkadaşlık kalmadı, ya da hesabı silindi), iki taraftan biri diğerini engellediyse (`isBlocked`: iki
 * yönden biri) ya da sunucu konuşmayı salt okunur bildirdiyse (`readOnly`; engelin yönü söylenmez). Engel
 * grup konuşmalarını etkilemez.
 */
export function dmPermissions(
  dm: { participantIds: readonly string[]; group: boolean; readOnly?: boolean },
  userId: string,
  isMember: (userId: string) => boolean,
  isBlocked?: (otherId: string) => boolean,
): number {
  if (!dm.participantIds.includes(userId) || !isMember(userId)) return 0;
  if (!dm.group) {
    const others = dm.participantIds.filter((id) => id !== userId);
    if (dm.readOnly === true || !others.some((id) => isMember(id)) || (isBlocked && others.some((id) => isBlocked(id)))) {
      return Permission.VIEW_CHANNEL;
    }
  }
  return DM_PERMISSIONS;
}

/** Kullanıcının en üstteki rolünün sırası; sahip herkesin üstündedir (sonsuz), rolü yoksa 0 */
export function highestRolePosition(ctx: PermissionContext, userId: string, roleIds: readonly string[]): number {
  if (ctx.ownerId !== null && userId === ctx.ownerId) return Number.POSITIVE_INFINITY;
  let highest = 0;
  for (const id of roleIds) highest = Math.max(highest, ctx.roles[id]?.position ?? 0);
  return highest;
}

/**
 * Hiyerarşi: `actor`, `target` üyeyi yönetebilir mi (at, yasakla, rol ver, sesten çıkar…). Sahip
 * herkesi yönetir, sahibi kimse yönetemez; diğerlerinde en üst rolü daha yukarıda olan yönetir. Kişi
 * kendini bu yolla yönetemez.
 */
export function outranks(
  ctx: PermissionContext,
  actor: { id: string; roles: readonly string[] },
  target: { id: string; roles: readonly string[] },
): boolean {
  if (actor.id === target.id) return false;
  if (ctx.ownerId !== null && target.id === ctx.ownerId) return false;
  return highestRolePosition(ctx, actor.id, actor.roles) > highestRolePosition(ctx, target.id, target.roles);
}

/** Hiyerarşi: rol, kullanıcının en üst rolünün altındaysa düzenleyebilir/verebilir (sahip hepsini) */
export function roleIsBelow(
  ctx: PermissionContext,
  actor: { id: string; roles: readonly string[] },
  role: Pick<Role, 'position'>,
): boolean {
  return role.position < highestRolePosition(ctx, actor.id, actor.roles);
}

/** Roller yukarıdan aşağı (listede gösterilen sıra); @everyone en sonda */
export function sortRoles<T extends Pick<Role, 'position' | 'id'>>(roles: Iterable<T>): T[] {
  return [...roles].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
}

/** Kullanıcının adının rengi: renkli rollerinden en üsttekinin rengi (yoksa null) */
export function memberColor(ctx: PermissionContext, roleIds: readonly string[]): string | null {
  let best: Role | null = null;
  for (const id of roleIds) {
    const role = ctx.roles[id];
    if (role?.color && (!best || role.position > best.position)) best = role;
  }
  return best?.color ?? null;
}

/** Üye listesinde üyenin gösterildiği grup: ayrı gösterilen rollerinden en üstteki (yoksa null) */
export function hoistedRole(ctx: PermissionContext, roleIds: readonly string[]): Role | null {
  let best: Role | null = null;
  for (const id of roleIds) {
    const role = ctx.roles[id];
    if (role?.hoist && (!best || role.position > best.position)) best = role;
  }
  return best;
}
