import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { decryptDevices } from '../src/iosDevicesCrypto.js';
import { startServer, type TestServer } from './helpers.js';

// Yönetim paneli → iPhone cihazları: onay/ret, onayların toplanıp tek GitHub iş akışı başlatması,
// çalıştırmanın izlenmesi ve belirteç yokken elle komut.

const U1 = '00008110-001A2B3C4D5E6F70';
const U2 = '00008120-000A1B2C3D4E5F60';
const U3 = 'A'.repeat(40);
const KEY = randomBytes(32);
const KEY_ENV = { IOS_DEVICES_KEY: KEY.toString('base64') };

let t: TestServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const record = (udid: string, name: string | null, at: string) =>
  JSON.stringify({ udid, product: 'iPhone15,2', version: '22A3354', deviceName: 'iPhone', name, at });

interface Call {
  method: string;
  url: string;
  body: any;
  auth: string | undefined;
}

/** Sahte GitHub: dispatch'leri kaydeder, çalıştırma listesini `runs` ile verir */
function fakeGithub(opts: { dispatchStatus?: number } = {}) {
  const calls: Call[] = [];
  const runs: { id: number; html_url: string; status: string; conclusion: string | null; display_title: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>)?.Authorization });
    if (method === 'POST') return new Response(null, { status: opts.dispatchStatus ?? 204 });
    return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { status: 200 });
  }) as typeof fetch;
  return { calls, runs, fetchImpl, dispatches: () => calls.filter((c) => c.method === 'POST') };
}

async function setup(env: Record<string, string>, github = fakeGithub()) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ios-cihaz-'));
  await writeFile(
    path.join(dir, 'udids.jsonl'),
    `${record(U1, 'Ayşe', '2026-09-20T10:00:00.000Z')}\n${record(U2, null, '2026-09-21T10:00:00.000Z')}\n${record(U3, 'Ali', '2026-09-22T10:00:00.000Z')}\n`,
  );
  t = await startServer({ githubFetch: github.fetchImpl, iosPollMs: 20 }, loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, ...env }));
  return github;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Koşul sağlanana dek yoklar (sabit bekleme yerine; yük altında zamanlayıcılar geç kalabilir) */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor: koşul zamanında sağlanmadı');
    await wait(20);
  }
}

describe('iPhone cihazları (yönetim)', () => {
  it('yalnızca hesap yöneticisi; eski kayıtlar "bekliyor" görünür', async () => {
    await setup({});
    const member = await t!.member('uye');
    expect((await t!.req(member.token, 'GET', '/api/admin/ios-devices')).statusCode).toBe(403);
    expect((await t!.req(member.token, 'PATCH', `/api/admin/ios-devices/${U1}`, { status: 'onaylandi' })).statusCode).toBe(403);
    expect((await t!.req(member.token, 'POST', '/api/admin/ios-devices/dispatch')).statusCode).toBe(403);
    expect((await t!.app.inject({ method: 'GET', url: '/api/admin/ios-devices' })).statusCode).toBe(401);

    const res = await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.devices.map((d: { udid: string }) => d.udid)).toEqual([U3, U2, U1]);
    expect(body.devices.every((d: { status: string }) => d.status === 'bekliyor')).toBe(true);
    expect(body.automation).toEqual({ enabled: false, keyMissing: false, pendingDispatchAt: null });
    expect(body.manualCommand).toBeNull();
  });

  it('onay/ret geçişleri dosyaya yazılır; belirteç yokken derleme başlatılmaz, elle komut verilir', async () => {
    const github = await setup({});
    const set = (udid: string, status: string) => t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${udid}`, { status });
    const ok = await set(U1.toLowerCase(), 'onaylandi');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ udid: U1, status: 'onaylandi', name: 'Ayşe' });
    expect((await set(U2, 'reddedildi')).json().status).toBe('reddedildi');
    expect((await set(U2, 'bekliyor')).json().status).toBe('bekliyor');
    expect((await set(U3, 'onaylandi')).statusCode).toBe(200);
    expect((await set(U1, 'uydurma')).statusCode).toBe(400);
    expect((await set('1234', 'onaylandi')).statusCode).toBe(400);
    expect((await set('00008110-FFFFFFFFFFFFFFFF', 'onaylandi')).statusCode).toBe(404);

    const state = JSON.parse(await readFile(path.join(dir!, 'udid-status.json'), 'utf8'));
    expect(state.statuses[U1].status).toBe('onaylandi');
    expect(state.statuses[U2].status).toBe('bekliyor');

    const body = (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    // Anahtar yok: komut cihazsız, UDID açık yazılmaz
    expect(body.manualCommand).toEqual({
      command: 'gh workflow run ios.yml --repo zziroo/diskort -f simulator=false -f signed=true -f attach-latest=true',
      encrypted: false,
    });
    expect(JSON.stringify(body.manualCommand)).not.toContain(U1);
    expect((await t!.req(t!.owner.token, 'POST', '/api/admin/ios-devices/dispatch')).statusCode).toBe(400);
    await wait(50);
    expect(github.calls).toHaveLength(0);
    // udids.jsonl olduğu gibi kalır
    expect((await readFile(path.join(dir!, 'udids.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('kısa sürede gelen onaylar tek derlemede toplanır; başarıyla bitince cihazlar "eklendi" olur', async () => {
    const github = await setup({ GITHUB_DISPATCH_TOKEN: 'gizli-belirtec', IOS_DISPATCH_DELAY_SEC: '2', ...KEY_ENV });
    const set = (udid: string, status: string) => t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${udid}`, { status });
    await set(U1, 'onaylandi');
    await set(U3, 'onaylandi');
    await set(U2, 'reddedildi');
    const pending = (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    expect(pending.automation.enabled).toBe(true);
    expect(pending.automation.pendingDispatchAt).not.toBeNull();
    expect(github.dispatches()).toHaveLength(0);

    await waitFor(() => github.dispatches().length > 0);
    const dispatches = github.dispatches();
    expect(dispatches).toHaveLength(1);
    const d = dispatches[0]!;
    expect(d.url).toBe('https://api.github.com/repos/zziroo/diskort/actions/workflows/ios.yml/dispatches');
    expect(d.auth).toBe('Bearer gizli-belirtec');
    expect(d.body.ref).toBe('main');
    expect(d.body.inputs).toMatchObject({ simulator: 'false', signed: 'true', 'attach-latest': 'true' });
    // Girdide UDID ya da ad açık görünmez; anahtarla çözülür
    // (şifreli `devices` base64 metninde kısa dizgiler rastgele geçebilir; onu bayt olarak, tam değerlerle denetle)
    const { devices: cipher, ...otherInputs } = d.body.inputs as Record<string, string>;
    expect(JSON.stringify({ ...d.body, inputs: otherInputs })).not.toMatch(/00008110|A{8}|Ali|Ayşe/);
    const cipherBytes = Buffer.from(cipher!.split('.')[2]!, 'base64url');
    for (const plain of [U1, U3, 'Ali', 'Ayşe']) expect(cipherBytes.includes(Buffer.from(plain))).toBe(false);
    expect(decryptDevices(d.body.inputs.devices, KEY)).toEqual([
      { udid: U3, name: 'Ali' },
      { udid: U1, name: 'Ayşe' },
    ]);
    const requestId = d.body.inputs['request-id'] as string;
    expect(requestId).toMatch(/^[0-9a-f]{8}$/);

    // Çalıştırma görünür, sürer, sonra başarıyla biter
    github.runs.push({ id: 7, html_url: 'https://github.com/zziroo/diskort/actions/runs/7', status: 'in_progress', conclusion: null, display_title: `iOS · cihaz ekleme ${requestId}` });
    const get = async () => (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    await waitFor(async () => (await get()).ci?.runId === 7);
    let body = await get();
    expect(body.ci).toMatchObject({ requestId, runId: 7, status: 'in_progress', udids: [U3, U1] });
    expect(body.devices.find((x: { udid: string }) => x.udid === U1).status).toBe('onaylandi');

    github.runs[0]!.status = 'completed';
    github.runs[0]!.conclusion = 'success';
    await waitFor(async () => (await get()).ci?.status === 'completed');
    body = await get();
    expect(body.ci).toMatchObject({ status: 'completed', conclusion: 'success', url: 'https://github.com/zziroo/diskort/actions/runs/7' });
    const status = Object.fromEntries(body.devices.map((x: { udid: string; status: string }) => [x.udid, x.status]));
    expect(status).toEqual({ [U1]: 'eklendi', [U2]: 'reddedildi', [U3]: 'eklendi' });
    // Yeni onay yoksa yeni derleme de yok
    expect(github.dispatches()).toHaveLength(1);
    expect((await t!.req(t!.owner.token, 'POST', '/api/admin/ios-devices/dispatch')).statusCode).toBe(409);
  });

  it('başarısız biten derleme GitHub\'da yeniden denenip başarılı olursa cihazlar yine "eklendi" olur', async () => {
    const github = await setup({ GITHUB_DISPATCH_TOKEN: 'gizli-belirtec', IOS_DISPATCH_DELAY_SEC: '2', ...KEY_ENV });
    await t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${U1}`, { status: 'onaylandi' });
    await waitFor(() => github.dispatches().length > 0);
    const requestId = github.dispatches()[0]!.body.inputs['request-id'] as string;
    const run = { id: 9, html_url: 'https://github.com/zziroo/diskort/actions/runs/9', status: 'completed', conclusion: 'failure', display_title: `iOS · cihaz ekleme ${requestId}` };
    github.runs.push(run);
    const get = async () => (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    await waitFor(async () => (await get()).ci?.conclusion === 'failure');
    expect((await get()).devices.find((x: { udid: string }) => x.udid === U1).status).toBe('onaylandi');

    // Aynı çalıştırma yeniden denendi ve başarıyla bitti; panel açılınca (20 sn sınırından sonra) görülür
    run.conclusion = 'success';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 21_000);
      const body = await get();
      expect(body.ci).toMatchObject({ status: 'completed', conclusion: 'success' });
      expect(body.devices.find((x: { udid: string }) => x.udid === U1).status).toBe('eklendi');
    } finally {
      vi.useRealTimers();
    }
  });

  it('elle "hemen derle" beklemeyi atlar; GitHub hatası panelde görünür, cihaz onaylı kalır', async () => {
    const github = await setup({ GITHUB_DISPATCH_TOKEN: 'x', IOS_DISPATCH_DELAY_SEC: '600', ...KEY_ENV }, fakeGithub({ dispatchStatus: 403 }));
    await t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${U2}`, { status: 'onaylandi' });
    const res = await t!.req(t!.owner.token, 'POST', '/api/admin/ios-devices/dispatch');
    expect(res.statusCode).toBe(502);
    expect(github.dispatches()).toHaveLength(1);
    const body = (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    expect(body.ci).toMatchObject({ status: 'hata', udids: [U2] });
    expect(body.automation.pendingDispatchAt).toBeNull();
    expect(body.devices.find((x: { udid: string }) => x.udid === U2).status).toBe('onaylandi');
  });

  it('belirteç var ama IOS_DEVICES_KEY yoksa derleme başlatılmaz (açık metne düşülmez); elle komut şifreli', async () => {
    const github = await setup({ GITHUB_DISPATCH_TOKEN: 'x', IOS_DISPATCH_DELAY_SEC: '0.05' });
    await t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${U1}`, { status: 'onaylandi' });
    await wait(150);
    expect(github.calls).toHaveLength(0);
    const res = await t!.req(t!.owner.token, 'POST', '/api/admin/ios-devices/dispatch');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('devices_key_missing');
    const body = (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json();
    expect(body.automation).toMatchObject({ enabled: false, keyMissing: true, pendingDispatchAt: null });
    expect(body.manualCommand.encrypted).toBe(false);
    expect(github.calls).toHaveLength(0);
    await t!.close();
    t = undefined;

    // Anahtar var, belirteç yok: panel komutu şifreli cihaz listesiyle verir
    await setup(KEY_ENV);
    await t!.req(t!.owner.token, 'PATCH', `/api/admin/ios-devices/${U1}`, { status: 'onaylandi' });
    const manual = (await t!.req(t!.owner.token, 'GET', '/api/admin/ios-devices')).json().manualCommand;
    expect(manual.encrypted).toBe(true);
    expect(manual.command).not.toContain(U1);
    const payload = /-f devices=(\S+)$/.exec(manual.command)![1]!;
    expect(decryptDevices(payload, KEY)).toEqual([{ udid: U1, name: 'Ayşe' }]);
  });
});
