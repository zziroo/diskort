import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  CUSTOM_STATUS_MAX_LENGTH,
  type SelfStatus,
} from '@diskort/shared';
import { connectGateway, type Account, type GatewayClient, type TestServer, startServer } from './helpers.js';

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

const connect = async (
  token: string,
  opts: { platform?: 'desktop' | 'android' | 'ios'; presence?: boolean } = {},
): Promise<GatewayClient> => {
  const features = [CLIENT_FEATURE_DM, ...(opts.presence === false ? [] : [CLIENT_FEATURE_PRESENCE])];
  const client = await connectGateway(s.app, token, features, opts.platform ? { platform: opts.platform } : {});
  clients.push(client);
  return client;
};

const setStatus = async (who: Account, body: unknown): Promise<SelfStatus> => {
  const res = await s.req(who.token, 'PATCH', '/api/me/status', body);
  expect(res.statusCode).toBe(200);
  return res.json() as SelfStatus;
};

const idle = (c: GatewayClient, value: boolean): void => c.ws.send(JSON.stringify({ t: 'IDLE_SET', d: { idle: value } }));

const HOUR = 60 * 60_000;

describe('durum', () => {
  it('doğrulama: geçersiz durum, uzun metin, geçersiz emoji ve süre reddedilir; hız sınırı', async () => {
    const ali = await s.member('ali');
    const bad = [
      { status: 'mesgul' },
      {},
      { customStatus: { text: 'x'.repeat(CUSTOM_STATUS_MAX_LENGTH + 1) } },
      { customStatus: { text: 'selam', emoji: 'değil' } },
      { status: 'dnd', expiresInMs: 10 },
      { status: 'dnd', expiresInMs: 400 * 24 * HOUR },
    ];
    for (const body of bad) expect((await s.req(ali.token, 'PATCH', '/api/me/status', body)).statusCode).toBe(400);

    const ok = await setStatus(ali, {
      status: 'dnd',
      expiresInMs: HOUR,
      customStatus: { text: '  toplantıda\nçıkınca  bakarım ', emoji: '📅', expiresInMs: 30 * 60_000 },
    });
    expect(ok.status).toBe('dnd');
    expect(ok.expiresAt).toBeGreaterThan(Date.now() + HOUR - 5000);
    expect(ok.customStatus).toEqual({ text: 'toplantıda çıkınca bakarım', emoji: '📅' });
    expect(ok.customStatusExpiresAt).toBeGreaterThan(Date.now());
    // Verilmeyen alan değişmez; null özel durumu temizler
    expect((await setStatus(ali, { status: 'idle' })).customStatus).not.toBeNull();
    expect((await setStatus(ali, { customStatus: null })).customStatus).toBeNull();
    expect((await s.req(ali.token, 'GET', '/api/me/status')).json()).toMatchObject({ status: 'idle', expiresAt: null });

    let limited = 0;
    for (let i = 0; i < 25; i++) {
      if ((await s.req(ali.token, 'PATCH', '/api/me/status', { status: 'online' })).statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('görünmez: başkalarına çevrimdışı görünür, gerçek durumu ve özel durumu sızmaz; kendi cihazları bilir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca = await connect(ali.token);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([
      { userId: ali.user.id, online: true, status: 'online', customStatus: null, activities: [] },
    ]);
    cv.events.length = 0;

    await setStatus(ali, { status: 'invisible', customStatus: { text: 'gizli plan' } });
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE')).toEqual([{ userId: ali.user.id, online: false, status: 'offline', customStatus: null }]);
    // Ali'nin kendi oturumu gerçek ayarı alır
    await ca.settle();
    expect(ca.of('USER_STATUS_UPDATE').at(-1)).toMatchObject({ status: 'invisible', customStatus: { text: 'gizli plan' } });
    cv.events.length = 0;

    // Görünmezken yapılan hiçbir şey (özel durum, boşta, yeni cihaz, bağlantının kopması) olay üretmez
    await setStatus(ali, { customStatus: { text: 'yine gizli' } });
    idle(ca, true);
    const ca2 = await connect(ali.token, { platform: 'android' });
    expect(ca2.ready.status).toMatchObject({ status: 'invisible' });
    expect(ca2.ready.online).not.toContain(ali.user.id);
    ca.ws.close();
    ca2.ws.close();
    await cv.settle();
    expect(cv.events.filter((e) => JSON.stringify(e).includes(ali.user.id))).toEqual([]);

    // Yeniden bağlanan / yeni katılan: READY ve GUILD_CREATE'te de görünmez
    const ca3 = await connect(ali.token);
    const cv2 = await connect(veli.token);
    expect(cv2.ready.online).not.toContain(ali.user.id);
    expect(JSON.stringify(cv2.ready.presences)).not.toContain('gizli');
    const guild = (await s.req(s.owner.token, 'POST', '/api/guilds', { name: 'İkinci' })).json() as { guild: { id: string } };
    const code = (await s.req(s.owner.token, 'POST', `/api/guilds/${guild.guild.id}/invites`, {})).json().code as string;
    await s.req(ali.token, 'POST', `/api/invites/${code}/accept`, {});
    const co = await connect(s.owner.token);
    await co.settle();
    expect(co.ready.online).not.toContain(ali.user.id);
    expect(JSON.stringify(co.events)).not.toContain('gizli');
    expect(JSON.stringify(co.ready)).not.toContain('gizli');

    // Görünür olunca özel durumla birlikte duyurulur
    cv2.events.length = 0;
    await setStatus(ali, { status: 'online' });
    await cv2.settle();
    expect(cv2.of('PRESENCE_UPDATE')).toEqual([
      { userId: ali.user.id, online: true, status: 'online', customStatus: { text: 'yine gizli', emoji: null }, activities: [] },
    ]);
    void ca3;
  });

  it('süre dolunca çevrim içine döner, özel durum temizlenir; tüm cihazlara bildirilir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const ca1 = await connect(ali.token);
    const ca2 = await connect(ali.token, { platform: 'android' });
    await setStatus(ali, { status: 'dnd', expiresInMs: HOUR, customStatus: { text: 'odak', expiresInMs: 4 * HOUR } });
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ status: 'dnd', customStatus: { text: 'odak' } });
    expect(ca2.of('USER_STATUS_UPDATE').at(-1)).toMatchObject({ status: 'dnd' });

    // Süresi dolmadan bir şey olmaz
    s.ctx.gateway.expireStatuses(Date.now() + HOUR / 2);
    s.ctx.gateway.expireStatuses(Date.now() + 2 * HOUR);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ status: 'online', customStatus: { text: 'odak' } });
    for (const c of [ca1, ca2]) {
      expect(c.of('USER_STATUS_UPDATE').at(-1)).toEqual({
        status: 'online',
        expiresAt: null,
        customStatus: { text: 'odak', emoji: null },
        customStatusExpiresAt: expect.any(Number),
      });
    }
    s.ctx.gateway.expireStatuses(Date.now() + 5 * HOUR);
    await cv.settle();
    expect(cv.of('PRESENCE_UPDATE').at(-1)).toEqual({
      userId: ali.user.id,
      online: true,
      status: 'online',
      customStatus: null,
      activities: [],
    });
    expect(s.ctx.gateway.statuses.get(ali.user.id).customStatus).toBeNull();
  });

  it('otomatik boşta: tüm oturumlar boştaysa Boşta; elle seçilen durumu ezmez', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const desk = await connect(ali.token);
    const phone = await connect(ali.token, { platform: 'android' });
    const last = async () => {
      await cv.settle();
      return cv.of('PRESENCE_UPDATE').at(-1)?.status;
    };
    idle(desk, true);
    expect(await last()).toBe('online'); // telefonda etkin
    idle(phone, true);
    expect(await last()).toBe('idle');
    // Kendi cihazları da görür
    expect(desk.of('PRESENCE_UPDATE').at(-1)).toMatchObject({ userId: ali.user.id, status: 'idle' });
    idle(phone, false);
    expect(await last()).toBe('online');
    await setStatus(ali, { status: 'dnd' });
    idle(phone, true);
    idle(desk, true);
    expect(await last()).toBe('dnd');
    // Boştaki oturumlar kalırken etkin olan kapanırsa da boşta
    await setStatus(ali, { status: 'online' });
    idle(phone, false);
    expect(await last()).toBe('online');
    phone.ws.close();
    expect(await last()).toBe('idle');
  });

  it('yalnızca telefondan bağlı: mobile yalnızca tüm oturumlar telefondayken; bağlanınca/kopunca yeniden duyurulur', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const cv = await connect(veli.token);
    const last = async () => {
      await cv.settle();
      return cv.of('PRESENCE_UPDATE').filter((p) => p.userId === ali.user.id).at(-1);
    };
    const updates = () => cv.of('PRESENCE_UPDATE').filter((p) => p.userId === ali.user.id).length;

    // Yalnızca telefon: mobile
    const android = await connect(ali.token, { platform: 'android' });
    expect(await last()).toMatchObject({ online: true, status: 'online', mobile: true });
    // Yeni katılan READY'de de görür
    const cv2 = await connect(veli.token);
    expect(cv2.ready.presences?.[ali.user.id]).toMatchObject({ status: 'online', mobile: true });

    // Masaüstü de açılınca normal nokta (alan hiç gönderilmez: eski biçimle aynı nesne)
    const desk = await connect(ali.token);
    expect(await last()).toEqual({ userId: ali.user.id, online: true, status: 'online', customStatus: null, activities: [] });
    // Bir telefon daha: hâlâ karışık, yeni olay yok
    const before = updates();
    const ios = await connect(ali.token, { platform: 'ios' });
    await cv.settle();
    expect(updates()).toBe(before);

    // Son masaüstü kapanınca yeniden telefon
    desk.ws.close();
    expect(await last()).toMatchObject({ status: 'online', mobile: true });
    // Telefonlardan biri kapanınca değişen bir şey yok
    const before2 = updates();
    android.ws.close();
    await cv.settle();
    expect(updates()).toBe(before2);

    // Telefon arka planda (boşta): durum rengi değişir, telefon biçimi kalır
    idle(ios, true);
    expect(await last()).toMatchObject({ status: 'idle', mobile: true });
    await setStatus(ali, { status: 'dnd' });
    expect(await last()).toMatchObject({ status: 'dnd', mobile: true });

    // Görünmez: çevrimdışı görünür, mobile sızmaz
    await setStatus(ali, { status: 'invisible' });
    expect(await last()).toEqual({ userId: ali.user.id, online: false, status: 'offline', customStatus: null });
    const cv3 = await connect(veli.token);
    expect(cv3.ready.presences?.[ali.user.id]).toBeUndefined();
    await setStatus(ali, { status: 'online' });
    expect(await last()).toMatchObject({ status: 'idle', mobile: true }); // telefon hâlâ arka planda

    // Platform bildirmeyen (eski masaüstü) oturum masaüstü sayılır
    const old = await connectGateway(s.app, ali.token, [CLIENT_FEATURE_DM]);
    clients.push(old);
    expect(await last()).toMatchObject({ status: 'online' });
    expect((await last())?.mobile).toBeUndefined();
    old.ws.close();
    expect(await last()).toMatchObject({ status: 'idle', mobile: true });

    // Son oturum kapanınca çevrimdışı (mobile yok)
    ios.ws.close();
    expect(await last()).toEqual({ userId: ali.user.id, online: false, status: 'offline', customStatus: null });
  });

  it('telefon bildirimi: Rahatsız Etmeyin ve masaüstünde etkin olana gitmez; boşta ya da görünmezken gider', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const text = s.channel('text').id;
    const calls: string[][] = [];
    s.ctx.push.notifyMention = async (_message, recipients) => {
      calls.push(recipients);
    };
    s.ctx.push.notifyDm = async (_message, recipients) => {
      calls.push(recipients);
    };
    const mention = async () => {
      calls.length = 0;
      expect((await s.req(ali.token, 'POST', `/api/channels/${text}/messages`, { content: '@veli bak' })).statusCode).toBe(201);
      return calls[0];
    };

    expect(await mention()).toEqual([veli.user.id]);
    await setStatus(veli, { status: 'dnd', expiresInMs: HOUR });
    expect(await mention()).toEqual([]);
    // Okunmamış bahsetme yine sayılır
    expect(s.ctx.store.mentionCounts(veli.user.id)[text]).toBe(2);
    // DM de bildirim üretmez
    const dm = (await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] })).json() as { id: string };
    calls.length = 0;
    await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'selam' });
    expect(calls).toEqual([[]]);
    // Süresi dolunca yine gider
    s.ctx.gateway.expireStatuses(Date.now() + 2 * HOUR);
    expect(await mention()).toEqual([veli.user.id]);

    await setStatus(veli, { status: 'invisible' });
    expect(await mention()).toEqual([veli.user.id]);
    await setStatus(veli, { status: 'online' });

    // Masaüstünde etkin (boşta bildirebilen yeni istemci): telefona gitmez; boştayken gider
    const desk = await connect(veli.token);
    expect(await mention()).toEqual([]);
    idle(desk, true);
    await desk.settle();
    expect(await mention()).toEqual([veli.user.id]);
    desk.ws.close();
    // Boşta bildirmeyen eski masaüstü ve telefon oturumu bildirimi kesmez
    await connect(veli.token, { presence: false });
    await connect(veli.token, { platform: 'android' });
    await desk.settle();
    expect(await mention()).toEqual([veli.user.id]);
  });

  it('ortak sunucusu olmayan durum ve özel durumu görmez', async () => {
    const ali = await s.member('ali');
    const yabanci = await s.member('yabanci');
    // yabancıyı ana sunucudan at: ali ile ortak sunucusu kalmaz
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${yabanci.user.id}`)).statusCode).toBe(204);
    const cy = await connect(yabanci.token);
    await connect(ali.token);
    await setStatus(ali, { status: 'dnd', customStatus: { text: 'özel' } });
    await cy.settle();
    expect(JSON.stringify(cy.events)).not.toContain(ali.user.id);
  });
});
