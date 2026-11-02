import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_ELAPSED_MAX_MS, ACTIVITY_MAX_COUNT, type ActivityReport } from '@diskort/shared';
import { configureClient, ensureActivityIcon, gateway, setActivities, useSession, type KeyValueStorage } from '../src';

const memory = new Map<string, string>();
const storage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

const me = { id: 'u1', username: 'ayse', displayName: 'Ayşe', avatarColor: '#fff', isAdmin: false, roles: [], removed: false };

const ready = {
  user: me,
  guilds: [],
  users: [me],
  voiceStates: [],
  online: ['u1'],
  primaryGuildId: null,
  lastMessageIds: {},
  readStates: {},
  mentionCounts: {},
  attachmentMaxBytes: 1,
};

/** Gönderilen mesajları kaydeden sahte WebSocket */
class FakeSocket {
  static OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  sent: { t: string; d?: unknown }[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.onclose?.({ code });
  }
  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Bağlantı açıldı, kimlik doğrulandı */
  identify(): void {
    this.readyState = FakeSocket.OPEN;
    this.receive({ t: 'HELLO', d: { heartbeatInterval: 600_000 } });
    this.receive({ t: 'READY', d: ready });
  }
  /** Gönderilen ACTIVITY_SET listeleri */
  get activities(): ActivityReport[][] {
    return this.sent.filter((m) => m.t === 'ACTIVITY_SET').map((m) => (m.d as { activities: ActivityReport[] }).activities);
  }
}

const game = (elapsedMs: number, extra: Partial<ActivityReport> = {}): ActivityReport => ({
  type: 'game',
  name: 'Portal 2',
  icon: null,
  elapsedMs,
  ...extra,
});

beforeEach(async () => {
  FakeSocket.opened = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage,
    serverUrl: () => 'http://sunucu.test/',
    notifyError: () => undefined,
  });
  useSession.getState().setSession('jeton', me);
});

afterEach(() => {
  setActivities([]);
  gateway.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('etkinlik bildirimi', () => {
  it('bağlıyken hemen gönderilir; aynı liste yeniden gönderilmez, bitince boş liste gider', () => {
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.identify();
    expect(ws.activities).toEqual([]);

    setActivities([game(60_000)]);
    expect(ws.activities).toEqual([[game(60_000)]]);
    // 10 sn sonra aynı oyun (başlangıcı aynı) yeniden bildirilirse gönderilmez
    vi.advanceTimersByTime(10_000);
    setActivities([game(70_000)]);
    setActivities([game(70_900)]);
    expect(ws.activities).toHaveLength(1);

    // İkon yüklenince aynı oyun ikonuyla yeniden bildirilir
    setActivities([game(70_000, { icon: 'a'.repeat(64) })]);
    expect(ws.activities[1]).toEqual([game(70_000, { icon: 'a'.repeat(64) })]);

    setActivities([]);
    setActivities([]);
    expect(ws.activities).toEqual([[game(60_000)], [game(70_000, { icon: 'a'.repeat(64) })], []]);
  });

  it('başka oyun, başka başlangıç ya da ikinci oyun yeniden gönderilir', () => {
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.identify();
    setActivities([game(60_000)]);
    setActivities([game(60_000, { name: 'ELDEN RING' })]);
    setActivities([game(5_000, { name: 'ELDEN RING' })]);
    setActivities([game(5_000, { name: 'ELDEN RING' }), game(60_000)]);
    setActivities([game(5_000, { name: 'ELDEN RING' }), game(60_000)]);
    setActivities([game(60_000)]);
    expect(ws.activities.map((list) => list.map((a) => [a.name, a.elapsedMs]))).toEqual([
      [['Portal 2', 60_000]],
      [['ELDEN RING', 60_000]],
      [['ELDEN RING', 5_000]],
      [
        ['ELDEN RING', 5_000],
        ['Portal 2', 60_000],
      ],
      [['Portal 2', 60_000]],
    ]);
  });

  it('liste en son başlayandan eskiye sıralanır ve en fazla dört etkinlik tutulur', () => {
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.identify();
    setActivities([50_000, 10_000, 40_000, 20_000, 30_000, 60_000].map((elapsed) => game(elapsed, { name: `Oyun ${elapsed}` })));
    expect(ws.activities[0]!.map((a) => a.elapsedMs)).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect(ws.activities[0]).toHaveLength(ACTIVITY_MAX_COUNT);
  });

  it('kimlik doğrulanmadan gönderilmez; READY gelince geçen süre o ana göre bildirilir', () => {
    setActivities([game(60_000)]);
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.readyState = FakeSocket.OPEN;
    ws.receive({ t: 'HELLO', d: { heartbeatInterval: 600_000 } });
    setActivities([game(60_000, { icon: 'b'.repeat(64) })]);
    expect(ws.activities).toEqual([]);

    vi.advanceTimersByTime(10_000);
    ws.receive({ t: 'READY', d: ready });
    expect(ws.activities).toEqual([[game(70_000, { icon: 'b'.repeat(64) })]]);
  });

  it('yeniden bağlanınca tam liste yeniden bildirilir; süreler yerel başlangıçtan hesaplanır', () => {
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.identify();
    setActivities([game(5_000, { name: 'ELDEN RING' }), game(60_000)]);

    vi.advanceTimersByTime(120_000);
    first.close(4000);
    vi.advanceTimersByTime(500); // ilk yeniden bağlanma beklemesi
    const second = FakeSocket.opened[1]!;
    expect(second.activities).toEqual([]);
    second.identify();
    expect(second.activities).toEqual([[game(125_500, { name: 'ELDEN RING' }), game(180_500)]]);
  });

  it('etkinlik yokken yeniden bağlanınca bir şey gönderilmez', () => {
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.identify();
    setActivities([game(1000)]);
    setActivities([]);
    first.close(4000);
    vi.advanceTimersByTime(500);
    FakeSocket.opened[1]!.identify();
    expect(FakeSocket.opened[1]!.activities).toEqual([]);
  });

  it('süre sınırlanır: negatif 0 olur, çok eski başlangıç en fazla bir hafta', () => {
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.identify();
    setActivities([game(-5000)]);
    expect(ws.activities[0]![0]!.elapsedMs).toBe(0);
    setActivities([game(ACTIVITY_ELAPSED_MAX_MS * 3, { name: 'Eski' })]);
    expect(ws.activities[1]![0]!.elapsedMs).toBe(ACTIVITY_ELAPSED_MAX_MS);
  });

  it('çıkış yapılıp yeniden girilince süren etkinlik yeniden bildirilir', () => {
    gateway.connect();
    FakeSocket.opened[0]!.identify();
    setActivities([game(1000)]);
    gateway.disconnect();
    gateway.connect();
    FakeSocket.opened[1]!.identify();
    expect(FakeSocket.opened[1]!.activities).toEqual([[game(1000)]]);
  });
});

describe('etkinlik ikonu', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let n = 0;
  /** Her test kendi anahtarını kullanır (yüklenenler oturum boyunca hatırlanır) */
  const newKey = (): string => (++n).toString(16).padStart(64, '0');

  const stubFetch = (respond: (method: string) => number | Error) => {
    const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
      calls.push({ method: init.method, url, headers: init.headers, body: init.body });
      const result = respond(init.method);
      if (result instanceof Error) throw result;
      return { ok: result >= 200 && result < 300, status: result };
    });
    return calls;
  };

  it('sunucuda varsa yüklenmez; sonraki sefer sorulmaz bile', async () => {
    const key = newKey();
    const calls = stubFetch(() => 200);
    const read = vi.fn(async () => png);
    expect(await ensureActivityIcon(key, read)).toBe(true);
    expect(await ensureActivityIcon(key, read)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['HEAD']);
    expect(calls[0]!.url).toBe(`http://sunucu.test/api/activity-icons/${key}`);
    expect(read).not.toHaveBeenCalled();
  });

  it('sunucuda yoksa PNG olarak yüklenir (oturum jetonuyla)', async () => {
    const key = newKey();
    const calls = stubFetch((method) => (method === 'HEAD' ? 404 : 201));
    expect(await ensureActivityIcon(key, async () => png)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
    expect(calls[1]!.headers).toEqual({ Authorization: 'Bearer jeton', 'Content-Type': 'image/png' });
    expect(calls[1]!.body).toBe(png);
  });

  it('eski sunucu (uç yok) ya da reddedilen yükleme: ikonsuz kalır ve yeniden denenmez', async () => {
    const key = newKey();
    const calls = stubFetch(() => 404);
    expect(await ensureActivityIcon(key, async () => png)).toBe(false);
    expect(await ensureActivityIcon(key, async () => png)).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
  });

  it('ağ hatası ve okunamayan ikon da başarısız sayılır', async () => {
    const offline = newKey();
    const calls = stubFetch(() => new Error('ağ yok'));
    expect(await ensureActivityIcon(offline, async () => png)).toBe(false);
    expect(await ensureActivityIcon(offline, async () => png)).toBe(false);
    expect(calls).toHaveLength(1);

    const unreadable = newKey();
    const more = stubFetch(() => 404);
    expect(await ensureActivityIcon(unreadable, async () => null)).toBe(false);
    expect(more.map((c) => c.method)).toEqual(['HEAD']);
  });

  it('geçici hata (ağ, 5xx, 429, 401) birkaç dakika sonra yeniden denenir', async () => {
    for (const failure of [new Error('ağ yok'), 503, 429, 401]) {
      const key = newKey();
      let calls = stubFetch((method) => (method === 'HEAD' ? 404 : failure));
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
      vi.advanceTimersByTime(4 * 60_000);
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      expect(calls).toHaveLength(2);

      vi.advanceTimersByTime(60_001);
      calls = stubFetch((method) => (method === 'HEAD' ? 404 : 201));
      expect(await ensureActivityIcon(key, async () => png)).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
    }
  });

  it('sunucunun kesin reddi (4xx) süre geçse de yeniden denenmez', async () => {
    for (const status of [400, 413, 415]) {
      const key = newKey();
      const calls = stubFetch((method) => (method === 'HEAD' ? 404 : status));
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      vi.advanceTimersByTime(60 * 60_000);
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
    }
  });

  it('eski sunucu (PUT 404/405) kalıcı sayılmaz: sunucu güncellenince yeniden denenir', async () => {
    for (const status of [404, 405]) {
      const key = newKey();
      const calls = stubFetch((method) => (method === 'HEAD' ? 404 : status));
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(await ensureActivityIcon(key, async () => png)).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT', 'HEAD', 'PUT']);
    }
  });

  it('HEAD 401 ya da 5xx dönerse körlemesine yüklenmez; sonra yeniden sorulur', async () => {
    for (const status of [401, 500, 429]) {
      const key = newKey();
      const read = vi.fn(async () => png);
      const calls = stubFetch(() => status);
      expect(await ensureActivityIcon(key, read)).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(['HEAD']);
      expect(read).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(await ensureActivityIcon(key, read)).toBe(false);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD']);
    }
  });

  it('oturum ya da sunucu adresi değişince bilinenler unutulur', async () => {
    const key = newKey();
    let calls = stubFetch(() => 404);
    expect(await ensureActivityIcon(key, async () => png)).toBe(false);
    expect(calls).toHaveLength(2);

    // Başka hesapla giriş: kesin ret de unutulur
    useSession.getState().setSession('baska-jeton', me);
    calls = stubFetch((method) => (method === 'HEAD' ? 404 : 201));
    expect(await ensureActivityIcon(key, async () => png)).toBe(true);
    expect(calls[1]!.headers.Authorization).toBe('Bearer baska-jeton');

    // Başka sunucu: orada olup olmadığı yeniden sorulur
    await configureClient({
      platform: 'desktop',
      version: '9.9.9',
      storage,
      serverUrl: () => 'http://baska.test',
      notifyError: () => undefined,
    });
    useSession.getState().setSession('baska-jeton', me);
    calls = stubFetch(() => 200);
    expect(await ensureActivityIcon(key, async () => png)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`http://baska.test/api/activity-icons/${key}`]);
  });

  it('aynı anda iki istek tek yükleme yapar', async () => {
    const key = newKey();
    const calls = stubFetch((method) => (method === 'HEAD' ? 404 : 200));
    const results = await Promise.all([ensureActivityIcon(key, async () => png), ensureActivityIcon(key, async () => png)]);
    expect(results).toEqual([true, true]);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
  });

  it('geçersiz anahtar ve kapalı oturum: hiçbir istek yapılmaz; girişten sonra denenir', async () => {
    const calls = stubFetch(() => 200);
    expect(await ensureActivityIcon('../kotu', async () => png)).toBe(false);
    const key = newKey();
    useSession.getState().logout();
    expect(await ensureActivityIcon(key, async () => png)).toBe(false);
    expect(calls).toHaveLength(0);
    useSession.getState().setSession('jeton', me);
    expect(await ensureActivityIcon(key, async () => png)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
