import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFailureLimiter } from '../src/routes/auth.js';
import { joinGuild } from './helpers.js';
import type { AppContext } from '../src/context.js';

const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '.' });

let app: FastifyInstance;
let ctx: AppContext;

beforeEach(async () => {
  ({ app, ctx } = await buildApp(config, { dbFile: ':memory:', logger: false }));
});

afterEach(async () => {
  await app.close();
});

async function register(inviteCode: string, username: string, password = 'sifre12345') {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode, username, password } });
}

async function adminToken(): Promise<string> {
  const invite = ctx.store.ensureBootstrapInvite()!;
  const res = await register(invite.code, 'admin');
  return res.json().token as string;
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function signedWebhook(body: object) {
  const raw = JSON.stringify(body);
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret);
  token.sha256 = createHash('sha256').update(raw).digest('base64');
  return app.inject({
    method: 'POST',
    url: '/api/livekit/webhook',
    headers: { 'content-type': 'application/webhook+json', authorization: await token.toJwt() },
    payload: raw,
  });
}

describe('kimlik doğrulama ve davetler', () => {
  it('ilk kayıt olan kullanıcı yönetici olur', async () => {
    const invite = ctx.store.ensureBootstrapInvite()!;
    const res = await register(invite.code, 'kurucu');
    expect(res.statusCode).toBe(201);
    expect(res.json().user.isAdmin).toBe(true);
    // Kullanıcı oluştuktan sonra yeni başlangıç daveti üretilmez.
    expect(ctx.store.ensureBootstrapInvite()).toBeNull();
  });

  it('geçersiz veya tükenmiş davetle kayıt reddedilir', async () => {
    expect((await register('YANLIS12', 'birisi')).statusCode).toBe(400);

    const token = await adminToken();
    const inv = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { authorization: `Bearer ${token}` },
      payload: { maxUses: 1 },
    });
    const code = inv.json().code as string;
    expect((await register(code, 'ayse')).statusCode).toBe(201);
    const second = await register(code, 'ali');
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invite');
  });

  it('davet kodu büyük/küçük harf ve boşluk duyarsızdır; davetle gelen kullanıcı yönetici değildir', async () => {
    const token = await adminToken();
    const code = (
      await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${token}` }, payload: {} })
    ).json().code as string;
    const res = await register(`  ${code.toLowerCase()} `, 'mehmet');
    expect(res.statusCode).toBe(201);
    expect(res.json().user.isAdmin).toBe(false);
  });

  it('aynı kullanıcı adı iki kez alınamaz', async () => {
    const token = await adminToken();
    const code = (
      await app.inject({ method: 'POST', url: `/api/guilds/${ctx.guild.id}/invites`, headers: { authorization: `Bearer ${token}` }, payload: {} })
    ).json().code as string;
    const res = await register(code, 'admin', 'baska-sifre-1');
    expect(res.statusCode).toBe(409);
    // Doğru şifreyle aynı ad: hesap sahibi giriş yapar ve davetin sunucusuna katılır (zaten üyeyse değişmez)
    const same = await register(code, 'admin');
    expect(same.statusCode).toBe(201);
    expect(same.json().user.username).toBe('admin');
  });

  it('yanlış şifreyle giriş reddedilir, doğru şifreyle kabul edilir', async () => {
    await adminToken();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'yanlis-sifre' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ADMIN', password: 'sifre12345' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.username).toBe('admin');
  });

  describe('kullanıcı adı başına giriş sınırı', () => {
    let nextIp = 0;
    /** Her deneme ayrı IP'den: IP sınırına takılmadan yalnız kullanıcı adı sınırı görülür */
    const login = (username: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: `10.0.${Math.floor(++nextIp / 250)}.${(nextIp % 250) + 1}`,
        payload: { username, password },
      });
    const failTimes = async (username: string, times: number) => {
      for (let i = 0; i < times; i++) expect((await login(username, 'yanlis-sifre')).statusCode).toBe(401);
    };

    it('bilinmeyen adda da argon2 doğrulaması çalışır', async () => {
      await adminToken();
      const spy = vi.spyOn(ctx.auth, 'verifyPassword');
      expect((await login('olmayan', 'bir-sifre')).statusCode).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe('bir-sifre');
    });

    it('10 başarısızdan sonra doğru şifre de 429 alır, argon2 çalışmaz; başka kullanıcı etkilenmez', async () => {
      const token = await adminToken();
      const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${token}` }, payload: {} })).json()
        .code as string;
      expect((await register(code, 'veli')).statusCode).toBe(201);

      await failTimes('  ADMIN ', 10);
      const spy = vi.spyOn(ctx.auth, 'verifyPassword');
      expect((await login('admin', 'yanlis-sifre')).statusCode).toBe(429);
      const blocked = await login('admin', 'sifre12345');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe('rate_limited');
      expect(spy).not.toHaveBeenCalled();

      expect((await login('veli', 'sifre12345')).statusCode).toBe(200);
      // Açık oturum etkilenmez
      expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    });

    it('kayıt ucu şifre sınama yolu değil: geçersiz davette argon2 çalışmaz, geçerli davette giriş sınırı işler', async () => {
      const token = await adminToken();
      const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${token}` }, payload: {} })).json()
        .code as string;
      const spy = vi.spyOn(ctx.auth, 'verifyPassword');
      expect((await register('GECERSIZ', 'admin', 'yanlis-sifre')).statusCode).toBe(400);
      expect((await register('GECERSIZ', 'admin')).statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();

      for (let i = 0; i < 10; i++) expect((await register(code, 'admin', 'yanlis-sifre')).statusCode).toBe(409);
      spy.mockClear();
      expect((await register(code, 'admin')).statusCode).toBe(429);
      expect(spy).not.toHaveBeenCalled();
      expect((await login('admin', 'sifre12345')).statusCode).toBe(429);
    });

    it('bilinmeyen ad da aynı sınıra takılır (429 hesabın varlığını ele vermez)', async () => {
      await failTimes('olmayan', 10);
      expect((await login('olmayan', 'yanlis-sifre')).statusCode).toBe(429);
    });

    it('başarılı giriş sayacı sıfırlar', async () => {
      await adminToken();
      await failTimes('admin', 9);
      expect((await login('admin', 'sifre12345')).statusCode).toBe(200);
      await failTimes('admin', 10);
      expect((await login('admin', 'yanlis-sifre')).statusCode).toBe(429);
    });

    it('sayaç pencere dolunca açılır, bellekte üst sınırı geçmez', () => {
      vi.useFakeTimers();
      try {
        const limiter = createFailureLimiter(1, 1_000, 2);
        expect(limiter.take('a')).toBe(true);
        expect(limiter.take('a')).toBe(false);
        vi.advanceTimersByTime(1_001);
        expect(limiter.take('a')).toBe(true);
        // Üçüncü anahtar en eskiyi atar: üst sınır aşılmaz
        expect(limiter.take('b')).toBe(true);
        expect(limiter.take('c')).toBe(true);
        expect(limiter.take('b')).toBe(false);
        expect(limiter.take('a')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('yönetici olmayan kullanıcı hesap daveti veya kanal oluşturamaz', async () => {
    const token = await adminToken();
    const code = (
      await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${token}` }, payload: {} })
    ).json().code as string;
    const userToken = (await register(code, 'uye')).json().token as string;
    await joinGuild(app, ctx.guild.id, token, userToken);
    const headers = { authorization: `Bearer ${userToken}` };
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers, payload: {} })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/guilds/${ctx.guild.id}/channels`,
          headers,
          payload: { name: 'x', type: 'voice' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('jetonsuz istek 401 döner', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });
});

describe('ses kanalları', () => {
  it('ses jetonu yalnızca ilgili odaya ve izin verilen kaynaklara yetki verir', async () => {
    const token = await adminToken();
    const channel = ctx.store.listChannels(ctx.guild.id).find((c) => c.type === 'voice')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/voice/${channel.id}/join`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roomName).toBe(`ch_${channel.id}`);
    const claims = decodeJwt(body.token);
    const video = claims.video as Record<string, unknown>;
    expect(video.room).toBe(`ch_${channel.id}`);
    expect(video.roomJoin).toBe(true);
    expect(video.roomAdmin).toBeUndefined();
    expect(video.canPublishSources).toEqual(['microphone', 'screen_share', 'screen_share_audio']);
  });

  it('olmayan kanal için ses jetonu verilmez', async () => {
    const token = await adminToken();
    const res = await app.inject({ method: 'POST', url: '/api/voice/yok/join', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });

  it('imzalı LiveKit webhookları ses durumunu günceller; imzasız olanlar reddedilir', async () => {
    const token = await adminToken();
    const userId = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } })).json()
      .id as string;
    const [a, b] = ctx.store.listChannels(ctx.guild.id).filter((c) => c.type === 'voice');
    const room = (id: string) => ({ name: `ch_${id}` });

    const unsigned = await app.inject({
      method: 'POST',
      url: '/api/livekit/webhook',
      headers: { 'content-type': 'application/webhook+json' },
      payload: JSON.stringify({ event: 'participant_joined', room: room(a!.id), participant: { identity: userId } }),
    });
    expect(unsigned.statusCode).toBe(401);
    expect(ctx.voice.get(userId)).toBeUndefined();

    await signedWebhook({ event: 'participant_joined', room: room(a!.id), participant: { identity: userId } });
    expect(ctx.voice.get(userId)?.channelId).toBe(a!.id);

    await signedWebhook({
      event: 'track_published',
      room: room(a!.id),
      participant: { identity: userId },
      track: { source: 'SCREEN_SHARE' },
    });
    expect(ctx.voice.get(userId)?.streaming).toBe(true);

    // Kanal değiştirme: yeni kanala katılım, eski kanaldan geç gelen ayrılma olayını geçersiz kılar.
    await signedWebhook({ event: 'participant_joined', room: room(b!.id), participant: { identity: userId } });
    await signedWebhook({ event: 'participant_left', room: room(a!.id), participant: { identity: userId } });
    expect(ctx.voice.get(userId)?.channelId).toBe(b!.id);
    expect(ctx.voice.get(userId)?.streaming).toBe(false);

    await signedWebhook({ event: 'participant_left', room: room(b!.id), participant: { identity: userId } });
    expect(ctx.voice.get(userId)).toBeUndefined();
  });
});

describe('ses durumu eşitleme', () => {
  it('LiveKit anlık görüntüsüyle kaçan katılma/ayrılmaları düzeltir', () => {
    const [a, b] = ctx.store.listChannels(ctx.guild.id).filter((c) => c.type === 'voice');
    ctx.voice.join('u1', a!.id);
    ctx.voice.join('u2', a!.id);
    ctx.voice.reconcile(
      new Map([
        ['u2', { channelId: b!.id, streaming: true }],
        ['u3', { channelId: a!.id, streaming: false }],
      ]),
    );
    expect(ctx.voice.get('u1')).toBeUndefined();
    expect(ctx.voice.get('u2')).toMatchObject({ channelId: b!.id, streaming: true });
    expect(ctx.voice.get('u3')?.channelId).toBe(a!.id);
  });

  it('anlık görüntü alınırken katılanı silmez', () => {
    const [a] = ctx.store.listChannels(ctx.guild.id).filter((c) => c.type === 'voice');
    const takenAt = Date.now() - 1000;
    ctx.voice.join('u4', a!.id);
    ctx.voice.reconcile(new Map(), takenAt);
    expect(ctx.voice.get('u4')?.channelId).toBe(a!.id);
    ctx.voice.reconcile(new Map(), Date.now() + 1);
    expect(ctx.voice.get('u4')).toBeUndefined();
  });
});
