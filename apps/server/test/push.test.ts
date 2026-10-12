import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { ApnsClient, type ApnsTransport } from '../src/apns.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { parsePushTag, pushTag } from '@diskort/shared';
import { joinGuild } from './helpers.js';
import { PushService } from '../src/push.js';

const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '.' });

function serviceAccountFile(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'diskort-fcm-'));
  const file = join(dir, 'fcm.json');
  writeFileSync(
    file,
    JSON.stringify({
      project_id: 'diskort-test',
      client_email: 'fcm@diskort-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://oauth2.test/token',
    }),
  );
  return file;
}

/** Google'ın erişim jetonu ve FCM uçlarını taklit eder; istekleri kaydeder. */
function fakeGoogle(fcmStatus = 200, fcmBody = '{}') {
  const requests: { url: string; body: string; auth?: string }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    requests.push({
      url: u,
      body: String(init?.body ?? ''),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    if (u === 'https://oauth2.test/token') {
      return new Response(JSON.stringify({ access_token: 'erisim-jetonu', expires_in: 3600 }), { status: 200 });
    }
    return new Response(fcmBody, { status: fcmStatus });
  }) as typeof fetch;
  return { fn, requests };
}

let app: FastifyInstance | undefined;
let ctx: AppContext;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function start(google: ReturnType<typeof fakeGoogle>) {
  const built = await buildApp(config, { dbFile: ':memory:', logger: false });
  app = built.app;
  ctx = built.ctx;
  // Sahte Google ile çalışan bildirim servisi (testler doğrudan çağırır)
  const push = new PushService(ctx.store, serviceAccountFile(), { warn: () => undefined, info: () => undefined }, google.fn);

  const bootstrap = ctx.store.ensureBootstrapInvite()!;
  const admin = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: bootstrap.code, username: 'ayse', password: 'sifre12345' },
    })
  ).json() as { token: string; user: { id: string } };
  const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: auth(admin.token), payload: {} })).json()
    .code as string;
  const member = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: code, username: 'mehmet', password: 'sifre12345', displayName: 'Mehmet' },
    })
  ).json() as { token: string; user: { id: string } };
  await joinGuild(app, ctx.guild.id, admin.token, member.token);
  const text = ctx.store.listChannels(ctx.guild.id).find((c) => c.type === 'text')!;
  return { admin, member, text, push };
}

describe('telefon bildirimleri', () => {
  it('cihaz jetonu kaydedilir, başka hesaba taşınır ve silinir', async () => {
    const { admin, member } = await start(fakeGoogle());
    const save = (token: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/me/push-tokens',
        headers: auth(token),
        payload: { token: 'cihaz-jetonu-123456', platform: 'android' },
      });
    expect((await save(member.token)).statusCode).toBe(204);
    expect(ctx.store.pushTokens([member.user.id])).toHaveLength(1);
    // Aynı telefonda başka hesapla giriş: jeton yeni hesaba geçer
    await save(admin.token);
    expect(ctx.store.pushTokens([member.user.id])).toHaveLength(0);
    expect(ctx.store.pushTokens([admin.user.id])).toHaveLength(1);

    const del = await app!.inject({
      method: 'DELETE',
      url: '/api/me/push-tokens',
      headers: auth(admin.token),
      payload: { token: 'cihaz-jetonu-123456' },
    });
    expect(del.statusCode).toBe(204);
    expect(ctx.store.pushTokens([admin.user.id])).toHaveLength(0);
  });

  it('bahsedilen kullanıcının telefonuna FCM ile bildirim gider', async () => {
    const google = fakeGoogle();
    const { admin, member, text, push } = await start(google);
    ctx.store.savePushToken(member.user.id, 'mehmetin-telefonu', 'android');
    const message = ctx.store.createMessage(text.id, admin.user.id, '@mehmet bakar mısın?')!;
    await push.notifyMention(message, ctx.store.resolveMentions(message.content, admin.user.id), text.name);

    const token = google.requests.find((r) => r.url === 'https://oauth2.test/token')!;
    const assertion = decodeJwt(new URLSearchParams(token.body).get('assertion')!);
    expect(assertion).toMatchObject({
      iss: 'fcm@diskort-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });

    const send = google.requests.find((r) => r.url.includes('fcm.googleapis.com'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/diskort-test/messages:send');
    expect(send.auth).toBe('Bearer erisim-jetonu');
    const body = JSON.parse(send.body) as { message: Record<string, any> };
    expect(body.message.token).toBe('mehmetin-telefonu');
    expect(body.message.notification.body).toBe('@Mehmet bakar mısın?');
    expect(body.message.data).toEqual({ type: 'mention', channelId: text.id, messageId: message.id });
    expect(body.message.android.notification.channel_id).toBe('diskort-mentions');
    expect(body.message.android.notification.tag).toBe(pushTag(text.id, message.id));
  });

  it('rol etiketi bildirim metninde rol adıyla yazılır (başka sunucunun ya da silinmiş rolü yazılmaz)', async () => {
    const google = fakeGoogle();
    const { admin, member, text, push } = await start(google);
    const role = ctx.store.createRole(text.guildId, { name: 'Oyun Ekibi', color: null, hoist: false, permissions: 0 });
    ctx.store.addMemberRole(member.user.id, role.id);
    ctx.store.savePushToken(member.user.id, 'mehmetin-telefonu', 'android');
    const message = ctx.store.createMessage(text.id, admin.user.id, `<@&${role.id}> ve <@&yokboyle> gelin`)!;
    const mentioned = ctx.store.resolveRoleMentions(message.content, admin.user.id, text.guildId);
    expect(mentioned).toEqual([member.user.id]);
    await push.notifyMention(message, mentioned, text.name, text.guildId);

    const send = google.requests.find((r) => r.url.includes('fcm.googleapis.com'))!;
    const body = JSON.parse(send.body) as { message: Record<string, any> };
    expect(body.message.notification.body).toBe('@Oyun Ekibi ve @silinmiş-rol gelin');
  });

  it('direkt mesaj ayrı Android kanalından, her mesaj ayrı bildirim olarak gider (etiket yok)', async () => {
    const google = fakeGoogle();
    const { admin, member, push } = await start(google);
    ctx.store.savePushToken(member.user.id, 'mehmetin-telefonu', 'android');
    const { dm } = ctx.store.openDirectDm(admin.user.id, member.user.id);
    const message = ctx.store.createMessage(dm.id, admin.user.id, 'akşam @mehmet ile görüşelim mi?')!;
    await push.notifyDm(message, [member.user.id], ctx.store.getDm(dm.id)!);

    const send = google.requests.find((r) => r.url.includes('fcm.googleapis.com'))!;
    const body = JSON.parse(send.body) as { message: Record<string, any> };
    expect(body.message.token).toBe('mehmetin-telefonu');
    expect(body.message.notification).toEqual({ title: 'ayse', body: 'akşam @Mehmet ile görüşelim mi?' });
    expect(body.message.data).toEqual({ type: 'dm', channelId: dm.id, messageId: message.id });
    // Etiket mesaja özgü: yeni mesaj öncekinin yerini almaz; telefon okununca kanalı etiketten bulur
    expect(body.message.android.notification).toEqual({
      channel_id: 'diskort-dm',
      tag: pushTag(dm.id, message.id),
      color: '#5865f2',
    });
    expect(parsePushTag(body.message.android.notification.tag)).toEqual({ channelId: dm.id, messageId: message.id });
    expect(parsePushTag(`dm-${dm.id}`)).toBeNull();
    expect(parsePushTag('diskort:a:b:12')).toEqual({ channelId: 'a:b', messageId: '12' });
    expect(parsePushTag('diskort:12')).toBeNull();

    // Grup: başlıkta grubun adı; yalnızca dosya içeren mesajda dosya bilgisi
    google.requests.length = 0;
    const group = ctx.store.createGroupDm(admin.user.id, [member.user.id], 'Hafta sonu');
    const onlyFiles = ctx.store.createMessage(group.id, admin.user.id, '')!;
    const file = { id: 'a', name: 'x.png', size: 1, contentType: 'image/png', width: 1, height: 1, url: '/x' };
    await push.notifyDm({ ...onlyFiles, attachments: [file, file] }, [member.user.id], group);
    const groupSend = JSON.parse(google.requests.find((r) => r.url.includes('fcm.googleapis.com'))!.body) as {
      message: Record<string, any>;
    };
    expect(groupSend.message.notification).toEqual({ title: 'ayse · Hafta sonu', body: '📎 2 dosya gönderdi' });
  });

  it('uygulama kaldırılmışsa (UNREGISTERED) jeton silinir; erişim jetonu önbelleklenir', async () => {
    const google = fakeGoogle(404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}');
    const { admin, member, text, push } = await start(google);
    ctx.store.savePushToken(member.user.id, 'eski-telefon-jetonu', 'android');
    const m1 = ctx.store.createMessage(text.id, admin.user.id, '@mehmet bir')!;
    await push.notifyMention(m1, [member.user.id], text.name);
    expect(ctx.store.pushTokens([member.user.id])).toHaveLength(0);

    ctx.store.savePushToken(member.user.id, 'yeni-telefon-jetonu', 'android');
    await push.notifyMention(m1, [member.user.id], text.name);
    expect(google.requests.filter((r) => r.url === 'https://oauth2.test/token')).toHaveLength(1);
  });

  it('hizmet hesabı yoksa hiçbir şey gönderilmez', async () => {
    const google = fakeGoogle();
    const built = await buildApp(config, { dbFile: ':memory:', logger: false });
    app = built.app;
    const push = new PushService(built.ctx.store, null, { warn: () => undefined, info: () => undefined }, google.fn);
    expect(push.enabled).toBe(false);
    await push.notifyMention(
      {
        id: '1',
        channelId: 'c',
        authorId: null,
        content: '@x',
        createdAt: 0,
        editedAt: null,
        attachments: [],
        reactions: [],
        mentionEveryone: false,
      },
      ['u'],
      'genel',
    );
    expect(google.requests).toHaveLength(0);
  });
});

describe('iOS bildirimleri (APNs)', () => {
  const quiet = { warn: () => undefined, info: () => undefined };

  function apnsKeyFile(): string {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const dir = mkdtempSync(join(tmpdir(), 'diskort-apns-'));
    const file = join(dir, 'AuthKey.p8');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return file;
  }

  function fakeApple(status = 200, body = '') {
    const requests: { origin: string; path: string; headers: Record<string, string>; body: string }[] = [];
    const transport: ApnsTransport = async (origin, path, headers, payload) => {
      requests.push({ origin, path, headers, body: payload });
      return { status, body };
    };
    return { transport, requests };
  }

  async function startIos(apple: ReturnType<typeof fakeApple>, withFcm = false) {
    const google = fakeGoogle();
    const env = await start(google);
    const apns = new ApnsClient(
      { keyFile: apnsKeyFile(), keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'com.diskort.app', sandbox: false },
      quiet,
      apple.transport,
    );
    const push = new PushService(ctx.store, withFcm ? serviceAccountFile() : null, quiet, google.fn, apns);
    return { ...env, push, google };
  }

  it('iOS cihazına APNs ile, Android cihazına FCM ile gider', async () => {
    const apple = fakeApple();
    const { admin, member, text, push, google } = await startIos(apple, true);
    ctx.store.savePushToken(member.user.id, 'a1b2c3d4', 'ios');
    ctx.store.savePushToken(member.user.id, 'android-telefon', 'android');
    const message = ctx.store.createMessage(text.id, admin.user.id, '@mehmet bakar mısın?')!;
    await push.notifyMention(message, ctx.store.resolveMentions(message.content, admin.user.id), text.name);

    expect(apple.requests).toHaveLength(1);
    const req = apple.requests[0]!;
    expect(req.origin).toBe('https://api.push.apple.com');
    expect(req.path).toBe('/3/device/a1b2c3d4');
    expect(req.headers['apns-topic']).toBe('com.diskort.app');
    expect(req.headers['apns-push-type']).toBe('alert');
    // Yenisi eskisinin yerini almaz (collapse yok); konuşmaya göre gruplanır (thread-id)
    expect(req.headers['apns-collapse-id']).toBeUndefined();
    const jwt = req.headers.authorization!.replace(/^bearer /, '');
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decodeJwt(jwt).iss).toBe('TEAM123456');
    const payload = JSON.parse(req.body) as Record<string, any>;
    expect(payload.aps.alert.body).toBe('@Mehmet bakar mısın?');
    expect(payload.aps['thread-id']).toBe(text.id);
    expect(payload.channelId).toBe(text.id);
    expect(payload.body).toEqual({ type: 'mention', channelId: text.id, messageId: message.id });

    const fcm = google.requests.filter((r) => r.url.includes('fcm.googleapis.com'));
    expect(fcm).toHaveLength(1);
    expect(JSON.parse(fcm[0]!.body).message.token).toBe('android-telefon');
  });

  it('direkt mesajların her biri ayrı bildirimdir, iOS konuşmaya göre gruplar', async () => {
    const apple = fakeApple();
    const { admin, member, push, google } = await startIos(apple, true);
    ctx.store.savePushToken(member.user.id, 'a1b2c3d4', 'ios');
    ctx.store.savePushToken(member.user.id, 'android-telefon', 'android');
    const { dm } = ctx.store.openDirectDm(admin.user.id, member.user.id);
    const first = ctx.store.createMessage(dm.id, admin.user.id, 'selam')!;
    const second = ctx.store.createMessage(dm.id, admin.user.id, 'orada mısın?')!;
    await push.notifyDm(first, [member.user.id], ctx.store.getDm(dm.id)!);
    await push.notifyDm(second, [member.user.id], ctx.store.getDm(dm.id)!);

    expect(apple.requests).toHaveLength(2);
    for (const [i, req] of apple.requests.entries()) {
      expect(req.headers['apns-collapse-id']).toBeUndefined();
      const payload = JSON.parse(req.body) as Record<string, any>;
      expect(payload.aps['thread-id']).toBe(dm.id);
      expect(payload.channelId).toBe(dm.id);
      expect(payload.messageId).toBe([first, second][i]!.id);
    }
    const fcm = google.requests.filter((r) => r.url.includes('fcm.googleapis.com'));
    expect(fcm).toHaveLength(2);
    const tags = fcm.map((r) => (JSON.parse(r.body).message as Record<string, any>).android.notification.tag);
    expect(tags).toEqual([pushTag(dm.id, first.id), pushTag(dm.id, second.id)]);
    for (const r of fcm) expect(JSON.parse(r.body).message.data.channelId).toBe(dm.id);
  });

  it('gelen arama ayrı Android kanalından gider; cevapsız arama aynı etiketle (iOS: aynı collapse-id) yerini alır', async () => {
    const apple = fakeApple();
    const { admin, member, push, google } = await startIos(apple, true);
    ctx.store.savePushToken(member.user.id, 'a1b2c3d4', 'ios');
    ctx.store.savePushToken(member.user.id, 'android-telefon', 'android');
    const { dm } = ctx.store.openDirectDm(admin.user.id, member.user.id);
    const record = ctx.store.createCallMessage(dm.id, admin.user.id, [member.user.id]);
    await push.notifyCall(ctx.store.getDm(dm.id)!, admin.user.id, record.id, [member.user.id]);
    await push.notifyMissedCall(ctx.store.getDm(dm.id)!, admin.user.id, record.id, [member.user.id]);

    const fcm = google.requests.filter((r) => r.url.includes('fcm.googleapis.com')).map((r) => JSON.parse(r.body).message);
    expect(fcm).toHaveLength(2);
    expect(fcm[0].android.notification).toMatchObject({ channel_id: 'diskort-call', tag: pushTag(dm.id, record.id) });
    expect(fcm[0].data).toEqual({ type: 'call', channelId: dm.id, messageId: record.id });
    expect(fcm[0].notification).toEqual({ title: 'ayse', body: '📞 Seni arıyor' });
    expect(fcm[1].android.notification.tag).toBe(pushTag(dm.id, record.id));
    expect(fcm[1].data.type).toBe('missed_call');
    expect(fcm[1].notification.body).toBe('📞 Cevapsız arama');

    expect(apple.requests).toHaveLength(2);
    for (const req of apple.requests) {
      expect(req.headers['apns-collapse-id']).toBe(pushTag(dm.id, record.id));
      expect(JSON.parse(req.body).channelId).toBe(dm.id);
    }
  });

  it('APNs anahtarı varken FCM yoksa Android\'e gitmez; geçersiz iOS jetonu silinir', async () => {
    const apple = fakeApple(410, '{"reason":"Unregistered"}');
    const { member, push, google } = await startIos(apple);
    ctx.store.savePushToken(member.user.id, 'eski-ios', 'ios');
    ctx.store.savePushToken(member.user.id, 'android-telefon', 'android');
    expect(await push.sendTest(member.user.id)).toBe(1);
    expect(google.requests).toHaveLength(0);
    expect(ctx.store.pushTokens([member.user.id]).map((t) => t.token)).toEqual(['android-telefon']);
  });

  it('APNs anahtarı yoksa iOS jetonlarına bir şey gönderilmez', async () => {
    const google = fakeGoogle();
    const { member } = await start(google);
    const push = new PushService(ctx.store, serviceAccountFile(), quiet, google.fn);
    ctx.store.savePushToken(member.user.id, 'ios-jetonu', 'ios');
    expect(await push.sendTest(member.user.id)).toBe(0);
    expect(google.requests).toHaveLength(0);
  });
});
