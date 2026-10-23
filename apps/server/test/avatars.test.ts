import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { AVATAR_COLORS, AVATAR_MAX_BYTES, type GatewayServerMessage, type ReadyPayload, type User } from '@diskort/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { joinGuild } from './helpers.js';
import { MIGRATIONS, Store } from '../src/db.js';

const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '.' });

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-avatar-'));
  ({ app, ctx } = await buildApp(config, { dbFile: ':memory:', logger: false, avatarsDir: dir }));
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

const upload = (token: string | null, body: Buffer, contentType = 'application/octet-stream') =>
  app.inject({
    method: 'POST',
    url: '/api/me/avatar',
    headers: { ...(token ? auth(token) : {}), 'content-type': contentType },
    payload: body,
  });

const remove = (token: string) => app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: auth(token) });

/** Sol yarısı kırmızı, sağ yarısı mavi resim */
function halves(width: number, height: number) {
  const left = { input: { create: { width: width / 2, height, channels: 3 as const, background: '#ff0000' } }, left: 0, top: 0 };
  return sharp({ create: { width, height, channels: 3, background: '#0000ff' } }).composite([left]);
}

const solid = (color: string, width = 64, height = 64) =>
  sharp({ create: { width, height, channels: 3, background: color } });

/** Resmin (x, y) noktasındaki renk */
async function pixel(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

const files = () => fs.readdirSync(dir).sort();

describe('profil fotoğrafı', () => {
  it('yüklenen resim 256×256 WebP olur, içerik adresinden önbelleklenebilir başlıklarla sunulur', async () => {
    const { member } = await setup();
    const res = await upload(member.token, await halves(600, 400).png().toBuffer(), 'image/png');
    expect(res.statusCode).toBe(200);
    const user = res.json() as User;
    expect(user.id).toBe(member.user.id);
    expect(user.avatarUrl).toMatch(new RegExp(`^/api/avatars/${member.user.id}/[0-9a-f]{32}\\.webp$`));
    expect(files()).toEqual([path.basename(user.avatarUrl!)]);

    // Oturum gerekmez (<img> jeton gönderemez)
    const served = await app.inject({ method: 'GET', url: user.avatarUrl! });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-length']).toBe(String(served.rawPayload.length));
    const meta = await sharp(served.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
    // Ortadan kare kırpılır: sol kırmızı, sağ mavi kalır
    expect((await pixel(served.rawPayload, 20, 128))[0]).toBeGreaterThan(200);
    expect((await pixel(served.rawPayload, 236, 128))[2]).toBeGreaterThan(200);

    const etag = served.headers.etag as string;
    const again = await app.inject({ method: 'GET', url: user.avatarUrl!, headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);

    // Kullanıcı bilgisinde her yerde görünür
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth(member.token) })).json().avatarUrl).toBe(
      user.avatarUrl,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'uye', password: 'sifre12345' },
    });
    expect(login.json().user.avatarUrl).toBe(user.avatarUrl);
    expect(ctx.store.listUsers().find((u) => u.id === member.user.id)?.avatarUrl).toBe(user.avatarUrl);
  });

  it('fotoğrafı olmayan kullanıcıda alan null; adres başka kullanıcıya ya da tahmine çalışmaz', async () => {
    const { admin, member } = await setup();
    expect(admin.user.avatarUrl).toBeNull();
    const user = (await upload(member.token, await solid('#00ff00').png().toBuffer())).json() as User;
    const file = path.basename(user.avatarUrl!);
    expect((await app.inject({ method: 'GET', url: `/api/avatars/${admin.user.id}/${file}` })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/avatars/${member.user.id}/${'0'.repeat(32)}.webp` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/avatars/${member.user.id}/${file.replace('.webp', '.png')}` }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/avatars/${member.user.id}/..%2F..%2Fdiskort.db` })).statusCode).toBe(
      404,
    );
  });

  it('JPEG, WebP ve GIF kabul edilir; tür bildirilene göre değil içeriğe göre belirlenir', async () => {
    const { member } = await setup();
    const inputs: [Buffer, string][] = [
      [await solid('#ff0000').jpeg().toBuffer(), 'text/plain'],
      [await solid('#00ff00').webp().toBuffer(), 'image/png'],
      [await solid('#0000ff').gif().toBuffer(), 'application/octet-stream'],
    ];
    for (const [body, declared] of inputs) {
      const res = await upload(member.token, body, declared);
      expect(res.statusCode).toBe(200);
      const served = await app.inject({ method: 'GET', url: (res.json() as User).avatarUrl! });
      expect((await sharp(served.rawPayload).metadata()).format).toBe('webp');
    }
  });

  it('resim olmayan dosyalar reddedilir, diske bir şey yazılmaz', async () => {
    const { member } = await setup();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const cases: [Buffer, string, number, string][] = [
      [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 415, 'unsupported_type'],
      [svg, 'image/svg+xml', 415, 'unsupported_type'],
      [await solid('#ff0000').tiff().toBuffer(), 'image/tiff', 415, 'unsupported_type'],
      [Buffer.alloc(0), 'image/png', 400, 'empty_file'],
    ];
    // Başlığı PNG ama gerisi bozuk
    const png = await solid('#ff0000').png().toBuffer();
    const broken = Buffer.concat([png.subarray(0, 33), Buffer.alloc(200, 7)]);
    cases.push([broken, 'image/png', 400, 'invalid_image']);
    for (const [body, declared, status, error] of cases) {
      const res = await upload(member.token, body, declared);
      expect([res.statusCode, res.json().error]).toEqual([status, error]);
    }
    expect(files()).toEqual([]);
    expect(ctx.store.getUser(member.user.id)!.avatarUrl).toBeNull();
    expect((await upload(null, png)).statusCode).toBe(401);
  });

  it('boyut sınırı: bildirilen boyut da akan gövde de denetlenir', async () => {
    const { member } = await setup();
    const png = await solid('#ff0000').png().toBuffer();
    const big = Buffer.concat([png, Buffer.alloc(AVATAR_MAX_BYTES + 1 - png.length)]);
    const over = await upload(member.token, big, 'image/png');
    expect(over.statusCode).toBe(413);
    expect(over.json().message).toBe('Resim çok büyük (en fazla 8 MB).');

    // Content-Length olmadan (parça parça) gönderilen büyük gövde de kesilir
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const status = await new Promise<number | 'kesildi'>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/me/avatar',
          headers: { ...auth(member.token), 'content-type': 'image/png', 'transfer-encoding': 'chunked' },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', () => resolve('kesildi'));
      const chunk = Buffer.alloc(256 * 1024, 2);
      let sent = 0;
      const pump = (): void => {
        while (sent <= AVATAR_MAX_BYTES + chunk.length) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    expect([413, 'kesildi']).toContain(status);
    await new Promise((r) => setTimeout(r, 100));
    expect(files()).toEqual([]);
  });

  it('çözünürlüğü çok yüksek resim çözülmeden reddedilir', async () => {
    const { member } = await setup();
    // Yalnızca başlığı gerçek PNG: 20000×20000
    const b = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(20000, 16);
    b.writeUInt32BE(20000, 20);
    const res = await upload(member.token, b, 'image/png');
    expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_image']);
  });

  it('EXIF yönü uygulanır, üst veriler (konum dahil) atılır; hareketli GIF’in ilk karesi alınır', async () => {
    const { member } = await setup();
    // Diskte 200×100 (sol kırmızı, sağ mavi); yön 6: 90° saat yönünde döndürülerek gösterilir → üst kırmızı
    const jpeg = await halves(200, 100)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 0/1 0/1' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const user = (await upload(member.token, jpeg, 'image/jpeg')).json() as User;
    const out = (await app.inject({ method: 'GET', url: user.avatarUrl! })).rawPayload;
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect((await pixel(out, 128, 10))[0]).toBeGreaterThan(200);
    expect((await pixel(out, 128, 246))[2]).toBeGreaterThan(200);

    // İki kareli GIF: kırmızı, sonra mavi
    const frames = Buffer.concat([
      await solid('#ff0000', 32, 32).raw().toBuffer(),
      await solid('#0000ff', 32, 32).raw().toBuffer(),
    ]);
    const gif = await sharp(frames, { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } } as never)
      .gif({ delay: [100, 100] })
      .toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    const animated = (await upload(member.token, gif, 'image/gif')).json() as User;
    const still = (await app.inject({ method: 'GET', url: animated.avatarUrl! })).rawPayload;
    expect((await sharp(still, { animated: true }).metadata()).pages ?? 1).toBe(1);
    expect((await pixel(still, 128, 128))[0]).toBeGreaterThan(200);
  });

  it('değiştirilince ve kaldırılınca eski dosya silinir, eski adres çalışmaz', async () => {
    const { member } = await setup();
    const first = (await upload(member.token, await solid('#ff0000').png().toBuffer())).json() as User;
    const second = (await upload(member.token, await solid('#0000ff').png().toBuffer())).json() as User;
    expect(second.avatarUrl).not.toBe(first.avatarUrl);
    expect(files()).toEqual([path.basename(second.avatarUrl!)]);
    expect((await app.inject({ method: 'GET', url: first.avatarUrl! })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: second.avatarUrl! })).statusCode).toBe(200);

    // Aynı resmi yeniden yüklemek aynı adresi verir ve dosyayı silmez
    const same = (await upload(member.token, await solid('#0000ff').png().toBuffer())).json() as User;
    expect(same.avatarUrl).toBe(second.avatarUrl);
    expect(files()).toEqual([path.basename(second.avatarUrl!)]);

    const removed = await remove(member.token);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as User).avatarUrl).toBeNull();
    expect(files()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: second.avatarUrl! })).statusCode).toBe(404);
    // Fotoğraf yokken kaldırmak da sorunsuz
    expect((await remove(member.token)).statusCode).toBe(200);
  });

  it('aynı resmi yükleyen iki kullanıcının dosyası ayrıdır', async () => {
    const { admin, member } = await setup();
    const image = await solid('#123456').png().toBuffer();
    const a = (await upload(admin.token, image)).json() as User;
    const b = (await upload(member.token, image)).json() as User;
    expect(path.basename(a.avatarUrl!)).not.toBe(path.basename(b.avatarUrl!));
    await remove(member.token);
    expect((await app.inject({ method: 'GET', url: a.avatarUrl! })).statusCode).toBe(200);
  });

  it('hesap silinince (kendisi ya da yönetici) fotoğrafı da silinir', async () => {
    const { admin, member } = await setup();
    await upload(member.token, await solid('#ff0000').png().toBuffer());
    const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: auth(admin.token), payload: {} })).json()
      .code as string;
    const third = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { inviteCode: code, username: 'ucuncu', password: 'sifre12345' },
      })
    ).json() as Account;
    const thirdUser = (await upload(third.token, await solid('#00ff00').png().toBuffer())).json() as User;
    expect(files()).toHaveLength(2);

    const self = await app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: auth(member.token),
      payload: { password: 'sifre12345' },
    });
    expect(self.statusCode).toBe(204);
    expect(files()).toEqual([path.basename(thirdUser.avatarUrl!)]);

    const byAdmin = await app.inject({ method: 'DELETE', url: `/api/users/${third.user.id}`, headers: auth(admin.token) });
    expect(byAdmin.statusCode).toBe(204);
    expect(files()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: thirdUser.avatarUrl! })).statusCode).toBe(404);
  });

  it('temizlik: kimsenin kullanmadığı eski dosyalar silinir, kullanılanlara ve yabancı dosyalara dokunulmaz', async () => {
    const { member } = await setup();
    const user = (await upload(member.token, await solid('#ff0000').png().toBuffer())).json() as User;
    fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.webp`), 'artık');
    fs.writeFileSync(path.join(dir, `${'b'.repeat(16)}.tmp`), 'yarım');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'bize ait değil');
    expect(await ctx.avatars.sweep()).toBe(0);
    expect(await ctx.avatars.sweep(Date.now() + 2 * 60 * 60_000)).toBe(2);
    expect(files()).toEqual(['README.txt', path.basename(user.avatarUrl!)].sort());
  });

  it('şema güncellemesi: mevcut kullanıcılar fotoğrafsız başlar', () => {
    const file = path.join(dir, 'eski.db');
    // Profil fotoğraflarından önceki sürümün şeması (6): sütun yok
    const old = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, 6)) old.exec(sql);
    old.exec(`PRAGMA user_version = 6`);
    old.exec(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, is_admin, created_at)
       VALUES ('u1', 'eski', 'Eski', 'x', '#5865f2', 1, 1)`,
    );
    old.close();

    const upgraded = new Store(file);
    expect((upgraded.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    expect(upgraded.listUsers()).toMatchObject([{ username: 'eski', avatarUrl: null }]);
    upgraded.close();
  });

  it('gateway: READY fotoğrafları taşır, değişiklik USER_UPDATE ile herkese gider', async () => {
    const { admin, member } = await setup();
    const first = (await upload(member.token, await solid('#ff0000').png().toBuffer())).json() as User;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    const events: GatewayServerMessage[] = [];
    const ready = await new Promise<ReadyPayload>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayServerMessage;
        if (msg.t === 'HELLO') ws.send(JSON.stringify({ t: 'IDENTIFY', d: { token: admin.token } }));
        else if (msg.t === 'READY') resolve(msg.d);
        else events.push(msg);
      });
    });
    expect(ready.users.find((u) => u.id === member.user.id)?.avatarUrl).toBe(first.avatarUrl);
    expect(ready.user.avatarUrl).toBeNull();

    const second = (await upload(member.token, await solid('#0000ff').png().toBuffer())).json() as User;
    await remove(member.token);
    await new Promise((r) => setTimeout(r, 150));
    const updates = events.filter((e) => e.t === 'USER_UPDATE').map((e) => (e.d as User).avatarUrl);
    expect(updates).toEqual([second.avatarUrl, null]);
    ws.close();
  });
});

describe('profil afişi, tema ve efekt', () => {
  const uploadBanner = (token: string, body: Buffer) =>
    app.inject({
      method: 'POST',
      url: '/api/me/banner',
      headers: { ...auth(token), 'content-type': 'image/png' },
      payload: body,
    });

  it('afiş 1020×360 WebP olur, sunulur, değişince eskisi silinir, kaldırılır', async () => {
    const { member } = await setup();
    const res = await uploadBanner(member.token, await halves(2000, 1000).png().toBuffer());
    expect(res.statusCode).toBe(200);
    const user = res.json() as User;
    expect(user.bannerUrl).toMatch(new RegExp(`^/api/banners/${member.user.id}/[0-9a-f]{32}\.webp$`));
    expect(user.avatarUrl).toBeNull();

    const served = await app.inject({ method: 'GET', url: user.bannerUrl! });
    expect(served.statusCode).toBe(200);
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(await sharp(served.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 1020, height: 360 });
    // Afişin adresi fotoğraf olarak sunulmaz (ve tersi)
    expect((await app.inject({ method: 'GET', url: user.bannerUrl!.replace('/banners/', '/avatars/') })).statusCode).toBe(404);

    const second = (await uploadBanner(member.token, await solid('#00ff00', 1200, 400).png().toBuffer())).json() as User;
    expect(second.bannerUrl).not.toBe(user.bannerUrl);
    expect(files()).toEqual([path.basename(second.bannerUrl!)]);
    expect((await app.inject({ method: 'GET', url: user.bannerUrl! })).statusCode).toBe(404);

    const removed = await app.inject({ method: 'DELETE', url: '/api/me/banner', headers: auth(member.token) });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as User).bannerUrl).toBeNull();
    expect(files()).toEqual([]);
  });

  it('afiş temizlikte silinmez, hesap silinince silinir', async () => {
    const { member } = await setup();
    await uploadBanner(member.token, await solid('#123456', 1020, 360).png().toBuffer());
    expect(files()).toHaveLength(1);
    expect(await ctx.avatars.sweep(Date.now() + 2 * 3600_000)).toBe(0);
    await app.inject({ method: 'DELETE', url: '/api/me', headers: auth(member.token), payload: { password: 'sifre12345' } });
    expect(files()).toEqual([]);
  });

  it('tema renkleri kaydedilir, geçersizleri reddedilir, null kaldırır; kaldırılan kozmetik alanları yok sayılır', async () => {
    const { member } = await setup();
    const patch = (payload: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/me', headers: auth(member.token), payload: payload as object });

    const ok = await patch({ profileTheme: { primary: '#FF0000', accent: '#00ff00' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ profileTheme: { primary: '#ff0000', accent: '#00ff00' } });

    expect((await patch({ profileTheme: { primary: 'red', accent: '#00ff00' } })).statusCode).toBe(400);
    expect((await patch({ profileTheme: { primary: '#ff0000' } })).statusCode).toBe(400);

    // Eski istemciler (0.11.3 ve öncesi) kaldırılan kozmetik alanlarını gönderebilir: istek reddedilmez,
    // aynı istekteki diğer alanlar kaydedilir, kozmetik alanları yanıtta hiç yoktur
    const legacy = await patch({
      displayName: 'Üye',
      profileEffect: 'kuzey',
      avatarDecoration: 'anim:olmayan-set',
      nameplate: 'fireworks',
      profileFrame: 'gold',
    });
    expect(legacy.statusCode).toBe(200);
    const user = legacy.json() as Record<string, unknown>;
    expect(user).toMatchObject({ displayName: 'Üye', profileTheme: { primary: '#ff0000', accent: '#00ff00' } });
    for (const key of ['profileEffect', 'animatedEffect', 'avatarDecoration', 'profileFrame', 'nameplate']) {
      expect(key in user).toBe(false);
    }
    expect((await patch({ nameplate: null, avatarDecoration: null })).statusCode).toBe(200);

    const cleared = (await patch({ profileTheme: null })).json() as User;
    expect(cleared.profileTheme).toBeNull();
  });

  it('avatar rengi: tema varsa ana renk, yoksa saklı renk (eski istemci avatarColor göndermeye devam eder)', async () => {
    const { member } = await setup();
    const patch = (payload: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/me', headers: auth(member.token), payload: payload as object });
    const me = async () =>
      (await app.inject({ method: 'GET', url: '/api/me', headers: auth(member.token) })).json() as User;

    const stored = (await me()).avatarColor;
    expect(AVATAR_COLORS).toContain(stored);

    // Tema kaydedilince güncelleme yanıtı (USER_UPDATE ile aynı nesne) ve okuma yeni rengi taşır
    const themed = (await patch({ profileTheme: { primary: '#123abc', accent: '#00ff00' } })).json() as User;
    expect(themed.avatarColor).toBe('#123abc');
    expect((await me()).avatarColor).toBe('#123abc');

    // Tema değişince renk de değişir
    expect(((await patch({ profileTheme: { primary: '#ABCDEF', accent: '#00ff00' } })).json() as User).avatarColor).toBe('#abcdef');

    // Eski istemci avatarColor gönderir: kabul edilir ve saklanır, ama tema varken görünen renk temanınkidir
    const other = AVATAR_COLORS.find((c) => c !== stored)!;
    const old = await patch({ avatarColor: other });
    expect(old.statusCode).toBe(200);
    expect((old.json() as User).avatarColor).toBe('#abcdef');
    expect((await patch({ avatarColor: '#010203' })).statusCode).toBe(400);

    // Tema kalkınca saklı renk (eski istemcinin son gönderdiği) görünür
    const cleared = (await patch({ profileTheme: null })).json() as User;
    expect(cleared.profileTheme).toBeNull();
    expect(cleared.avatarColor).toBe(other);
    expect((await me()).avatarColor).toBe(other);
  });
});
