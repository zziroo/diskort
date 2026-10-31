import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  Permission as P,
  type Channel,
  type GatewayServerMessage,
  type GuildData,
  type ReadyPayload,
  type User,
  type VoiceState,
} from '@diskort/shared';
import { configureClient, gateway, guildVoiceActivity, useGuild, useSession } from '../src';

const user = (id: string): User => ({ id, username: id, displayName: id.toUpperCase(), avatarColor: '#fff', isAdmin: false });

const voiceChannel = (id: string, guildId: string, hidden = false): Channel => ({
  id,
  guildId,
  name: id,
  type: 'voice',
  position: 0,
  overwrites: hidden ? [{ roleId: guildId, allow: 0, deny: P.VIEW_CHANNEL }] : [],
});

const guild = (id: string, ownerId: string, channels: Channel[]): GuildData => ({
  guild: { id, name: `Sunucu ${id}`, ownerId, iconUrl: null },
  channels,
  roles: [{ id, name: '@everyone', color: null, position: 0, hoist: false, permissions: DEFAULT_EVERYONE_PERMISSIONS }],
  members: ['ben', 'ali'].map((userId) => ({ userId, roles: [], joinedAt: 1, removed: false })),
  sounds: [],
});

const vs = (userId: string, channelId: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  userId,
  channelId,
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  streaming: false,
  joinedAt: 0,
  ...extra,
});

const index = (...states: VoiceState[]): Record<string, VoiceState> =>
  Object.fromEntries(states.map((s) => [s.userId, s]));

const ready = (): ReadyPayload => ({
  user: user('ben'),
  // Sahip 'ali': 'ben' sıradan üye (özel kanalı göremez)
  guilds: [
    guild('a', 'ali', [voiceChannel('a-ses', 'a'), voiceChannel('a-gizli', 'a', true)]),
    guild('b', 'ali', [voiceChannel('b-ses', 'b')]),
  ],
  users: [user('ben'), user('ali')],
  voiceStates: [],
  online: [],
  primaryGuildId: 'a',
  lastMessageIds: {},
  readStates: {},
  mentionCounts: {},
  attachmentMaxBytes: 1,
  dms: [],
});

const memory = new Map<string, string>();

beforeEach(async () => {
  memory.clear();
  useGuild.getState().reset();
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
    serverUrl: () => 'sunucu.test/',
    notifyError: () => undefined,
  });
  useSession.getState().setSession('jeton', user('ben'));
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(
    { t: 'READY', d: ready() },
    'jeton',
  );
});

const activity = (guildId: string, states: Record<string, VoiceState>, selfId: string | null = 'ben') =>
  guildVoiceActivity({ guilds: useGuild.getState().guilds, voiceStates: states }, guildId, selfId ?? undefined);

describe('sunucu çubuğu ses etkinliği', () => {
  it('kimse seste değilse rozet yok', () => {
    expect(activity('a', {})).toBeNull();
  });

  it('görülebilen bir ses kanalında biri varsa "voice"', () => {
    expect(activity('a', index(vs('ali', 'a-ses')))).toBe('voice');
  });

  it('yalnızca görünmeyen kanaldaki kişi rozet göstermez (varlık sızmaz)', () => {
    expect(activity('a', index(vs('ali', 'a-gizli')))).toBeNull();
    expect(activity('a', index(vs('ali', 'a-gizli', { streaming: true })))).toBeNull();
    // Görünen kanaldaki biri varsa yine sayılır
    expect(activity('a', index(vs('ali', 'a-gizli', { streaming: true }), vs('x', 'a-ses')))).toBe('voice');
  });

  it('yayın yapan varsa "stream", seste olanlardan önce gelir', () => {
    expect(activity('a', index(vs('x', 'a-ses'), vs('ali', 'a-ses', { streaming: true })))).toBe('stream');
  });

  it('başka sunucunun kanallarındaki kişiler sayılmaz', () => {
    const states = index(vs('ali', 'b-ses', { streaming: true }));
    expect(activity('a', states)).toBeNull();
    expect(activity('b', states)).toBe('stream');
  });

  it('kullanıcının kendisi de sayılır; bilinmeyen sunucu ya da oturumsuz durumda rozet yok', () => {
    expect(activity('a', index(vs('ben', 'a-ses')))).toBe('voice');
    expect(activity('yok', index(vs('ben', 'a-ses')))).toBeNull();
    expect(activity('a', index(vs('ben', 'a-ses')), null)).toBeNull();
  });
});
