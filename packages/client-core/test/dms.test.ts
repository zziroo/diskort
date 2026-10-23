import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  CLIENT_FEATURE_VOICE_TRACE,
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  DM_PERMISSIONS,
  Permission as P,
  type DmChannel,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type Message,
  type ReadyPayload,
  type User,
} from '@diskort/shared';
import {
  ackChannel,
  configureClient,
  dmBlockedReason,
  isUnread,
  dmTitle,
  gateway,
  permissionsOf,
  sortDms,
  useGuild,
  useMessages,
  useSession,
} from '../src';
import { member, profile, toReady, type TestUser } from './fixtures';

const user = (id: string, extra: Partial<TestUser> = {}): TestUser => ({
  id,
  username: id,
  displayName: id.toUpperCase(),
  avatarColor: '#fff',
  isAdmin: false,
  ...extra,
});

const dm = (id: string, participantIds: string[], extra: Partial<DmChannel> = {}): DmChannel => ({
  id,
  participantIds,
  group: participantIds.length > 2,
  name: null,
  ownerId: null,
  createdAt: 1,
  lastMessageId: null,
  lastActivityAt: 1,
  ...extra,
});

const message = (id: string, channelId: string, authorId: string, content = 'selam'): Message => ({
  id,
  channelId,
  authorId,
  content,
  createdAt: 1000 + Number(id),
  editedAt: null,
  attachments: [],
  reactions: [],
  mentionEveryone: false,
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

const ready = (extra: Partial<ReadyPayload> = {}): ReadyPayload => ({
  ...readyBase(),
  ...extra,
});

const readyBase = (): ReadyPayload =>
  toReady({
  user: user('ben'),
  guild: { id: 'g', name: 'G', ownerId: 'sahip' },
  channels: [{ id: 'genel', guildId: 'g', name: 'genel', type: 'text', position: 0, overwrites: [] }],
  users: [user('ben'), user('ali'), user('veli'), user('sahip', { isAdmin: true })],
  roles: [{ id: 'g', name: '@everyone', color: null, position: 0, hoist: false, permissions: P.VIEW_CHANNEL }],
  voiceStates: [],
  online: [],
  lastMessageIds: { d1: '5' },
  readStates: { d1: '3' },
  mentionCounts: { d1: 2 },
  attachmentMaxBytes: 1,
  dms: [dm('d1', ['ben', 'ali'], { lastMessageId: '5', lastActivityAt: 50 })],
  });

const directs: { message: Message; dm: DmChannel }[] = [];
const mentions: Message[] = [];
let viewing: string | null = null;
const reads: [string, string][] = [];

beforeEach(async () => {
  directs.length = 0;
  mentions.length = 0;
  reads.length = 0;
  viewing = null;
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    serverUrl: () => 'http://sunucu.test',
    notifyError: () => undefined,
    isViewingChannel: (id) => id === viewing,
    onMention: (m) => mentions.push(m),
    onDirectMessage: (m, d) => directs.push({ message: m, dm: d }),
    onChannelRead: (channelId, lastReadId) => void reads.push([channelId, lastReadId]),
  });
  useSession.getState().setSession('jeton', user('ben'));
  useMessages.setState({ channels: {}, mentionCounts: {}, pendingFiles: {} });
  receive({ t: 'READY', d: ready() });
});

describe('direkt mesajlar', () => {
  it('IDENTIFY DM özelliğini bildirir', () => {
    const sent: GatewayClientMessage[] = [];
    const g = gateway as unknown as { send: (m: GatewayClientMessage) => void };
    const original = g.send;
    g.send = (m) => void sent.push(m);
    try {
      receive({ t: 'HELLO', d: { heartbeatInterval: 60_000 } });
    } finally {
      g.send = original;
      (gateway as unknown as { clearTimers: () => void }).clearTimers();
    }
    const identify = sent.find((m) => m.t === 'IDENTIFY');
    expect(identify?.t === 'IDENTIFY' && identify.d.features).toEqual([
      CLIENT_FEATURE_DM,
      CLIENT_FEATURE_PRESENCE,
      CLIENT_FEATURE_VOICE_TRACE,
    ]);
  });

  it("READY'deki konuşmalar kanal listesinden ayrı tutulur; okunmamış bilgisi ortak", () => {
    const s = useGuild.getState();
    expect(s.channels.map((c) => c.id)).toEqual(['genel']);
    expect(Object.keys(s.dms)).toEqual(['d1']);
    expect(useMessages.getState().mentionCounts.d1).toBe(2);
  });

  it('konuşmaya gelen her mesaj okunmamış sayısını artırır ve bildirilir; açıkken sayılmaz', () => {
    receive({ t: 'MESSAGE_CREATE', d: message('6', 'd1', 'ali') });
    expect(useMessages.getState().mentionCounts.d1).toBe(3);
    expect(directs.map((d) => [d.message.id, d.dm.id])).toEqual([['6', 'd1']]);
    // Son etkinlik güncellenir (liste sırası)
    expect(useGuild.getState().dms.d1).toMatchObject({ lastMessageId: '6', lastActivityAt: 1006 });
    expect(useGuild.getState().lastMessageIds.d1).toBe('6');

    // Kendi mesajımız ve bakılan konuşma sayılmaz; DM'deki @bahsetme ayrıca bildirilmez
    receive({ t: 'MESSAGE_CREATE', d: message('7', 'd1', 'ben') });
    viewing = 'd1';
    receive({ t: 'MESSAGE_CREATE', d: message('8', 'd1', 'ali', '@ben bak') });
    expect(useMessages.getState().mentionCounts.d1).toBe(3);
    expect(directs).toHaveLength(1);
    expect(mentions).toEqual([]);
  });

  it('konuşma olayları listeyi günceller; kaldırılan konuşmanın yerel verisi silinir', () => {
    receive({ t: 'DM_CHANNEL_CREATE', d: dm('d2', ['ben', 'ali', 'veli'], { lastMessageId: '9', lastActivityAt: 90 }) });
    expect(sortDms(useGuild.getState().dms).map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(useGuild.getState().lastMessageIds.d2).toBe('9');

    receive({ t: 'DM_CHANNEL_UPDATE', d: dm('d2', ['ben', 'ali', 'veli'], { name: 'Ekip', lastActivityAt: 90 }) });
    expect(useGuild.getState().dms.d2?.name).toBe('Ekip');

    receive({ t: 'DM_CHANNEL_DELETE', d: { id: 'd1' } });
    expect(Object.keys(useGuild.getState().dms)).toEqual(['d2']);
    expect(useMessages.getState().mentionCounts.d1).toBeUndefined();

    // Hesabı silinen konuşmalardan düşer
    receive({ t: 'USER_DELETE', d: { id: 'veli' } });
    expect(useGuild.getState().dms.d2?.participantIds).toEqual(['ben', 'ali']);
  });

  it('yeniden bağlanınca listeden kalkmış konuşmanın önbelleği atılır (yüklenmeye çalışılmaz)', () => {
    useMessages.setState({
      channels: { eski: { messages: [], hasMore: false, loading: false, loaded: true } },
    });
    receive({ t: 'READY', d: ready() });
    expect(useMessages.getState().channels.eski).toBeUndefined();
  });

  it('yetkiler: yalnızca katılımcılar; yönetici ayrıcalığı yok; karşı taraf ayrıldıysa yalnızca okuma', () => {
    const s = useGuild.getState();
    expect(permissionsOf(s, 'ben', 'd1')).toBe(DM_PERMISSIONS);
    expect(permissionsOf(s, 'ali', 'd1')).toBe(DM_PERMISSIONS);
    expect(permissionsOf(s, 'veli', 'd1')).toBe(0);
    expect(permissionsOf(s, 'sahip', 'd1')).toBe(0);
    expect(permissionsOf(s, 'sahip', 'genel')).toBe(ALL_PERMISSIONS);
    expect(DM_PERMISSIONS & P.MANAGE_MESSAGES).toBe(0);

    // Ali tek ortak sunucudan ayrıldı: konuşma okunur, yazılamaz
    receive({ t: 'GUILD_MEMBER_REMOVE', d: { guildId: 'g', userId: 'ali' } });
    const after = useGuild.getState();
    expect(permissionsOf(after, 'ben', 'd1')).toBe(P.VIEW_CHANNEL);
    expect(dmBlockedReason(after.dms.d1!, after.users, 'ben', after.reachable)).toContain('ortak bir sunucunuz yok');
  });

  it('konuşmanın adı: grup adı, yoksa diğer kişilerin adları', () => {
    const users = useGuild.getState().users;
    expect(dmTitle(dm('x', ['ben', 'ali']), users, 'ben')).toBe('ALI');
    expect(dmTitle(dm('x', ['ben', 'ali', 'veli']), users, 'ben')).toBe('ALI, VELI');
    expect(dmTitle(dm('x', ['ben', 'ali', 'veli'], { name: 'Ekip' }), users, 'ben')).toBe('Ekip');
    expect(dmTitle(dm('x', ['ben']), users, 'ben')).toBe('Silinmiş Kullanıcı');
    expect(dmTitle(dm('x', ['ben'], { group: true }), users, 'ben')).toBe('Boş grup');
  });
});

describe('okunma durumu cihazlar arasında (READ_STATE_UPDATE)', () => {
  it('başka cihazda okununca okunmamış işareti ve DM sayacı temizlenir', () => {
    expect(isUnread(useGuild.getState(), 'd1')).toBe(true);
    expect(reads).toEqual([['d1', '3']]); // READY'deki okunma durumu da bildirilir
    reads.length = 0;

    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '5', mentionCount: 0 } });
    expect(useGuild.getState().readStates.d1).toBe('5');
    expect(isUnread(useGuild.getState(), 'd1')).toBe(false);
    expect(useMessages.getState().mentionCounts.d1).toBeUndefined();
    expect(reads).toEqual([['d1', '5']]);

    // Geride kalan (sırası karışmış) olay okunma durumunu geri almaz
    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '4', mentionCount: 0 } });
    expect(useGuild.getState().readStates.d1).toBe('5');
  });

  it('kısmi okumada sunucunun sayısı korunur; yerel sayı hiç artırılmaz', () => {
    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '4', mentionCount: 2 } });
    expect(useGuild.getState().readStates.d1).toBe('4');
    expect(isUnread(useGuild.getState(), 'd1')).toBe(true);
    expect(useMessages.getState().mentionCounts.d1).toBe(2);

    // Bakılan kanalda yerel sayım yoktur: başka cihazın kısmi okuması rozet getirmez
    useMessages.setState({ mentionCounts: {} });
    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '4', mentionCount: 1 } });
    expect(useMessages.getState().mentionCounts.d1).toBeUndefined();
  });

  it('okunduktan sonra gelen mesaj yeniden okunmamış sayılır; kendi mesajının onayı işareti kaldırır', () => {
    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '5', mentionCount: 0 } });
    receive({ t: 'MESSAGE_CREATE', d: message('6', 'd1', 'ali') });
    expect(isUnread(useGuild.getState(), 'd1')).toBe(true);
    expect(useMessages.getState().mentionCounts.d1).toBe(1);
    // Başka cihazdan yazılan kendi mesajımız: mesajın ardından gelen onay
    receive({ t: 'MESSAGE_CREATE', d: message('7', 'd1', 'ben') });
    receive({ t: 'READ_STATE_UPDATE', d: { channelId: 'd1', lastReadId: '7', mentionCount: 0 } });
    expect(isUnread(useGuild.getState(), 'd1')).toBe(false);
    expect(useMessages.getState().mentionCounts.d1).toBeUndefined();
  });

  it('bu cihazda okumak da bildirilir (telefon bildirimleri kalksın)', () => {
    reads.length = 0;
    ackChannel('d1');
    expect(reads).toEqual([['d1', '5']]);
    expect(useMessages.getState().mentionCounts.d1).toBeUndefined();
    expect(useGuild.getState().readStates.d1).toBe('5');
  });
});
