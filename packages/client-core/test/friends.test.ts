import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  DM_PERMISSIONS,
  Permission as P,
  type FriendEntry,
  type FriendsList,
  type GatewayServerMessage,
  type ReadyPayload,
  type User,
} from '@diskort/shared';
import {
  acceptFriendRequest,
  configureClient,
  dmBlockedReason,
  friendStatusOf,
  gateway,
  permissionsOf,
  removeFriend,
  sendFriendRequest,
  useGuild,
  useSession,
} from '../src';

const user = (id: string): User => ({ id, username: id, displayName: id.toUpperCase(), avatarColor: '#fff', isAdmin: false });
const entry = (id: string, createdAt = 1): FriendEntry => ({ userId: id, createdAt, user: user(id) });
const list = (friends: string[], incoming: string[] = [], outgoing: string[] = []): FriendsList => ({
  friends: friends.map((id) => entry(id)),
  incoming: incoming.map((id) => entry(id)),
  outgoing: outgoing.map((id) => entry(id)),
});

// Zeki ile ortak sunucu yok, yalnızca arkadaşlık; ayşe'nin isteği bekliyor (profili READY'nin users'ında yok)
const ready = (): ReadyPayload => ({
  user: user('ben'),
  guilds: [
    {
      guild: { id: 'a', name: 'A', ownerId: 'ben', iconUrl: null },
      channels: [],
      roles: [{ id: 'a', name: '@everyone', color: null, position: 0, hoist: false, permissions: DEFAULT_EVERYONE_PERMISSIONS }],
      members: ['ben', 'ali'].map((userId) => ({ userId, roles: [], joinedAt: 1, removed: false })),
    },
  ],
  users: [user('ben'), user('ali'), user('zeki')],
  voiceStates: [],
  online: [],
  primaryGuildId: 'a',
  lastMessageIds: {},
  readStates: {},
  mentionCounts: {},
  attachmentMaxBytes: 1,
  dms: [
    {
      id: 'dm-zeki',
      participantIds: ['ben', 'zeki'],
      group: false,
      name: null,
      ownerId: null,
      createdAt: 1,
      lastMessageId: null,
      lastActivityAt: 1,
    },
  ],
  friends: list(['zeki'], ['ayse']),
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

const errors: string[] = [];

beforeEach(async () => {
  errors.length = 0;
  useGuild.getState().reset();
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    serverUrl: () => 'sunucu.test/',
    notifyError: (m) => void errors.push(m),
  });
  useSession.getState().setSession('jeton', user('ben'));
  receive({ t: 'READY', d: ready() });
});

/** Sahte sunucu yanıtı */
const respond = (status: number, body: unknown) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

describe('arkadaşlar', () => {
  it('READY: arkadaşlar ulaşılabilir sayılır (ortak sunucu olmadan DM yazılır); istek bekleyenin profili tanınır', () => {
    const s = useGuild.getState();
    expect(s.friendIds).toEqual({ zeki: true });
    expect(s.reachable).toMatchObject({ ali: true, zeki: true });
    expect(s.reachable.ayse).toBeUndefined();
    expect(s.users.ayse?.displayName).toBe('AYSE');
    expect(permissionsOf(s, 'ben', 'dm-zeki')).toBe(DM_PERMISSIONS);
    expect(dmBlockedReason(s.dms['dm-zeki']!, s.users, 'ben', s.reachable)).toBeNull();
    expect(friendStatusOf(s, 'zeki', 'ben')).toBe('friend');
    expect(friendStatusOf(s, 'ayse', 'ben')).toBe('incoming');
    expect(friendStatusOf(s, 'ali', 'ben')).toBe('none');
    expect(friendStatusOf(s, 'ben', 'ben')).toBe('self');
  });

  it('FRIENDS_UPDATE: arkadaşlıktan çıkınca ortak sunucu yoksa DM salt okunur olur; yeni arkadaş ulaşılabilir olur', () => {
    receive({ t: 'FRIENDS_UPDATE', d: list([], [], ['ali']) });
    let s = useGuild.getState();
    expect(s.reachable.zeki).toBeUndefined();
    expect(s.reachable.ali).toBe(true); // ortak sunucu sürüyor
    expect(permissionsOf(s, 'ben', 'dm-zeki')).toBe(P.VIEW_CHANNEL);
    expect(dmBlockedReason(s.dms['dm-zeki']!, s.users, 'ben', s.reachable)).toContain('arkadaş değilsiniz');
    expect(friendStatusOf(s, 'ali', 'ben')).toBe('outgoing');

    receive({ t: 'FRIENDS_UPDATE', d: list(['zeki', 'yeni']) });
    s = useGuild.getState();
    expect(s.reachable).toMatchObject({ zeki: true, yeni: true });
    expect(s.users.yeni?.displayName).toBe('YENI');
  });

  it('silinen hesap listeden düşer', () => {
    receive({ t: 'USER_DELETE', d: { id: 'zeki' } });
    const s = useGuild.getState();
    expect(s.friends.friends).toEqual([]);
    expect(s.friendIds).toEqual({});
    expect(s.reachable.zeki).toBeUndefined();
    expect(s.friends.incoming.map((e) => e.userId)).toEqual(['ayse']);
  });

  it('REST yanıtı listeyi hemen uygular; istek hatası bildirim yerine döner', async () => {
    const fetch = respond(201, { status: 'pending', ...list(['zeki'], ['ayse'], ['ali']) });
    expect(await sendFriendRequest(' @ali ')).toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledWith('http://sunucu.test/api/friends/requests', expect.objectContaining({ method: 'POST', body: '{"username":"@ali"}' }));
    expect(useGuild.getState().friends.outgoing.map((e) => e.userId)).toEqual(['ali']);
    // Yanıtta status alanı listeye karışmaz
    expect('status' in useGuild.getState().friends).toBe(false);

    respond(404, { error: 'not_found', message: 'Kullanıcı bulunamadı.' });
    expect(await sendFriendRequest('yok')).toEqual({ error: 'Kullanıcı bulunamadı.' });
    expect(errors).toEqual([]);

    respond(200, list(['zeki', 'ayse'], [], ['ali']));
    expect(await acceptFriendRequest('ayse')).toBe(true);
    expect(useGuild.getState().reachable.ayse).toBe(true);

    respond(404, { error: 'not_found', message: 'Arkadaşlık isteği bulunamadı.' });
    expect(await removeFriend('kimse')).toBe(false);
    expect(errors).toEqual(['Arkadaşlık isteği bulunamadı.']);
  });
});
