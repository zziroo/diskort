import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_ELAPSED_MAX_MS,
  ACTIVITY_ICON_MAX_BYTES,
  ACTIVITY_MAX_COUNT,
  ACTIVITY_NAME_MAX_LENGTH,
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  activityIconPath,
  type Activity,
} from '@diskort/shared';
import { ActivityIconStore, inspectPng } from '../src/activityIcons.js';
import { combineActivities, parseActivityReports } from '../src/presence.js';
import { auth, connectGateway, type GatewayClient, type TestServer, startServer } from './helpers.js';

let s: TestServer;
let dir: string;
const clients: GatewayClient[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-activity-'));
  s = await startServer({ activityIconsDir: dir });
  await s.app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = async (token: string): Promise<GatewayClient> => {
  const client = await connectGateway(s.app, token, [CLIENT_FEATURE_DM, CLIENT_FEATURE_PRESENCE]);
  clients.push(client);
  return client;
};

// Not: etkinlik bildirimleri oturum başına art arda 3 kez anında uygulanır, sonrası 5 saniyede bir; testler
// (sel koruması testi dışında) oturum başına en fazla 3 bildirim gönderir.
const report = (c: GatewayClient, activities: unknown): void =>
  c.ws.send(JSON.stringify({ t: 'ACTIVITY_SET', d: { activities } }));
const game = (name: string, elapsedMs = 0, icon: string | null = null) => ({ type: 'game', name, icon, elapsedMs });
const names = (activities: readonly Activity[] | undefined): string[] => (activities ?? []).map((a) => a.name);

const MIN = 60_000;
const HOUR = 60 * MIN;

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Tek renk PNG */
const png = (width: number, height = width, color = '#3366cc'): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();

/** Tek PNG parçası (CRC'si doğru) */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** IHDR'den hemen sonra bir parça ekler */
const withChunk = (image: Buffer, type: string, data: Buffer): Buffer =>
  Buffer.concat([image.subarray(0, 33), chunk(type, data), image.subarray(33)]);

type Chunk = { type: string; data: Buffer };

/** PNG'nin parçaları (imzadan sonra, sırayla) */
function chunksOf(image: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 8; offset + 12 <= image.length; ) {
    const length = image.readUInt32BE(offset);
    chunks.push({ type: image.toString('latin1', offset + 4, offset + 8), data: image.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

/** Parçalardan (CRC'leri doğru) PNG kurar */
const build = (chunks: Chunk[]): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks.map((c) => chunk(c.type, c.data))]);

/** Electron'un nativeImage.toPNG() çıktısı (32×32, iki IDAT'lı): masaüstünün ürettiği ikonlar böyle */
const ELECTRON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nOzOQQ0AAAgEIOcMbvMzhh9IwCTZetT1TEBAQEBAQEBAQEBAQEBA4AAAAP//W21OGwAAAAZJREFUAwB/jAPA3VioMwAAAABJRU5ErkJggg==';

const put = (token: string | null, key: string, body: Buffer, contentType = 'image/png') =>
  s.app.inject({
    method: 'PUT',
    url: activityIconPath(key),
    headers: { ...(token ? auth(token) : {}), 'content-type': contentType },
    payload: body,
  });

describe('etkinlik', () => {
  it('ACTIVITY_SET ortak sunucudakilere PRESENCE_UPDATE ile gider; READY ve GUILD_CREATE içerir; boş liste temizler', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([
      { userId: ali.user.id, online: true, status: 'online', customStatus: null, activities: [] },
    ]);
    cv.events.length = 0;

    const before = Date.now();
    report(ca, [game('  Counter-Strike\n2  ', 5 * MIN)]);
    await cv.settle();
    const updates = cv.of('PRESENCE_UPDATE');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      userId: ali.user.id,
      online: true,
      status: 'online',
      activities: [{ type: 'game', name: 'Counter-Strike 2', icon: null }],
    });
    const activities = updates[0]!.activities!;
    expect(activities[0]!.startedAt).toBeGreaterThanOrEqual(before - 5 * MIN);
    expect(activities[0]!.startedAt).toBeLessThanOrEqual(Date.now() - 5 * MIN);
    // Kendi oturumu da alır
    expect(ca.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ userId: ali.user.id, activities: [{ name: 'Counter-Strike 2' }] });

    // Sonradan bağlanan READY'de, yeni katıldığı sunucuda GUILD_CREATE'te görür
    const cv2 = await connect(veli.token);
    expect(cv2.ready.presences?.[ali.user.id]?.activities).toEqual(activities);
    const guild = (await s.req(ali.token, 'POST', '/api/guilds', { name: 'İkinci' })).json() as { guild: { id: string } };
    const code = (await s.req(ali.token, 'POST', `/api/guilds/${guild.guild.id}/invites`, {})).json().code as string;
    await s.req(veli.token, 'POST', `/api/invites/${code}/accept`, {});
    await cv.settle();
    expect(cv.of('GUILD_CREATE').at(-1)?.presences?.[ali.user.id]?.activities).toEqual(activities);

    // Boşta ve Rahatsız Etmeyin'de de görünür
    await s.req(ali.token, 'PATCH', '/api/me/status', { status: 'dnd' });
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ status: 'dnd', activities: [{ name: 'Counter-Strike 2' }] });

    cv.events.length = 0;
    report(ca, []);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([
      { userId: ali.user.id, online: true, status: 'dnd', customStatus: null, activities: [] },
    ]);
    // Zaten yokken temizlemek olay üretmez
    cv.events.length = 0;
    report(ca, []);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([]);
  });

  it('liste olmayan bildirim yok sayılır; listedeki geçersiz öğeler atlanır; süre sınırlanır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    report(ca, [game('Hades', MIN)]);
    await cv.settle();
    cv.events.length = 0;

    for (const activities of [undefined, null, 'Hades', 42, {}, game('Tek Oyun'), { 0: game('Sahte Liste'), length: 1 }]) {
      report(ca, activities);
    }
    ca.ws.send(JSON.stringify({ t: 'ACTIVITY_SET' }));
    ca.ws.send(JSON.stringify({ t: 'ACTIVITY_SET', d: null }));
    ca.ws.send(JSON.stringify({ t: 'ACTIVITY_SET', d: { activity: null } }));
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([]);
    expect(names(s.ctx.gateway.presenceOf(ali.user.id).activities)).toEqual(['Hades']);
    expect(ca.ws.readyState).toBe(ca.ws.OPEN);

    // Geçersiz öğeler atlanır, geçerliler alınır. En uzun ad kabul edilir (kod noktası sayılır); süre eksi ya
    // da aşırıysa sınıra çekilir; biçimi bozuk ya da sunucuda olmayan ikon: etkinlik ikonsuz görünür
    const long = '🎮'.repeat(ACTIVITY_NAME_MAX_LENGTH);
    report(ca, [
      null,
      'Hades',
      42,
      [],
      {},
      { type: 'listening', name: 'Şarkı', icon: null, elapsedMs: 0 },
      { type: 'game', name: 123, icon: null, elapsedMs: 0 },
      game(''),
      game(' \n\t\u0000 '),
      game('x'.repeat(ACTIVITY_NAME_MAX_LENGTH + 1)),
      { type: 'game', name: 'Süresiz', icon: null },
      { type: 'game', name: 'Süresi Yazı', icon: null, elapsedMs: '5' },
      { type: 'game', name: 'Süresi Boş', icon: null, elapsedMs: null },
      game(long, -5000),
      game('Eski', ACTIVITY_ELAPSED_MAX_MS * 10),
      game('İkonlu', MIN, '../../etc/passwd'),
      game('İkonlu 2', 2 * MIN, 'a'.repeat(64)),
    ]);
    await cv.settle();
    const list = cv.of('PRESENCE_UPDATE').at(-1)!.activities!;
    expect(names(list)).toEqual([long, 'İkonlu', 'İkonlu 2', 'Eski']);
    expect(Math.abs(list[0]!.startedAt - Date.now())).toBeLessThan(5000);
    expect(Math.abs(Date.now() - ACTIVITY_ELAPSED_MAX_MS - list[3]!.startedAt)).toBeLessThan(5000);
    expect(list.map((a) => a.icon)).toEqual([null, null, null, null]);

    // Görünmez ad (yalnızca sıfır genişlikli / yön karakterleri, Hangul dolgu harfleri, boş Braille, yalın
    // birleşen işaret) reddedilir; adın içindekiler atılır
    report(ca, [
      game('​‏⁠­﻿'),
      game('ㅤᅟᅠﾠ'),
      game('⠀ ⠀'),
      game('؜͏᠎'),
      game('́'),
      game('‮Ha​desㅤ‬'),
    ]);
    await cv.settle();
    expect(names(cv.of('PRESENCE_UPDATE').at(-1)!.activities)).toEqual(['Hades']);
  });

  it('aynı oyun yeniden bildirilince başlangıç korunur; ikon değişikliği duyurulur', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    report(ca, [game('Factorio', 10_000)]);
    await cv.settle();
    const first = cv.of('PRESENCE_UPDATE').at(-1)!.activities!;
    expect(first).toHaveLength(1);
    cv.events.length = 0;

    report(ca, [game('Factorio', 35_000)]);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([]);
    expect(s.ctx.gateway.presenceOf(ali.user.id).activities).toEqual(first);

    // İkon sonradan yüklendi: başlangıç aynı kalır, ikon gelir
    const icon = await png(32);
    expect((await put(ali.token, sha(icon), icon)).statusCode).toBe(201);
    report(ca, [game('Factorio', 40_000, sha(icon))]);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)!.activities).toEqual([{ ...first[0]!, icon: sha(icon) }]);
  });

  it('bir dakikadan büyük fark ve yeni oyun duyurulur; öteki oyunların başlangıcı korunur', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    const last = async (): Promise<Activity[]> => {
      await cv.settle();
      return cv.of('PRESENCE_UPDATE').at(-1)!.activities!;
    };
    report(ca, [game('Factorio', 10_000)]);
    const [first] = await last();
    report(ca, [game('Factorio', 10 * MIN)]);
    const [moved] = await last();
    expect(first!.startedAt - moved!.startedAt).toBeGreaterThan(9 * MIN);
    // İkinci oyun açıldı: ilkinin başlangıcı oynamaz
    report(ca, [game('Factorio', 10 * MIN + 20_000), game('Satisfactory', MIN)]);
    const both = await last();
    expect(names(both)).toEqual(['Satisfactory', 'Factorio']);
    expect(both[1]).toEqual(moved);
  });

  it('bir oturumda birden çok oyun: en son başlayan ilk sırada, en fazla ACTIVITY_MAX_COUNT, aynı oyun bir kez', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    const last = async (): Promise<Activity[]> => {
      await cv.settle();
      return cv.of('PRESENCE_UPDATE').at(-1)!.activities!;
    };
    report(ca, [game('Eski Oyun', HOUR), game('Yeni Oyun', MIN)]);
    const two = await last();
    expect(names(two)).toEqual(['Yeni Oyun', 'Eski Oyun']);
    expect(two[0]!.startedAt).toBeGreaterThan(two[1]!.startedAt);

    // Fazlası alınmaz (ilk geçerli ACTIVITY_MAX_COUNT öğe), sonra sıralanır
    report(ca, Array.from({ length: ACTIVITY_MAX_COUNT + 3 }, (_, i) => game(`Oyun ${i}`, (10 - i) * MIN)));
    expect(names(await last())).toEqual(['Oyun 3', 'Oyun 2', 'Oyun 1', 'Oyun 0']);

    // Aynı oyun iki kez: ilki geçerli
    report(ca, [game('Çift', 5 * MIN), game('Çift', HOUR), game('Tek', MIN)]);
    const deduped = await last();
    expect(names(deduped)).toEqual(['Tek', 'Çift']);
    expect(Math.abs(Date.now() - 5 * MIN - deduped[1]!.startedAt)).toBeLessThan(5000);
  });

  it('iki oturum: listeler birleşir, aynı oyun tek öğedir; oturum kapanınca etkinlikleri kalkar', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const desk = await connect(ali.token);
    const laptop = await connect(ali.token);
    const last = async (): Promise<Activity[] | undefined> => {
      await cv.settle();
      return cv.of('PRESENCE_UPDATE').at(-1)?.activities;
    };
    report(desk, [game('Eski Oyun', HOUR)]);
    const [old] = (await last())!;
    report(laptop, [game('Yeni Oyun', MIN)]);
    expect(names(await last())).toEqual(['Yeni Oyun', 'Eski Oyun']);

    // Aynı oyun öteki oturumda da bildirildi (yeniden bağlanma, eski oturum henüz düşmedi): tek öğe, başlangıç
    // aynı, hiçbir duyuru yok
    cv.events.length = 0;
    report(laptop, [game('Yeni Oyun', MIN), game('Eski Oyun', HOUR + 20_000)]);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([]);
    const combined = s.ctx.gateway.presenceOf(ali.user.id).activities!;
    expect(names(combined)).toEqual(['Yeni Oyun', 'Eski Oyun']);
    expect(combined[1]).toEqual(old);
    // Eski oturum düşünce de değişmez: başlangıç yeni oturuma taşınmıştı
    desk.ws.close();
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([]);
    expect(s.ctx.gateway.presenceOf(ali.user.id).activities).toEqual(combined);

    // Aynı oyun iki cihazda ayrı zamanlarda başlamış: yine tek öğe, en son başlayan
    const phone = await connect(ali.token);
    report(phone, [game('Eski Oyun', 10 * MIN)]);
    const merged = (await last())!;
    expect(names(merged)).toEqual(['Yeni Oyun', 'Eski Oyun']);
    expect(merged[1]!.startedAt - old!.startedAt).toBeGreaterThan(45 * MIN);

    phone.ws.close();
    expect((await last())![1]).toEqual(old);
    laptop.ws.close();
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toEqual({ userId: ali.user.id, online: false, status: 'offline', customStatus: null });
    // Yeniden bağlanınca eski etkinlikler geri gelmez
    await connect(ali.token);
    expect(await last()).toEqual([]);
  });

  it('birleştirme: yakın başlangıçlarda eskisi, uzakta en son başlayan; ikonu olan; sıra ve sınır', () => {
    const at = (name: string, startedAt: number, icon: string | null = null): Activity => ({ type: 'game', name, icon, startedAt });
    expect(combineActivities([])).toEqual([]);
    expect(combineActivities([[at('A', 1000)], [at('A', 31_000, 'k')], [at('B', 500)]])).toEqual([at('A', 1000, 'k'), at('B', 500)]);
    expect(combineActivities([[at('A', 31_000, 'k')], [at('A', 1000)]])).toEqual([at('A', 1000, 'k')]);
    expect(combineActivities([[at('A', 1000, 'k')], [at('A', 200_000)]])).toEqual([at('A', 200_000, 'k')]);
    // Eşit başlangıçta ada göre; en fazla ACTIVITY_MAX_COUNT
    const many = combineActivities([[at('c', 5), at('a', 5)], [at('b', 5), at('e', 9)], [at('d', 1), at('f', 0)]]);
    expect(names(many)).toEqual(['e', 'a', 'b', 'c']);
    // Liste olmayan: undefined; boş liste: boş
    expect(parseActivityReports({ length: 0 }, () => true)).toBeUndefined();
    expect(parseActivityReports([], () => true)).toEqual([]);
    // Steam kimliği: yalnızca rakam ve en çok 10 hane geçer; eski istemcinin göndermediği ya da geçersiz
    // alan düşer (alan hiç konmaz: eski istemciler bilmediği alanı zaten yok sayar)
    const parsed = parseActivityReports(
      [
        { type: 'game', name: 'A', icon: null, elapsedMs: 0, steamAppId: '620' },
        { type: 'game', name: 'B', icon: null, elapsedMs: 0, steamAppId: 'abc' },
        { type: 'game', name: 'C', icon: null, elapsedMs: 0, steamAppId: '12345678901' },
        { type: 'game', name: 'D', icon: null, elapsedMs: 0 },
      ],
      () => true,
      1000,
    )!;
    expect(parsed.map((a) => a.steamAppId)).toEqual(['620', undefined, undefined, undefined]);
    expect(parseActivityReports([{ type: 'game', name: 'E', icon: null, elapsedMs: 0, steamAppId: 620 }], () => true)![0]!.steamAppId).toBeUndefined();
    expect(Object.hasOwn(parsed[1]!, 'steamAppId')).toBe(false);
    // Birleştirmede kimliği olan oturumunki korunur
    expect(combineActivities([[at('A', 1000)], [{ ...at('A', 31_000), steamAppId: '620' }]])).toEqual([{ ...at('A', 1000), steamAppId: '620' }]);
  });

  it('görünmez kullanıcının etkinliği sızmaz; görünür olunca duyurulur', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ca = await connect(ali.token);
    await s.req(ali.token, 'PATCH', '/api/me/status', { status: 'invisible' });
    const cv = await connect(veli.token);
    report(ca, [game('Gizli Oyun', MIN)]);
    await cv.settle();
    expect(JSON.stringify(cv.events)).not.toContain('Gizli Oyun');
    expect(s.ctx.gateway.presenceOf(ali.user.id)).toEqual({ status: 'offline', customStatus: null });
    const cv2 = await connect(veli.token);
    expect(JSON.stringify(cv2.ready)).not.toContain('Gizli Oyun');

    await s.req(ali.token, 'PATCH', '/api/me/status', { status: 'online' });
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ status: 'online', activities: [{ name: 'Gizli Oyun' }] });
    // Yeniden görünmez: çevrimdışı duyurusunda etkinlik yok
    await s.req(ali.token, 'PATCH', '/api/me/status', { status: 'invisible' });
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toEqual({ userId: ali.user.id, online: false, status: 'offline', customStatus: null });
  });

  it('sel koruması: art arda 3 bildirimden sonrası 5 saniyede bire iner, son hâl mutlaka uygulanır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    await cv.settle();
    cv.events.length = 0;
    for (let i = 0; i < 40; i++) report(ca, [game(`Oyun ${i}`)]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(cv.of('PRESENCE_UPDATE').map((u) => names(u.activities))).toEqual([['Oyun 0'], ['Oyun 1'], ['Oyun 2']]);
    // Bekleyen son bildirim ~5. saniyede uygulanır; yavaş makinede pay kalsın diye gelene dek beklenir
    for (const deadline = Date.now() + 12_000; cv.of('PRESENCE_UPDATE').length < 4 && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').map((u) => names(u.activities))).toEqual([['Oyun 0'], ['Oyun 1'], ['Oyun 2'], ['Oyun 39']]);
  });
});

describe('etkinlik ikonları', () => {
  it('yükleme doğrulanır: oturum, anahtar, özet, PNG, parçalar, kare, kenar, boyut', async () => {
    const ali = await s.member('ali');
    const icon = await png(64);
    const key = sha(icon);
    expect((await put(null, key, icon)).statusCode).toBe(401);
    expect((await put(ali.token, 'abc', icon)).statusCode).toBe(400);
    expect((await put(ali.token, key.toUpperCase(), icon)).statusCode).toBe(400);
    // Özet uyuşmuyor
    const mismatch = await put(ali.token, sha(Buffer.from('başka')), icon);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: 'hash_mismatch' });
    // Boş gövde, yanlış içerik türü
    expect((await put(ali.token, sha(Buffer.alloc(0)), Buffer.alloc(0))).statusCode).toBe(400);
    expect((await put(ali.token, key, icon, 'application/json')).statusCode).toBe(415);

    const rejected = async (body: Buffer, status: number, error: string): Promise<void> => {
      const res = await put(ali.token, sha(body), body);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ error });
    };
    // PNG değil (içeriğe bakılır)
    await rejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 415, 'unsupported_type');
    await rejected(await sharp(icon).jpeg().toBuffer(), 415, 'unsupported_type');
    // Bozuk yapı: sonunda artık bayt, kesik dosya, tutmayan CRC
    await rejected(Buffer.concat([icon, Buffer.from('<script>')]), 415, 'unsupported_type');
    await rejected(icon.subarray(0, icon.length - 12), 415, 'unsupported_type');
    const corrupt = Buffer.from(icon);
    corrupt[40] = corrupt[40]! ^ 0xff;
    await rejected(corrupt, 415, 'unsupported_type');
    // İzinli olmayan parçalar: hareketli PNG (APNG), metin, özel parça
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(1, 0);
    await rejected(withChunk(icon, 'acTL', actl), 415, 'unsupported_type');
    await rejected(withChunk(icon, 'tEXt', Buffer.from('Comment\0gizli veri')), 415, 'unsupported_type');
    await rejected(withChunk(icon, 'prVt', Buffer.from('özel')), 415, 'unsupported_type');
    // Kare değil, çok küçük, çok büyük kenar
    await rejected(await png(64, 32), 400, 'invalid_image');
    await rejected(await png(8), 400, 'invalid_image');
    await rejected(await png(256), 400, 'invalid_image');
    // Çok büyük dosya (Fastify gövde sınırı)
    await rejected(Buffer.alloc(ACTIVITY_ICON_MAX_BYTES + 1, 1), 413, 'too_large');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(s.ctx.activityIcons.count).toBe(0);

    // Zararsız ek parça (piksel yoğunluğu) kabul edilir
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(2835, 0);
    phys.writeUInt32BE(2835, 4);
    phys[8] = 1;
    const bare = build(chunksOf(icon).filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type)));
    const dense = withChunk(bare, 'pHYs', phys);
    expect((await put(ali.token, sha(dense), dense)).statusCode).toBe(201);
  });

  it('yüklenen ikon sunulur; yeniden yükleme dosyaya dokunmaz; ACTIVITY_SET ikonu taşır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const icon = await png(128);
    const key = sha(icon);
    const url = activityIconPath(key);

    expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'HEAD', url })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/api/activity-icons/..%2F..%2Fdiskort.db' })).statusCode).toBe(404);

    const created = await put(ali.token, key, icon);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ key });
    const file = path.join(dir, `${key}.png`);
    expect(fs.readFileSync(file).equals(icon)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([`${key}.png`]);
    // Aynı ikon (başka kullanıcıdan da) yeniden yazılmaz
    const past = new Date(Date.now() - HOUR);
    fs.utimesSync(file, past, past);
    const again = await put(veli.token, key, icon);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ key });
    expect(Math.abs(fs.statSync(file).mtimeMs - past.getTime())).toBeLessThan(2000);

    // Oturumsuz okunur (resim etiketleri jeton gönderemez)
    const res = await s.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.equals(icon)).toBe(true);
    const head = await s.app.inject({ method: 'HEAD', url });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('image/png');
    expect(head.rawPayload.length).toBe(0);
    const cached = await s.app.inject({ method: 'GET', url, headers: { 'if-none-match': res.headers.etag as string } });
    expect(cached.statusCode).toBe(304);

    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    report(ca, [game('Hades', 0, key), game('İkonsuz', MIN, sha(Buffer.from('yok')))]);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)!.activities).toMatchObject([
      { name: 'Hades', icon: key },
      { name: 'İkonsuz', icon: null },
    ]);
  });

  it('kullanıcı başına yükleme sınırı yalnızca yeni ikonları sayar', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const icons = await Promise.all(Array.from({ length: 31 }, (_, i) => png(16, 16, `rgb(${i * 8}, 10, 200)`)));
    expect(new Set(icons.map(sha)).size).toBe(31);
    for (const icon of icons.slice(0, 30)) expect((await put(ali.token, sha(icon), icon)).statusCode).toBe(201);
    const limited = await put(ali.token, sha(icons[30]!), icons[30]!);
    expect(limited.statusCode).toBe(429);
    // Var olanı yeniden göndermek ve başka kullanıcı sınıra takılmaz
    expect((await put(ali.token, sha(icons[0]!), icons[0]!)).statusCode).toBe(200);
    expect((await put(veli.token, sha(icons[30]!), icons[30]!)).statusCode).toBe(201);
  });

  it('depo: toplam ikon sınırı (bir kez günlüğe yazılır), açılışta var olanları tanır, yarım ve boş dosyaları siler', async () => {
    const a = await png(16, 16, '#ff0000');
    const b = await png(16, 16, '#00ff00');
    const c = await png(16, 16, '#0000ff');
    const warnings: string[] = [];
    const store = new ActivityIconStore(dir, { maxCount: 2, log: { warn: (_obj, msg) => void warnings.push(msg ?? '') } });
    expect(await store.save(sha(a), a)).toBe(true);
    expect(await store.save(sha(b), b)).toBe(true);
    expect(warnings).toEqual([]);
    await expect(store.save(sha(c), c)).rejects.toMatchObject({ status: 507, code: 'storage_full' });
    await expect(store.save(sha(c), c)).rejects.toMatchObject({ status: 507, code: 'storage_full' });
    expect(warnings).toHaveLength(1);
    // Dolu depoda var olan ikon yine başarılıdır
    expect(await store.save(sha(a), a)).toBe(false);
    expect(store.has(sha(c))).toBe(false);
    expect(store.pathOf(sha(c))).toBeNull();

    fs.writeFileSync(path.join(dir, '0123456789abcdef.tmp'), 'yarım');
    fs.writeFileSync(path.join(dir, `${sha(c)}.png`), '');
    fs.writeFileSync(path.join(dir, 'notlar.txt'), 'bize ait değil');
    const reopened = new ActivityIconStore(dir);
    expect(reopened.count).toBe(2);
    expect(reopened.has(sha(a))).toBe(true);
    expect(reopened.has(sha(c))).toBe(false);
    expect(reopened.pathOf(sha(b))).toBe(path.join(dir, `${sha(b)}.png`));
    expect(fs.readdirSync(dir).sort()).toEqual([`${sha(a)}.png`, `${sha(b)}.png`, 'notlar.txt'].sort());
    // Silinen boş dosyanın yerine ikon yeniden yüklenebilir
    expect(await reopened.save(sha(c), c)).toBe(true);
  });

  it('PNG parçaları: uzunluk, sıra, tekrar ve sıkıştırılmış verinin boyutu denetlenir', async () => {
    const ali = await s.member('ali');
    const icon = await png(128);
    const parts = chunksOf(icon);
    const ihdr = parts[0]!;
    const iend = parts.at(-1)!;
    const pixels = Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data));
    const idat: Chunk = { type: 'IDAT', data: pixels };
    const srgb: Chunk = { type: 'sRGB', data: Buffer.from([0]) };
    const gama: Chunk = { type: 'gAMA', data: Buffer.from([0, 0, 0xb1, 0x8f]) };
    const phys: Chunk = { type: 'pHYs', data: Buffer.from([0, 0, 0x0e, 0xc3, 0, 0, 0x0e, 0xc3, 1]) };
    const make = (...middle: Chunk[]): Buffer => build([ihdr, ...middle, iend]);
    const ok = { width: 128, height: 128 };

    // Masaüstü yardımcısının ürettiği düzen: IHDR sRGB gAMA pHYs IDAT IEND
    const desktop = make(srgb, gama, phys, idat);
    expect(chunksOf(desktop).map((c) => c.type)).toEqual(['IHDR', 'sRGB', 'gAMA', 'pHYs', 'IDAT', 'IEND']);
    expect(inspectPng(desktop)).toEqual(ok);
    expect((await put(ali.token, sha(desktop), desktop)).statusCode).toBe(201);
    // Electron'un ürettiği ikon (iki IDAT'lı) ve paletli PNG de geçer
    const electron = Buffer.from(ELECTRON_PNG, 'base64');
    expect(chunksOf(electron).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IDAT', 'IEND']);
    expect(inspectPng(electron)).toEqual({ width: 32, height: 32 });
    expect((await put(ali.token, sha(electron), electron)).statusCode).toBe(201);
    const palette = await sharp(await png(32)).png({ palette: true }).toBuffer();
    expect(chunksOf(palette).map((c) => c.type)).toContain('PLTE');
    expect(inspectPng(palette)).toEqual({ width: 32, height: 32 });
    // Veri birkaç IDAT'a bölünebilir (art arda olmak koşuluyla)
    const half = pixels.length >> 1;
    const first: Chunk = { type: 'IDAT', data: pixels.subarray(0, half) };
    const second: Chunk = { type: 'IDAT', data: pixels.subarray(half) };
    expect(inspectPng(make(first, second))).toEqual(ok);

    const bad: Record<string, Buffer> = {
      'gAMA fazla uzun': make({ type: 'gAMA', data: Buffer.alloc(8) }, idat),
      'sRGB fazla uzun': make({ type: 'sRGB', data: Buffer.alloc(2) }, idat),
      'pHYs fazla uzun': make({ type: 'pHYs', data: Buffer.alloc(4096) }, idat),
      'pHYs iki kez': make(phys, phys, idat),
      'pHYs IDATtan sonra': make(idat, phys),
      'IDATlar arasında parça': make(first, srgb, second),
      'PLTE çok büyük': make({ type: 'PLTE', data: Buffer.alloc(771) }, idat),
      'PLTE üçe bölünmüyor': make({ type: 'PLTE', data: Buffer.alloc(4) }, idat),
      'tRNS çok büyük': make({ type: 'tRNS', data: Buffer.alloc(257) }, idat),
      'ikinci IDAT çöp': make(idat, { type: 'IDAT', data: Buffer.from('gizlice taşınan veri') }),
      'zlib akışından sonra artık bayt': make({ type: 'IDAT', data: Buffer.concat([pixels, Buffer.from('artık')]) }),
      'kesik veri': make({ type: 'IDAT', data: pixels.subarray(0, pixels.length - 4) }),
      'IHDRden az veri': build([ihdr, ...chunksOf(await png(64)).filter((c) => c.type === 'IDAT'), iend]),
      'IHDRden çok veri': build([chunksOf(await png(64))[0]!, idat, iend]),
      'IDAT yok': make(),
      geçişli: await sharp(icon).png({ progressive: true }).toBuffer(),
    };
    for (const [name, image] of Object.entries(bad)) {
      expect(inspectPng(image), name).toBeNull();
      const res = await put(ali.token, sha(image), image);
      expect(res.statusCode, name).toBe(415);
    }
    expect(s.ctx.activityIcons.count).toBe(2);
  });

  it('PNG yapısı: boyutlar okunur, bozuk başlık ve izinsiz parça reddedilir', async () => {
    const icon = await png(48);
    expect(inspectPng(icon)).toEqual({ width: 48, height: 48 });
    expect(inspectPng(await png(20, 30))).toEqual({ width: 20, height: 30 });
    expect(inspectPng(Buffer.alloc(0))).toBeNull();
    expect(inspectPng(icon.subarray(0, 8))).toBeNull();
    expect(inspectPng(icon.subarray(0, 33))).toBeNull();
    // IEND'siz: imza + IHDR + IDAT
    expect(inspectPng(icon.subarray(0, icon.length - 12))).toBeNull();
    expect(inspectPng(withChunk(icon, 'sRGB', Buffer.from([0])))).toEqual({ width: 48, height: 48 });
    expect(inspectPng(withChunk(icon, 'gAMA', Buffer.from([0, 0, 0xb1, 0x8f])))).toEqual({ width: 48, height: 48 });
    for (const type of ['acTL', 'fcTL', 'fdAT', 'tEXt', 'zTXt', 'iTXt', 'iCCP', 'eXIf', 'tIME', 'abCd']) {
      expect(inspectPng(withChunk(icon, type, Buffer.alloc(4)))).toBeNull();
    }
  });
});
