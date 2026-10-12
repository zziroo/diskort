import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  Permission as P,
  type Channel,
  type GatewayServerMessage,
  type ReadyPayload,
  type Role,
  type User,
} from '@diskort/shared';
import {
  broadcastSuggestions,
  can,
  channelPermissionInfos,
  configureClient,
  effectivePermissions,
  gateway,
  isMentioned,
  memberActions,
  memberColorOf,
  memberGroups,
  channelMemberGroups,
  moveTargets,
  overwriteState,
  reorderedIds,
  canReorderChannels,
  voiceDropTargets,
  permissionsOf,
  rolePermissionSource,
  setOverwriteState,
  useGuild,
  useSession,
} from '../src';
import { member, profile, toReady, type TestUser } from './fixtures';

const role = (id: string, position: number, permissions: number, extra: Partial<Role> = {}): Role => ({
  id,
  name: id,
  color: null,
  position,
  hoist: false,
  permissions,
  ...extra,
});

const user = (id: string, roles: string[] = [], extra: Partial<TestUser> = {}): TestUser => ({
  id,
  username: id,
  displayName: id.toUpperCase(),
  avatarColor: '#fff',
  isAdmin: false,
  roles,
  removed: false,
  ...extra,
});

const ready = (): ReadyPayload => toReady(legacy());

const channel = (id: string, type: 'text' | 'voice', overwrites: Channel['overwrites'] = []): Channel => ({
  id,
  guildId: 'g',
  name: id,
  type,
  position: 0,
  overwrites,
});

const legacy = () => ({
  user: user('mod', ['mod']),
  guild: { id: 'g', name: 'Test', ownerId: 'sahip' },
  channels: [
    channel('genel', 'text'),
    channel('duyuru', 'text', [{ roleId: 'g', allow: 0, deny: P.SEND_MESSAGES }]),
    channel('ses', 'voice'),
    channel('oyun', 'voice', [{ roleId: 'g', allow: 0, deny: P.CONNECT }]),
  ],
  users: [
    user('sahip', ['admin']),
    user('mod', ['mod']),
    user('ali', ['dj']),
    user('veli'),
    user('eski', [], { removed: true }),
  ],
  roles: [
    role('admin', 3, P.ADMINISTRATOR, { color: '#e67e22', hoist: true }),
    role('mod', 2, P.KICK_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS | P.MANAGE_ROLES, { color: '#3498db', hoist: true }),
    role('dj', 1, 0, { color: '#2ecc71' }),
    role('g', 0, DEFAULT_EVERYONE_PERMISSIONS),
  ],
  voiceStates: [
    { userId: 'ali', channelId: 'ses', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, streaming: false, joinedAt: 1 },
  ],
  online: ['sahip', 'mod', 'ali'],
  lastMessageIds: {},
  readStates: {},
  mentionCounts: {},
  attachmentMaxBytes: 1,
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

beforeEach(async () => {
  const memory = new Map<string, string>();
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
    serverUrl: () => 'http://sunucu.test',
    notifyError: () => undefined,
  });
  useSession.getState().setSession('jeton', profile(user('mod', ['mod'])));
  receive({ t: 'READY', d: ready() });
});

describe('yetkiler', () => {
  it('sunucudakiyle aynı kurallarla hesaplanır', () => {
    const s = useGuild.getState();
    expect(can(s, 'mod', P.KICK_MEMBERS)).toBe(true);
    expect(can(s, 'mod', P.BAN_MEMBERS)).toBe(false);
    expect(can(s, 'veli', P.SEND_MESSAGES, 'duyuru')).toBe(false);
    expect(can(s, 'veli', P.ADD_REACTIONS, 'duyuru')).toBe(true);
    expect(can(s, 'veli', P.SPEAK, 'oyun')).toBe(false);
    expect(can(s, 'sahip', P.SEND_MESSAGES, 'duyuru')).toBe(true);
    // Görünmeyen kanal ve atılan üye: hiçbir yetki
    expect(permissionsOf(s, 'veli', 'yok')).toBe(0);
    expect(permissionsOf(s, 'eski')).toBe(0);
  });

  it('rol ve sunucu olaylarıyla canlı güncellenir', () => {
    receive({ t: 'GUILD_MEMBER_UPDATE', d: { guildId: 'g', member: member(user('veli', ['mod'])) } });
    expect(can(useGuild.getState(), 'veli', P.KICK_MEMBERS)).toBe(true);
    const roles = legacy().roles.map((r) => (r.id === 'mod' ? { ...r, permissions: 0 } : r));
    receive({ t: 'ROLES_UPDATE', d: { guildId: 'g', roles } });
    expect(can(useGuild.getState(), 'veli', P.KICK_MEMBERS)).toBe(false);
    receive({ t: 'GUILD_UPDATE', d: { id: 'g', name: 'Test', ownerId: 'veli' } });
    expect(can(useGuild.getState(), 'veli', P.BAN_MEMBERS)).toBe(true);
  });

  it('kanal görünmez olunca oradaki ses durumları da gider', () => {
    receive({ t: 'CHANNEL_DELETE', d: { id: 'ses' } });
    expect(useGuild.getState().voiceStates).toEqual({});
  });

  it('rolleri olmayan (eski) sunucuda yöneticilik bayrağına göre tahmin edilir', () => {
    receive({ t: 'READY', d: toReady({ ...legacy(), roles: [], users: [user('mod', [], { isAdmin: true }), user('veli')] }) });
    const s = useGuild.getState();
    expect(can(s, 'mod', P.BAN_MEMBERS)).toBe(true);
    expect(can(s, 'veli', P.SEND_MESSAGES)).toBe(true);
    expect(can(s, 'veli', P.MANAGE_MESSAGES)).toBe(false);
  });
});

describe('görünüm', () => {
  it('üye listesi ayrı gösterilen rollere göre gruplanır; atılanlar görünmez', () => {
    const groups = memberGroups(useGuild.getState());
    expect(groups.map((g) => [g.title, g.members.map((m) => m.id)])).toEqual([
      ['admin', ['sahip']],
      ['mod', ['mod']],
      ['Çevrimiçi', ['ali']],
      ['Çevrimdışı', ['veli']],
    ]);
    expect(memberColorOf(useGuild.getState(), 'ali')).toBe('#2ecc71');
    expect(memberColorOf(useGuild.getState(), 'veli')).toBeNull();
  });

  it('kanal panelinde yalnızca kanalı görebilen üyeler listelenir', () => {
    receive({
      t: 'CHANNEL_UPDATE',
      d: channel('duyuru', 'text', [
        { roleId: 'g', allow: 0, deny: P.VIEW_CHANNEL },
        { roleId: 'mod', allow: P.VIEW_CHANNEL, deny: 0 },
      ]),
    });
    const s = useGuild.getState();
    // Yönetici (sahip) her kanalı görür; ali ve veli göremez
    expect(channelMemberGroups(s, 'duyuru').map((g) => [g.title, g.members.map((m) => m.id)])).toEqual([
      ['admin', ['sahip']],
      ['mod', ['mod']],
    ]);
    expect(channelMemberGroups(s, 'genel')).toEqual(memberGroups(s));
  });

  it('@everyone bahsetmesi herkesi, kendi mesajı kimseyi ilgilendirmez', () => {
    const me = { id: 'mod', username: 'mod' };
    expect(isMentioned({ content: 'selam @everyone', mentionEveryone: true, authorId: 'ali' }, me)).toBe(true);
    expect(isMentioned({ content: '@everyone', mentionEveryone: false, authorId: 'ali' }, me)).toBe(false);
    expect(isMentioned({ content: '@mod bak', mentionEveryone: false, authorId: 'ali' }, me)).toBe(true);
    expect(isMentioned({ content: '@everyone', mentionEveryone: true, authorId: 'mod' }, me)).toBe(false);
  });

  it('@here, bayrağı varsa @everyone gibi vurgulanır; bayraksız (yetkisiz) @here düz metindir', () => {
    const me = { id: 'mod', username: 'mod' };
    expect(isMentioned({ content: '@here', mentionEveryone: false, mentionHere: true, authorId: 'ali' }, me)).toBe(true);
    expect(isMentioned({ content: '@here', mentionEveryone: false, mentionHere: false, authorId: 'ali' }, me)).toBe(false);
    // Bayrağı bilmeyen eski sunucu
    expect(isMentioned({ content: '@here', mentionEveryone: false, authorId: 'ali' }, me)).toBe(false);
    expect(isMentioned({ content: '@here', mentionEveryone: false, mentionHere: true, authorId: 'mod' }, me)).toBe(false);
  });
});

describe('rol düzenleme ipuçları', () => {
  const everyone = DEFAULT_EVERYONE_PERMISSIONS;

  it('@everyone rolünde açık yetki diğer rollerde herkeste zaten var sayılır', () => {
    const role = { permissions: 0, isEveryone: false };
    expect(rolePermissionSource(role, everyone, P.MENTION_EVERYONE)).toBe('everyone');
    expect(rolePermissionSource(role, everyone, P.SEND_MESSAGES)).toBe('everyone');
    // @everyone'da kapalıysa rolün kendi ayarı geçerli
    expect(rolePermissionSource(role, everyone & ~P.MENTION_EVERYONE, P.MENTION_EVERYONE)).toBe('role');
    expect(rolePermissionSource(role, everyone, P.KICK_MEMBERS)).toBe('role');
    // @everyone rolünün kendisi hep kendi ayarı
    expect(rolePermissionSource({ permissions: everyone, isEveryone: true }, everyone, P.MENTION_EVERYONE)).toBe('role');
  });

  it('Yönetici rolünde diğer bütün yetkiler zaten var', () => {
    const admin = { permissions: P.ADMINISTRATOR, isEveryone: false };
    expect(rolePermissionSource(admin, 0, P.KICK_MEMBERS)).toBe('administrator');
    expect(rolePermissionSource(admin, everyone, P.SEND_MESSAGES)).toBe('administrator');
    expect(rolePermissionSource(admin, 0, P.ADMINISTRATOR)).toBe('role');
    // @everyone'da Yönetici (tehlikeli ama olası): herkeste her şey var
    expect(rolePermissionSource({ permissions: 0, isEveryone: false }, P.ADMINISTRATOR, P.BAN_MEMBERS)).toBe('everyone');
  });

  it('üyenin etkin yetkileri ve kaynakları', () => {
    const s = useGuild.getState();
    expect(effectivePermissions(s, 'sahip').all).toBe('owner');
    expect(effectivePermissions(s, 'eski')).toEqual({ all: null, granted: [] });
    expect(effectivePermissions(s, 'yok')).toEqual({ all: null, granted: [] });

    const veli = effectivePermissions(s, 'veli');
    expect(veli.all).toBeNull();
    expect(veli.granted.map((g) => g.info.name)).toEqual([
      'CREATE_INVITE',
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'ATTACH_FILES',
      'ADD_REACTIONS',
      'MENTION_EVERYONE',
      'CONNECT',
      'SPEAK',
      'STREAM',
    ]);
    expect(veli.granted.every((g) => g.roles.map((r) => r.id).join() === 'g')).toBe(true);

    const mod = effectivePermissions(s, 'mod');
    expect(mod.all).toBeNull();
    const kick = mod.granted.find((g) => g.info.name === 'KICK_MEMBERS')!;
    expect(kick.roles.map((r) => r.id)).toEqual(['mod']);
    expect(mod.granted.find((g) => g.info.name === 'MENTION_EVERYONE')!.roles.map((r) => r.id)).toEqual(['g']);

    // Yönetici rolü verilen üye
    receive({ t: 'GUILD_MEMBER_UPDATE', d: { guildId: 'g', member: member(user('veli', ['admin'])) } });
    const admin = effectivePermissions(useGuild.getState(), 'veli');
    expect(admin.all).toBe('administrator');
    expect(admin.granted[0]).toMatchObject({ info: { name: 'ADMINISTRATOR' } });
    expect(admin.granted[0]!.roles.map((r) => r.id)).toEqual(['admin']);
  });
});

describe('bahsetme önerileri', () => {
  it('@everyone ve @here yalnızca yetkisi olana önerilir', () => {
    expect(broadcastSuggestions('', true).map((m) => m.name)).toEqual(['everyone', 'here']);
    expect(broadcastSuggestions('H', true).map((m) => m.name)).toEqual(['here']);
    expect(broadcastSuggestions('ever', true).map((m) => m.name)).toEqual(['everyone']);
    expect(broadcastSuggestions('ali', true)).toEqual([]);
    expect(broadcastSuggestions('', false)).toEqual([]);
    // Direkt mesajda yetki yoktur
    receive({
      t: 'DM_CHANNEL_CREATE',
      d: {
        id: 'dm1',
        participantIds: ['mod', 'ali'],
        group: false,
        name: null,
        ownerId: null,
        createdAt: 1,
        lastMessageId: null,
        lastActivityAt: 1,
      },
    });
    const s = useGuild.getState();
    expect(can(s, 'mod', P.MENTION_EVERYONE, 'dm1')).toBe(false);
    expect(can(s, 'mod', P.MENTION_EVERYONE, 'genel')).toBe(true);
    // Salt okunur kanalda mesaj gönderemeyen herkesten de bahsedemez
    expect(can(s, 'mod', P.MENTION_EVERYONE, 'duyuru')).toBe(false);
  });
});

describe('üye yönetimi', () => {
  it('yetkiye ve hiyerarşiye göre yapılabilecekler', () => {
    const ali = memberActions('ali');
    expect(ali).toMatchObject({ kick: true, ban: false, mute: true, deafen: false, move: true });
    expect(ali.roles.map((r) => r.id)).toEqual(['dj']);
    // Sahip atılamaz; rol verme ve sesteki yönetim (susturma, taşıma) Discord'daki gibi hedefin seviyesine bakmaz
    expect(memberActions('sahip')).toMatchObject({ kick: false, ban: false });
    expect(memberActions('sahip').roles.map((r) => r.id)).toEqual(['dj']);
    // Kendini atamaz ama sesteyse kendini yönetebilir
    expect(memberActions('mod').kick).toBe(false);
    // Taşıma hedefleri: bulunduğu kanal ve üyenin bağlanamadığı kanal hariç
    expect(moveTargets(user('ali', ['dj'])).map((c) => c.id)).toEqual([]);
    receive({ t: 'CHANNEL_CREATE', d: channel('muzik', 'voice') });
    expect(moveTargets(user('ali', ['dj'])).map((c) => c.id)).toEqual(['muzik']);
    // Sürükle-bırak hedefleri: başkası için taşıma hedefleri; seste olmayan için hiçbiri, üstteki (sahip) de taşınabilir
    expect([...voiceDropTargets('ali')]).toEqual(['muzik']);
    expect(voiceDropTargets('sahip').size).toBe(0);
    receive({
      t: 'VOICE_STATE_UPDATE',
      d: { userId: 'sahip', channelId: 'ses', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, streaming: false, joinedAt: 2 },
    });
    expect(voiceDropTargets('sahip').size).toBeGreaterThan(0);
    // Kendini: bağlanabildiği her kanala (taşıma yetkisi aranmaz)
    receive({
      t: 'VOICE_STATE_UPDATE',
      d: { userId: 'mod', channelId: 'muzik', selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, streaming: false, joinedAt: 3 },
    });
    expect([...voiceDropTargets('mod')]).toEqual(['ses']);
  });

  it('kanal sıralama yardımcısı', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(reorderedIds(ids, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(reorderedIds(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderedIds(ids, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderedIds(ids, 'b', 'b', true)).toEqual(ids);
    expect(reorderedIds(ids, 'x', 'a', true)).toEqual(ids);
    expect(canReorderChannels()).toBe(false);
  });

  it('kanal izni düzenleme yardımcıları', () => {
    let list = setOverwriteState([], 'g', P.VIEW_CHANNEL, 'deny');
    list = setOverwriteState(list, 'dj', P.VIEW_CHANNEL, 'allow');
    expect(overwriteState(list.find((o) => o.roleId === 'g'), P.VIEW_CHANNEL)).toBe('deny');
    expect(overwriteState(list.find((o) => o.roleId === 'dj'), P.VIEW_CHANNEL)).toBe('allow');
    expect(overwriteState(undefined, P.VIEW_CHANNEL)).toBe('inherit');
    list = setOverwriteState(list, 'g', P.VIEW_CHANNEL, 'inherit');
    expect(list.map((o) => o.roleId)).toEqual(['dj']);
    expect(channelPermissionInfos('voice').map((p) => p.name)).toEqual([
      'VIEW_CHANNEL',
      'CONNECT',
      'SPEAK',
      'STREAM',
      'MUTE_MEMBERS',
      'DEAFEN_MEMBERS',
      'MOVE_MEMBERS',
    ]);
    const text = channelPermissionInfos('text');
    expect(text.map((p) => p.name)).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'ATTACH_FILES',
      'ADD_REACTIONS',
      'MANAGE_MESSAGES',
      'PIN_MESSAGES',
      'MENTION_EVERYONE',
    ]);
    expect(text.every((p) => !hasPermission(p.flag, P.CONNECT))).toBe(true);
  });
});
