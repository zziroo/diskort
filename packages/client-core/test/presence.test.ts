import { beforeEach, describe, expect, it } from 'vitest';
import { clearAfterMs, type GatewayServerMessage, type ReadyPayload, type User } from '@diskort/shared';
import { configureClient, displayStatusOf, formatRemaining, gateway, onMobileOf, useGuild, useSession } from '../src';

const user = (id: string): User => ({ id, username: id, displayName: id, avatarColor: '#fff', isAdmin: false });

const ready = (extra: Partial<ReadyPayload> = {}): ReadyPayload => ({
  user: user('ben'),
  guilds: [],
  users: [user('ben'), user('ali'), user('veli')],
  voiceStates: [],
  online: ['ben', 'ali'],
  primaryGuildId: null,
  lastMessageIds: {},
  readStates: {},
  mentionCounts: {},
  attachmentMaxBytes: 1,
  ...extra,
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

const status = (id: string) => displayStatusOf(useGuild.getState(), id, 'ben');

beforeEach(async () => {
  useGuild.getState().reset();
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    serverUrl: () => 'sunucu.test/',
    notifyError: () => undefined,
  });
  useSession.getState().setSession('jeton', user('ben'));
});

describe('durum', () => {
  it('eski sunucu: çevrimiçi olanlar "online", kendi ayarın yok', () => {
    receive({ t: 'READY', d: ready() });
    expect(status('ali')).toBe('online');
    expect(status('veli')).toBe('offline');
    expect(status('ben')).toBe('online');
    expect(useGuild.getState().selfStatus).toBeNull();
    // Eski biçimli PRESENCE_UPDATE de çalışır
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'veli', online: true } });
    expect(status('veli')).toBe('online');
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ali', online: false } });
    expect(status('ali')).toBe('offline');
    expect(useGuild.getState().online.ali).toBeUndefined();
  });

  it('yeni sunucu: durumlar, özel durum ve kendi görünmezliğin', () => {
    receive({
      t: 'READY',
      d: ready({
        online: ['ali'],
        presences: { ali: { status: 'dnd', customStatus: { text: 'odak', emoji: null } } },
        status: { status: 'invisible', expiresAt: null, customStatus: null, customStatusExpiresAt: null },
      }),
    });
    expect(status('ali')).toBe('dnd');
    // Kendin görünmezsin (başkaları çevrimdışı görür)
    expect(status('ben')).toBe('invisible');
    const before = useGuild.getState().presences;
    receive({
      t: 'PRESENCE_UPDATE',
      d: { userId: 'ali', online: true, status: 'dnd', customStatus: { text: 'odak', emoji: null } },
    });
    // Değişmeyen durum yeni nesne üretmez
    expect(useGuild.getState().presences).toBe(before);
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ali', online: true, status: 'idle', customStatus: null } });
    expect(status('ali')).toBe('idle');
    receive({
      t: 'USER_STATUS_UPDATE',
      d: { status: 'online', expiresAt: null, customStatus: null, customStatusExpiresAt: null },
    });
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ben', online: true, status: 'idle', customStatus: null } });
    // Otomatik boşta kendi noktanda da görünür
    expect(status('ben')).toBe('idle');
  });

  it('yalnızca telefondan bağlı: READY ve PRESENCE_UPDATE ile gelir, değişince güncellenir; eski sunucuda yok', () => {
    const mobile = (id: string | null) => onMobileOf(useGuild.getState(), id);
    receive({
      t: 'READY',
      d: ready({
        online: ['ali', 'veli'],
        presences: {
          ali: { status: 'online', customStatus: null, activities: [], mobile: true },
          veli: { status: 'idle', customStatus: null, activities: [] },
        },
      }),
    });
    expect(mobile('ali')).toBe(true);
    expect(mobile('veli')).toBe(false);
    expect(mobile('ben')).toBe(false);
    expect(mobile(null)).toBe(false);

    // Masaüstü açıldı: alan yok (normal nokta); yalnızca bu değişse de yeni nesne
    const before = useGuild.getState().presences;
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ali', online: true, status: 'online', customStatus: null, activities: [] } });
    expect(useGuild.getState().presences).not.toBe(before);
    expect(mobile('ali')).toBe(false);
    // Son masaüstü kapandı: yeniden telefon; durum rengi ayrı (boşta)
    receive({
      t: 'PRESENCE_UPDATE',
      d: { userId: 'ali', online: true, status: 'idle', customStatus: null, activities: [], mobile: true },
    });
    expect(mobile('ali')).toBe(true);
    expect(status('ali')).toBe('idle');
    // Aynısı tekrar gelirse nesne değişmez
    const same = useGuild.getState().presences;
    receive({
      t: 'PRESENCE_UPDATE',
      d: { userId: 'ali', online: true, status: 'idle', customStatus: null, activities: [], mobile: true },
    });
    expect(useGuild.getState().presences).toBe(same);
    // Çevrimdışı (ya da görünmez): telefon da yok
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ali', online: false, status: 'offline', customStatus: null } });
    expect(mobile('ali')).toBe(false);
    // Eski biçimli PRESENCE_UPDATE (alan yok)
    receive({ t: 'PRESENCE_UPDATE', d: { userId: 'ali', online: true } });
    expect(mobile('ali')).toBe(false);
    expect(status('ali')).toBe('online');
  });

  it('süre yardımcıları', () => {
    const now = new Date(2026, 0, 1, 22, 0, 0);
    expect(clearAfterMs('today', now)).toBe(2 * 60 * 60_000);
    expect(clearAfterMs(null)).toBeNull();
    expect(formatRemaining(Date.now() + 15 * 60_000)).toBe('15 dakika sonra');
    expect(formatRemaining(Date.now() + 3 * 24 * 60 * 60_000)).toBe('3 gün sonra');
    expect(formatRemaining(null)).toBeNull();
  });
});
