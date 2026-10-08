import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_FEATURE_DM, type DmChannel, type FriendsList, type Message } from '@diskort/shared';
import { connectGateway, type Account, type GatewayClient, type TestServer, startServer } from './helpers.js';

let s: TestServer;
const clients: GatewayClient[] = [];
let pushes: { from: string; to: string[] }[];

beforeEach(async () => {
  s = await startServer();
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  pushes = [];
  s.ctx.push.notifyFriendRequest = async (from, to) => {
    pushes.push({ from, to });
  };
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await s.close();
});

const connect = async (token: string): Promise<GatewayClient> => {
  const client = await connectGateway(s.app, token, [CLIENT_FEATURE_DM]);
  clients.push(client);
  return client;
};

/** Sunucudan atılan üye: hesabı durur, kimseyle ortak sunucusu kalmaz */
const outsider = async (username: string): Promise<Account> => {
  const account = await s.member(username);
  expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${account.user.id}`)).statusCode).toBe(204);
  return account;
};

const list = async (a: Account): Promise<FriendsList> => (await s.req(a.token, 'GET', '/api/friends')).json() as FriendsList;
const ids = (l: FriendsList) => ({
  friends: l.friends.map((e) => e.userId),
  incoming: l.incoming.map((e) => e.userId),
  outgoing: l.outgoing.map((e) => e.userId),
});

const befriend = async (a: Account, b: Account): Promise<void> => {
  expect((await s.req(a.token, 'POST', '/api/friends/requests', { username: b.user.username })).statusCode).toBe(201);
  expect((await s.req(b.token, 'POST', `/api/friends/requests/${a.user.id}/accept`)).statusCode).toBe(200);
};

describe('arkadaşlar', () => {
  it('istek → kabul: ortak sunucu olmadan bire bir DM açılır, yazılır, gruba eklenir; iki tarafa liste ve durum gider', async () => {
    const ali = await s.member('ali');
    const veli = await outsider('veli');
    const ayse = await s.member('ayse');
    // Ortak sunucu yok: DM açılamaz
    expect((await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] })).statusCode).toBe(404);
    const a = await connect(ali.token);
    const v = await connect(veli.token);

    const sent = await s.req(ali.token, 'POST', '/api/friends/requests', { username: '@VELI' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().status).toBe('pending');
    expect(ids(sent.json())).toEqual({ friends: [], incoming: [], outgoing: [veli.user.id] });
    expect(sent.json().outgoing[0].user.username).toBe('veli');
    expect(ids(await list(veli))).toEqual({ friends: [], incoming: [ali.user.id], outgoing: [] });
    expect(pushes).toEqual([{ from: ali.user.id, to: [veli.user.id] }]);
    // Tekrar göndermek bir şey değiştirmez (yeni bildirim yok)
    const again = await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'veli' });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('pending');
    expect(pushes).toHaveLength(1);
    // İstek bekliyorken hâlâ DM yok
    expect((await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] })).statusCode).toBe(404);

    const accepted = await s.req(veli.token, 'POST', `/api/friends/requests/${ali.user.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(ids(accepted.json())).toEqual({ friends: [ali.user.id], incoming: [], outgoing: [] });
    expect(ids(await list(ali))).toEqual({ friends: [veli.user.id], incoming: [], outgoing: [] });
    await a.settle();
    expect(a.of('FRIENDS_UPDATE').map(ids)).toEqual([
      { friends: [], incoming: [], outgoing: [veli.user.id] },
      { friends: [veli.user.id], incoming: [], outgoing: [] },
    ]);
    expect(v.of('FRIENDS_UPDATE').map(ids).at(-1)).toEqual({ friends: [ali.user.id], incoming: [], outgoing: [] });
    // Birbirinin çevrimiçi durumunu görürler
    expect(a.of('PRESENCE_UPDATE').some((p) => p.userId === veli.user.id && p.online)).toBe(true);
    expect(v.of('PRESENCE_UPDATE').some((p) => p.userId === ali.user.id && p.online)).toBe(true);

    // DM açılır ve yazılır
    const opened = await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] });
    expect(opened.statusCode).toBe(201);
    const dm = opened.json() as DmChannel;
    expect((await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'selam' })).statusCode).toBe(201);
    // Gruba eklenir (ekleyenin arkadaşı)
    const g = await s.req(ali.token, 'POST', '/api/dms', { userIds: [ayse.user.id] });
    const group = (await s.req(ali.token, 'POST', '/api/dms', { userIds: [ayse.user.id, s.owner.user.id] })).json() as DmChannel;
    expect(g.statusCode).toBe(201);
    expect((await s.req(ali.token, 'PUT', `/api/dms/${group.id}/participants/${veli.user.id}`)).statusCode).toBe(200);
    // Ayşe veli'yi tanımıyor: onu gruba ekleyemez
    const other = (await s.req(ayse.token, 'POST', '/api/dms', { userIds: [ali.user.id, s.owner.user.id] })).json() as DmChannel;
    expect((await s.req(ayse.token, 'PUT', `/api/dms/${other.id}/participants/${veli.user.id}`)).statusCode).toBe(404);
    expect((await s.req(ayse.token, 'POST', '/api/dms', { userIds: [veli.user.id, ali.user.id] })).statusCode).toBe(404);

    // Yeniden bağlanınca READY'de liste, profil ve çevrimiçi durum
    const again2 = await connect(ali.token);
    expect(ids(again2.ready.friends!)).toEqual({ friends: [veli.user.id], incoming: [], outgoing: [] });
    expect(again2.ready.users.map((u) => u.id)).toContain(veli.user.id);
    expect(again2.ready.online).toContain(veli.user.id);
  });

  it('karşı yönde bekleyen istek varken gönderilen istek kabul sayılır; kendine, olmayana istek yok; reddetme ve geri çekme', async () => {
    const ali = await s.member('ali');
    const veli = await outsider('veli');
    const ayse = await s.member('ayse');

    expect((await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'ali' })).statusCode).toBe(400);
    const missing = await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'yok-boyle-biri' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
    expect((await s.req(ali.token, 'POST', '/api/friends/requests', { username: '' })).statusCode).toBe(400);
    expect((await s.req(ali.token, 'POST', `/api/friends/requests/${veli.user.id}/accept`)).statusCode).toBe(404);

    await s.req(veli.token, 'POST', '/api/friends/requests', { username: 'ali' });
    const mutual = await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'veli' });
    expect(mutual.statusCode).toBe(200);
    expect(mutual.json().status).toBe('friends');
    expect(ids(mutual.json())).toEqual({ friends: [veli.user.id], incoming: [], outgoing: [] });
    expect(pushes).toHaveLength(1); // yalnızca ilk istek
    // Zaten arkadaş: değişiklik yok
    const already = await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'veli' });
    expect(already.json().status).toBe('friends');
    expect((await s.req(ali.token, 'POST', `/api/friends/requests/${veli.user.id}/accept`)).statusCode).toBe(200);

    // Reddet (alan) ve geri çek (gönderen) aynı uç
    await s.req(ayse.token, 'POST', '/api/friends/requests', { username: 'ali' });
    expect(ids(await list(ali)).incoming).toEqual([ayse.user.id]);
    const declined = await s.req(ali.token, 'DELETE', `/api/friends/requests/${ayse.user.id}`);
    expect(declined.statusCode).toBe(200);
    expect(ids(declined.json()).incoming).toEqual([]);
    expect(ids(await list(ayse)).outgoing).toEqual([]);
    await s.req(ayse.token, 'POST', '/api/friends/requests', { username: 'ali' });
    expect((await s.req(ayse.token, 'DELETE', `/api/friends/requests/${ali.user.id}`)).statusCode).toBe(200);
    expect(ids(await list(ali)).incoming).toEqual([]);
    // Tekrarlanabilir
    expect((await s.req(ayse.token, 'DELETE', `/api/friends/requests/${ali.user.id}`)).statusCode).toBe(200);
  });

  it('engel: seni engelleyene istek genel 403 (neden söylenmez), engellediğine nedeni söylenir; engellemek arkadaşlığı ve istekleri kaldırır', async () => {
    const ali = await s.member('ali');
    const veli = await outsider('veli');
    const ayse = await s.member('ayse');

    expect((await s.req(veli.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);
    const hidden = await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'veli' });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().message).not.toMatch(/engel/i);
    expect((await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'yok-boyle-biri' })).statusCode).toBe(404);
    const mine = await s.req(veli.token, 'POST', '/api/friends/requests', { username: 'ali' });
    expect(mine.statusCode).toBe(403);
    expect(mine.json().message).toContain('engelledin');
    expect(pushes).toEqual([]);
    expect(ids(await list(veli))).toEqual({ friends: [], incoming: [], outgoing: [] });

    // Arkadaşlık varken engelleme: arkadaşlık gider, iki tarafa güncel liste
    await befriend(ali, ayse);
    const a = await connect(ali.token);
    const y = await connect(ayse.token);
    expect((await s.req(ayse.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);
    expect(ids(await list(ali)).friends).toEqual([]);
    expect(ids(await list(ayse)).friends).toEqual([]);
    await a.settle();
    expect(a.of('FRIENDS_UPDATE').map(ids).at(-1)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(y.of('FRIENDS_UPDATE').map(ids).at(-1)).toEqual({ friends: [], incoming: [], outgoing: [] });
    // Engeli kaldırınca arkadaşlık geri gelmez
    await s.req(ayse.token, 'DELETE', `/api/me/blocks/${ali.user.id}`);
    expect(ids(await list(ali)).friends).toEqual([]);

    // Bekleyen istek varken engelleme: istek de gider
    await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'ayse' });
    expect((await s.req(ayse.token, 'PUT', `/api/me/blocks/${ali.user.id}`)).statusCode).toBe(204);
    expect(ids(await list(ali)).outgoing).toEqual([]);
    expect(ids(await list(ayse)).incoming).toEqual([]);
  });

  it('arkadaşlıktan çıkınca: ortak sunucu yoksa yeni DM açılamaz, var olan konuşma kalır ama salt okunur', async () => {
    const ali = await s.member('ali');
    const veli = await outsider('veli');
    const ayse = await s.member('ayse');
    await befriend(ali, veli);
    await befriend(ali, ayse);
    const dm = (await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] })).json() as DmChannel;
    const withAyse = (await s.req(ali.token, 'POST', '/api/dms', { userIds: [ayse.user.id] })).json() as DmChannel;
    await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'görüşürüz' });
    await connect(ali.token);
    const v = await connect(veli.token);

    const removed = await s.req(veli.token, 'DELETE', `/api/friends/${ali.user.id}`);
    expect(removed.statusCode).toBe(200);
    expect(ids(removed.json()).friends).toEqual([]);
    expect(ids(await list(ali)).friends).toEqual([ayse.user.id]);
    // Tekrarlanabilir
    expect((await s.req(veli.token, 'DELETE', `/api/friends/${ali.user.id}`)).statusCode).toBe(200);
    await v.settle();
    // Artık birbirinin çevrimiçi durumunu görmez
    expect(v.of('PRESENCE_UPDATE').filter((p) => p.userId === ali.user.id).at(-1)?.online).toBe(false);

    // Konuşma listede ve okunur, yazılamaz; yeni konuşma açılamaz
    expect(((await s.req(ali.token, 'GET', '/api/dms')).json() as DmChannel[]).map((d) => d.id)).toContain(dm.id);
    expect(((await s.req(veli.token, 'GET', '/api/dms')).json() as DmChannel[]).map((d) => d.id)).toContain(dm.id);
    const history = await s.req(veli.token, 'GET', `/api/channels/${dm.id}/messages`);
    expect(history.statusCode).toBe(200);
    expect((history.json() as Message[]).map((m) => m.content)).toEqual(['görüşürüz']);
    expect((await s.req(veli.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'x' })).statusCode).toBe(403);
    expect((await s.req(ali.token, 'POST', `/api/channels/${dm.id}/messages`, { content: 'x' })).statusCode).toBe(403);
    expect((await s.req(ali.token, 'POST', '/api/dms', { userIds: [veli.user.id] })).statusCode).toBe(404);
    expect((await s.req(veli.token, 'POST', '/api/dms', { userIds: [ali.user.id, ayse.user.id] })).statusCode).toBe(404);

    // Ortak sunucusu olan arkadaştan çıkmak DM'i etkilemez
    await s.req(ali.token, 'DELETE', `/api/friends/${ayse.user.id}`);
    expect((await s.req(ali.token, 'POST', `/api/channels/${withAyse.id}/messages`, { content: 'hâlâ' })).statusCode).toBe(201);
  });

  it('hesap silinince arkadaşların ve istek bekleyenlerin listesinden düşer', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const ayse = await s.member('ayse');
    await befriend(ali, veli);
    await s.req(ali.token, 'POST', '/api/friends/requests', { username: 'ayse' });
    const y = await connect(ayse.token);

    expect((await s.req(s.owner.token, 'DELETE', `/api/users/${ali.user.id}`)).statusCode).toBe(204);
    expect(ids(await list(veli)).friends).toEqual([]);
    expect(ids(await list(ayse)).incoming).toEqual([]);
    await y.settle();
    expect(y.of('FRIENDS_UPDATE').map(ids).at(-1)).toEqual({ friends: [], incoming: [], outgoing: [] });
  });
});
