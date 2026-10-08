import type {
  AcceptInviteResponse,
  ApiErrorBody,
  AuthResponse,
  Ban,
  Channel,
  ChannelLinkItem,
  ChannelMediaItem,
  ChannelPanelPage,
  ChangePasswordRequest,
  CreateRoleRequest,
  DeleteAccountRequest,
  DmChannel,
  FriendRequestResponse,
  FriendsList,
  Guild,
  PushTokenRequest,
  Message,
  PinnedMessage,
  ReactionUsersPage,
  CreateChannelRequest,
  CreateGuildRequest,
  CreateInviteRequest,
  GuildData,
  GuildMember,
  Invite,
  InvitePreview,
  LoginRequest,
  RegisterRequest,
  ResetCodeResponse,
  ResetPasswordRequest,
  ReleaseNotes,
  SearchResponse,
  Role,
  UpdateChannelRequest,
  UpdateGuildRequest,
  UpdateMeRequest,
  UpdateRoleRequest,
  User,
  UserBlock,
  VoiceJoinResponse,
  VoiceModerationRequest,
} from '@diskort/shared';
import {
  CLIENT_FEATURE_COSMETIC_PACKS,
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  CLIENT_FEATURE_VOICE_TRACE,
  CLIENT_FEATURES_HEADER,
} from '@diskort/shared';
import { env } from './env';
import { useSession } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** İstemcinin tanıdığı ek özellikler: gateway'de IDENTIFY ile, HTTP isteklerinde CLIENT_FEATURES_HEADER ile bildirilir */
export const CLIENT_FEATURES: readonly string[] = [
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  CLIENT_FEATURE_COSMETIC_PACKS,
  CLIENT_FEATURE_VOICE_TRACE,
];

/**
 * Kullanıcı döndüren her isteğe eklenen başlık: sunucu, paketleri tanıdığını bildirmeyen istemciye set
 * seçimlerinde yalnızca yerleşik kimlikleri gönderir (bkz. CLIENT_FEATURE_COSMETIC_PACKS).
 */
export const clientFeatureHeaders = (): Record<string, string> => ({ [CLIENT_FEATURES_HEADER]: CLIENT_FEATURES.join(',') });

/** Oturum jetonuyla JSON isteği; hata durumunda ApiError atar. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = useSession.getState().token;
  const headers: Record<string, string> = clientFeatureHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(normalizeServerUrl(env().serverUrl()) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Sunucuya ulaşılamadı. Adresi ve internet bağlantını kontrol et.');
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = data as Partial<ApiErrorBody> | null;
    if (res.status === 401 && token) useSession.getState().logout();
    throw new ApiError(res.status, err?.error ?? 'error', err?.message ?? `İstek başarısız (${res.status}).`);
  }
  return data as T;
}

export const api = {
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/api/auth/login', body),
  releaseNotes: () => request<{ releases: ReleaseNotes[] }>('GET', '/api/releases').then((r) => r.releases),
  register: (body: RegisterRequest) => request<AuthResponse>('POST', '/api/auth/register', body),
  resetPassword: (body: ResetPasswordRequest) => request<AuthResponse>('POST', '/api/auth/reset', body),
  me: () => request<User>('GET', '/api/me'),
  updateMe: (body: UpdateMeRequest) => request<User>('PATCH', '/api/me', body),
  removeAvatar: () => request<User>('DELETE', '/api/me/avatar'),
  removeBanner: () => request<User>('DELETE', '/api/me/banner'),
  changePassword: (body: ChangePasswordRequest) => request<AuthResponse>('POST', '/api/me/password', body),
  deleteAccount: (body: DeleteAccountRequest) => request<void>('DELETE', '/api/me', body),
  registerPushToken: (body: PushTokenRequest) => request<void>('POST', '/api/me/push-tokens', body),
  unregisterPushToken: (token: string) => request<void>('DELETE', '/api/me/push-tokens', { token }),
  sendTestPush: () => request<{ devices: number }>('POST', '/api/me/push-test'),

  // Hesaplar (hesap yöneticileri: hesabın kendi bayrağı, sunuculardan bağımsız)
  /** Tüm hesaplar */
  listUsers: () => request<User[]>('GET', '/api/users'),
  listAdmins: () => request<User[]>('GET', '/api/admins'),
  grantAdmin: (userId: string) => request<User>('PUT', `/api/admins/${userId}`),
  /** Son yönetici alınamaz (400 last_admin) */
  revokeAdmin: (userId: string) => request<void>('DELETE', `/api/admins/${userId}`),
  createResetCode: (userId: string) => request<ResetCodeResponse>('POST', `/api/users/${userId}/reset-code`),
  deleteUser: (userId: string) => request<void>('DELETE', `/api/users/${userId}`),
  /** Yalnızca hesap açtıran davetler (sunucuya katılmaz) */
  listAccountInvites: () => request<Invite[]>('GET', '/api/invites'),
  createAccountInvite: (body: CreateInviteRequest) => request<Invite>('POST', '/api/invites', body),
  deleteAccountInvite: (code: string) => request<void>('DELETE', `/api/invites/${encodeURIComponent(code)}`),

  // Sunucular
  createGuild: (body: CreateGuildRequest) => request<GuildData>('POST', '/api/guilds', body),
  updateGuild: (guildId: string, body: UpdateGuildRequest) => request<Guild>('PATCH', `/api/guilds/${guildId}`, body),
  deleteGuild: (guildId: string) => request<void>('DELETE', `/api/guilds/${guildId}`),
  leaveGuild: (guildId: string) => request<void>('DELETE', `/api/guilds/${guildId}/members/me`),
  removeGuildIcon: (guildId: string) => request<Guild>('DELETE', `/api/guilds/${guildId}/icon`),
  /** Davet bağlantısının önizlemesi (giriş gerekmez) */
  previewInvite: (code: string) => request<InvitePreview>('GET', `/api/invites/${encodeURIComponent(code)}`),
  /** Davet koduyla sunucuya katılır */
  acceptInvite: (code: string) =>
    request<AcceptInviteResponse>('POST', `/api/invites/${encodeURIComponent(code)}/accept`),

  /** Sesli sohbette yönetim: sunucuda sustur/sağırlaştır, taşı (channelId) ya da sesten çıkar (null) */
  moderateVoice: (guildId: string, userId: string, body: VoiceModerationRequest) =>
    request<void>('PATCH', `/api/guilds/${guildId}/members/${userId}/voice`, body),
  kickMember: (guildId: string, userId: string) => request<void>('DELETE', `/api/guilds/${guildId}/members/${userId}`),
  banMember: (guildId: string, userId: string, reason?: string) =>
    request<void>('PUT', `/api/guilds/${guildId}/bans/${userId}`, reason ? { reason } : {}),
  listBans: (guildId: string) => request<Ban[]>('GET', `/api/guilds/${guildId}/bans`),
  unban: (guildId: string, userId: string) => request<void>('DELETE', `/api/guilds/${guildId}/bans/${userId}`),

  createRole: (guildId: string, body: CreateRoleRequest) => request<Role>('POST', `/api/guilds/${guildId}/roles`, body),
  updateRole: (guildId: string, id: string, body: UpdateRoleRequest) =>
    request<Role>('PATCH', `/api/guilds/${guildId}/roles/${id}`, body),
  deleteRole: (guildId: string, id: string) => request<void>('DELETE', `/api/guilds/${guildId}/roles/${id}`),
  /** @everyone hariç tüm roller, yukarıdan aşağı */
  reorderRoles: (guildId: string, roleIds: string[]) =>
    request<Role[]>('PUT', `/api/guilds/${guildId}/roles/order`, { roleIds }),
  addMemberRole: (guildId: string, userId: string, roleId: string) =>
    request<GuildMember>('PUT', `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`),
  removeMemberRole: (guildId: string, userId: string, roleId: string) =>
    request<GuildMember>('DELETE', `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`),

  listInvites: (guildId: string) => request<Invite[]>('GET', `/api/guilds/${guildId}/invites`),
  createInvite: (guildId: string, body: CreateInviteRequest) =>
    request<Invite>('POST', `/api/guilds/${guildId}/invites`, body),
  deleteInvite: (guildId: string, code: string) =>
    request<void>('DELETE', `/api/guilds/${guildId}/invites/${encodeURIComponent(code)}`),

  createChannel: (guildId: string, body: CreateChannelRequest) =>
    request<Channel>('POST', `/api/guilds/${guildId}/channels`, body),
  updateChannel: (id: string, body: UpdateChannelRequest) => request<Channel>('PATCH', `/api/channels/${id}`, body),
  deleteChannel: (id: string) => request<void>('DELETE', `/api/channels/${id}`),
  /** Görülebilen tüm kanalların yeni sırası; yanıt görülebilen kanallar (yeni konumlarıyla) */
  reorderChannels: (guildId: string, channelIds: string[]) =>
    request<Channel[]>('PUT', `/api/guilds/${guildId}/channels/order`, { channelIds }),

  /** Mesaj araması; params: q, guildId | dmId, channelId, cursor, limit, tz (bkz. sunucu routes/search.ts) */
  search: (params: Record<string, string>) =>
    request<SearchResponse>('GET', `/api/search?${new URLSearchParams(params).toString()}`),

  joinVoice: (channelId: string) => request<VoiceJoinResponse>('POST', `/api/voice/${channelId}/join`),

  listMessages: (channelId: string, before?: string, limit?: number) => {
    const query = new URLSearchParams();
    if (before) query.set('before', before);
    if (limit) query.set('limit', String(limit));
    const qs = query.toString();
    return request<Message[]>('GET', `/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
  },
  sendMessage: (
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    reply?: { replyToId: string; replyMention: boolean },
  ) =>
    request<Message>('POST', `/api/channels/${channelId}/messages`, {
      content,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(reply ?? {}),
    }),
  updateMessage: (id: string, content: string) => request<Message>('PATCH', `/api/messages/${id}`, { content }),
  deleteMessage: (id: string) => request<void>('DELETE', `/api/messages/${id}`),
  /** Bağlantı önizlemelerini kaldırır (yazar ya da MANAGE_MESSAGES) */
  suppressEmbeds: (id: string) => request<Message>('DELETE', `/api/messages/${id}/embeds`),
  /** Kanalın sabitlenmiş mesajları, en son sabitlenen önce */
  listPins: (channelId: string) => request<PinnedMessage[]>('GET', `/api/channels/${channelId}/pins`),
  /** Kanal paneli: kanalda (konuşmada) paylaşılan resim ve videolar, yeniden eskiye (before: nextCursor) */
  channelMedia: (channelId: string, before?: string | null) =>
    request<ChannelPanelPage<ChannelMediaItem>>(
      'GET',
      `/api/channels/${channelId}/media${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  /** Kanal paneli: kanalda paylaşılan resim/video dışındaki dosyalar (belge, arşiv, ses, APK…), yeniden eskiye */
  channelFiles: (channelId: string, before?: string | null) =>
    request<ChannelPanelPage<ChannelMediaItem>>(
      'GET',
      `/api/channels/${channelId}/files${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  /** Kanal paneli: mesajlardaki bağlantılar, yeniden eskiye (before: nextCursor) */
  channelLinks: (channelId: string, before?: string | null) =>
    request<ChannelPanelPage<ChannelLinkItem>>(
      'GET',
      `/api/channels/${channelId}/links${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  pinMessage: (channelId: string, messageId: string) =>
    request<void>('PUT', `/api/channels/${channelId}/pins/${messageId}`),
  unpinMessage: (channelId: string, messageId: string) =>
    request<void>('DELETE', `/api/channels/${channelId}/pins/${messageId}`),
  addReaction: (messageId: string, emoji: string) =>
    request<void>('PUT', `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  removeReaction: (messageId: string, emoji: string) =>
    request<void>('DELETE', `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  /** Bu emojiyle tepki verenler (sayfalı; after: önceki sayfanın next değeri) */
  reactionUsers: (messageId: string, emoji: string, after?: string, limit?: number) => {
    const query = new URLSearchParams();
    if (after) query.set('after', after);
    if (limit) query.set('limit', String(limit));
    const qs = query.toString();
    return request<ReactionUsersPage>(
      'GET',
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}${qs ? `?${qs}` : ''}`,
    );
  },
  ack: (channelId: string, messageId: string) =>
    request<void>('POST', `/api/channels/${channelId}/ack`, { messageId }),

  // Direkt mesajlar: mesajları kanallarla aynı uçlardan (listMessages, sendMessage…) gider
  listDms: () => request<DmChannel[]>('GET', '/api/dms'),
  /** Tek kişi: bire bir konuşma (varsa aynısı); birden çok kişi: yeni grup */
  createDm: (userIds: string[], name?: string | null) =>
    request<DmChannel>('POST', '/api/dms', name ? { userIds, name } : { userIds }),
  renameDm: (id: string, name: string | null) => request<DmChannel>('PATCH', `/api/dms/${id}`, { name }),
  /** Bire bir konuşmayı listeden kaldırır; gruptan ayrılır */
  closeDm: (id: string) => request<void>('DELETE', `/api/dms/${id}`),
  addDmParticipant: (id: string, userId: string) =>
    request<DmChannel>('PUT', `/api/dms/${id}/participants/${userId}`),
  /**
   * DM araması: arama, konuşmanın ses odasına bağlanınca (joinVoice(dmId)) başlar; bunlar yalnızca çalmayı
   * yönetir. Reddet: yalnızca senin için çalma biter (tekrarlanabilir).
   */
  declineDmCall: (id: string) => request<void>('POST', `/api/dms/${id}/call/decline`),
  /** Aramadaki biri, aramada olmayan bir katılımcıyı (userId yoksa hepsini) yeniden çalar; aramada değilsen 409 */
  ringDmCall: (id: string, userId?: string) =>
    request<void>('POST', `/api/dms/${id}/call/ring`, userId ? { userId } : {}),

  // Engellemeler (yalnızca kendi listen)
  listBlocks: () => request<UserBlock[]>('GET', '/api/me/blocks'),
  blockUser: (userId: string) => request<void>('PUT', `/api/me/blocks/${userId}`),
  unblockUser: (userId: string) => request<void>('DELETE', `/api/me/blocks/${userId}`),

  // Arkadaşlar: her değişiklik isteği yapanın güncel listesini döner (FRIENDS_UPDATE da gelir)
  listFriends: () => request<FriendsList>('GET', '/api/friends'),
  /** Kullanıcı adıyla istek; karşı tarafın bekleyen isteği varsa kabul sayılır (status 'friends') */
  sendFriendRequest: (username: string) => request<FriendRequestResponse>('POST', '/api/friends/requests', { username }),
  acceptFriendRequest: (userId: string) => request<FriendsList>('POST', `/api/friends/requests/${userId}/accept`),
  /** Gelen isteği reddet ya da gönderdiğini geri çek */
  deleteFriendRequest: (userId: string) => request<FriendsList>('DELETE', `/api/friends/requests/${userId}`),
  removeFriend: (userId: string) => request<FriendsList>('DELETE', `/api/friends/${userId}`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Beklenmeyen bir hata oluştu.';
}
