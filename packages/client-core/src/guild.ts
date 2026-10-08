import { create } from 'zustand';
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  sameActivities,
  type Channel,
  type DmCall,
  type DmChannel,
  type FriendsList,
  type GatewayServerMessage,
  type Guild,
  type GuildCreatePayload,
  type GuildData,
  type GuildMember,
  type Presence,
  type ReadyPayload,
  type SelfStatus,
  type Role,
  type User,
  type VoiceState,
} from '@diskort/shared';
import { env } from './env';

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting';

/**
 * Seçili sunucudaki hâliyle kullanıcı: profil + o sunucudaki rolleri. `removed`: seçili sunucunun
 * (şu anki) üyesi değil (eski üye, başka sunuculardan ya da DM'den tanınan kişi).
 */
export type MemberUser = User & { roles: string[]; removed: boolean };

/** Üye olunan bir sunucunun istemcideki durumu */
export interface GuildState {
  guild: Guild;
  /** Görülebilen kanallar, sıralı */
  channels: Channel[];
  /** @everyone dahil roller (@everyone'ın kimliği sunucu kimliğidir) */
  roles: Record<string, Role>;
  /** Üyeler; eski üyeler `removed` */
  members: Record<string, GuildMember>;
}

export interface GuildStore {
  status: GatewayStatus;
  /** Üye olunan sunucular */
  guilds: Record<string, GuildState>;
  /** Sunucuların sol çubuktaki sırası (katılma sırası) */
  guildOrder: string[];
  /** Kanal → sunucusu (görülebilen kanallar) */
  channelGuild: Record<string, string>;
  /** Tanınan hesapların profilleri (ortak sunucular, eski üyeler, DM'ler) */
  profiles: Record<string, User>;
  /** Ortak sunucusu olan kişiler ve arkadaşlar (bire bir DM'e yalnızca onlara yazılabilir, gruba onlar eklenir) */
  reachable: Record<string, true>;
  /** Ana sunucu (ilk kurulan; silinemez) */
  primaryGuildId: string | null;
  /**
   * Seçili sunucu. `guild`, `channels`, `roles` ve `users` onun görünümüdür; seçim değişince (ya da o
   * sunucu değişince) yeniden hesaplanır. Hiç sunucu yoksa null.
   */
  activeGuildId: string | null;
  guild: Guild | null;
  /** Seçili sunucuda görülebilen kanallar (sunucu süzer); direkt mesajlar burada değil */
  channels: Channel[];
  /** Listede açık direkt mesaj konuşmaları (kimlik → konuşma); DM'leri tanımayan sunucuda boş */
  dms: Record<string, DmChannel>;
  /**
   * Konuşmalarda süren sesli aramalar (konuşma kimliği → arama). Kimin seste olduğu voiceStates'tedir
   * (channelId = konuşmanın kimliği). Aramaları tanımayan eski sunucuda boş.
   */
  dmCalls: Record<string, DmCall>;
  /** Engellediğin kişiler (yalnızca kendi listen; seni engelleyenler bilinmez) */
  blockedIds: Record<string, true>;
  /** Arkadaşlar ve bekleyen istekler (READY, FRIENDS_UPDATE, REST yanıtları); arkadaşları tanımayan sunucuda boş */
  friends: FriendsList;
  /** Arkadaşların kimlikleri (friends.friends'ten) */
  friendIds: Record<string, true>;
  /**
   * Tanınan tüm hesaplar, seçili sunucudaki rolleriyle (mesajlarda adları görünsün diye eski üyeler ve
   * başka sunuculardakiler de); üye listesinde `removed` olanlar gösterilmez
   */
  users: Record<string, MemberUser>;
  /** Seçili sunucunun rolleri */
  roles: Record<string, Role>;
  voiceStates: Record<string, VoiceState>;
  /** Çevrimiçi görünenler (görünmezler hariç) */
  online: Record<string, true>;
  /**
   * Çevrimiçi görünenlerin durumu ve özel durumu (kişi başına nesne değişmedikçe aynı kalır). Eski sunucuda
   * herkes 'online'dır. Kendi kaydın da buradadır (görünmezsen yok; bkz. selfStatus).
   */
  presences: Record<string, Presence>;
  /** Kendi durum ayarların (eski sunucuda null) */
  selfStatus: SelfStatus | null;
  /** Metin kanalı ya da DM → en son mesaj kimliği */
  lastMessageIds: Record<string, string>;
  /** Metin kanalı ya da DM → bu kullanıcının okuduğu son mesaj */
  readStates: Record<string, string>;
  /** Sunucunun kabul ettiği en büyük dosya (bayt) */
  attachmentMaxBytes: number;
  /** Sunucu seçer (null: hiçbiri); seçim cihazda hatırlanır */
  selectGuild: (id: string | null) => void;
  markRead: (channelId: string, messageId: string) => void;
  setLastMessageId: (channelId: string, messageId: string | null) => void;
  /** REST yanıtıyla gelen konuşmayı hemen listeye koyar (gateway olayı da gelir; tekrar zararsız) */
  upsertDm: (dm: DmChannel) => void;
  removeDm: (id: string) => void;
  /** Engel listesini hemen günceller (REST yanıtından; USER_BLOCKS_UPDATE da gelir) */
  setBlocked: (userId: string, blocked: boolean) => void;
  /** Arkadaş listesini hemen günceller (REST yanıtından; FRIENDS_UPDATE da gelir, tekrar zararsız) */
  setFriends: (list: FriendsList) => void;
  /** Çalan aramayı bu cihazda hemen susturur (reddet; sunucu DM_CALL_UPDATE ile de bildirir) */
  stopRingingLocally: (channelId: string, userId: string) => void;
  setStatus: (status: GatewayStatus) => void;
  setReady: (payload: ReadyPayload) => void;
  apply: (msg: GatewayServerMessage) => void;
  reset: () => void;
}

const sortChannels = (channels: Channel[]): Channel[] =>
  [...channels].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'tr'));

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

const toGuildState = (d: GuildData): GuildState => ({
  guild: d.guild,
  channels: sortChannels(d.channels),
  roles: byId(d.roles),
  members: Object.fromEntries(d.members.map((m) => [m.userId, m])),
});

/** Seçili sunucuyu cihazda hatırlamak için anahtar */
const ACTIVE_GUILD_KEY = 'diskort-active-guild';

/** Hatırlanan seçim (depolama mobilde eşzamansız: bağlanırken okunur, bkz. restoreActiveGuild) */
let remembered: string | null = null;
/** Seçilmek istenen ama henüz gelmemiş sunucu */
let pendingSelect: string | null = null;

/** Hatırlanan sunucu seçimini okur; READY'den sonra gelirse ve o sunucu varsa seçer. */
export function restoreActiveGuild(): void {
  let value: string | null | Promise<string | null>;
  try {
    value = env().storage.getItem(ACTIVE_GUILD_KEY);
  } catch {
    return;
  }
  const apply = (id: string | null): void => {
    remembered = id;
    const s = useGuild.getState();
    // Bağlantı hazırsa ve kullanıcı henüz başka seçim yapmadıysa (ilk sunucu kendiliğinden seçildi)
    if (id && s.status === 'ready' && s.guilds[id] && s.activeGuildId === s.guildOrder[0]) s.selectGuild(id);
  };
  if (value instanceof Promise) value.then(apply, () => undefined);
  else apply(value);
}

function rememberGuild(id: string | null): void {
  remembered = id ?? remembered;
  try {
    if (id) env().storage.setItem(ACTIVE_GUILD_KEY, id);
  } catch {
    // depolama kullanılamıyor
  }
}

type Core = Pick<GuildStore, 'guilds' | 'guildOrder' | 'profiles' | 'activeGuildId'>;
type Derived = Pick<GuildStore, 'guild' | 'channels' | 'roles' | 'users' | 'reachable' | 'channelGuild'>;

const NO_ROLES: Record<string, Role> = {};
const NO_CHANNELS: Channel[] = [];

/** Kanal → sunucu haritası */
function channelIndex(guilds: Record<string, GuildState>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const g of Object.values(guilds)) for (const c of g.channels) index[c.id] = g.guild.id;
  return index;
}

/** Ortak sunucusu olanlar ve arkadaşlar */
function reachableOf(guilds: Record<string, GuildState>, friendIds: Record<string, true>): Record<string, true> {
  const result: Record<string, true> = { ...friendIds };
  for (const g of Object.values(guilds)) {
    for (const m of Object.values(g.members)) if (!m.removed) result[m.userId] = true;
  }
  return result;
}

/** Profiller + seçili sunucudaki roller */
function usersOf(profiles: Record<string, User>, active: GuildState | undefined): Record<string, MemberUser> {
  const users: Record<string, MemberUser> = {};
  for (const p of Object.values(profiles)) {
    const member = active?.members[p.id];
    users[p.id] = { ...p, roles: member && !member.removed ? member.roles : [], removed: !member || member.removed };
  }
  return users;
}

/**
 * Seçili sunucunun görünümünü yeniden hesaplar. Değişmeyen parçalar aynı nesne kalır (seçiciler gereksiz
 * yere yeniden çizmesin). `touched`: hangi parçaların değişmiş olabileceği.
 */
function derive(
  prev: GuildStore,
  next: Core,
  touched: { members?: boolean; channels?: boolean; profiles?: boolean } = {},
  friendIds: Record<string, true> = prev.friendIds,
): Core & Derived {
  const active = next.activeGuildId ? next.guilds[next.activeGuildId] : undefined;
  const prevActive = prev.activeGuildId ? prev.guilds[prev.activeGuildId] : undefined;
  const switched = next.activeGuildId !== prev.activeGuildId;
  const usersStale = switched || touched.profiles || prevActive?.members !== active?.members;
  return {
    ...next,
    guild: active?.guild ?? null,
    channels: active?.channels ?? NO_CHANNELS,
    roles: active?.roles ?? NO_ROLES,
    users: usersStale ? usersOf(next.profiles, active) : prev.users,
    reachable: touched.members || friendIds !== prev.friendIds ? reachableOf(next.guilds, friendIds) : prev.reachable,
    channelGuild: touched.channels ? channelIndex(next.guilds) : prev.channelGuild,
  };
}

/** Seçili sunucu geçersizse (ayrıldın, sunucu silindi) başkasını seçer */
function validActive(guilds: Record<string, GuildState>, order: string[], wanted: string | null): string | null {
  if (wanted && guilds[wanted]) return wanted;
  return order[0] ?? null;
}

const EMPTY_FRIENDS: FriendsList = { friends: [], incoming: [], outgoing: [] };

/** Arkadaşların kimlikleri */
const friendIdsOf = (list: FriendsList): Record<string, true> =>
  Object.fromEntries(list.friends.map((f) => [f.userId, true as const]));

/** Arkadaş listesinin değişmesi: kimlikler, ulaşılabilenler ve listedeki profiller (tanınan hesaplara eklenir) */
function applyFriends(s: GuildStore, friends: FriendsList): Partial<GuildStore> {
  const friendIds = friendIdsOf(friends);
  const profiles = { ...s.profiles };
  for (const e of [...friends.friends, ...friends.incoming, ...friends.outgoing]) profiles[e.userId] = e.user;
  return {
    ...derive(
      s,
      { guilds: s.guilds, guildOrder: s.guildOrder, profiles, activeGuildId: s.activeGuildId },
      { profiles: true },
      friendIds,
    ),
    friends,
    friendIds,
  };
}

/** Listeden bir kişiyi (hesabı silindi) çıkarır; listede yoksa aynı nesne */
function withoutFriend(list: FriendsList, userId: string): FriendsList {
  const has = (l: FriendsList['friends']) => l.some((e) => e.userId === userId);
  if (!has(list.friends) && !has(list.incoming) && !has(list.outgoing)) return list;
  const drop = (l: FriendsList['friends']) => l.filter((e) => e.userId !== userId);
  return { friends: drop(list.friends), incoming: drop(list.incoming), outgoing: drop(list.outgoing) };
}

const initial = {
  status: 'idle' as GatewayStatus,
  guilds: {},
  guildOrder: [],
  channelGuild: {},
  profiles: {},
  reachable: {},
  primaryGuildId: null,
  activeGuildId: null,
  guild: null,
  channels: [],
  dms: {},
  dmCalls: {},
  blockedIds: {},
  friends: EMPTY_FRIENDS,
  friendIds: {},
  users: {},
  roles: {},
  voiceStates: {},
  online: {},
  presences: {},
  selfStatus: null,
  lastMessageIds: {},
  readStates: {},
  attachmentMaxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
};

/** Bir sunucunun kanallarındaki ses durumlarını çıkarır */
function withoutChannels(voiceStates: Record<string, VoiceState>, channelIds: Set<string>): Record<string, VoiceState> {
  if (!Object.values(voiceStates).some((v) => channelIds.has(v.channelId))) return voiceStates;
  return Object.fromEntries(Object.entries(voiceStates).filter(([, v]) => !channelIds.has(v.channelId)));
}

/** Sunucunun durumunu değiştirir (yoksa bir şey yapmaz) */
function updateGuild(
  s: GuildStore,
  guildId: string,
  fn: (g: GuildState) => GuildState,
  touched: { members?: boolean; channels?: boolean } = {},
): Partial<GuildStore> {
  const current = s.guilds[guildId];
  if (!current) return {};
  const guilds = { ...s.guilds, [guildId]: fn(current) };
  return derive(s, { guilds, guildOrder: s.guildOrder, profiles: s.profiles, activeGuildId: s.activeGuildId }, touched);
}

/** Gateway'den gelen durum: sunucular, kanallar, kullanıcılar, roller, kim hangi ses kanalında. */
export const useGuild = create<GuildStore>()((set) => ({
  ...initial,
  selectGuild: (id) =>
    set((s) => {
      // Henüz gelmemiş sunucu (davetle katılındı, GUILD_CREATE bekleniyor): gelince seçilir
      if (id && !s.guilds[id]) {
        pendingSelect = id;
        return {};
      }
      pendingSelect = null;
      const activeGuildId = id;
      if (activeGuildId === s.activeGuildId) return {};
      rememberGuild(activeGuildId);
      return derive(s, { guilds: s.guilds, guildOrder: s.guildOrder, profiles: s.profiles, activeGuildId });
    }),
  setStatus: (status) => set({ status }),
  setReady: (p) =>
    set((s) => {
      const guilds = Object.fromEntries(p.guilds.map((g) => [g.guild.id, toGuildState(g)]));
      const guildOrder = p.guilds.map((g) => g.guild.id);
      const activeGuildId = validActive(guilds, guildOrder, s.activeGuildId ?? remembered);
      const friends = p.friends ?? EMPTY_FRIENDS;
      const friendIds = friendIdsOf(friends);
      const profiles = byId(p.users);
      // Listedeki profiller (bekleyen istekler READY'nin users'ında olmayabilir)
      for (const e of [...friends.friends, ...friends.incoming, ...friends.outgoing]) profiles[e.userId] ??= e.user;
      const core: Core = { guilds, guildOrder, profiles, activeGuildId };
      return {
        ...derive({ ...s, activeGuildId: null }, core, { members: true, channels: true, profiles: true }, friendIds),
        friends,
        friendIds,
        status: 'ready',
        primaryGuildId: p.primaryGuildId ?? null,
        dms: byId(p.dms ?? []),
        dmCalls: Object.fromEntries((p.dmCalls ?? []).map((c) => [c.channelId, c])),
        blockedIds: Object.fromEntries((p.blockedUserIds ?? []).map((id) => [id, true as const])),
        voiceStates: Object.fromEntries(p.voiceStates.map((v) => [v.userId, v])),
        online: Object.fromEntries(p.online.map((id) => [id, true as const])),
        presences: presencesOf(p.online, p.presences),
        selfStatus: p.status ?? null,
        lastMessageIds: p.lastMessageIds,
        readStates: p.readStates,
        attachmentMaxBytes: p.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
      };
    }),
  markRead: (channelId, messageId) =>
    set((s) =>
      Number(messageId) > Number(s.readStates[channelId] ?? 0)
        ? { readStates: { ...s.readStates, [channelId]: messageId } }
        : {},
    ),
  setLastMessageId: (channelId, messageId) =>
    set((s) => {
      const lastMessageIds = { ...s.lastMessageIds };
      if (messageId) lastMessageIds[channelId] = messageId;
      else delete lastMessageIds[channelId];
      return { lastMessageIds };
    }),
  upsertDm: (dm) => set((s) => ({ dms: { ...s.dms, [dm.id]: dm } })),
  removeDm: (id) =>
    set((s) => {
      if (!s.dms[id]) return {};
      const { [id]: _removed, ...dms } = s.dms;
      return { dms };
    }),
  setBlocked: (userId, blocked) =>
    set((s) => {
      if (Boolean(s.blockedIds[userId]) === blocked) return {};
      const { [userId]: _removed, ...rest } = s.blockedIds;
      return { blockedIds: blocked ? { ...rest, [userId]: true } : rest };
    }),
  setFriends: (list) => set((s) => applyFriends(s, list)),
  stopRingingLocally: (channelId, userId) =>
    set((s) => {
      const call = s.dmCalls[channelId];
      if (!call || !call.ringing.includes(userId)) return {};
      return { dmCalls: { ...s.dmCalls, [channelId]: { ...call, ringing: call.ringing.filter((id) => id !== userId) } } };
    }),
  apply: (msg) => set((s) => applyEvent(s, msg)),
  reset: () => {
    // Çıkışta bellekteki seçim unutulur (bir sonraki bağlantıda depolamadan yeniden okunur)
    remembered = null;
    pendingSelect = null;
    set(initial);
  },
}));

const ONLINE: Presence = { status: 'online', customStatus: null };

/** READY / GUILD_CREATE'teki durumlar; eski sunucuda çevrimiçi olan herkes 'online' */
function presencesOf(online: string[], presences: Record<string, Presence> | undefined): Record<string, Presence> {
  const result: Record<string, Presence> = {};
  for (const id of online) result[id] = presences?.[id] ?? ONLINE;
  return result;
}

const sameCustom = (a: Presence['customStatus'], b: Presence['customStatus']): boolean =>
  a === b || (a !== null && b !== null && a.text === b.text && a.emoji === b.emoji);

function applyPresence(
  s: GuildStore,
  d: { userId: string; online: boolean } & Partial<Presence>,
): Partial<GuildStore> {
  const status = d.status ?? (d.online ? 'online' : 'offline');
  const visible = status !== 'offline';
  const prev = s.presences[d.userId];
  const next: Presence | undefined = visible
    ? { status, customStatus: d.customStatus ?? null, activities: d.activities ?? [] }
    : undefined;
  const presenceSame =
    prev && next
      ? prev.status === next.status &&
        sameCustom(prev.customStatus, next.customStatus) &&
        sameActivities(prev.activities, next.activities)
      : prev === next;
  const onlineSame = Boolean(s.online[d.userId]) === visible;
  if (presenceSame && onlineSame) return {};
  const result: Partial<GuildStore> = {};
  if (!onlineSame) {
    const online = { ...s.online };
    if (visible) online[d.userId] = true;
    else delete online[d.userId];
    result.online = online;
  }
  if (!presenceSame) {
    const presences = { ...s.presences };
    if (next) presences[d.userId] = next;
    else delete presences[d.userId];
    result.presences = presences;
  }
  return result;
}

function applyGuildCreate(s: GuildStore, d: GuildCreatePayload): Partial<GuildStore> {
  const guilds = { ...s.guilds, [d.guild.id]: toGuildState(d) };
  const guildOrder = s.guildOrder.includes(d.guild.id) ? s.guildOrder : [...s.guildOrder, d.guild.id];
  const profiles = { ...s.profiles, ...byId(d.users) };
  // İlk sunucu (ya da hiç seçim yokken) ve seçilmesi beklenen sunucu kendiliğinden seçilir
  const wanted = pendingSelect === d.guild.id;
  if (wanted) pendingSelect = null;
  const activeGuildId = wanted ? d.guild.id : (s.activeGuildId ?? d.guild.id);
  if (wanted) rememberGuild(d.guild.id);
  const voiceStates = { ...s.voiceStates };
  for (const v of d.voiceStates) voiceStates[v.userId] = v;
  const online = { ...s.online };
  for (const id of d.online) online[id] = true;
  return {
    ...derive(s, { guilds, guildOrder, profiles, activeGuildId }, { members: true, channels: true, profiles: true }),
    voiceStates,
    online,
    presences: { ...s.presences, ...presencesOf(d.online, d.presences) },
    lastMessageIds: { ...s.lastMessageIds, ...d.lastMessageIds },
    readStates: { ...s.readStates, ...d.readStates },
  };
}

function applyGuildDelete(s: GuildStore, guildId: string): Partial<GuildStore> {
  const current = s.guilds[guildId];
  if (!current) return {};
  const { [guildId]: _gone, ...guilds } = s.guilds;
  const guildOrder = s.guildOrder.filter((id) => id !== guildId);
  const activeGuildId = s.activeGuildId === guildId ? (guildOrder[0] ?? null) : s.activeGuildId;
  const channelIds = new Set(current.channels.map((c) => c.id));
  return {
    ...derive(s, { guilds, guildOrder, profiles: s.profiles, activeGuildId }, { members: true, channels: true }),
    voiceStates: withoutChannels(s.voiceStates, channelIds),
  };
}

function applyEvent(s: GuildStore, msg: GatewayServerMessage): Partial<GuildStore> {
  switch (msg.t) {
    case 'VOICE_STATE_UPDATE':
      return { voiceStates: { ...s.voiceStates, [msg.d.userId]: msg.d } };
    case 'VOICE_STATE_DELETE': {
      if (s.voiceStates[msg.d.userId]?.channelId !== msg.d.channelId) return {};
      const { [msg.d.userId]: _removed, ...rest } = s.voiceStates;
      return { voiceStates: rest };
    }
    case 'USER_UPDATE': {
      const profiles = { ...s.profiles, [msg.d.id]: msg.d };
      return derive(s, { guilds: s.guilds, guildOrder: s.guildOrder, profiles, activeGuildId: s.activeGuildId }, { profiles: true });
    }
    case 'USER_DELETE': {
      const id = msg.d.id;
      const { [id]: _user, ...profiles } = s.profiles;
      const { [id]: _voice, ...voiceStates } = s.voiceStates;
      const { [id]: _online, ...online } = s.online;
      const { [id]: _presence, ...presences } = s.presences;
      const guilds = Object.fromEntries(
        Object.entries(s.guilds).map(([gid, g]) => {
          if (!g.members[id]) return [gid, g];
          const { [id]: _member, ...members } = g.members;
          return [gid, { ...g, members }];
        }),
      );
      // Silinen hesap konuşmalardan düşer (sunucu da güncel konuşmayı gönderir)
      const dms = Object.values(s.dms).some((d) => d.participantIds.includes(id))
        ? Object.fromEntries(
            Object.entries(s.dms).map(([dmId, d]) => [
              dmId,
              d.participantIds.includes(id) ? { ...d, participantIds: d.participantIds.filter((p) => p !== id) } : d,
            ]),
          )
        : s.dms;
      // Arkadaş listesinden ve isteklerden de düşer (sunucu FRIENDS_UPDATE da gönderir)
      const friends = withoutFriend(s.friends, id);
      const friendIds = friends === s.friends ? s.friendIds : friendIdsOf(friends);
      return {
        ...derive(
          s,
          { guilds, guildOrder: s.guildOrder, profiles, activeGuildId: s.activeGuildId },
          { members: true, profiles: true },
          friendIds,
        ),
        voiceStates,
        online,
        presences,
        dms,
        friends,
        friendIds,
      };
    }
    case 'PRESENCE_UPDATE':
      return applyPresence(s, msg.d);
    case 'USER_STATUS_UPDATE':
      return { selfStatus: msg.d };
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE': {
      const channel = msg.d;
      return updateGuild(
        s,
        channel.guildId,
        (g) => ({ ...g, channels: sortChannels([...g.channels.filter((c) => c.id !== channel.id), channel]) }),
        { channels: true },
      );
    }
    case 'CHANNEL_DELETE': {
      // Kanal silindi ya da artık görülemiyor: oradaki ses durumları da gider
      const guildId = msg.d.guildId ?? s.channelGuild[msg.d.id];
      if (!guildId) return {};
      const voiceStates = withoutChannels(s.voiceStates, new Set([msg.d.id]));
      return {
        ...updateGuild(s, guildId, (g) => ({ ...g, channels: g.channels.filter((c) => c.id !== msg.d.id) }), {
          channels: true,
        }),
        voiceStates,
      };
    }
    case 'GUILD_CREATE':
      return applyGuildCreate(s, msg.d);
    case 'GUILD_UPDATE':
      return updateGuild(s, msg.d.id, (g) => ({ ...g, guild: msg.d }));
    case 'GUILD_DELETE':
      return applyGuildDelete(s, msg.d.id);
    case 'GUILD_MEMBER_ADD': {
      const { guildId, member, user } = msg.d;
      const current = s.guilds[guildId];
      if (!current) return {};
      const guilds = { ...s.guilds, [guildId]: { ...current, members: { ...current.members, [member.userId]: member } } };
      const profiles = { ...s.profiles, [user.id]: user };
      return derive(s, { guilds, guildOrder: s.guildOrder, profiles, activeGuildId: s.activeGuildId }, {
        members: true,
        profiles: true,
      });
    }
    case 'GUILD_MEMBER_UPDATE': {
      const { guildId, member } = msg.d;
      return updateGuild(s, guildId, (g) => ({ ...g, members: { ...g.members, [member.userId]: member } }), {
        members: true,
      });
    }
    case 'GUILD_MEMBER_REMOVE': {
      const { guildId, userId } = msg.d;
      return updateGuild(
        s,
        guildId,
        (g) => {
          const member = g.members[userId];
          if (!member) return g;
          return { ...g, members: { ...g.members, [userId]: { ...member, roles: [], removed: true } } };
        },
        { members: true },
      );
    }
    case 'ROLES_UPDATE':
      return updateGuild(s, msg.d.guildId, (g) => ({ ...g, roles: byId(msg.d.roles) }));
    case 'MESSAGE_CREATE': {
      if (Number(msg.d.id) <= Number(s.lastMessageIds[msg.d.channelId] ?? 0)) return {};
      const lastMessageIds = { ...s.lastMessageIds, [msg.d.channelId]: msg.d.id };
      const dm = s.dms[msg.d.channelId];
      // DM listesi son etkinliğe göre sıralanır
      return dm
        ? {
            lastMessageIds,
            dms: { ...s.dms, [dm.id]: { ...dm, lastMessageId: msg.d.id, lastActivityAt: msg.d.createdAt } },
          }
        : { lastMessageIds };
    }
    case 'READ_STATE_UPDATE': {
      // Başka cihazda (ya da bu cihazda) okundu: okunma durumu yalnızca ileri gider
      const { channelId, lastReadId } = msg.d;
      return Number(lastReadId) > Number(s.readStates[channelId] ?? 0)
        ? { readStates: { ...s.readStates, [channelId]: lastReadId } }
        : {};
    }
    case 'DM_CHANNEL_CREATE':
    case 'DM_CHANNEL_UPDATE': {
      // Konuşma listeye (yeniden) girerken son mesajı okunmamış bilgisine de yansır
      const last = msg.d.lastMessageId;
      const lastMessageIds =
        last && Number(last) > Number(s.lastMessageIds[msg.d.id] ?? 0)
          ? { ...s.lastMessageIds, [msg.d.id]: last }
          : s.lastMessageIds;
      return { dms: { ...s.dms, [msg.d.id]: msg.d }, lastMessageIds };
    }
    case 'DM_CHANNEL_DELETE': {
      if (!s.dms[msg.d.id]) return {};
      const { [msg.d.id]: _removed, ...dms } = s.dms;
      return { dms };
    }
    case 'DM_CALL_UPDATE':
      return { dmCalls: { ...s.dmCalls, [msg.d.channelId]: msg.d } };
    case 'DM_CALL_DELETE': {
      if (!s.dmCalls[msg.d.channelId]) return {};
      const { [msg.d.channelId]: _ended, ...dmCalls } = s.dmCalls;
      return { dmCalls };
    }
    case 'USER_BLOCKS_UPDATE':
      return { blockedIds: Object.fromEntries(msg.d.userIds.map((id) => [id, true as const])) };
    case 'FRIENDS_UPDATE':
      return applyFriends(s, msg.d);
    default:
      return {};
  }
}

/** Kanalda okunmamış mesaj var mı */
export function isUnread(state: Pick<GuildStore, 'lastMessageIds' | 'readStates'>, channelId: string): boolean {
  const last = state.lastMessageIds[channelId];
  return last !== undefined && Number(last) > Number(state.readStates[channelId] ?? 0);
}

/** Sunucunun bir metin kanalında okunmamış mesaj var mı (sol çubuktaki işaret) */
export function isGuildUnread(
  state: Pick<GuildStore, 'guilds' | 'lastMessageIds' | 'readStates'>,
  guildId: string,
): boolean {
  return state.guilds[guildId]?.channels.some((c) => c.type === 'text' && isUnread(state, c.id)) ?? false;
}

/**
 * Ses odası bir sunucu kanalının mı. DM aramasının odası (channelId = konuşmanın kimliği) ve bilinmeyen kanal
 * değildir: DM katılımcıları o odanın ses durumlarını alır, ama bunlar sunucu bağlamında (üye listesi,
 * profil kartı, "Yayını izle", sunucu ses rozeti) görünmemeli.
 */
export const isGuildVoiceChannel = (s: Pick<GuildStore, 'channelGuild'>, channelId: string | null | undefined): boolean =>
  Boolean(channelId && s.channelGuild[channelId]);

/** Ses odası bir DM aramasının mı (listede açık konuşma ya da süren arama) */
export const isDmVoiceChannel = (s: Pick<GuildStore, 'dms' | 'dmCalls'>, channelId: string | null | undefined): boolean =>
  Boolean(channelId && (s.dms[channelId] || s.dmCalls[channelId]));

/** Kişinin sunucu kanalındaki ses durumu; DM aramasındaysa (ya da seste değilse) undefined */
export function guildVoiceStateOf(
  s: Pick<GuildStore, 'voiceStates' | 'channelGuild'>,
  userId: string | null | undefined,
): VoiceState | undefined {
  const state = userId ? s.voiceStates[userId] : undefined;
  return state && isGuildVoiceChannel(s, state.channelId) ? state : undefined;
}

export function membersOf(voiceStates: Record<string, VoiceState>, channelId: string): VoiceState[] {
  return Object.values(voiceStates)
    .filter((v) => v.channelId === channelId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

/** Kanal (hangi sunucuda olursa olsun; görülebiliyorsa) */
export function channelById(
  state: Pick<GuildStore, 'guilds' | 'channelGuild'>,
  channelId: string | null | undefined,
): Channel | undefined {
  if (!channelId) return undefined;
  const guildId = state.channelGuild[channelId];
  return guildId ? state.guilds[guildId]?.channels.find((c) => c.id === channelId) : undefined;
}
