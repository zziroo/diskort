import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, GatewayServerMessage, Message } from '@diskort/shared';
import {
  ackChannel,
  addFiles,
  api,
  ApiError,
  configureClient,
  discardMessage,
  EMOJI_CATEGORIES,
  flushAcks,
  gateway,
  loadInitial,
  loadOlder,
  retryMessage,
  sendMessage,
  toggleReaction,
  uploadProgress,
  useGuild,
  useMessages,
  useSession,
  type KeyValueStorage,
  type LocalFile,
  type LocalMessage,
  type UploadRequest,
  type UploadResponse,
} from '../src';

const memory = new Map<string, string>();
const storage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

const errors: string[] = [];
const mentioned: Message[] = [];
let viewing: string | null = null;
let uploadImpl: (req: UploadRequest) => Promise<UploadResponse> = async () => ({ status: 0, body: '' });

const me = { id: 'u1', username: 'ayse', displayName: 'Ayşe', avatarColor: '#fff', isAdmin: false, roles: [], removed: false };

const message = (id: string, content: string, authorId = 'u2'): Message => ({
  id,
  channelId: 'c1',
  authorId,
  content,
  createdAt: Date.now(),
  editedAt: null,
  attachments: [],
  reactions: [],
  mentionEveryone: false,
});

/** Gateway'den mesaj gelmiş gibi yap */
const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

beforeEach(async () => {
  memory.clear();
  errors.length = 0;
  mentioned.length = 0;
  viewing = null;
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage,
    serverUrl: () => 'http://sunucu.test',
    notifyError: (m) => errors.push(m),
    isViewingChannel: (id) => id === viewing,
    onMention: (m) => mentioned.push(m),
    upload: (req) => uploadImpl(req),
  });
  useSession.getState().setSession('jeton', me);
  useMessages.setState({
    channels: { c1: { messages: [], hasMore: false, loading: false, loaded: true } },
    pendingFiles: {},
  });
});

describe('oturum', () => {
  it('platform deposuna yazılır ve yeniden yüklenir', async () => {
    expect(JSON.parse(memory.get('diskort-session')!).state.token).toBe('jeton');
    // Uygulama yeniden açılmış gibi: depodaki oturum okunur
    memory.set('diskort-session', JSON.stringify({ state: { token: 'yeni', user: { ...me, displayName: 'A' } }, version: 0 }));
    await useSession.persist.rehydrate();
    expect(useSession.getState()).toMatchObject({ token: 'yeni', user: { displayName: 'A' } });
  });
});

describe('mesaj gönderme', () => {
  it('bekleyen mesaj sunucu onayıyla yer değiştirir ve okundu sayılır', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    sendMessage('c1', 'selam');
    expect(useMessages.getState().channels.c1!.messages).toMatchObject([{ content: 'selam', status: 'pending' }]);

    resolve(new Response(JSON.stringify(message('7', 'selam', 'u1')), { status: 201 }));
    await vi.waitFor(() => expect(useMessages.getState().channels.c1!.messages[0]!.status).toBeUndefined());
    expect(useMessages.getState().channels.c1!.messages).toMatchObject([{ id: '7', content: 'selam' }]);
    expect(useGuild.getState().readStates.c1).toBe('7');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('http://sunucu.test/api/channels/c1/messages');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer jeton');
  });

  it('gönderilemeyen mesaj başarısız işaretlenir ve hata platforma bildirilir', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'Yavaşla.' }), { status: 429 })));
    sendMessage('c1', 'çok hızlı');
    await vi.waitFor(() => expect(useMessages.getState().channels.c1!.messages[0]!.status).toBe('failed'));
    expect(errors).toEqual(['Yavaşla.']);
  });
});

describe('gateway olayları', () => {
  it('bakılmayan kanaldaki bahsetme sayılır ve platforma iletilir; bakılan kanalda sayılmaz', () => {
    receive({ t: 'MESSAGE_CREATE', d: message('10', '@ayse bak') });
    expect(useMessages.getState().mentionCounts.c1).toBe(1);
    expect(mentioned.map((m) => m.id)).toEqual(['10']);

    viewing = 'c1';
    receive({ t: 'MESSAGE_CREATE', d: message('11', '@ayse tekrar') });
    expect(useMessages.getState().mentionCounts.c1).toBe(1);
    expect(useMessages.getState().channels.c1!.messages.map((m) => m.id)).toEqual(['10', '11']);

    // Yetkili yazarın @everyone bahsetmesi de sayılır (sunucu işaretler); işaretsiz olan sayılmaz
    viewing = null;
    receive({ t: 'MESSAGE_CREATE', d: { ...message('12', '@everyone akşam?'), mentionEveryone: true } });
    receive({ t: 'MESSAGE_CREATE', d: message('13', '@everyone yetkisiz') });
    expect(useMessages.getState().mentionCounts.c1).toBe(2);
    expect(mentioned.map((m) => m.id)).toEqual(['10', '12']);
  });

  it('silinen ve düzenlenen mesajlar listeye yansır', () => {
    receive({ t: 'MESSAGE_CREATE', d: message('20', 'ilk') });
    receive({ t: 'MESSAGE_UPDATE', d: { ...message('20', 'düzeltildi'), editedAt: 1 } });
    expect(useMessages.getState().channels.c1!.messages[0]!.content).toBe('düzeltildi');
    receive({ t: 'MESSAGE_DELETE', d: { id: '20', channelId: 'c1' } });
    expect(useMessages.getState().channels.c1!.messages).toEqual([]);
  });
});

describe('tepkiler', () => {
  const reactions = () => useMessages.getState().channels.c1!.messages[0]!.reactions;
  const event = (t: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', userId: string, emoji = '👍') =>
    receive({ t, d: { messageId: '30', channelId: 'c1', userId, emoji } });

  beforeEach(() => receive({ t: 'MESSAGE_CREATE', d: message('30', 'tepki ver') }));

  it('başkalarının tepkileri sayılır; sayı sıfıra inince tepki kalkar', () => {
    event('MESSAGE_REACTION_ADD', 'u2');
    event('MESSAGE_REACTION_ADD', 'u3');
    event('MESSAGE_REACTION_ADD', 'u2', '🔥');
    expect(reactions()).toEqual([
      { emoji: '👍', count: 2, me: false },
      { emoji: '🔥', count: 1, me: false },
    ]);
    event('MESSAGE_REACTION_REMOVE', 'u2');
    event('MESSAGE_REACTION_REMOVE', 'u3');
    expect(reactions()).toEqual([{ emoji: '🔥', count: 1, me: false }]);
  });

  it('kendi tepkimiz hemen görünür, gateway onayı iki kez saymaz; düzenleme tepkileri silmez', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    event('MESSAGE_REACTION_ADD', 'u2');
    await toggleReaction('c1', '30', '👍');
    expect(reactions()).toEqual([{ emoji: '👍', count: 2, me: true }]);
    event('MESSAGE_REACTION_ADD', 'u1'); // kendi olayımız
    expect(reactions()).toEqual([{ emoji: '👍', count: 2, me: true }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`http://sunucu.test/api/messages/30/reactions/${encodeURIComponent('👍')}`);
    expect(init!.method).toBe('PUT');

    const { reactions: _omit, ...update } = { ...message('30', 'düzeltildi'), editedAt: 2 };
    receive({ t: 'MESSAGE_UPDATE', d: update });
    expect(reactions()).toEqual([{ emoji: '👍', count: 2, me: true }]);

    await toggleReaction('c1', '30', '👍');
    expect(reactions()).toEqual([{ emoji: '👍', count: 1, me: false }]);
    expect(vi.mocked(fetch).mock.calls[1]![1]!.method).toBe('DELETE');
  });

  it('sunucu reddederse tepki geri alınır ve hata gösterilir', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'Yavaşla.' }), { status: 429 })),
    );
    await toggleReaction('c1', '30', '🎉');
    expect(reactions()).toEqual([]);
    expect(errors).toEqual(['Yavaşla.']);
  });
});

describe('emoji listesi', () => {
  it('her emoji sunucunun kabul ettiği tek bir tam emojidir; kategori içinde tekrar yoktur', () => {
    const rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');
    for (const category of EMOJI_CATEGORIES) {
      expect(category.emojis.filter((e) => !rgi.test(e))).toEqual([]);
      expect(new Set(category.emojis).size).toBe(category.emojis.length);
    }
  });
});

describe('dosya ekleri', () => {
  const file = (name: string, size: number, type = 'image/png'): LocalFile => ({ name, size, type, uri: `file:///${name}` });
  const attachment = (id: string, name: string): Attachment => ({
    id: id.repeat(32).slice(0, 32),
    name,
    size: 10,
    contentType: 'image/png',
    width: 1,
    height: 1,
    url: `/api/attachments/${id.repeat(32).slice(0, 32)}/${name}`,
  });
  const messages = () => useMessages.getState().channels.c1!.messages;

  it('boş, çok büyük ve fazla dosyalar yazma kutusuna eklenmez', () => {
    useGuild.setState({ attachmentMaxBytes: 1000 });
    addFiles('c1', [file('bos.png', 0), file('buyuk.png', 1001), file('tamam.png', 1000)]);
    expect(useMessages.getState().pendingFiles.c1!.map((f) => f.name)).toEqual(['tamam.png']);
    expect(errors).toEqual(['"bos.png" boş bir dosya.', '"buyuk.png" çok büyük (en fazla 1000 B).']);
    addFiles('c1', Array.from({ length: 12 }, (_, i) => file(`${i}.png`, 1)));
    expect(useMessages.getState().pendingFiles.c1).toHaveLength(10);
    expect(errors.at(-1)).toBe('Bir mesaja en fazla 10 dosya eklenebilir.');
  });

  it('dosyalar ilerlemeyle yüklenir, sonra mesaj dosya kimlikleriyle gönderilir', async () => {
    useGuild.setState({ attachmentMaxBytes: 1_000_000 });
    const requests: UploadRequest[] = [];
    let finishSecond!: () => void;
    uploadImpl = async (req) => {
      requests.push(req);
      req.onProgress(5);
      if (requests.length === 2) await new Promise<void>((r) => (finishSecond = r));
      const a = attachment(String(requests.length), req.file.name);
      return { status: 201, body: JSON.stringify(a) };
    };
    const sent = { ...message('40', 'ikisi birden', 'u1'), attachments: [attachment('1', 'a.png'), attachment('2', 'b.png')] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sent), { status: 201 })));

    addFiles('c1', [file('a.png', 10), file('b.png', 10, '')]);
    sendMessage('c1', 'ikisi birden');
    expect(useMessages.getState().pendingFiles.c1).toBeUndefined();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(uploadProgress(messages()[0]!)).toEqual({ sent: 15, total: 20 });
    expect(requests[0]!.url).toBe('http://sunucu.test/api/channels/c1/attachments?name=a.png');
    expect(requests[0]!.headers).toEqual({
      Authorization: 'Bearer jeton',
      'Content-Type': 'image/png',
      // Her isteğe eklenen özellik başlığı (bkz. clientFeatureHeaders)
      'x-diskort-features': 'dm,presence,voice_trace,session_token',
    });
    // Türü bilinmeyen dosya
    expect(requests[1]!.headers['Content-Type']).toBe('application/octet-stream');

    finishSecond();
    await vi.waitFor(() => expect(messages()[0]!.status).toBeUndefined());
    expect(messages()).toMatchObject([{ id: '40', attachments: [{ name: 'a.png' }, { name: 'b.png' }] }]);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      content: 'ikisi birden',
      attachmentIds: [attachment('1', 'a.png').id, attachment('2', 'b.png').id],
    });
  });

  it('yükleme başarısız olursa yeniden denemede yüklenmiş dosyalar tekrar yüklenmez', async () => {
    let calls = 0;
    uploadImpl = async (req) => {
      calls++;
      if (calls === 2) return { status: 413, body: JSON.stringify({ error: 'too_large', message: 'Dosya çok büyük.' }) };
      return { status: 201, body: JSON.stringify(attachment(String(calls), req.file.name)) };
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(message('41', '', 'u1')), { status: 201 })));
    addFiles('c1', [file('a.png', 10), file('b.png', 10)]);
    sendMessage('c1', '');
    await vi.waitFor(() => expect(messages()[0]!.status).toBe('failed'));
    expect(errors).toEqual(['Dosya çok büyük.']);
    expect(messages()[0]!.uploads!.map((u) => Boolean(u.attachment))).toEqual([true, false]);

    retryMessage('c1', messages()[0]!.nonce!);
    await vi.waitFor(() => expect(messages()[0]!.id).toBe('41'));
    expect(calls).toBe(3);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).attachmentIds).toEqual([
      attachment('1', 'a.png').id,
      attachment('3', 'b.png').id,
    ]);
  });

  it('yükleme sürerken vazgeçilirse istek iptal edilir ve mesaj kalkar', async () => {
    let signal!: AbortSignal;
    uploadImpl = (req) => {
      signal = req.signal;
      return new Promise((resolve) => req.signal.addEventListener('abort', () => resolve({ status: 0, body: '' })));
    };
    addFiles('c1', [file('a.png', 10)]);
    sendMessage('c1', 'iptal');
    await vi.waitFor(() => expect(signal).toBeDefined());
    discardMessage('c1', messages()[0]!.nonce!);
    expect(signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(messages()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('onay gatewayden önce gelirse dosyaları yüklenmiş bekleyen mesajın yerine geçer', async () => {
    const uploaded = attachment('7', 'a.png');
    uploadImpl = async () => ({ status: 201, body: JSON.stringify(uploaded) });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined))); // yanıt hiç gelmez
    addFiles('c1', [file('a.png', 10)]);
    sendMessage('c1', '');
    addFiles('c1', [file('b.png', 10)]);
    await vi.waitFor(() => expect(messages()[0]!.uploads![0]!.attachment).toBeDefined());
    receive({ t: 'MESSAGE_CREATE', d: { ...message('50', '', 'u1'), attachments: [uploaded] } });
    expect(messages().map((m) => m.id)).toEqual(['50']);
    // Yazma kutusuna sonradan eklenen dosya yerinde durur
    expect(useMessages.getState().pendingFiles.c1!.map((f) => f.name)).toEqual(['b.png']);
  });
});

describe('yeniden bağlanınca tazeleme', () => {
  const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  const cached = (list: string[], extra: LocalMessage[] = []): void =>
    useMessages.setState({
      channels: { c1: { messages: [...list.map((id) => message(id, id)), ...extra], hasMore: true, loading: false, loaded: false } },
    });
  const serve = (list: string[]) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(list.map((id) => message(id, id))), { status: 200 })));
  const shown = () => useMessages.getState().channels.c1!.messages.map((m) => m.id);

  it('en yeni sayfa önbellekle örtüşmüyorsa önbellek sayfayla değiştirilir (boşluk kalmaz)', async () => {
    const pending: LocalMessage = { ...message('tmp-1', 'gidiyor', 'u1'), status: 'pending', nonce: 'n1' };
    cached(['1', '2', '3'], [pending]);
    serve(ids(100, 149));
    await loadInitial('c1');
    expect(shown()).toEqual([...ids(100, 149), 'tmp-1']);
    expect(useMessages.getState().channels.c1!.hasMore).toBe(true);
  });

  it('sayfanın aralığında olup sayfada olmayan mesajlar (kopukken silinen) çıkarılır', async () => {
    const failed: LocalMessage = { ...message('tmp-2', 'gitmedi', 'u1'), status: 'failed', nonce: 'n2' };
    // Tam sayfa: sayfadan eski önbellek (örtüşme var) korunur, aralıktaki 30 silinmiş
    cached([...ids(5, 60), '61'], [failed]);
    serve(ids(10, 60).filter((id) => id !== '30'));
    await loadInitial('c1');
    // 61 istekten önce önbellekteydi ama en yeni sayfada yok: o da silinmiş
    expect(shown()).toEqual([...ids(5, 60).filter((id) => id !== '30'), 'tmp-2']);
  });

  it('tam olmayan sayfa kanalın tamamıdır: sayfada olmayan eski mesajlar da çıkarılır', async () => {
    cached(['1', '2', '3', '4']);
    serve(['2', '4']);
    await loadInitial('c1');
    expect(shown()).toEqual(['2', '4']);
  });

  it('istek sürerken gelen mesaj sayfada olmasa da kalır', async () => {
    cached(['10', '11']);
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    const done = loadInitial('c1');
    receive({ t: 'MESSAGE_CREATE', d: message('14', 'yeni') });
    resolve(new Response(JSON.stringify(['10', '11', '12'].map((id) => message(id, id))), { status: 200 }));
    await done;
    expect(shown()).toEqual(['10', '11', '12', '14']);
  });
});

describe('uyku ve yeniden bağlanma', () => {
  const NETWORK_ERROR = 'Sunucuya ulaşılamadı. Adresi ve internet bağlantını kontrol et.';
  const ready = (readStates: Record<string, string> = {}): void =>
    receive({
      t: 'READY',
      d: {
        user: me,
        users: [],
        guilds: [],
        primaryGuildId: null,
        voiceStates: [],
        online: [],
        lastMessageIds: {},
        readStates,
        mentionCounts: {},
        attachmentMaxBytes: 1,
        dms: [
          {
            id: 'c1',
            participantIds: ['u1', 'u2'],
            group: false,
            name: null,
            ownerId: null,
            createdAt: 1,
            lastMessageId: null,
            lastActivityAt: 1,
          },
        ],
      },
    });
  const pageOf = (list: string[]): Response => new Response(JSON.stringify(list.map((id) => message(id, id))), { status: 200 });
  const cached = (list: string[], hasMore = false): void =>
    useMessages.setState({
      channels: { c1: { messages: list.map((id) => message(id, id)), hasMore, loading: false, loaded: true } },
    });
  const channel = () => useMessages.getState().channels.c1!;
  const shown = () => channel().messages.map((m) => m.id);
  /** Yanıtları testin elinden verilen fetch */
  const held = () => {
    const replies: ((r: Response | Error) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () => new Promise<Response>((resolve, reject) => replies.push((r) => (r instanceof Error ? reject(r) : resolve(r)))),
      ),
    );
    return replies;
  };
  const offline = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('ağ yok');
      }),
    );
  const calls = () => vi.mocked(fetch).mock.calls.length;
  const ackCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/ack'));

  beforeEach(() => {
    vi.useFakeTimers();
    useGuild.setState({ lastMessageIds: {}, readStates: {} });
  });

  afterEach(() => {
    useSession.getState().logout(); // bekleyen denemeler sonraki teste kalmasın
    vi.useRealTimers();
  });

  it('READY içeriği ekranda bırakır, kanal yüklü kalır; tazelenince güncel sayılır', async () => {
    cached(['1', '2']);
    const replies = held();
    ready();
    expect(channel()).toMatchObject({ loaded: true, stale: true, loading: true });
    expect(shown()).toEqual(['1', '2']);
    // Tazeleme sürerken gelen mesaj düşmez
    receive({ t: 'MESSAGE_CREATE', d: message('4', 'yeni') });
    expect(shown()).toEqual(['1', '2', '4']);

    replies[0]!(pageOf(['1', '2', '3']));
    await vi.advanceTimersByTimeAsync(0);
    expect(channel()).toMatchObject({ loaded: true, stale: false, loading: false });
    expect(shown()).toEqual(['1', '2', '3', '4']);
    expect(calls()).toBe(1);
  });

  it('bilinmeyen kanal yine önbellekten düşer', () => {
    useMessages.setState({ channels: { gitti: { messages: [], hasMore: false, loading: false, loaded: true } } });
    ready();
    expect(useMessages.getState().channels.gitti).toBeUndefined();
  });

  it('eski mesajlar yüklenirken gelen READY: yükleme bitince tazeleme yapılır', async () => {
    cached(['5', '6'], true);
    const replies = held();
    const older = loadOlder('c1');
    ready();
    expect(calls()).toBe(1); // süren istek bitmeden ikincisi başlamaz
    expect(channel()).toMatchObject({ loaded: true, stale: true });

    replies[0]!(pageOf(['3', '4']));
    await older;
    expect(calls()).toBe(2);
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('http://sunucu.test/api/channels/c1/messages');
    expect(channel().stale).toBe(true);

    replies[1]!(pageOf(['3', '4', '5', '6', '7']));
    await vi.advanceTimersByTimeAsync(0);
    expect(channel()).toMatchObject({ stale: false, loading: false });
    expect(shown()).toEqual(['3', '4', '5', '6', '7']);
  });

  it('eski mesaj yüklemesi başarısız olsa da READY sonrası tazeleme yapılır', async () => {
    cached(['5', '6'], true);
    const replies = held();
    const older = loadOlder('c1');
    ready();
    replies[0]!(new TypeError('ağ yok'));
    await older;
    expect(errors).toEqual([NETWORK_ERROR]);
    expect(calls()).toBe(2);
    replies[1]!(pageOf(['5', '6', '7']));
    await vi.advanceTimersByTimeAsync(0);
    expect(channel()).toMatchObject({ stale: false, loading: false });
  });

  it('tazeleme sürerken gelen ikinci READY: ilk yanıt tazelemeyi bitirmez, bir kez daha istenir', async () => {
    cached(['1']);
    const replies = held();
    ready();
    ready();
    expect(calls()).toBe(1);
    replies[0]!(pageOf(['1', '2']));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(2);
    expect(channel()).toMatchObject({ stale: true, loading: true });
    replies[1]!(pageOf(['1', '2', '3']));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(2);
    expect(channel()).toMatchObject({ stale: false, loading: false });
  });

  it('tazeleme başarısızsa artan aralıklarla yeniden dener, sonunda bir kez bildirip vazgeçer', async () => {
    cached(['1', '2']);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls()).toBe(1);
    expect(channel()).toMatchObject({ loaded: true, stale: true, loading: false });
    expect(channel().failed).toBeFalsy();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(3);
    expect(errors).toEqual([]); // ara denemeler sessiz
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls()).toBe(4);
    expect(channel()).toMatchObject({ loaded: true, stale: true, failed: true, loading: false });
    expect(shown()).toEqual(['1', '2']);
    expect(errors).toEqual([NETWORK_ERROR]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(4);

    // "Tekrar dene" tazelemeyi tamamlar
    vi.stubGlobal('fetch', vi.fn(async () => pageOf(['1', '2', '3'])));
    await loadInitial('c1');
    expect(channel()).toMatchObject({ stale: false, failed: false });
    expect(shown()).toEqual(['1', '2', '3']);
  });

  it('vazgeçilmiş kanalda eski mesajlar yüklenir, bu tazelemeyi yeniden başlatmaz', async () => {
    cached(['5', '6'], true);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000);
    expect(channel().failed).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => pageOf(['3', '4'])));
    await loadOlder('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    expect(shown()).toEqual(['3', '4', '5', '6']);
    expect(channel()).toMatchObject({ stale: true, failed: true });
  });

  it('otomatik deneme başarılı olursa başka deneme ve bildirim olmaz', async () => {
    cached(['1']);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    const ok = vi.fn(async () => pageOf(['1', '2']));
    vi.stubGlobal('fetch', ok);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(channel()).toMatchObject({ stale: false, failed: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('elle yükleme deneme sayısını baştan başlatır, bekleyen denemenin yerine geçer', async () => {
    useMessages.setState({ channels: {} });
    offline();
    await loadInitial('c1');
    await vi.advanceTimersByTimeAsync(2_000 + 5_000);
    expect(calls()).toBe(3);
    await loadInitial('c1');
    expect(calls()).toBe(4);
    await vi.advanceTimersByTimeAsync(15_000); // eski beklemedeki deneme gelmedi
    expect(calls()).toBe(6);
    await vi.advanceTimersByTimeAsync(5_000 + 15_000);
    expect(calls()).toBe(7);
    expect(channel()).toMatchObject({ loaded: false, failed: true });
    expect(errors).toEqual([NETWORK_ERROR]);
  });

  it('bekleyen deneme eski mesaj yüklemesine denk gelirse yüklemeden sonra yapılır', async () => {
    cached(['5', '6'], true);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    const replies = held();
    const older = loadOlder('c1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls()).toBe(1);
    replies[0]!(pageOf(['3', '4']));
    await older;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls()).toBe(2);
    replies[1]!(pageOf(['3', '4', '5', '6', '7']));
    await vi.advanceTimersByTimeAsync(0);
    expect(channel()).toMatchObject({ stale: false });
  });

  it('kanal önbellekten çıktıysa ya da hesap değiştiyse deneme yapılmaz', async () => {
    cached(['1']);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    receive({ t: 'DM_CHANNEL_DELETE', d: { id: 'c1' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    expect(useMessages.getState().channels.c1).toBeUndefined();

    cached(['1']);
    offline();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    useSession.getState().setSession('baska', { ...me, id: 'u2' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    expect(useMessages.getState().channels).toEqual({});
    expect(errors).toEqual([]);
  });

  it('yanıtı beklenirken kanal çıktıysa önbelleğe geri yazılmaz', async () => {
    cached(['1']);
    const replies = held();
    ready();
    receive({ t: 'DM_CHANNEL_DELETE', d: { id: 'c1' } });
    replies[0]!(new TypeError('ağ yok'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    expect(useMessages.getState().channels.c1).toBeUndefined();
  });

  it('uykuda askıda kalan sayfa isteği 20 saniyede ağ hatası olur, kanal meşgul kalmaz', async () => {
    useMessages.setState({ channels: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener('abort', () => reject(new DOMException('iptal', 'AbortError'))),
          ),
      ),
    );
    void loadInitial('c1');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(channel().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel().loading).toBe(false);
    expect(errors).toEqual([]);

    const err = api.listMessages('c1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await err).toBeInstanceOf(ApiError);
    expect(await err).toMatchObject({ status: 0, code: 'network', message: NETWORK_ERROR });
  });

  it('süre gövde okunurken dolarsa da ağ hatasıdır; boş yanıt sayılmaz', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('iptal')))),
      })),
    );
    const err = api.listMessages('c1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await err).toMatchObject({ status: 0, code: 'network' });
  });

  it('süre sınırı yalnızca sayfa isteklerinde: POST iptal sinyali taşımaz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await api.ack('c1', '5');
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal).toBeUndefined();
    await api.listMessages('c1').catch(() => undefined);
    expect(vi.mocked(fetch).mock.calls[1]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('okundu bilgisi gidene kadar bekler: başarısızsa korunur, READY onu yeniden gönderir', async () => {
    useGuild.setState({ lastMessageIds: { c1: '9' } });
    offline();
    ackChannel('c1');
    await vi.advanceTimersByTimeAsync(500);
    expect(ackCalls()).toHaveLength(1);
    flushAcks(); // telefon arka plana geçti: hâlâ ağ yok
    await vi.advanceTimersByTimeAsync(0);
    expect(ackCalls()).toHaveLength(2);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ack') ? new Response(null, { status: 204 }) : pageOf([]))));
    ready({ c1: '5' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ackCalls()).toHaveLength(1);
    expect(JSON.parse(ackCalls()[0]![1]!.body as string)).toEqual({ messageId: '9' });
    // Sunucunun geride kalan bilgisi yerel okunmayı geri almaz
    expect(useGuild.getState().readStates.c1).toBe('9');

    // Gitti: bir daha gönderilmez
    flushAcks();
    await vi.advanceTimersByTimeAsync(0);
    expect(ackCalls()).toHaveLength(1);
  });

  it('kalıcı hatada (ör. kanal silinmiş) yeniden denenmez, hemen vazgeçilir', async () => {
    cached(['1']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found', message: 'Kanal bulunamadı.' }), { status: 404 })),
    );
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    expect(channel()).toMatchObject({ stale: true, failed: true, loading: false });
    expect(errors).toEqual(['Kanal bulunamadı.']);
  });

  it('erişimi giden kanalın okundu bilgisi beklemede kalmaz', async () => {
    useGuild.setState({ lastMessageIds: { c1: '9' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden', message: 'Yetkin yok.' }), { status: 403 })),
    );
    ackChannel('c1');
    await vi.advanceTimersByTimeAsync(500);
    expect(ackCalls()).toHaveLength(1);
    flushAcks();
    await vi.advanceTimersByTimeAsync(0);
    expect(ackCalls()).toHaveLength(1);
  });

  it('gönderilen okundu bilgisi sürerken daha yenisi geldiyse yenisi bekler', async () => {
    useGuild.setState({ lastMessageIds: { c1: '9' } });
    const replies = held();
    ackChannel('c1');
    await vi.advanceTimersByTimeAsync(500);
    useGuild.setState({ lastMessageIds: { c1: '10' } });
    ackChannel('c1');
    replies[0]!(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(ackCalls().map(([, init]) => JSON.parse(init!.body as string).messageId)).toEqual(['9', '10']);
    flushAcks(); // 10'un yanıtı gelmedi: hâlâ bekliyor
    expect(ackCalls()).toHaveLength(3);
  });

  it('hesap değişince bekleyen okundu bilgisi düşer', async () => {
    useGuild.setState({ lastMessageIds: { c1: '9' } });
    offline();
    ackChannel('c1');
    await vi.advanceTimersByTimeAsync(500);
    useSession.getState().setSession('baska', { ...me, id: 'u2' });
    flushAcks();
    expect(ackCalls()).toHaveLength(1);
  });

  it('READY okunma durumlarını kanal kanal birleştirir: büyük olan kalır', () => {
    useMessages.setState({ channels: {} });
    useGuild.setState({ readStates: { c1: '9', c2: '100', c3: '4' } });
    ready({ c1: '12', c2: '99', c4: '1' });
    expect(useGuild.getState().readStates).toEqual({ c1: '12', c2: '100', c3: '4', c4: '1' });
  });
});

describe('oturum jetonu yenilenince', () => {
  const filled = (): void =>
    useMessages.setState({
      channels: { c1: { messages: [message('1', 'merhaba')], hasMore: false, loading: false, loaded: true } },
      mentionCounts: { c1: 2 },
    });

  it('mesaj önbelleği korunur: kanal iskelette kalmaz', () => {
    filled();
    receive({ t: 'SESSION_TOKEN', d: { token: 'yenilenen' } });
    expect(useMessages.getState().channels.c1).toMatchObject({ loaded: true, messages: [{ id: '1' }] });
    expect(useMessages.getState().mentionCounts.c1).toBe(2);
  });

  it('başka hesapla girilince önbellek silinir', () => {
    filled();
    useSession.getState().setSession('baska', { ...me, id: 'u2' });
    expect(useMessages.getState().channels).toEqual({});
  });

  it('çıkışta önbellek silinir', () => {
    filled();
    useSession.getState().logout();
    expect(useMessages.getState().channels).toEqual({});
  });
});
