import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { INTRO_SOUND_MAX_BYTES, type GatewayServerMessage, type User } from '@diskort/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { ffmpegTranscode, type IntroSoundTranscode } from '../src/introSounds.js';
import { parseRange } from '../src/routes/introSounds.js';
import { joinGuild } from './helpers.js';

const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '.' });

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
/** Sahte dönüştürücünün aldığı başlangıç noktaları */
let starts: number[];

/** Sahte ffmpeg: "bozuk" ile başlayan girdi okunamaz, "boş" boş çıktı verir; diğerleri etiketlenip döner */
const fakeTranscode: IntroSoundTranscode = async (input, startSec) => {
  starts.push(startSec);
  const text = input.toString();
  if (text.startsWith('bozuk')) throw new Error('Invalid data found when processing input');
  if (text.startsWith('boş')) return Buffer.alloc(0);
  return Buffer.from(`ID3 mp3 ${text}`);
};

beforeEach(async () => {
  starts = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-intro-'));
  ({ app, ctx } = await buildApp(config, {
    dbFile: ':memory:',
    logger: false,
    introSoundsDir: dir,
    introSoundTranscode: fakeTranscode,
  }));
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

type Account = { token: string; user: User };

async function setup(): Promise<{ admin: Account; member: Account }> {
  const bootstrap = ctx.store.ensureBootstrapInvite()!;
  const admin = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: bootstrap.code, username: 'admin', password: 'sifre12345' },
    })
  ).json() as Account;
  const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: auth(admin.token), payload: {} })).json()
    .code as string;
  const member = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: code, username: 'uye', password: 'sifre12345' },
    })
  ).json() as Account;
  await joinGuild(app, ctx.guild.id, admin.token, member.token);
  return { admin, member };
}

const upload = (token: string | null, body: Buffer | string, query = '') =>
  app.inject({
    method: 'POST',
    url: `/api/me/intro-sound${query}`,
    headers: { ...(token ? auth(token) : {}), 'content-type': 'audio/mpeg' },
    payload: typeof body === 'string' ? Buffer.from(body) : body,
  });

const remove = (token: string) => app.inject({ method: 'DELETE', url: '/api/me/intro-sound', headers: auth(token) });

const files = () => fs.readdirSync(dir).sort();

describe('giriş sesi', () => {
  it('yükleme, sunma, değiştirme ve kaldırma', async () => {
    const { member } = await setup();
    const res = await upload(member.token, 'ses-1', '?start=1.5');
    expect(res.statusCode).toBe(200);
    const user = res.json() as User;
    expect(user.introSoundUrl).toMatch(new RegExp(`^/api/intro-sounds/${member.user.id}/[0-9a-f]{32}\\.mp3$`));
    expect(starts).toEqual([1.5]);
    expect(ctx.store.getUser(member.user.id)!.introSoundUrl).toBe(user.introSoundUrl);
    expect(files()).toHaveLength(1);

    // Kimlik doğrulamasız sunulur, süresiz önbelleklenebilir
    const served = await app.inject({ method: 'GET', url: user.introSoundUrl! });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('audio/mpeg');
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(served.headers['accept-ranges']).toBe('bytes');
    expect(served.body).toBe('ID3 mp3 ses-1');
    const etag = served.headers.etag as string;
    const cached = await app.inject({ method: 'GET', url: user.introSoundUrl!, headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);

    // Aralık isteği (expo-audio)
    const part = await app.inject({ method: 'GET', url: user.introSoundUrl!, headers: { range: 'bytes=0-2' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-2/${'ID3 mp3 ses-1'.length}`);
    expect(part.body).toBe('ID3');
    const bad = await app.inject({ method: 'GET', url: user.introSoundUrl!, headers: { range: 'bytes=999-' } });
    expect(bad.statusCode).toBe(416);

    // Değiştirince eski adres 404, eski dosya silinir
    const second = (await upload(member.token, 'ses-2')).json() as User;
    expect(starts).toEqual([1.5, 0]);
    expect(second.introSoundUrl).not.toBe(user.introSoundUrl);
    expect((await app.inject({ method: 'GET', url: user.introSoundUrl! })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: second.introSoundUrl! })).statusCode).toBe(200);
    expect(files()).toHaveLength(1);

    // Başka kullanıcının kimliğiyle aynı özet sunulmaz
    const hashFile = second.introSoundUrl!.split('/').pop()!;
    expect((await app.inject({ method: 'GET', url: `/api/intro-sounds/baskasi/${hashFile}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/intro-sounds/${member.user.id}/../x.mp3` })).statusCode).toBe(404);

    const removed = await remove(member.token);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as User).introSoundUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: second.introSoundUrl! })).statusCode).toBe(404);
    expect(files()).toEqual([]);
  });

  it('kimlik doğrulaması gerekir; yükleme yalnızca kendi hesabını değiştirir', async () => {
    const { admin, member } = await setup();
    expect((await upload(null, 'ses')).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/me/intro-sound' })).statusCode).toBe(401);
    await upload(member.token, 'uye-sesi');
    expect(ctx.store.getUser(admin.user.id)!.introSoundUrl).toBeNull();
    expect(ctx.store.getUser(member.user.id)!.introSoundUrl).not.toBeNull();
  });

  it('okunamayan ses, boş çıktı ve geçersiz başlangıç reddedilir', async () => {
    const { member } = await setup();
    const broken = await upload(member.token, 'bozuk dosya');
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: 'unsupported', message: 'Ses dosyası okunamadı.' });
    expect((await upload(member.token, 'boş çıktı')).statusCode).toBe(400);

    for (const query of ['?start=-1', '?start=abc', '?start=3601', '?start=1e3', '?start=Infinity', '?start=NaN']) {
      const res = await upload(member.token, 'ses', query);
      expect([query, res.statusCode, res.json().error]).toEqual([query, 400, 'invalid_start']);
    }
    expect((await upload(member.token, 'ses', '?start=3600')).statusCode).toBe(200);
    expect(starts).toEqual([0, 0, 3600]);
    // Boş gövde
    const empty = await upload(member.token, Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
  });

  it('boyut sınırı: 8 MB üstü 413', async () => {
    const { member } = await setup();
    const over = await upload(member.token, Buffer.alloc(INTRO_SOUND_MAX_BYTES + 1, 1));
    expect(over.statusCode).toBe(413);
    expect(over.json().message).toBe('Ses dosyası çok büyük (en fazla 8 MB).');
    expect(starts).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('hız sınırı: 10 dakikada 5 değişiklik (yükleme ve kaldırma birlikte)', async () => {
    const { member } = await setup();
    for (let i = 0; i < 4; i++) expect((await upload(member.token, `ses-${i}`)).statusCode).toBe(200);
    expect((await remove(member.token)).statusCode).toBe(200);
    const limited = await upload(member.token, 'ses-6');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toBe('Giriş sesini çok sık değiştiriyorsun, biraz bekle.');
    expect((await remove(member.token)).statusCode).toBe(429);
  });

  it('hesap yöneticisi kaldırabilir; diğerleri kaldıramaz; değişiklik USER_UPDATE ile gider', async () => {
    const { admin, member } = await setup();
    const uploaded = (await upload(member.token, 'ses')).json() as User;

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/users/${admin.user.id}/intro-sound`,
      headers: auth(member.token),
    });
    expect(forbidden.statusCode).toBe(403);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    const events: GatewayServerMessage[] = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayServerMessage;
        if (msg.t === 'HELLO') ws.send(JSON.stringify({ t: 'IDENTIFY', d: { token: admin.token } }));
        else if (msg.t === 'READY') {
          expect(msg.d.users.find((u) => u.id === member.user.id)?.introSoundUrl).toBe(uploaded.introSoundUrl);
          resolve();
        } else events.push(msg);
      });
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${member.user.id}/intro-sound`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as User).introSoundUrl).toBeNull();
    expect(files()).toEqual([]);
    const missing = await app.inject({ method: 'DELETE', url: '/api/users/yok/intro-sound', headers: auth(admin.token) });
    expect(missing.statusCode).toBe(404);

    await new Promise((r) => setTimeout(r, 150));
    const updates = events.filter((e) => e.t === 'USER_UPDATE').map((e) => (e.d as User).introSoundUrl);
    expect(updates).toEqual([null]);
    ws.close();
  });

  it('hesap silinince dosya da silinir; temizlik artık dosyaları siler', async () => {
    const { admin, member } = await setup();
    await upload(member.token, 'ses');
    expect(files()).toHaveLength(1);
    fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.mp3`), 'artık');
    fs.writeFileSync(path.join(dir, 'baska-dosya.txt'), 'dokunma');
    const old = Date.now() + 2 * 3_600_000;
    expect(await ctx.introSounds.sweep(old)).toBe(1);
    expect(files()).toHaveLength(2);

    const del = await app.inject({ method: 'DELETE', url: `/api/users/${member.user.id}`, headers: auth(admin.token) });
    expect(del.statusCode).toBe(204);
    expect(files()).toEqual(['baska-dosya.txt']);
  });
});

describe('parseRange', () => {
  it('tek aralıkları çözer', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=2-400', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('bytes=10-', 10)).toBe('invalid');
    expect(parseRange('bytes=5-2', 10)).toBe('invalid');
    expect(parseRange('bytes=-0', 10)).toBe('invalid');
  });
});

// Gerçek ffmpeg yalnızca kuruluysa denenir (sunucu imajında kurulu; geliştirme makinesinde olmayabilir)
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpegPath, ['-version']).status === 0;

/** `seconds` saniyelik 44.1 kHz stereo 16 bit sinüs WAV */
function sineWav(seconds: number): Buffer {
  const rate = 44_100;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe.skipIf(!hasFfmpeg)('ffmpeg dönüştürücü', () => {
  it('8 sn WAV en fazla 5 sn MP3 olur; bozuk girdi hata verir', async () => {
    const transcode = ffmpegTranscode(ffmpegPath);
    const out = await transcode(sineWav(8), 1);
    // 5 sn × 96 kbps ≈ 60 KB (+ başlık); MP3 çerçeve eşlemesi ya da ID3 ile başlar
    expect(out.length).toBeGreaterThan(20_000);
    expect(out.length).toBeLessThan(80_000);
    expect(out.subarray(0, 3).toString() === 'ID3' || (out[0] === 0xff && (out[1]! & 0xe0) === 0xe0)).toBe(true);
    await expect(transcode(Buffer.from('bu bir ses dosyası değil'), 0)).rejects.toThrow();
  }, 30_000);

  it('başlangıç noktası girdinin sonunu geçerse (sesi olmayan çıktı) reddeder', async () => {
    const transcode = ffmpegTranscode(ffmpegPath);
    await expect(transcode(sineWav(2), 30)).rejects.toMatchObject({ code: 'unsupported' });
  }, 30_000);
});
