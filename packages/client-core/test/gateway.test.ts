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

    gateway.resume();
    ws.receive({ t: 'HEARTBEAT_ACK' });
    vi.advanceTimersByTime(10_000);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.opened).toHaveLength(1);
  });
});
