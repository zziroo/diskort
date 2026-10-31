import { createPublicKey, generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AscClient,
  autoProfileName,
  BROADCAST_BUNDLE_ID,
  createProfileBody,
  diffDevices,
  makeJwt,
  matchCertificate,
  neutralDeviceName,
  parseDevices,
  profileDevices,
  registerDeviceBody,
  syncProfile,
  type AscResource,
} from '../../../scripts/ios-provisioning-lib.mjs';

// iOS Ad Hoc profilini App Store Connect API ile hazırlayan betiğin (scripts/ios-provisioning.mjs) saf
// kısımları ve sahte API'ye karşı tüm akış. Gerçek Apple API'si burada denenmez.

const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBgjCCASmgAwIBAgIEChssPTAKBggqhkjOPQQDAjAfMR0wGwYDVQQDDBREaXNr
b3J0IFRlc3QgRGFnaXRpbTAeFw0yNjA5MjgxMTMzNDNaFw0zNjA5MjUxMTMzNDNa
MB8xHTAbBgNVBAMMFERpc2tvcnQgVGVzdCBEYWdpdGltMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEgG6VEX74wASlXT3LD31Xo5P8ktwK3tzdSuPzzPb1pJvgJfDk
ln4ddh8+U/1Bkw/7COiFXE2ET2IvpZtFaOTKXaNTMFEwHQYDVR0OBBYEFJsyAhJj
w5JRlaAwW/WhA9B3yS4BMB8GA1UdIwQYMBaAFJsyAhJjw5JRlaAwW/WhA9B3yS4B
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgf9IYN+3WJt0z/8vi
U4M41YnROjxbMLKw8yzfR3WPU14CICeiVTbUHS/Wpz9mF5/Iv/8nC7+5Iuu5ZuWL
LeBhJKiU
-----END CERTIFICATE-----`;
const CERT_DER_B64 = new X509Certificate(CERT_PEM).raw.toString('base64');

const U1 = '00008110-001A2B3C4D5E6F70';
const U2 = '00008120-000A1B2C3D4E5F60';
const U3 = 'A'.repeat(40);

const device = (id: string, udid: string, status = 'ENABLED', deviceClass = 'IPHONE'): AscResource => ({
  type: 'devices',
  id,
  attributes: { udid, status, deviceClass, name: `cihaz ${id}`, platform: 'IOS' },
});

describe('App Store Connect betiği: saf kısımlar', () => {
  it('ES256 JWT: başlık, iddialar ve imza (JOSE r||s)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    const jwt = makeJwt({ keyId: 'ABC123DEFG', issuerId: 'issuer-uuid', privateKey: pem, now });
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toEqual({ iss: 'issuer-uuid', iat: now / 1000, exp: now / 1000 + 900, aud: 'appstoreconnect-v1' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    const sig = Buffer.from(s!, 'base64url');
    expect(sig).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('cihaz listesini okur: JSON ya da UDID=Ad, büyük harf, tekrarsız, bozuk UDID hata', () => {
    expect(parseDevices('')).toEqual([]);
    expect(parseDevices(JSON.stringify([{ udid: U1.toLowerCase(), name: 'Ayşe\u0007' }, U2, { udid: U1 }]))).toEqual([
      { udid: U1, name: 'Ayşe' },
      { udid: U2, name: neutralDeviceName(U2) },
    ]);
    expect(parseDevices(`${U1}=Ali, ${U3}`)).toEqual([
      { udid: U1, name: 'Ali' },
      { udid: U3, name: neutralDeviceName(U3) },
    ]);
    expect(() => parseDevices('1234')).toThrow(/Geçersiz UDID/);
    expect(() => parseDevices('{"udid":"x"}')).toThrow();
  });

  it('cihaz farkı: kaydedilecek, yeniden açılacak, zaten var', () => {
    const existing = [device('d1', U1.toLowerCase()), device('d2', U2, 'DISABLED')];
    const diff = diffDevices(parseDevices(`${U1},${U2},${U3}`), existing);
    expect(diff.toRegister.map((d) => d.udid)).toEqual([U3]);
    expect(diff.toEnable.map((d) => d.id)).toEqual(['d2']);
    expect(diff.present.map((d) => d.id)).toEqual(['d1']);
  });

  it('profile yalnızca açık iPhone/iPad girer', () => {
    const list = [device('b', U1), device('a', U2, 'DISABLED'), device('c', U3, 'ENABLED', 'APPLE_WATCH'), device('d', U3, 'ENABLED', 'IPAD')];
    expect(profileDevices(list).map((d) => d.id)).toEqual(['b', 'd']);
  });

  it('sertifikayı DER ya da seri numarasıyla eşler', () => {
    const certs = (content: string | null, serial: string): AscResource[] => [
      { id: 'x', attributes: { certificateContent: null, serialNumber: '0102' } },
      { id: 'c1', attributes: { certificateContent: content, serialNumber: serial } },
    ];
    expect(matchCertificate(certs(CERT_DER_B64, 'FFFF'), CERT_PEM)?.id).toBe('c1');
    expect(matchCertificate(certs(null, '0A1B2C3D'), CERT_PEM)?.id).toBe('c1');
    expect(matchCertificate(certs(null, 'a1b2c3d'), CERT_PEM)?.id).toBe('c1');
    expect(matchCertificate(certs(null, '99'), CERT_PEM)).toBeNull();
    expect(() => matchCertificate([], 'pem değil')).toThrow();
  });

  it('istek gövdeleri', () => {
    expect(registerDeviceBody({ udid: U1, name: 'x'.repeat(80) })).toEqual({
      data: { type: 'devices', attributes: { name: 'x'.repeat(50), platform: 'IOS', udid: U1 } },
    });
    expect(createProfileBody({ name: 'P', bundleIdId: 'B', certificateId: 'C', deviceIds: ['d1', 'd2'] })).toEqual({
      data: {
        type: 'profiles',
        attributes: { name: 'P', profileType: 'IOS_APP_ADHOC' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: 'B' } },
          certificates: { data: [{ type: 'certificates', id: 'C' }] },
          devices: { data: [{ type: 'devices', id: 'd1' }, { type: 'devices', id: 'd2' }] },
        },
      },
    });
    expect(autoProfileName(new Date(Date.UTC(2026, 0, 5, 7, 9)))).toBe('Diskort Ad Hoc otomatik 20260105-0709');
  });
});

/** Sahte App Store Connect: yalnızca betiğin kullandığı uçlar */
function fakeAsc(opts: {
  devices: AscResource[];
  profiles?: AscResource[];
  profileDevices?: Record<string, string[]>;
  /** Profilin App ID'si (verilmezse B1, com.diskort.app) */
  profileBundles?: Record<string, string>;
  conflictOn?: string;
  /** Yeni kaydedilen cihaz bu kadar liste okumasından sonra açık görünür (Apple'daki gecikme) */
  newDeviceSettlesAfter?: { reads: number; status?: string; deviceClass?: string };
  /** Yeni kaydedilen cihaz listede hiç görünmez (yalnızca kayıt yanıtında gelir) */
  hideNewDevices?: boolean;
}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const devices = [...opts.devices];
  const profiles = [...(opts.profiles ?? [])];
  let next = 1;
  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    calls.push({ method, path: `${path}${url.search}`, body });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    if (method === 'GET' && path === '/v1/bundleIds')
      return json(200, { data: [{ id: 'B0', attributes: { identifier: 'com.diskort.app.widget', platform: 'IOS' } }, { id: 'B1', attributes: { identifier: 'com.diskort.app', platform: 'IOS' } }, { id: 'B2', attributes: { identifier: 'com.diskort.app.broadcast', platform: 'IOS' } }] });
    if (method === 'GET' && path === '/v1/certificates')
      return json(200, { data: [{ id: 'C1', attributes: { certificateContent: CERT_DER_B64, serialNumber: '0A1B2C3D', certificateType: 'DISTRIBUTION' } }] });
    if (method === 'GET' && path === '/v1/devices') {
      const settle = opts.newDeviceSettlesAfter;
      if (settle && !url.searchParams.has('cursor') && --settle.reads <= 0) {
        for (const d of devices) if (d.id.startsWith('n')) d.attributes = { ...d.attributes, status: 'ENABLED', deviceClass: 'IPHONE' };
      }
      // İki sayfa: links.next izlenmeli
      if (!url.searchParams.has('cursor')) return json(200, { data: devices.slice(0, 1), links: { next: `${url.origin}${path}?cursor=2` } });
      return json(200, { data: devices.slice(1), links: {} });
    }
    if (method === 'POST' && path === '/v1/devices') {
      const udid = body.data.attributes.udid;
      if (udid === opts.conflictOn) {
        devices.push(device(`n${next++}`, udid));
        return json(409, { errors: [{ status: '409', detail: 'already exists' }] });
      }
      const settle = opts.newDeviceSettlesAfter;
      const d = settle ? device(`n${next++}`, udid, settle.status ?? 'PROCESSING', settle.deviceClass ?? 'UNKNOWN') : device(`n${next++}`, udid);
      if (!opts.hideNewDevices) devices.push(d);
      return json(201, { data: { ...d, attributes: { ...d.attributes } } });
    }
    if (method === 'PATCH' && path.startsWith('/v1/devices/')) {
      const id = path.split('/')[3]!;
      const d = devices.find((x) => x.id === id)!;
      d.attributes.status = 'ENABLED';
      return json(200, { data: d });
    }
    if (method === 'GET' && path === '/v1/profiles') return json(200, { data: profiles });
    const m = /^\/v1\/profiles\/([^/]+)\/(bundleId|certificates|devices)$/.exec(path);
    if (method === 'GET' && m) {
      if (m[2] === 'bundleId') return json(200, { data: { id: opts.profileBundles?.[m[1]!] ?? 'B1' } });
      if (m[2] === 'certificates') return json(200, { data: [{ id: 'C1', attributes: {} }] });
      return json(200, { data: (opts.profileDevices?.[m[1]!] ?? []).map((id) => ({ id, attributes: {} })) });
    }
    if (method === 'POST' && path === '/v1/profiles')
      return json(201, { data: { id: 'P-new', attributes: { name: body.data.attributes.name, profileContent: Buffer.from('yeni profil').toString('base64') } } });
    if (method === 'DELETE' && path.startsWith('/v1/profiles/')) return json(204, null);
    return json(404, { errors: [{ detail: `bilinmeyen uç ${method} ${path}` }] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const autoProfile = (id: string, name: string, expires = '2027-06-01T00:00:00.000+0000', state = 'ACTIVE'): AscResource => ({
  id,
  attributes: { name, profileState: state, expirationDate: expires, profileContent: Buffer.from(`profil ${id}`).toString('base64') },
});
const now = new Date(Date.UTC(2026, 8, 28, 12, 0));

describe('App Store Connect betiği: akış (sahte API)', () => {
  it('yayın eklentisinin profili ayrı adla oluşur, uygulamanın profili silinmez', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P-app', 'Diskort Ad Hoc otomatik 20260901-0000'), autoProfile('P-eski', 'Diskort Yayin Ad Hoc otomatik 20260101-0000', '2026-10-01T00:00:00.000+0000')],
      profileDevices: { 'P-app': ['d1'], 'P-eski': ['d1'] },
    });
    const client = new AscClient({ token: () => 'jwt', fetch: api.fetchImpl });
    const r = await syncProfile({ client, bundleIdentifier: BROADCAST_BUNDLE_ID, certPem: CERT_PEM, now });
    expect(r.profileName).toBe('Diskort Yayin Ad Hoc otomatik 20260928-1200');
    expect(r.deleted).toEqual(['Diskort Yayin Ad Hoc otomatik 20260101-0000']);
    const created = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!.body as any;
    expect(created.data.relationships.bundleId.data.id).toBe('B2');
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/P-app'))).toBe(false);
  });

  it('yayın eklentisinin geçerli profili yeniden kullanılır', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Yayin Ad Hoc otomatik 20260901-0000')],
      profileDevices: { P1: ['d1'] },
      profileBundles: { P1: 'B2' },
    });
    const r = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: api.fetchImpl }), bundleIdentifier: BROADCAST_BUNDLE_ID, certPem: CERT_PEM, now });
    expect(r.reused).toBe(true);
  });

  it('istenen App Group profilde yoksa profil yenilenir', async () => {
    const profiles = [autoProfile('P1', 'Diskort Ad Hoc otomatik 20260901-0000')];
    const stale = fakeAsc({ devices: [device('d1', U1)], profiles, profileDevices: { P1: ['d1'] } });
    const r = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: stale.fetchImpl }), requiredAppGroup: 'group.com.diskort.app', certPem: CERT_PEM, now });
    expect(r.reused).toBe(false);

    profiles[0]!.attributes.profileContent = Buffer.from('<string>group.com.diskort.app</string>').toString('base64');
    const fresh = fakeAsc({ devices: [device('d1', U1)], profiles, profileDevices: { P1: ['d1'] } });
    const r2 = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: fresh.fetchImpl }), requiredAppGroup: 'group.com.diskort.app', certPem: CERT_PEM, now });
    expect(r2.reused).toBe(true);
  });

  it('yeni cihazı kaydeder, kapalıyı açar, yeni profil oluşturur, eski otomatik profilleri siler', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1), device('d2', U2, 'DISABLED')],
      profiles: [autoProfile('P-old', 'Diskort Ad Hoc otomatik 20260101-0000'), autoProfile('P-manual', 'Diskort Ad Hoc')],
      profileDevices: { 'P-old': ['d1'] },
    });
    const client = new AscClient({ token: () => 'jwt', fetch: api.fetchImpl });
    const logs: string[] = [];
    const r = await syncProfile({ client, certPem: CERT_PEM, devices: parseDevices(`${U1},${U2},${U3}=Yeni`), now, log: (m) => logs.push(m) });
    expect(r.registered).toEqual([U3]);
    expect(r.enabled).toEqual([U2]);
    expect(r.reused).toBe(false);
    expect(r.deviceCount).toBe(3);
    expect(r.profileName).toBe('Diskort Ad Hoc otomatik 20260928-1200');
    expect(Buffer.from(r.profileContent!, 'base64').toString()).toBe('yeni profil');
    const create = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!;
    expect(create.body.data.relationships.devices.data.map((d: { id: string }) => d.id)).toEqual(['d1', 'd2', 'n1']);
    expect(create.body.data.relationships.bundleId.data.id).toBe('B1');
    expect(create.body.data.relationships.certificates.data[0].id).toBe('C1');
    const register = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/devices')!;
    expect(register.body.data.attributes).toEqual({ name: 'Yeni', platform: 'IOS', udid: U3 });
    // Elle oluşturulan profile dokunulmaz
    expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/v1/profiles/P-old']);
    expect(r.deleted).toEqual(['Diskort Ad Hoc otomatik 20260101-0000']);
    // Günlükte tam UDID yok
    expect(logs.join('\n')).not.toContain(U3);
  });

  it('cihazlar değişmediyse geçerli otomatik profili yeniden kullanır; bitmek üzereyse yeniler', async () => {
    const same = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Ad Hoc otomatik 20260901-0000')],
      profileDevices: { P1: ['d1'] },
    });
    const r = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: same.fetchImpl }), certPem: CERT_PEM, devices: parseDevices(U1), now });
    expect(r.reused).toBe(true);
    expect(Buffer.from(r.profileContent!, 'base64').toString()).toBe('profil P1');
    expect(same.calls.some((c) => c.method !== 'GET')).toBe(false);

    const expiring = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Ad Hoc otomatik 20251001-0000', '2026-10-10T00:00:00.000+0000')],
      profileDevices: { P1: ['d1'] },
    });
    const r2 = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: expiring.fetchImpl }), certPem: CERT_PEM, now });
    expect(r2.reused).toBe(false);
  });

  it('409: aynı cihaz o arada kaydedilmişse devam eder', async () => {
    const api = fakeAsc({ devices: [device('d1', U1)], conflictOn: U2 });
    const r = await syncProfile({ client: new AscClient({ token: () => 'jwt', fetch: api.fetchImpl }), certPem: CERT_PEM, devices: parseDevices(U2), now });
    expect(r.registered).toEqual([U2]);
    expect(r.deviceCount).toBe(2);
  });

  it('yeni cihaz Apple listesinde geç açık görünürse bekler, eski profili yeniden kullanmaz', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Ad Hoc otomatik 20260901-0000')],
      profileDevices: { P1: ['d1'] },
      newDeviceSettlesAfter: { reads: 3 },
    });
    const sleeps: number[] = [];
    const r = await syncProfile({
      client: new AscClient({ token: () => 'jwt', fetch: api.fetchImpl }),
      certPem: CERT_PEM,
      devices: parseDevices(U2),
      now,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.reused).toBe(false);
    expect(r.deviceCount).toBe(2);
    expect(sleeps.length).toBe(1);
    const create = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!;
    expect(create.body.data.relationships.devices.data.map((d: { id: string }) => d.id)).toEqual(['d1', 'n1']);
  });

  it('yeni cihaz hiç açık görünmezse yine de profile girer', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Ad Hoc otomatik 20260901-0000')],
      profileDevices: { P1: ['d1'] },
      newDeviceSettlesAfter: { reads: 1000 },
    });
    const logs: string[] = [];
    const r = await syncProfile({
      client: new AscClient({ token: () => 'jwt', fetch: api.fetchImpl }),
      certPem: CERT_PEM,
      devices: parseDevices(U2),
      now,
      log: (m) => logs.push(m),
      sleep: async () => {},
    });
    expect(r.reused).toBe(false);
    expect(r.deviceCount).toBe(2);
    expect(logs.join('\n')).toContain('henüz açık görünmüyor');
  });

  it('yeni cihaz listede hiç görünmese de kayıt yanıtından profile girer', async () => {
    const api = fakeAsc({
      devices: [device('d1', U1)],
      profiles: [autoProfile('P1', 'Diskort Ad Hoc otomatik 20260901-0000')],
      profileDevices: { P1: ['d1'] },
      hideNewDevices: true,
    });
    const sleeps: number[] = [];
    const r = await syncProfile({
      client: new AscClient({ token: () => 'jwt', fetch: api.fetchImpl }),
      certPem: CERT_PEM,
      devices: parseDevices(U2),
      now,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps.length).toBe(11);
    expect(r.reused).toBe(false);
    const create = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!;
    expect(create.body.data.relationships.devices.data.map((d: { id: string }) => d.id)).toEqual(['d1', 'n1']);
  });

  it('deneme kipi hiçbir şeyi değiştirmez', async () => {
    const api = fakeAsc({ devices: [device('d1', U1), device('d2', U2, 'DISABLED')], profiles: [autoProfile('P-old', 'Diskort Ad Hoc otomatik 20260101-0000')] });
    const client = new AscClient({ token: () => 'jwt', fetch: api.fetchImpl, dryRun: true });
    const r = await syncProfile({ client, certPem: CERT_PEM, devices: parseDevices(`${U2},${U3}`), dryRun: true, now });
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(r.profileContent).toBeNull();
    expect(r.plan.join('\n')).toContain('Kaydedilecek');
    // İstemci de değiştiren isteği reddeder
    await expect(client.request('POST', '/v1/devices', {})).rejects.toThrow(/Deneme kipinde/);
  });
});
