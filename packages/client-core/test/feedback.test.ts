import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ERROR_STACK_MAX,
  NATIVE_CRASH_STACK_MAX,
  NATIVE_CRASH_WHERE,
  Permission,
  type Feedback,
  type GatewayServerMessage,
  type Role,
  type User,
} from '@diskort/shared';
import {
  ApiError,
  baseFeedbackContext,
  configureClient,
  gateway,
  loadAllFeedback,
  loadMyFeedback,
  onOwnFeedbackUpdate,
  recentClientErrors,
  reportClientError,
  submitFeedback,
  updateFeedback,
  useFeedback,
  useGuild,
  useSession,
  type KeyValueStorage,
  type UploadRequest,
  type UploadResponse,
} from '../src';

const memory = new Map<string, string>();
const storage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

const me: User = { id: 'u1', username: 'ayse', displayName: 'Ayşe', avatarColor: '#fff', isAdmin: false };
const everyone: Role = { id: 'g1', name: '@everyone', color: null, position: 0, hoist: false, permissions: 0 };
const managerRole: Role = { id: 'r1', name: 'Yönetici', color: null, position: 1, hoist: false, permissions: Permission.MANAGE_GUILD };

const feedback = (id: number, patch: Partial<Feedback> = {}): Feedback => ({
  id,
  userId: 'u1',
  type: 'hata',
  title: null,
  body: `geri bildirim ${id}`,
  context: null,
  screenshots: [],
  status: 'yeni',
  adminNote: null,
  createdAt: id,
  updatedAt: id,
  ...patch,
});

const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

let uploads: UploadRequest[] = [];
let uploadImpl: (req: UploadRequest) => Promise<UploadResponse> = async () => ({ status: 0, body: '' });
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Ana sunucuda (g1) kullanıcıya verilen roller */
function setRoles(user: User, roles: string[] = []): void {
  const guild = { id: 'g1', name: 'Diskort', ownerId: 'sahip' };
  useGuild.setState({
    primaryGuildId: 'g1',
    guilds: {
      g1: {
        guild,
        channels: [],
        roles: { g1: everyone, r1: managerRole },
        members: { [user.id]: { userId: user.id, roles, joinedAt: 1, removed: false } },
        sounds: [],
      },
    },
    guildOrder: ['g1'],
    activeGuildId: 'g1',
    guild,
    roles: { g1: everyone, r1: managerRole },
    users: { [user.id]: { ...user, roles, removed: false } },
  });
}

beforeEach(async () => {
  memory.clear();
  uploads = [];
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage,
    serverUrl: () => 'http://sunucu.test',
    notifyError: () => undefined,
    upload: (req) => {
      uploads.push(req);
      return uploadImpl(req);
    },
  });
  useSession.getState().setSession('jeton', me);
  useFeedback.setState({ mine: null, all: null, newCount: 0 });
  setRoles(me);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('son hatalar', () => {
  it('bildirilen hataların mesajları tutulur (en fazla 10, art arda tekrar bir kez)', () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    for (let i = 0; i < 12; i++) reportClientError(new Error(`hata ${i}`), 'test');
    reportClientError(new Error('hata 11'), 'test');
    const errors = recentClientErrors();
    expect(errors).toHaveLength(10);
    expect(errors[0]).toBe('test: hata 2');
    expect(errors.at(-1)).toBe('test: hata 11');
    expect(baseFeedbackContext()).toMatchObject({ platform: 'desktop', appVersion: '9.9.9', recentErrors: errors });
  });

  it('yığın 4000 karakterde kesilir; telefonun yerel çökmelerinde 8000', () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const long = (message: string): Error => Object.assign(new Error(message), { stack: 'x'.repeat(9000) });
    reportClientError(long('uzun js hatası'), 'genel');
    reportClientError(long('uzun yerel çökme'), NATIVE_CRASH_WHERE);
    const stacks = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse((init as RequestInit).body as string) as { stack: string }).stack.length,
    );
    expect(stacks).toEqual([CLIENT_ERROR_STACK_MAX, NATIVE_CRASH_STACK_MAX]);
  });

  it('yerel çökmeler aynı özetle de gider ve JS hatalarının payından yemez', () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    // Oturumun JS hatası payı dolar (en fazla 20)
    for (let i = 0; i < 25; i++) reportClientError(new Error(`doldur ${i}`), 'genel');
    fetchMock.mockClear();
    reportClientError(new Error('pay doldu'), 'genel');
    reportClientError(new Error('CRASH_NATIVE SIGSEGV'), NATIVE_CRASH_WHERE);
    reportClientError(new Error('CRASH_NATIVE SIGSEGV'), NATIVE_CRASH_WHERE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('gönderme', () => {
  it('önce ekran görüntüleri yüklenir, sonra kimlikleriyle geri bildirim gönderilir', async () => {
    let n = 0;
    uploadImpl = async () => ({
      status: 201,
      body: JSON.stringify({ id: String(++n).repeat(32), width: 10, height: 10, size: 5, url: '/x' }),
    });
    const created = feedback(7);
    fetchMock.mockResolvedValue(json(201, created));
    const result = await submitFeedback({
      type: 'hata',
      title: '  ',
      body: ' Ses kopuyor ',
      context: { platform: 'desktop' },
      screenshots: [
        { name: 'a.png', size: 100, type: 'image/png' },
        { name: 'b.png', size: 100, type: 'image/png' },
      ],
    });
    expect(result).toEqual(created);
    expect(uploads.map((u) => u.url)).toEqual([
      'http://sunucu.test/api/feedback/screenshots',
      'http://sunucu.test/api/feedback/screenshots',
    ]);
    expect(uploads[0]!.headers.Authorization).toBe('Bearer jeton');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://sunucu.test/api/feedback');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'hata',
      title: null,
      body: 'Ses kopuyor',
      context: { platform: 'desktop' },
      screenshotIds: ['1'.repeat(32), '2'.repeat(32)],
    });
    expect(useFeedback.getState().mine).toEqual([created]);
  });

  it('yükleme ya da sunucu hatası iletilir; sınırı aşan resim hiç gönderilmez', async () => {
    await expect(
      submitFeedback({
        type: 'hata',
        title: '',
        body: 'x',
        context: null,
        screenshots: [{ name: 'dev.png', size: 50 * 1024 * 1024, type: 'image/png' }],
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(uploads).toHaveLength(0);

    fetchMock.mockResolvedValue(json(429, { error: 'rate_limited', message: 'Bir saatte en fazla 5' }));
    const err = await submitFeedback({ type: 'oneri', title: '', body: 'x', context: null, screenshots: [] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('en fazla 5');
  });
});

describe('canlı güncellemeler', () => {
  it('yetkili: yeni geri bildirim listeye ve rozete eklenir, durum değişince sayı düşer', async () => {
    const admin: User = { ...me, id: 'u9' };
    useSession.getState().setUser(admin);
    setRoles(admin, ['r1']);
    fetchMock.mockResolvedValue(json(200, [feedback(2), feedback(1, { status: 'tamamlandi' })]));
    await loadAllFeedback();
    expect(useFeedback.getState().newCount).toBe(1);

    receive({ t: 'FEEDBACK_CREATE', d: feedback(3) });
    expect(useFeedback.getState().all!.map((f) => f.id)).toEqual([3, 2, 1]);
    expect(useFeedback.getState().newCount).toBe(2);

    fetchMock.mockResolvedValue(json(200, feedback(3, { status: 'incelendi' })));
    await updateFeedback(3, { status: 'incelendi' });
    expect(useFeedback.getState().newCount).toBe(1);

    receive({ t: 'FEEDBACK_DELETE', d: { id: 2 } });
    expect(useFeedback.getState().all!.map((f) => f.id)).toEqual([3, 1]);
    expect(useFeedback.getState().newCount).toBe(0);
  });

  it('gönderen: kendi geri bildiriminin durumu güncellenir ve dinleyiciye bildirilir', async () => {
    fetchMock.mockResolvedValue(json(200, [feedback(1)]));
    await loadMyFeedback();
    const seen: [string, string | undefined][] = [];
    const off = onOwnFeedbackUpdate((item, previous) => seen.push([item.status, previous?.status]));
    receive({ t: 'FEEDBACK_UPDATE', d: feedback(1, { status: 'tamamlandi', adminNote: 'Düzeltildi' }) });
    off();
    expect(useFeedback.getState().mine![0]).toMatchObject({ status: 'tamamlandi', adminNote: 'Düzeltildi' });
    expect(seen).toEqual([['tamamlandi', 'yeni']]);
    // Yetkili olmayanın listesi ve rozeti yok
    expect(useFeedback.getState().all).toBeNull();
    expect(useFeedback.getState().newCount).toBe(0);
  });

  it('çıkış yapınca temizlenir', () => {
    useFeedback.setState({ mine: [feedback(1)], all: [feedback(1)], newCount: 1 });
    useSession.getState().logout();
    expect(useFeedback.getState()).toMatchObject({ mine: null, all: null, newCount: 0 });
  });
});
