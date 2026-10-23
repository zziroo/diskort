import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_FEATURE_DM, CLIENT_FEATURE_PRESENCE, type GatewayServerMessage, type User } from '@diskort/shared';
import { Coalescer } from '../src/gateway.js';
import { connectGateway, type GatewayClient, type TestServer, startServer } from './helpers.js';

let s: TestServer;
const clients: GatewayClient[] = [];

beforeEach(async () => {
  s = await startServer();
  await s.app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
});

const connect = async (token: string): Promise<GatewayClient> => {
  const client = await connectGateway(s.app, token, [CLIENT_FEATURE_DM, CLIENT_FEATURE_PRESENCE]);
  clients.push(client);
  return client;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bağlantının kapanma kodunu bekler */
const closed = (ws: WebSocket): Promise<number> =>
  ws.readyState === ws.CLOSED ? Promise.resolve(-1) : new Promise((r) => ws.once('close', (code) => r(code)));

describe('gateway oturumları', () => {
  it("eski istemcinin bildirdiği kaldırılmış 'cosmetic_packs' ve bilinmeyen bayraklar yok sayılır", async () => {
    const ali = await s.member('ali');
    const client = await connectGateway(s.app, ali.token, [CLIENT_FEATURE_DM, 'cosmetic_packs', 'ileride-gelecek']);
    clients.push(client);
    // Bağlantı kurulur, bilinen bayrak (DM) etkindir, kullanıcıda kozmetik alanı yoktur
    expect(client.ready.dms).toBeDefined();
    expect(s.ctx.gateway.isOnline(ali.user.id)).toBe(true);
    for (const key of ['animatedEffect', 'avatarDecoration', 'nameplate']) expect(key in client.ready.user).toBe(false);
  });

  it('kimlik doğrulanırken kapanan bağlantı çevrimiçi kalmaz (hayalet oturum)', async () => {
    const ali = await s.member('ali');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = s.ctx.auth.userFromToken.bind(s.ctx.auth);
    s.ctx.auth.userFromToken = async (token: string): Promise<User | null> => {
      await gate;
      return original(token);
    };

    const { port } = s.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    await new Promise<void>((resolve) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayServerMessage;
        if (msg.t === 'HELLO') {
          ws.send(JSON.stringify({ t: 'IDENTIFY', d: { token: ali.token, features: [CLIENT_FEATURE_DM] } }));
          resolve();
        }
      }),
    );
    await wait(50); // IDENTIFY sunucuda jeton denetiminde bekliyor
    ws.close();
    await closed(ws);
    await wait(50);
    release();
    await wait(100);

    expect(s.ctx.gateway.isOnline(ali.user.id)).toBe(false);
    expect(s.ctx.gateway.connectedUserIds()).not.toContain(ali.user.id);
    expect(s.ctx.gateway.sessionsInfo()).toEqual([]);
    expect(s.ctx.gateway.openSockets()).toBe(0);
  });

  it('şifre değişince diğer cihazların bağlantısı kapanır, bu cihazınki kalır; bildirim jetonları silinir', async () => {
    const ali = await s.member('ali');
    const other = await connect(ali.token);
    // Diğer cihaz başka bir girişten gelen ayrı jetonla bağlı (aynı saniyede aynı jeton üretilir)
    await wait(1100);
    const login = await s.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ali', password: 'sifre12345' },
    });
    const secondToken = login.json().token as string;
    const phone = await connect(secondToken);
    const self = await connect(ali.token);
    s.ctx.store.savePushToken(ali.user.id, 'bu-cihazin-jetonu-1234', 'android');
    s.ctx.store.savePushToken(ali.user.id, 'baska-cihazin-jetonu-1234', 'android');

    const phoneClosed = closed(phone.ws);
    const res = await s.req(ali.token, 'POST', '/api/me/password', {
      currentPassword: 'sifre12345',
      newPassword: 'yenisifre123',
      pushToken: 'bu-cihazin-jetonu-1234',
    });
    expect(res.statusCode).toBe(200);
    expect(await phoneClosed).toBe(4004);
    expect(phone.of('INVALID_SESSION')).toHaveLength(1);
    // Aynı jetonla bağlı olan (şifreyi değiştiren) cihazlar açık kalır
    await self.settle();
    expect(self.ws.readyState).toBe(WebSocket.OPEN);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
    expect(s.ctx.gateway.isOnline(ali.user.id)).toBe(true);
    expect(s.ctx.store.pushTokens([ali.user.id]).map((t) => t.token)).toEqual(['bu-cihazin-jetonu-1234']);

    // Jeton verilmezse hepsi silinir
    const fresh = res.json().token as string;
    await s.req(fresh, 'POST', '/api/me/password', { currentPassword: 'yenisifre123', newPassword: 'ucuncusifre1' });
    expect(s.ctx.store.pushTokens([ali.user.id])).toEqual([]);
  }, 15_000);

  it('sıfırlama koduyla şifre sıfırlanınca bütün bağlantılar kapanır ve bildirim jetonları silinir', async () => {
    const ali = await s.member('ali');
    const a = await connect(ali.token);
    const b = await connect(ali.token);
    s.ctx.store.savePushToken(ali.user.id, 'telefon-jetonu-12345', 'ios');
    const { code } = (await s.req(s.owner.token, 'POST', `/api/users/${ali.user.id}/reset-code`)).json() as { code: string };
    const done = Promise.all([closed(a.ws), closed(b.ws)]);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { username: 'ali', code, newPassword: 'sifirlandi123' },
    });
    expect(res.statusCode).toBe(200);
    expect(await done).toEqual([4004, 4004]);
    expect(s.ctx.gateway.isOnline(ali.user.id)).toBe(false);
    expect(s.ctx.store.pushTokens([ali.user.id])).toEqual([]);
  });

  it('boşta ve ses durumu seli sınırlanır ama son istenen durum kaybolmaz', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    await cv.settle();
    const before = cv.of('PRESENCE_UPDATE').length;
    for (let i = 0; i < 200; i++) ca.ws.send(JSON.stringify({ t: 'IDLE_SET', d: { idle: i % 2 === 0 } }));
    // Son mesaj idle: false; ardından bir kez daha true: son hâl "Boşta" olmalı
    ca.ws.send(JSON.stringify({ t: 'IDLE_SET', d: { idle: true } }));
    await wait(1200);
    const updates = cv.of('PRESENCE_UPDATE').slice(before).filter((p) => p.userId === ali.user.id);
    expect(updates.length).toBeLessThanOrEqual(10);
    expect(updates.at(-1)?.status).toBe('idle');
    expect(s.ctx.gateway.presenceOf(ali.user.id).status).toBe('idle');

    // Ses durumu: seste iken sel sonunda son bayraklar uygulanır
    const voice = s.channel('voice').id;
    s.ctx.voice.join(ali.user.id, voice);
    for (let i = 0; i < 100; i++) {
      ca.ws.send(JSON.stringify({ t: 'VOICE_STATE_SET', d: { selfMute: i % 2 === 1, selfDeaf: false } }));
    }
    ca.ws.send(JSON.stringify({ t: 'VOICE_STATE_SET', d: { selfMute: true, selfDeaf: true } }));
    await wait(1200);
    expect(s.ctx.voice.list().find((v) => v.userId === ali.user.id)).toMatchObject({ selfMute: true, selfDeaf: true });
  });

  it('Coalescer: kova dolana dek anında, sonra aralıklı; ara değerler atlanır, son değer uygulanır', async () => {
    const applied: number[] = [];
    const c = new Coalescer<number>((v) => applied.push(v), 2, 50);
    for (let i = 1; i <= 10; i++) c.push(i);
    expect(applied).toEqual([1, 2]);
    await wait(120);
    expect(applied).toEqual([1, 2, 10]);
    c.push(11);
    c.cancel();
    await wait(80);
    // 11 ya kovadan anında uygulandı ya da iptal edildi; iptalden sonra hiçbir şey gelmez
    expect(applied.filter((v) => v > 11)).toEqual([]);
  });
});
