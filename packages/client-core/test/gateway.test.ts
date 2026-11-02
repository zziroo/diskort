import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureClient, gateway, useGuild, useSession, type KeyValueStorage } from '../src';

const memory = new Map<string, string>();
const storage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

const me = { id: 'u1', username: 'ayse', displayName: 'Ayşe', avatarColor: '#fff', isAdmin: false, roles: [], removed: false };

/** Açılan bağlantıları kaydeden sahte WebSocket */
class FakeSocket {
  static OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  /** Ölü TCP yolu: close() çağrılsa da kapanış olayı gelmez */
  dead = false;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data).t);
  }
  close(code = 1000): void {
    this.closed = true;
    if (!this.dead) this.onclose?.({ code });
  }
  /** Sunucudan mesaj gelmiş gibi */
  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Bağlantı açıldı ve sunucu HELLO gönderdi */
  hello(heartbeatInterval: number): void {
    this.readyState = FakeSocket.OPEN;
    this.receive({ t: 'HELLO', d: { heartbeatInterval } });
  }
  /** Sunucu kimliği doğruladı */
  ready(): void {
    this.receive({
      t: 'READY',
      d: { user: me, users: [], guilds: [], voiceStates: [], online: [], lastMessageIds: {}, readStates: {}, mentionCounts: {} },
    });
  }
}

beforeEach(async () => {
  FakeSocket.opened = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  await configureClient({
    platform: 'android',
    version: '9.9.9',
    storage,
    serverUrl: () => 'http://sunucu.test',
    notifyError: () => undefined,
    upload: async () => ({ status: 0, body: '' }),
  });
  useSession.getState().setSession('jeton', me);
});

afterEach(() => {
  gateway.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('gateway bağlantısı', () => {
  it('zaten bağlıyken yeniden connect() çağrılınca çalışan bağlantı bozulmaz, ikinci bağlantı açılmaz', () => {
    gateway.connect();
    expect(FakeSocket.opened).toHaveLength(1);
    useGuild.setState({ status: 'ready' });

    // Telefonda Android ekranı yeniden kuruldu: kök yerleşim baştan çizilir ve yine connect() çağırır
    gateway.connect();
    gateway.resume();
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.opened[0]!.closed).toBe(false);
    expect(useGuild.getState().status).toBe('ready');
  });

  it('kopmuş bağlantıyı beklemeden yeniden açar; oturum kapanınca kapatır', () => {
    vi.useFakeTimers();
    gateway.connect();
    FakeSocket.opened[0]!.close(4000);
    // Yeniden bağlanma zamanlayıcısı beklerken connect()/resume() hemen bağlanır
    gateway.connect();
    expect(FakeSocket.opened).toHaveLength(2);
    FakeSocket.opened[1]!.hello(60_000);
    FakeSocket.opened[1]!.ready();
    // Bekleyen zamanlayıcı ikinci bir bağlantı açmaz
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.opened).toHaveLength(2);

    gateway.disconnect();
    expect(FakeSocket.opened[1]!.closed).toBe(true);
    // Çıkıştan sonra yeniden giriş: yeni bağlantı
    gateway.connect();
    expect(FakeSocket.opened).toHaveLength(3);
  });
});

describe('zorunlu çıkış', () => {
  const withSessionEnded = async (): Promise<ReturnType<typeof vi.fn>> => {
    const ended = vi.fn();
    await configureClient({
      platform: 'android',
      version: '9.9.9',
      storage,
      serverUrl: () => 'http://sunucu.test',
      notifyError: () => undefined,
      onSessionEnded: ended,
    });
    useSession.getState().setSession('jeton', me);
    return ended;
  };

  it('INVALID_SESSION oturumu kapatır ve platforma bildirir (ör. bildirim kaydı unutulsun)', async () => {
    const ended = await withSessionEnded();
    gateway.connect();
    FakeSocket.opened[0]!.receive({ t: 'INVALID_SESSION', d: {} });
    expect(useSession.getState().token).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('gateway 4004 kapanışı da bildirir; oturum açılırken bildirilmez', async () => {
    const ended = await withSessionEnded();
    expect(ended).not.toHaveBeenCalled();
    gateway.connect();
    FakeSocket.opened[0]!.close(4004);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('ölü bağlantı', () => {
  it('heartbeat yanıtsız kalınca kapanış olayını beklemeden yeniden bağlanır', () => {
    vi.useFakeTimers();
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.dead = true;
    first.hello(1000);
    first.ready();

    vi.advanceTimersByTime(1000); // HEARTBEAT gönderildi
    expect(first.sent).toContain('HEARTBEAT');
    vi.advanceTimersByTime(1000); // ACK gelmedi: bağlantı bırakılır
    expect(first.closed).toBe(true);
    expect(first.onclose).toBeNull();
    expect(useGuild.getState().status).toBe('reconnecting');

    // Kapanış olayı hiç gelmese de ilk bekleme sonunda yeni bağlantı açılır
    vi.advanceTimersByTime(500);
    expect(FakeSocket.opened).toHaveLength(2);
    // Eski bağlantıda çalan zamanlayıcı kalmaz
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('ACK gelirse heartbeat bağlantıyı bırakmaz', () => {
    vi.useFakeTimers();
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(1000);
    ws.ready();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      ws.receive({ t: 'HEARTBEAT_ACK' });
    }
    expect(ws.closed).toBe(false);
    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('resume(): açık görünen bağlantı yoklanır, yanıt gelmezse hemen yeniden bağlanılır', () => {
    vi.useFakeTimers();
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.hello(60_000);
    first.ready();
    first.dead = true;

    gateway.resume();
    expect(first.sent.filter((t) => t === 'HEARTBEAT')).toHaveLength(1);
    // Art arda resume() ikinci yoklama göndermez
    gateway.resume();
    expect(first.sent.filter((t) => t === 'HEARTBEAT')).toHaveLength(1);

    vi.advanceTimersByTime(4999);
    expect(FakeSocket.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('resume(): yoklamaya ACK gelirse bağlantı korunur', () => {
    vi.useFakeTimers();
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(60_000);
    ws.ready();

    gateway.resume();
    ws.receive({ t: 'HEARTBEAT_ACK' });
    vi.advanceTimersByTime(10_000);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.opened).toHaveLength(1);
  });
});

describe('READY öncesi', () => {
  it('IDENTIFY dışında her şey atılır; boşta durumu READY ile gider', () => {
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(60_000);
    expect(ws.sent).toEqual(['IDENTIFY']);

    gateway.send({ t: 'TYPING_START', d: { channelId: 'c1' } });
    gateway.setIdle(true);
    expect(ws.sent).toEqual(['IDENTIFY']);

    ws.ready();
    expect(ws.sent).toEqual(['IDENTIFY', 'IDLE_SET']);
    gateway.send({ t: 'TYPING_START', d: { channelId: 'c1' } });
    expect(ws.sent).toEqual(['IDENTIFY', 'IDLE_SET', 'TYPING_START']);
    gateway.setIdle(false); // Sonraki testlere boşta durumu kalmasın
  });

  it('resume() hiçbir şey yapmaz: yoklama gönderilmez, yoklama zaman aşımı çalışmaz', () => {
    vi.useFakeTimers();
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(60_000);

    gateway.resume();
    expect(ws.sent).toEqual(['IDENTIFY']);
    vi.advanceTimersByTime(14_000);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('heartbeat aralığı geçse de gönderilmez ve bağlantı bırakılmaz', () => {
    vi.useFakeTimers();
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(1000);

    vi.advanceTimersByTime(5000);
    expect(ws.sent).toEqual(['IDENTIFY']);
    expect(ws.closed).toBe(false);

    // READY'den sonra heartbeat normal işler
    ws.ready();
    vi.advanceTimersByTime(1000);
    expect(ws.sent).toEqual(['IDENTIFY', 'HEARTBEAT']);
  });
});

describe('READY zaman aşımı', () => {
  it('el sıkışma takılırsa bağlantı bırakılır ve yeniden bağlanılır', () => {
    vi.useFakeTimers();
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.dead = true; // Soket hiç açılmadı, HELLO da gelmedi

    vi.advanceTimersByTime(14_999);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(first.onclose).toBeNull();
    expect(useGuild.getState().status).toBe('reconnecting');

    vi.advanceTimersByTime(500);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('HELLO geldi READY gelmediyse de yeniden bağlanılır; yeni bağlantının süresi baştan başlar', () => {
    vi.useFakeTimers();
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.dead = true;
    first.hello(60_000);

    vi.advanceTimersByTime(15_000 + 500);
    expect(first.closed).toBe(true);
    expect(FakeSocket.opened).toHaveLength(2);

    const second = FakeSocket.opened[1]!;
    vi.advanceTimersByTime(14_999);
    expect(second.closed).toBe(false);
  });

  it('READY süreyi iptal eder', () => {
    vi.useFakeTimers();
    gateway.connect();
    const ws = FakeSocket.opened[0]!;
    ws.hello(60_000);
    ws.ready();

    vi.advanceTimersByTime(30_000);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('süre dolunca heartbeat ikinci bir yeniden bağlanma kurmaz', () => {
    vi.useFakeTimers();
    gateway.connect();
    const first = FakeSocket.opened[0]!;
    first.dead = true;
    first.hello(1000);

    // Süre dolduğu anda heartbeat da çalışır; ardından yalnızca bir yeni bağlantı açılmalı
    vi.advanceTimersByTime(15_000);
    expect(first.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.opened).toHaveLength(2);
    FakeSocket.opened[1]!.hello(60_000);
    FakeSocket.opened[1]!.ready();
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('kapanış olayı ve çıkış süreyi temizler', () => {
    vi.useFakeTimers();
    gateway.connect();
    FakeSocket.opened[0]!.close(4000); // Kapanış: yalnızca yeniden bağlanma zamanlayıcısı kalır
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.opened).toHaveLength(2);

    gateway.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });
});
