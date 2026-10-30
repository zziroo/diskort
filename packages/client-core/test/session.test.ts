import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClientMessage, GatewayServerMessage, User } from '@diskort/shared';
import { configureClient, gateway, tokenExpiresAt, useSession } from '../src';

const b64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** İmzasız sahte JWT: yalnızca `exp` okunur */
const jwt = (expSeconds: number): string => `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', exp: expSeconds })}.imza`;

const user: User = { id: 'u1', username: 'ben', displayName: 'Ben', avatarColor: '#000', createdAt: 0 } as unknown as User;
const receive = (msg: GatewayServerMessage): void =>
  (gateway as unknown as { handle: (m: GatewayServerMessage, t: string) => void }).handle(msg, 'jeton');

let errors: string[];

beforeEach(async () => {
  errors = [];
  vi.useFakeTimers();
  await configureClient({
    platform: 'desktop',
    version: '9.9.9',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    serverUrl: () => 'http://sunucu.test',
    notifyError: (m) => void errors.push(m),
    isViewingChannel: () => false,
    onMention: () => undefined,
  });
});

afterEach(() => {
  useSession.getState().logout();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('oturum jetonu', () => {
  it('tokenExpiresAt: JWT dolma anını okur, bozuk jetonda null', () => {
    expect(tokenExpiresAt(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(tokenExpiresAt('jeton')).toBeNull();
    expect(tokenExpiresAt(`${b64url({})}.${b64url({ exp: 'yarin' })}.x`)).toBeNull();
  });

  it('SESSION_TOKEN gelince yeni jeton saklanır; oturum kapalıyken yok sayılır', () => {
    useSession.getState().setSession('eski', user);
    receive({ t: 'SESSION_TOKEN', d: { token: 'yeni' } });
    expect(useSession.getState().token).toBe('yeni');
    expect(useSession.getState().user).toBe(user);
    useSession.getState().logout();
    receive({ t: 'SESSION_TOKEN', d: { token: 'gec-gelen' } });
    expect(useSession.getState().token).toBeNull();
  });

  it('uygulama içinde değişen jeton (şifre değişikliği) açık bağlantıya bildirilir; sunucunun yenilediği geri gönderilmez', () => {
    const sent: GatewayClientMessage[] = [];
    const g = gateway as unknown as { send: (m: GatewayClientMessage) => void; identified: boolean };
    const original = g.send;
    g.send = (m) => void sent.push(m);
    g.identified = true;
    try {
      useSession.getState().setSession('t1', user);
      expect(sent).toEqual([]);
      useSession.getState().setSession('t2', user);
      expect(sent).toEqual([{ t: 'SESSION_TOKEN_SET', d: { token: 't2' } }]);
      receive({ t: 'SESSION_TOKEN', d: { token: 't3' } });
      expect(sent).toHaveLength(1);
      expect(useSession.getState().token).toBe('t3');
    } finally {
      g.send = original;
      g.identified = false;
    }
  });

  it('süresi dolan jetonla sunucuya sorulur; 401 gelince oturum kapanır', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized', message: 'Oturum geçersiz' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const now = Date.now();
    useSession.getState().setSession(jwt(Math.floor(now / 1000) + 5), user);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/me');
    expect(useSession.getState().token).toBeNull();
  });

  it('cihaz saati ilerideyse (sunucu 200 döner) oturum kalır, sonra yeniden bakılır', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(user), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const token = jwt(Math.floor(Date.now() / 1000) + 2);
    useSession.getState().setSession(token, user);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useSession.getState().token).toBe(token);
    // Bir saat sonra yeniden sorulur
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('jeton yenilenince (SESSION_TOKEN) eski dolma anı beklenmez', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(user), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useSession.getState().setSession(jwt(Math.floor(Date.now() / 1000) + 5), user);
    receive({ t: 'SESSION_TOKEN', d: { token: jwt(Math.floor(Date.now() / 1000) + 3600) } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
