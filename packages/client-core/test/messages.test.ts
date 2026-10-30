import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, GatewayServerMessage, Message } from '@diskort/shared';
import {
  addFiles,
  configureClient,
  discardMessage,
  EMOJI_CATEGORIES,
  gateway,
  loadInitial,
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
