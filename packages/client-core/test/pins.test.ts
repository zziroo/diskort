import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayServerMessage, Message, PinnedMessage } from '@diskort/shared';
import {
  configureClient,
  gateway,
  openPins,
  pinMessage,
  unpinMessage,
  useMessages,
  usePins,
  useSession,
  type KeyValueStorage,
} from '../src';

const memory = new Map<string, string>();
const storage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};
const errors: string[] = [];
const me = { id: 'u1', username: 'ayse', displayName: 'Ayşe', avatarColor: '#fff', isAdmin: false };

const message = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: 'c1',
  authorId: 'u2',
  content,
  createdAt: 1,
  editedAt: null,
  attachments: [],
  reactions: [],
  mentionEveryone: false,
  ...extra,
});
const pinned = (id: string, content: string, pinnedAt: number): PinnedMessage => ({
  ...message(id, content),
  pinned: true,
  pinnedAt,
  pinnedBy: 'u2',
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  errors.length = 0;
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage,
    serverUrl: () => 'http://sunucu.test',
    notifyError: (m) => errors.push(m),
  });
  useSession.getState().setSession('jeton', me);
  usePins.setState({ channels: {}, unseen: {} });
  useMessages.setState({
    channels: { c1: { messages: [message('5', 'bir'), message('6', 'iki')], hasMore: false, loading: false, loaded: true } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sabitlenmiş mesajlar', () => {
  it('liste açılınca istenir; açıkken gelen değişiklik listeyi yeniler, nokta yanmaz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([pinned('5', 'bir', 10)])));
    const close = openPins('c1');
    await flush();
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['5']);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://sunucu.test/api/channels/c1/pins');

    vi.stubGlobal('fetch', vi.fn(async () => json([pinned('6', 'iki', 20), pinned('5', 'bir', 10)])));
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c1', lastPinAt: 20 } });
    await flush();
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['6', '5']);
    expect(usePins.getState().unseen.c1).toBeUndefined();

    // Düzenlenen sabit mesaj listede güncellenir; silinen listeden çıkar
    receive({ t: 'MESSAGE_UPDATE', d: { ...message('6', 'iki (düzenlendi)'), pinned: true } });
    expect(usePins.getState().channels.c1!.items[0]!.content).toBe('iki (düzenlendi)');
    receive({ t: 'MESSAGE_DELETE', d: { id: '5', channelId: 'c1' } });
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['6']);
    close();
  });

  it('liste kapalıyken başkasının yeni sabitlemesi nokta yakar (kaldırması yakmaz); açınca söner', async () => {
    const now = Date.now();
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c2', lastPinAt: now } });
    expect(usePins.getState().unseen.c2).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => json([])));
    const close = openPins('c2');
    expect(usePins.getState().unseen.c2).toBeUndefined();
    close();
    // Başka bir sabitleme kaldırıldı: son sabitleme zamanı aynı kaldı ya da geriledi
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c2', lastPinAt: now } });
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c2', lastPinAt: now - 5000 } });
    expect(usePins.getState().unseen.c2).toBeUndefined();
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c2', lastPinAt: now + 1 } });
    expect(usePins.getState().unseen.c2).toBe(true);
  });

  it('eskimiş liste yenilenemezse eskimiş kalır: sonraki açılışta yeniden istenir', async () => {
    usePins.setState({
      channels: { c1: { items: [pinned('5', 'bir', 10)], loaded: true, loading: false, stale: true } },
    });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'server', message: 'Sunucu hatası.' }, 500)));
    openPins('c1')();
    await flush();
    expect(usePins.getState().channels.c1).toMatchObject({ loading: false, stale: true });
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['5']);
    expect(errors).toEqual(['Sunucu hatası.']);

    vi.stubGlobal('fetch', vi.fn(async () => json([pinned('6', 'iki', 20)])));
    openPins('c1')();
    await flush();
    expect(usePins.getState().channels.c1).toMatchObject({ loading: false, stale: false });
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['6']);
  });

  it('kendi sabitlememiz mesajı işaretler ve nokta yakmaz; kaldırma hemen listeden çıkarır, hata olursa geri alır', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await pinMessage({ id: '5', channelId: 'c1' })).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('http://sunucu.test/api/channels/c1/pins/5');
    expect(init?.method).toBe('PUT');
    expect(useMessages.getState().channels.c1!.messages[0]!.pinned).toBe(true);
    receive({ t: 'CHANNEL_PINS_UPDATE', d: { channelId: 'c1', lastPinAt: 40 } });
    expect(usePins.getState().unseen.c1).toBeUndefined();

    usePins.setState({
      channels: { c1: { items: [pinned('5', 'bir', 40)], loaded: true, loading: false, stale: false } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'forbidden', message: 'Bu kanalda mesaj sabitleme iznin yok.' }, 403)),
    );
    const pending = unpinMessage({ id: '5', channelId: 'c1' });
    expect(usePins.getState().channels.c1!.items).toEqual([]);
    expect(await pending).toBe(false);
    expect(usePins.getState().channels.c1!.items.map((m) => m.id)).toEqual(['5']);
    expect(errors).toEqual(['Bu kanalda mesaj sabitleme iznin yok.']);
  });
});
