import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';
import {
  CLIENT_FEATURE_DM,
  DM_PERMISSIONS,
  Permission as P,
  voiceRoomName,
  type DmCall,
  type DmChannel,
  type Message,
  type UserBlock,
  type VoiceTelemetryReport,
} from '@diskort/shared';
import type { AdminDashboard } from '../src/dashboard.js';
import { TrackSource } from '../src/livekit.js';
import { isPrivateId, PRIVATE_CALL_NAME } from '../src/privateCalls.js';
import { config, connectGateway, joinGuild, type Account, type GatewayClient, type TestServer, startServer } from './helpers.js';

// DM aramaları (çalma, zaman aşımı, reddetme, arama kaydı), DM ses yetkileri, engelleme ve yönetim
// panelinde DM aramalarının gizliliği.

const RING_MS = 1500;

let s: TestServer;
const clients: GatewayClient[] = [];

beforeEach(async () => {
  s = await startServer({ callRingMs: RING_MS });
  await s.app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
  vi.restoreAllMocks();
});

const connect = async (token: string, legacy = false): Promise<GatewayClient> => {
  const client = await connectGateway(s.app, token, legacy ? undefined : [CLIENT_FEATURE_DM]);
  clients.push(client);
  return client;
};

const openDm = async (from: Account, ...to: Account[]): Promise<DmChannel> => {
  const res = await s.req(from.token, 'POST', '/api/dms', { userIds: to.map((a) => a.user.id) });
  expect([200, 201]).toContain(res.statusCode);
  return res.json() as DmChannel;
};

/** LiveKit'e bağlandı: ses durumu + katılma webhook'u (sunucunun gördüğü sırayla) */
const joinRoom = (who: Account, channelId: string): void => {
  s.ctx.voice.join(who.user.id, channelId, false, `sid-${who.user.id}`);
  s.ctx.calls.webhookJoined(who.user.id, channelId);
};
const leaveRoom = (who: Account, channelId: string): void => {
  s.ctx.voice.leave(who.user.id, channelId);
};

const calls = (c: GatewayClient): DmCall[] => c.of('DM_CALL_UPDATE');
const lastCall = (c: GatewayClient): DmCall | undefined => calls(c).at(-1);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Webhook gövdesini LiveKit gibi imzalar */
async function signedWebhook(body: object) {
  const raw = JSON.stringify(body);
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret);
  token.sha256 = createHash('sha256').update(raw).digest('base64');
  return s.app.inject({
    method: 'POST',
    url: '/api/livekit/webhook',
    headers: { 'content-type': 'application/webhook+json', authorization: await token.toJwt() },
    payload: raw,
  });
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('DM sesli arama: yetkiler ve katılma', () => {
  it('katılımcı DM odasına bağlanabilir (mikrofon ve ekran izniyle); dışarıdaki 404, salt okunur konuşmada 403', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    expect(DM_PERMISSIONS & (P.CONNECT | P.SPEAK | P.STREAM)).toBe(P.CONNECT | P.SPEAK | P.STREAM);
    expect(s.ctx.permissions.inChannel(ali.user.id, dm.id)).toBe(DM_PERMISSIONS);

    const res = await s.req(ali.token, 'POST', `/api/voice/${dm.id}/join`);
    expect(res.statusCode).toBe(200);
    expect(res.json().roomName).toBe(voiceRoomName(dm.id));
    const grant = decodeJwt(res.json().token).video as { room: string; canPublishSources: string[] };
    expect(grant.room).toBe(voiceRoomName(dm.id));
    expect(grant.canPublishSources).toEqual(expect.arrayContaining(['microphone', 'screen_share', 'screen_share_audio']));

    const outsider = await s.member('merakli');
    expect((await s.req(outsider.token, 'POST', `/api/voice/${dm.id}/join`)).statusCode).toBe(404);
    expect((await s.req(s.owner.token, 'POST', `/api/voice/${dm.id}/join`)).statusCode).toBe(404);

    // Veli tek ortak sunucudan ayrıldı: konuşma salt okunur, arama da yok
    expect((await s.req(veli.token, 'DELETE', `/api/guilds/${s.guildId}/members/me`)).statusCode).toBe(204);
    expect(s.ctx.permissions.inChannel(ali.user.id, dm.id)).toBe(P.VIEW_CHANNEL);
    const denied = await s.req(ali.token, 'POST', `/api/voice/${dm.id}/join`);
    expect(denied.statusCode).toBe(403);
  });

  it('ses durumu DM odasında: sunucu susturması yok, yayın önizlemesi yalnızca katılımcılara', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    // Ali sunucuda susturulmuş olsa da DM'de susturma uygulanmaz
    s.ctx.store.setServerVoiceFlags(s.guildId, ali.user.id, { serverMute: true, serverDeaf: false });
    const state = s.ctx.voice.join(ali.user.id, dm.id);
    expect(state).toMatchObject({ serverMute: false, serverDeaf: false });
    expect(s.ctx.moderation.sources(ali.user.id, dm.id)).toEqual(
      expect.arrayContaining([TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]),
    );
    s.ctx.voice.setStreaming(ali.user.id, dm.id, true);
    const outsider = await s.member('merakli');
    expect((await s.req(outsider.token, 'GET', `/api/voice/${dm.id}/stream-preview/${ali.user.id}`)).statusCode).toBe(404);
    // Önizleme yüklenmedi: katılımcı için de 404, ama yol DM'yi tanıyor (yetki hatası değil)
    expect((await s.req(veli.token, 'GET', `/api/voice/${dm.id}/stream-preview/${ali.user.id}`)).statusCode).toBe(404);
  });

  it('kişi tek odada: DM aramasına girince sunucu kanalından çıkar (webhook)', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const voice = s.channel('voice');
    const join = (room: string, sid: string) =>
      signedWebhook({ event: 'participant_joined', room: { name: voiceRoomName(room) }, participant: { identity: ali.user.id, sid } });
    expect((await join(voice.id, 'A')).statusCode).toBe(200);
    expect(s.ctx.voice.get(ali.user.id)?.channelId).toBe(voice.id);
    expect((await join(dm.id, 'B')).statusCode).toBe(200);
    expect(s.ctx.voice.get(ali.user.id)?.channelId).toBe(dm.id);
    expect(s.livekit.of('removeParticipant')).toContainEqual([voice.id, ali.user.id]);
    // Webhook ile başlayan arama karşı tarafı çalar
    expect(s.ctx.calls.get(dm.id)?.ringing).toEqual([veli.user.id]);
  });
});

describe('DM aramaları: çalma ve arama kaydı', () => {
  it('ilk bağlanan diğerlerini çalar; katılınca çalma biter; oda boşalınca arama biter ve kayıt süresiyle güncellenir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const a = await connect(ali.token);
    const v = await connect(veli.token);
    const legacy = await connect(veli.token, true);
    const notifyCall = vi.spyOn(s.ctx.push, 'notifyCall');

    joinRoom(ali, dm.id);
    await v.settle();
    expect(lastCall(v)).toMatchObject({ channelId: dm.id, startedBy: ali.user.id, ringing: [veli.user.id] });
    expect(lastCall(a)?.ringing).toEqual([veli.user.id]);
    // Konuşmaya arama kaydı düştü (veli için okunmamış)
    const created = v.of('MESSAGE_CREATE').find((m) => m.channelId === dm.id)!;
    expect(created).toMatchObject({ type: 'call', authorId: ali.user.id, call: { participantIds: [ali.user.id], endedAt: null } });
    expect(lastCall(v)?.messageId).toBe(created.id);
    expect(s.ctx.store.mentionCounts(veli.user.id)[dm.id]).toBe(1);
    // Çalınan kişinin telefonuna bildirim (masaüstünde etkin değil)
    expect(notifyCall).toHaveBeenCalledWith(expect.objectContaining({ id: dm.id }), ali.user.id, created.id, [veli.user.id]);
    // Eski istemci (DM tanımayan) arama olaylarını almaz
    expect(legacy.events.some((e) => e.t.startsWith('DM_'))).toBe(false);

    // Yeni bağlanan oturum READY'de süren aramayı alır
    const late = await connect(veli.token);
    expect(late.ready.dmCalls).toEqual([expect.objectContaining({ channelId: dm.id, ringing: [veli.user.id] })]);

    joinRoom(veli, dm.id);
    await v.settle();
    expect(lastCall(v)?.ringing).toEqual([]);
    // Webhook ikinci kez çalmaz
    s.ctx.calls.webhookJoined(ali.user.id, dm.id);
    expect(notifyCall).toHaveBeenCalledTimes(1);

    leaveRoom(ali, dm.id);
    await v.settle();
    expect(v.of('DM_CALL_DELETE')).toEqual([]);
    leaveRoom(veli, dm.id);
    await v.settle();
    expect(v.of('DM_CALL_DELETE')).toEqual([{ channelId: dm.id }]);
    expect(s.ctx.calls.get(dm.id)).toBeNull();
    const updated = v.of('MESSAGE_UPDATE').find((m) => m.id === created.id)!;
    expect(updated.call).toMatchObject({ participantIds: [ali.user.id, veli.user.id] });
    expect(updated.call!.endedAt).toBeGreaterThanOrEqual(created.createdAt);
    expect(updated.content).toContain('sürdü');
    expect(updated.editedAt).toBeNull();
    // Arama kaydı düzenlenemez
    expect((await s.req(ali.token, 'PATCH', `/api/messages/${created.id}`, { content: 'değişti' })).statusCode).toBe(400);
  });

  it('kimse açmazsa: çalma süresi dolar, arama bitince "cevapsız arama" olur ve bildirimi gider', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    const missed = vi.spyOn(s.ctx.push, 'notifyMissedCall');

    joinRoom(ali, dm.id);
    await v.settle();
    expect(lastCall(v)?.ringing).toEqual([veli.user.id]);
    await wait(RING_MS + 150);
    expect(lastCall(v)?.ringing).toEqual([]);
    expect(s.ctx.calls.get(dm.id)).not.toBeNull();

    leaveRoom(ali, dm.id);
    await v.settle();
    const record = v.of('MESSAGE_UPDATE').at(-1) as Message;
    expect(record).toMatchObject({ type: 'call', call: { participantIds: [ali.user.id] }, content: '📞 Cevapsız arama.' });
    expect(missed).toHaveBeenCalledWith(expect.objectContaining({ id: dm.id }), ali.user.id, record.id, [veli.user.id]);
  });

  it('çalmanın bitişi veritabanı hatasıyla duyurulamazsa süreç düşmez, arama sürer', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    joinRoom(ali, dm.id);
    await v.settle();

    const participants = vi.spyOn(s.ctx.permissions, 'dmParticipants').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const warn = vi.spyOn(s.app.log, 'warn');
    await wait(RING_MS + 150);
    expect(participants).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'çalmanın bitişi duyurulamadı');
    expect(s.ctx.calls.get(dm.id)).not.toBeNull();
  });

  it('reddetme yalnızca reddedeni susturur; aramadaki biri yeniden çalabilir; grup katılımcıları hep birlikte çalınır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const group = await openDm(ali, veli, ayse);
    const v = await connect(veli.token);

    joinRoom(ali, group.id);
    await v.settle();
    expect([...lastCall(v)!.ringing].sort()).toEqual([veli.user.id, ayse.user.id].sort());

    expect((await s.req(veli.token, 'POST', `/api/dms/${group.id}/call/decline`)).statusCode).toBe(204);
    await v.settle();
    expect(lastCall(v)?.ringing).toEqual([ayse.user.id]);
    // Tekrarlanabilir
    expect((await s.req(veli.token, 'POST', `/api/dms/${group.id}/call/decline`)).statusCode).toBe(204);

    // Aramada olmayan yeniden çalamaz; aramadaki çalar
    expect((await s.req(veli.token, 'POST', `/api/dms/${group.id}/call/ring`, { userId: veli.user.id })).statusCode).toBe(409);
    expect((await s.req(ali.token, 'POST', `/api/dms/${group.id}/call/ring`, { userId: 'yok' })).statusCode).toBe(404);
    expect((await s.req(ali.token, 'POST', `/api/dms/${group.id}/call/ring`, { userId: veli.user.id })).statusCode).toBe(204);
    await v.settle();
    expect([...lastCall(v)!.ringing].sort()).toEqual([veli.user.id, ayse.user.id].sort());

    // Dışarıdaki biri aramayı göremez ve reddedemez
    const outsider = await s.member('merakli');
    expect((await s.req(outsider.token, 'POST', `/api/dms/${group.id}/call/decline`)).statusCode).toBe(404);
  });

  it('Rahatsız Etmeyin\'dekiler çalınmaz (bildirim de yok); arama yine görünür', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    s.ctx.store.saveStatusRow({
      user_id: veli.user.id,
      status: 'dnd',
      status_expires_at: null,
      custom_text: null,
      custom_emoji: null,
      custom_expires_at: null,
    });
    const v = await connect(veli.token);
    const notifyCall = vi.spyOn(s.ctx.push, 'notifyCall');
    joinRoom(ali, dm.id);
    await v.settle();
    expect(lastCall(v)).toMatchObject({ channelId: dm.id, ringing: [] });
    expect(notifyCall).not.toHaveBeenCalled();
  });

  it('eşitlemeyle (webhook olmadan) kurulan arama kimseyi çalmaz; yeniden başlatmada bitmemiş kayıt sürdürülür', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    s.ctx.voice.join(ali.user.id, dm.id);
    await v.settle();
    const first = lastCall(v)!;
    expect(first.ringing).toEqual([]);
    // Webhook geç geldi ama başlatan o: arama yeni, yine de bir kez çalar
    s.ctx.calls.webhookJoined(ali.user.id, dm.id);
    await v.settle();
    expect(lastCall(v)?.ringing).toEqual([veli.user.id]);

    // Sunucu "yeniden başladı": bellek gitti, kayıt bitmemiş duruyor; eşitleme odayı geri getirince sürdürülür
    s.ctx.calls.stop();
    expect(s.ctx.store.openCallMessage(dm.id)?.id).toBe(first.messageId);
  });

  it('bitmemiş görünen bayat kayıtlar eşitlemeden sonra kapanır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const stale = s.ctx.store.createCallMessage(dm.id, ali.user.id, [], Date.now() - 60_000);
    expect(s.ctx.calls.closeStaleRecords()).toBe(1);
    expect(s.ctx.store.getMessage(Number(stale.id))?.call?.endedAt).not.toBeNull();
    expect(s.ctx.store.openCallMessages()).toEqual([]);
  });
});

describe('engelleme', () => {
  it('engellenen yeni bire bir konuşma açamaz; var olan konuşma iki taraf için de salt okunur; nedeni yalnızca engelleyen bilir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const dm = await openDm(ali, veli);
    await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'selam' });
    const a = await connect(ali.token);
    const v = await connect(veli.token);

    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(400);
    expect((await s.req(ali.token, 'PUT', '/api/me/blocks/yok-boyle-biri')).statusCode).toBe(404);
    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);
    // Tekrarlanabilir
    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);
    await v.settle();

    // Listeyi yalnızca engelleyen görür
    expect(((await s.req(ali.token, 'GET', '/api/me/blocks')).json() as UserBlock[]).map((b) => b.userId)).toEqual([veli.user.id]);
    expect((await s.req(veli.token, 'GET', '/api/me/blocks')).json()).toEqual([]);
    expect(a.of('USER_BLOCKS_UPDATE')).toEqual([{ userIds: [veli.user.id] }]);
    expect(v.of('USER_BLOCKS_UPDATE')).toEqual([]);
    expect((await connect(ali.token)).ready.blockedUserIds).toEqual([veli.user.id]);
    expect((await connect(veli.token)).ready.blockedUserIds).toEqual([]);

    // Konuşma iki taraf için salt okunur (yönü söylenmez)
    expect(v.of('DM_CHANNEL_UPDATE').at(-1)).toMatchObject({ id: dm.id, readOnly: true });
    for (const who of [ali, veli]) {
      const list = (await s.req(who.token, 'GET', '/api/dms')).json() as DmChannel[];
      expect(list.find((d) => d.id === dm.id)?.readOnly).toBe(true);
      expect(s.ctx.permissions.inChannel(who.user.id, dm.id)).toBe(P.VIEW_CHANNEL);
    }
    // Geçmiş okunur
    expect((await s.req(veli.token, 'GET', `/api/channels/${dm.id}/messages`)).statusCode).toBe(200);

    // Mesaj: engellenene genel ileti (engel sözcüğü yok), engelleyene kendi engeli
    const vSend = await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'neden?' });
    expect(vSend.statusCode).toBe(403);
    expect(vSend.body.toLowerCase()).not.toContain('engel');
    const aSend = await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'x' });
    expect(aSend.statusCode).toBe(403);
    expect(aSend.json().message).toContain('engelledin');
    // Tepki de yok
    const msg = ((await s.req(ali.token, 'GET', `/api/channels/${dm.id}/messages`)).json() as Message[])[0]!;
    expect((await s.req(veli.token, 'PUT', `/api/messages/${msg.id}/reactions/👍`)).statusCode).toBe(403);
    // Arama yok
    const vJoin = await s.req(veli.token, 'POST', `/api/voice/${dm.id}/join`);
    expect(vJoin.statusCode).toBe(403);
    expect(vJoin.body.toLowerCase()).not.toContain('engel');
    expect((await s.req(ali.token, 'POST', `/api/voice/${dm.id}/join`)).statusCode).toBe(403);

    // Var olan konuşma yine açılır (salt okunur); yeni konuşma açılamaz
    expect((await s.req(veli.token, 'POST', '/api/dms', { userIds: [ali.user.id] })).json()).toMatchObject({ id: dm.id, readOnly: true });
    const ayseNew = await openDm(ayse, veli);
    expect(ayseNew.readOnly).toBeUndefined();
    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${ayse.user.id}`)).statusCode).toBe(204);
    const fresh = await s.req(ayse.token, 'POST', '/api/dms', { userIds: [ali.user.id] });
    expect(fresh.statusCode).toBe(403);
    expect(fresh.body.toLowerCase()).not.toContain('engel');

    // Engel kalkınca konuşma yeniden yazılabilir
    expect((await s.req(ali.token, 'DELETE', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);
    expect((await s.req(ali.token, 'DELETE', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);
    await v.settle();
    expect(v.of('DM_CHANNEL_UPDATE').at(-1)).toMatchObject({ id: dm.id });
    expect(v.of('DM_CHANNEL_UPDATE').at(-1)?.readOnly).toBeUndefined();
    expect((await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'barıştık' })).statusCode).toBe(201);
  });

  it('gruplar: engelli çiftle grup kurulamaz, ekleyenle eklenen arasında engel varsa eklenemez; mesajlar etkilenmez', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const can = await s.member('can');
    const group = await openDm(ali, ayse, can);
    const g2 = await openDm(veli, ayse, ali);
    expect((await s.req(veli.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);

    const create = await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id, ayse.user.id] });
    expect(create.statusCode).toBe(403);
    expect(create.body.toLowerCase()).not.toContain('engel');
    const createMine = await s.req(veli.token, 'POST', '/api/dms', { userIds: [ali.user.id, ayse.user.id] });
    expect(createMine.statusCode).toBe(403);
    expect(createMine.json().message).toContain('Engellediğin');
    // Ayşe (engelsiz) gruba Veli'yi ekleyebilir; Ali ekleyemez
    const added = await s.req(ali.token, 'PUT', `/api/dms/${group.id}/participants/${veli.user.id}`);
    expect(added.statusCode).toBe(403);
    expect(added.body.toLowerCase()).not.toContain('engel');
    expect((await s.req(ayse.token, 'PUT', `/api/dms/${group.id}/participants/${veli.user.id}`)).statusCode).toBe(200);
    // Grupta mesajlar engelden etkilenmez
    expect((await s.req(ali.token, 'POST', `/api/channels/${g2.id}/messages`, { content: 'herkese' })).statusCode).toBe(201);
    expect((await s.req(veli.token, 'POST', `/api/channels/${g2.id}/messages`, { content: 'herkese' })).statusCode).toBe(201);
  });

  it('grupta engellediğin kişinin araması seni çalmaz; bire bir aramada engel aramayı iki taraf için bitirir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const group = await openDm(ali, veli, ayse);
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    expect((await s.req(veli.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);
    // Grup araması: Ali başlattı, Veli çalınmaz (yine de katılabilir)
    joinRoom(ali, group.id);
    await v.settle();
    expect(lastCall(v)?.ringing).toEqual([ayse.user.id]);
    expect((await s.req(veli.token, 'POST', `/api/voice/${group.id}/join`)).statusCode).toBe(200);
    leaveRoom(ali, group.id);
    await v.settle();

    // Bire bir arama sürerken engel: iki taraf da odadan çıkarılır, arama biter
    expect((await s.req(veli.token, 'DELETE', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);
    joinRoom(ali, dm.id);
    joinRoom(veli, dm.id);
    await v.settle();
    expect(s.ctx.calls.get(dm.id)).not.toBeNull();
    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);
    await v.settle();
    expect(s.livekit.of('removeParticipant')).toEqual(
      expect.arrayContaining([
        [dm.id, ali.user.id],
        [dm.id, veli.user.id],
      ]),
    );
    expect(s.ctx.voice.list().filter((x) => x.channelId === dm.id)).toEqual([]);
    expect(s.ctx.calls.get(dm.id)).toBeNull();
    expect(v.of('DM_CALL_DELETE')).toContainEqual({ channelId: dm.id });
  });
});

describe('yönetim paneli gizliliği', () => {
  it('DM araması panelde "Özel arama": konuşma, ad ve katılımcı kimlikleri görünmez; ölçümler takma kimlikle tutulur', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    await s.req(ali.token, 'PATCH', `/api/me`, { displayName: 'Gizli Ali' });
    joinRoom(ali, dm.id);
    joinRoom(veli, dm.id);
    s.ctx.voice.setStreaming(ali.user.id, dm.id, true);

    const report: VoiceTelemetryReport = {
      v: 1,
      platform: 'desktop',
      version: '0.9.6',
      channelId: dm.id,
      windowSec: 30,
      samples: 15,
      quality: 'poor',
      poorSec: 20,
      serverQuality: 'poor',
      rttMs: { avg: 320, max: 600 },
      jitterInMs: 5,
      jitterOutMs: 3,
      lossOutPct: 0,
      lossInPct: 14,
      concealedPct: 0.1,
      bitrateOut: 40_000,
      bitrateIn: 90_000,
      availableOut: 5_000_000,
      candidate: 'relay',
      protocol: 'tls',
      reconnects: 1,
      mic: null,
      screen: null,
    };
    expect((await s.req(ali.token, 'POST', '/api/telemetry/voice', report)).statusCode).toBe(204);
    expect((await s.req(ali.token, 'POST', '/api/telemetry/voice', report)).statusCode).toBe(204);

    const secrets = [dm.id, ali.user.id, veli.user.id, 'Gizli Ali', '@ali', '"ali"', '"veli"'];
    const leaks = (body: string): string[] => secrets.filter((x) => body.includes(x));

    const dashRes = await s.req(s.owner.token, 'GET', '/api/admin/dashboard');
    const dash = dashRes.json() as AdminDashboard;
    const room = dash.voice.channels.find((c) => c.private)!;
    expect(room).toMatchObject({ name: PRIVATE_CALL_NAME, guildId: null, guildName: null });
    expect(isPrivateId(room.channelId)).toBe(true);
    expect(room.participants).toHaveLength(2);
    for (const p of room.participants) {
      expect(isPrivateId(p.userId)).toBe(true);
      expect(p.user).toBeNull();
    }
    // Kalite ölçümü panelde: takma kimlikle (aynı kişi aynı takma kimlik)
    const q = dash.voice.quality.find((e) => e.channelId === room.channelId)!;
    expect(room.participants.map((p) => p.userId)).toContain(q.userId);
    expect(leaks(JSON.stringify(dash.voice))).toEqual([]);
    // Panelin geri kalanında (kullanıcı listesi) adlar olabilir; ama hiçbir yerde DM'nin kimliği yok
    expect(dashRes.body).not.toContain(dm.id);

    for (const url of [
      '/api/admin/telemetry/incidents',
      '/api/admin/voice-history',
      `/api/admin/telemetry?user=${encodeURIComponent(q.userId)}`,
      '/api/admin/voice/traces',
      '/api/admin/line-tests',
    ]) {
      const res = await s.req(s.owner.token, 'GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(leaks(res.body), url).toEqual([]);
    }
    const incidents = (await s.req(s.owner.token, 'GET', '/api/admin/telemetry/incidents')).json();
    expect(incidents.incidents[0].channelId).toBe(room.channelId);
    expect(incidents.channels[room.channelId]).toEqual({ name: PRIVATE_CALL_NAME, guildId: null });
    expect(incidents.users[q.userId].displayName).toBe('Gizli katılımcı');
    // Kişinin kendi geçmişinde DM araması yok
    expect((await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${ali.user.id}`)).json().entries).toEqual([]);
    // Yönetici özel aramadan olay kaydı isteyemez
    expect((await s.req(s.owner.token, 'POST', '/api/admin/voice/traces/request', { channelId: room.channelId })).statusCode).toBe(404);
  });

  it('DM aramasının olay kaydı takma kimlikle saklanır; ses geçmişine yazılmaz', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    joinRoom(ali, dm.id);
    const now = Date.now();
    const upload = {
      v: 1,
      id: 'kesit-1',
      platform: 'desktop',
      version: '0.9.6',
      channelId: dm.id,
      reason: 'freeze',
      reasons: ['freeze'],
      eventId: null,
      triggerAt: now - 1000,
      sentAt: now,
      offsetMs: 0,
      attempt: 1,
      more: false,
      intervalMs: 1000,
      samples: [{ q: 1, t: now - 2000, dt: 1000, x: null, up: [] }],
      marks: [],
    };
    expect((await s.req(ali.token, 'POST', '/api/telemetry/voice-trace', upload)).statusCode).toBe(204);
    const list = (await s.req(s.owner.token, 'GET', '/api/admin/voice/traces')).json();
    expect(list.traces).toHaveLength(1);
    expect(isPrivateId(list.traces[0].userId)).toBe(true);
    expect(isPrivateId(list.traces[0].channelId)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(dm.id);
    expect(JSON.stringify(list)).not.toContain(ali.user.id);
    const history = s.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM voice_sessions WHERE channel_id = ?').get(dm.id) as { n: number };
    expect(history.n).toBe(0);
  });
});

describe('eski istemciler', () => {
  it('DM tanımayan istemci arama ve engel olaylarını almaz; READY ek alanları yok sayılabilir', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const legacy = await connect(veli.token, true);
    expect(legacy.ready.dmCalls).toBeUndefined();
    joinRoom(ali, dm.id);
    await legacy.settle();
    expect(legacy.events.filter((e) => e.t.startsWith('DM_') || e.t.startsWith('MESSAGE') || e.t.startsWith('VOICE'))).toEqual([]);
  });

  it('başka sunucudan (ortak sunucu yok) biri DM aramasını göremez', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    // Kendi sunucusunu kuran ve ana sunucudan ayrılan üçüncü kişi
    const other = await s.member('baska');
    const g = (await s.req(other.token, 'POST', '/api/guilds', { name: 'Başka' })).json();
    await joinGuild(s.app, g.guild.id, other.token, ali.token);
    const o = await connect(other.token);
    joinRoom(ali, dm.id);
    await o.settle();
    expect(o.of('DM_CALL_UPDATE')).toEqual([]);
    expect(o.of('VOICE_STATE_UPDATE').filter((x) => x.channelId === dm.id)).toEqual([]);
  });
});

describe('inceleme düzeltmeleri', () => {
  it('salt okunur DM: eski mesaj düzenlenemez (engellenene neden söylenmez), sabitlenemez; silmek serbest', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const vMsg = (await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'eski' })).json() as Message;
    const aMsg = (await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'benim' })).json() as Message;
    expect((await s.req(ali.token, 'PUT', `/api/me/blocks/${veli.user.id}`)).statusCode).toBe(204);

    const vEdit = await s.req(veli.token, 'PATCH', `/api/messages/${vMsg.id}`, { content: 'değişti' });
    expect(vEdit.statusCode).toBe(403);
    expect(vEdit.json().message).toBe('Bu konuşmaya artık mesaj gönderemezsin.');
    const aEdit = await s.req(ali.token, 'PATCH', `/api/messages/${aMsg.id}`, { content: 'değişti' });
    expect(aEdit.statusCode).toBe(403);
    expect(aEdit.json().message).toContain('engelledin');
    expect(s.ctx.store.getMessage(Number(vMsg.id))?.content).toBe('eski');
    const pin = await s.req(veli.token, 'PUT', `/api/channels/${dm.id}/pins/${vMsg.id}`);
    expect(pin.statusCode).toBe(403);
    expect(pin.body.toLowerCase()).not.toContain('engel');
    expect((await s.req(veli.token, 'DELETE', `/api/messages/${vMsg.id}`)).statusCode).toBe(204);
  });

  it('takma kişi kimliği konuşmaya özgü: aynı kişi iki DM aramasında bağlanamaz', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const d1 = await openDm(ali, veli);
    const d2 = await openDm(ali, ayse);
    const p = s.ctx.privacy;
    expect(p.user(ali.user.id, d1.id)).toBe(p.user(ali.user.id, d1.id));
    expect(p.user(ali.user.id, d1.id)).not.toBe(p.user(ali.user.id, d2.id));
    expect(isPrivateId(p.user(ali.user.id, d1.id))).toBe(true);
    expect(p.user(ali.user.id, s.channel('voice').id)).toBe(ali.user.id);
    expect(p.resolve(p.channel(d1.id))).toBe(d1.id);
  });

  it('gruptan ayrılan çalınırken: aramayı kendi listesinden kaldıran DM_CALL_DELETE alır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const group = await openDm(ali, veli, ayse);
    const v = await connect(veli.token);
    joinRoom(ali, group.id);
    await v.settle();
    expect(lastCall(v)?.ringing).toContain(veli.user.id);
    expect((await s.req(veli.token, 'DELETE', `/api/dms/${group.id}`)).statusCode).toBe(204);
    await v.settle();
    expect(v.of('DM_CALL_DELETE')).toEqual([{ channelId: group.id }]);
    expect(s.ctx.calls.get(group.id)?.ringing).toEqual([ayse.user.id]);
  });

  it('reddeden cevapsız arama bildirimi almaz; süresi dolan ya da hiç yanıt vermeyen alır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const group = await openDm(ali, veli, ayse);
    const missed = vi.spyOn(s.ctx.push, 'notifyMissedCall');
    joinRoom(ali, group.id);
    expect((await s.req(veli.token, 'POST', `/api/dms/${group.id}/call/decline`)).statusCode).toBe(204);
    leaveRoom(ali, group.id);
    expect(missed).toHaveBeenCalledTimes(1);
    expect(missed.mock.calls[0]![3]).toEqual([ayse.user.id]);
  });

  it('aynı kişi aramayı hemen yeniden başlatırsa: yeni kayıt, okunmamış, çalma ve bildirim yok; karşı taraf arayınca yeni arama', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    const notifyCall = vi.spyOn(s.ctx.push, 'notifyCall');
    joinRoom(ali, dm.id);
    leaveRoom(ali, dm.id);
    joinRoom(ali, dm.id);
    await v.settle();
    const created = v.of('MESSAGE_CREATE').filter((m) => m.channelId === dm.id);
    expect(created).toHaveLength(1);
    expect(v.of('MESSAGE_UPDATE').at(-1)).toMatchObject({ id: created[0]!.id, call: { endedAt: null } });
    expect(lastCall(v)).toMatchObject({ messageId: created[0]!.id, ringing: [] });
    expect(notifyCall).toHaveBeenCalledTimes(1);
    expect(s.ctx.store.mentionCounts(veli.user.id)[dm.id]).toBe(1);
    // Aramadaki biri yine de elle çalabilir
    expect((await s.req(ali.token, 'POST', `/api/dms/${dm.id}/call/ring`, {})).statusCode).toBe(204);
    expect(s.ctx.calls.get(dm.id)?.ringing).toEqual([veli.user.id]);
    leaveRoom(ali, dm.id);

    // Karşı taraf geri arıyor: yeni kayıt, çalar
    joinRoom(veli, dm.id);
    await v.settle();
    expect(v.of('MESSAGE_CREATE').filter((m) => m.channelId === dm.id)).toHaveLength(2);
    expect(s.ctx.calls.get(dm.id)?.ringing).toEqual([ali.user.id]);
  });

  it('gruba arama sürerken eklenen kişi aramadakileri de alır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const yeni = await s.member('yeni');
    const group = await openDm(ali, veli, ayse);
    joinRoom(ali, group.id);
    joinRoom(veli, group.id);
    const y = await connect(yeni.token);
    expect((await s.req(ayse.token, 'PUT', `/api/dms/${group.id}/participants/${yeni.user.id}`)).statusCode).toBe(200);
    await y.settle();
    expect(y.of('VOICE_STATE_UPDATE').filter((x) => x.channelId === group.id).map((x) => x.userId).sort()).toEqual(
      [ali.user.id, veli.user.id].sort(),
    );
    expect(y.of('DM_CALL_UPDATE')).toEqual([expect.objectContaining({ channelId: group.id })]);
  });

  it('arama kaydı başlatanın okunmamış mesajlarını okunmuş saydırmaz', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const unread = (await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'bak' })).json() as Message;
    joinRoom(ali, dm.id);
    expect(Number(s.ctx.store.readStates(ali.user.id)[dm.id] ?? 0)).toBeLessThan(Number(unread.id));
    leaveRoom(ali, dm.id);
    // Okumuşken başlatınca kendi kaydı okunmuş sayılır (Veli, Ali'nin arama kaydını okudu)
    s.ctx.store.ack(veli.user.id, dm.id, Number(s.ctx.store.getDm(dm.id)!.lastMessageId));
    joinRoom(veli, dm.id);
    const record = s.ctx.calls.get(dm.id)!.messageId!;
    expect(s.ctx.store.readStates(veli.user.id)[dm.id]).toBe(record);
  });

  it('webhook ile başlayan arama bayat kaydı sürdürmez (yeni kayıt, çalar); yalnızca eşitleme sürdürür', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const stale = s.ctx.store.createCallMessage(dm.id, ali.user.id, [], Date.now() - 60_000);
    joinRoom(ali, dm.id);
    const call = s.ctx.calls.get(dm.id)!;
    expect(call.messageId).not.toBe(stale.id);
    expect(call.ringing).toEqual([veli.user.id]);
    expect(s.ctx.store.getMessage(Number(stale.id))?.call?.endedAt).not.toBeNull();
    leaveRoom(ali, dm.id);

    // Yeniden başlatma: bitmemiş kayıt eşitlemeyle geri gelen odada sürdürülür, kimse çalınmaz
    const open = s.ctx.store.createCallMessage(dm.id, veli.user.id, [], Date.now() - 5_000);
    s.ctx.calls.duringReconcile(() => s.ctx.voice.join(veli.user.id, dm.id));
    s.ctx.calls.webhookJoined(veli.user.id, dm.id);
    expect(s.ctx.calls.get(dm.id)).toMatchObject({ messageId: open.id, startedBy: veli.user.id, ringing: [] });
  });
});

describe('ikinci inceleme düzeltmeleri', () => {
  it('açılmış bir aramanın hemen ardından yeniden arama yeni aramadır: yeni kayıt, çalar', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const v = await connect(veli.token);
    const notifyCall = vi.spyOn(s.ctx.push, 'notifyCall');
    joinRoom(ali, dm.id);
    joinRoom(veli, dm.id);
    leaveRoom(veli, dm.id);
    leaveRoom(ali, dm.id);
    joinRoom(ali, dm.id);
    await v.settle();
    expect(v.of('MESSAGE_CREATE').filter((m) => m.channelId === dm.id)).toHaveLength(2);
    const call = s.ctx.calls.get(dm.id)!;
    expect(call.ringing).toEqual([veli.user.id]);
    expect(call.ringStartedAt?.[veli.user.id]).toEqual(expect.any(Number));
    expect(notifyCall).toHaveBeenCalledTimes(2);
  });

  it('açılışta ilk eşitlemeden önce gelen webhook süren aramanın kaydını kapatmaz, kimseyi çalmaz', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const dm = await openDm(ali, veli);
    const open = s.ctx.store.createCallMessage(dm.id, veli.user.id, [], Date.now() - 5_000);
    s.ctx.calls.expectFirstSync();
    joinRoom(ali, dm.id);
    expect(s.ctx.calls.get(dm.id)).toMatchObject({ messageId: open.id, ringing: [] });
    expect(s.ctx.store.getMessage(Number(open.id))?.call?.endedAt).toBeNull();
    leaveRoom(ali, dm.id);
    // İlk eşitleme bitti: bundan sonra webhook'la başlayan arama bayat kaydı sürdürmez
    s.ctx.calls.duringReconcile(() => undefined);
    s.ctx.store.createCallMessage(dm.id, veli.user.id, [], Date.now() - 5_000);
    joinRoom(veli, dm.id);
    expect(s.ctx.calls.get(dm.id)?.ringing).toEqual([ali.user.id]);
  });

  it('engelleyen, engellenenin bulunduğu grup aramasında artık çalınmaz (aramayı başlatan başkası olsa da)', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    const group = await openDm(ali, veli, ayse);
    joinRoom(ali, group.id);
    expect([...s.ctx.calls.get(group.id)!.ringing].sort()).toEqual([veli.user.id, ayse.user.id].sort());
    expect((await s.req(veli.token, 'PUT', `/api/me/blocks/${ayse.user.id}`)).statusCode).toBe(204);
    expect(s.ctx.calls.get(group.id)?.ringing).toEqual([ayse.user.id]);
    expect(Object.keys(s.ctx.calls.get(group.id)!.ringStartedAt ?? {})).toEqual([ayse.user.id]);
  });
});
