import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MAX_RECORDS, parseDeviceAttributes } from '../src/routes/udid.js';

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const UDID = '00008110-001A2B3C4D5E6F70';

/** iOS'un gönderdiği gövdenin benzeri: imza baytlarının arasında düz metin plist */
function signedBody(fields: Record<string, string>): Buffer {
  const entries = Object.entries(fields)
    .map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>`;
  return Buffer.concat([Buffer.from([0x30, 0x80, 0x06, 0x09, 0x2a, 0x86]), Buffer.from(plist, 'utf8'), Buffer.from([0xa0, 0x80, 0x00])]);
}

describe('iPhone UDID toplama', () => {
  it('imzalı gövdeden bilgileri çıkarır, bozuk UDID\'yi reddeder', () => {
    const d = parseDeviceAttributes(
      signedBody({ UDID: UDID.toLowerCase(), PRODUCT: 'iPhone15,2', VERSION: '22A3354', DEVICE_NAME: 'Ayşe&apos;nin iPhone&apos;u', CHALLENGE: 'Ayşe' }),
    );
    expect(d).toEqual({ udid: UDID, product: 'iPhone15,2', version: '22A3354', deviceName: "Ayşe'nin iPhone'u", name: 'Ayşe' });
    expect(parseDeviceAttributes(signedBody({ UDID: 'not-a-udid' }))).toBeNull();
    expect(parseDeviceAttributes(Buffer.from('rastgele'))).toBeNull();
  });

  it('profili verir, kaydı dosyaya bir kez yazar ve 301 ile sayfaya yönlendirir', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'udid-'));
    ({ app } = await buildApp(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), { dbFile: ':memory:', logger: false }));

    const profile = await app.inject({ method: 'GET', url: '/api/udid/profile?ad=Ay%C5%9Fe%3C', headers: { host: 'diskort.test' } });
    expect(profile.statusCode).toBe(200);
    expect(profile.headers['content-type']).toBe('application/x-apple-aspen-config');
    expect(profile.body).toContain('<string>Profile Service</string>');
    expect(profile.body).toContain('/api/udid/receive</string>');
    expect(profile.body).toContain('<string>Ayşe&lt;</string>');

    const post = () =>
      app!.inject({
        method: 'POST',
        url: '/api/udid/receive',
        headers: { 'content-type': 'application/pkcs7-signature' },
        payload: signedBody({ UDID, PRODUCT: 'iPhone15,2', CHALLENGE: 'Ayşe' }),
      });
    const res = await post();
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(`/udid?udid=${UDID}&model=iPhone15%2C2`);
    await post();
    const lines = (await readFile(path.join(dir, 'udids.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ udid: UDID, product: 'iPhone15,2', name: 'Ayşe' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/udid/receive',
      headers: { 'content-type': 'application/pkcs7-signature' },
      payload: Buffer.from('bozuk'),
    });
    expect(bad.statusCode).toBe(301);
    expect(bad.headers.location).toBe('/udid?hata=1');
  });

  it('liste doluyken bilinmeyen cihaz kaydedilmez ve hata sayfasına gider, bilinen cihaz yine başarı alır', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'udid-'));
    const file = path.join(dir, 'udids.jsonl');
    const line = (udid: string) => JSON.stringify({ udid, product: null, version: null, deviceName: null, name: null, at: '2026-09-20T10:00:00.000Z' });
    const filled = `${Array.from({ length: MAX_RECORDS - 1 }, (_, i) => line(`00008110-${String(i).padStart(16, '0')}`)).join('\n')}\n${line(UDID)}\n`;
    await writeFile(file, filled);
    ({ app } = await buildApp(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), { dbFile: ':memory:', logger: false }));

    const post = (udid: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/udid/receive',
        headers: { 'content-type': 'application/pkcs7-signature' },
        payload: signedBody({ UDID: udid }),
      });
    const unknown = await post('00008120-000A1B2C3D4E5F60');
    expect(unknown.statusCode).toBe(301);
    expect(unknown.headers.location).toBe('/udid?hata=dolu');
    expect((await post(UDID)).headers.location).toBe(`/udid?udid=${UDID}`);
    expect(await readFile(file, 'utf8')).toBe(filled);
  });
});
