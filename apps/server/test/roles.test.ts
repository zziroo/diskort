import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission as P, type Channel, type Message, type Role } from '@diskort/shared';
import { startServer, type TestServer } from './helpers.js';

let s: TestServer;

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  await s.close();
});

const decodeJwt = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('roller', () => {
  it('yeni toplulukta @everyone ve Yönetici rolü vardır; sahip Yönetici rolündedir', async () => {
    const roles = (await s.req(s.owner.token, 'GET', `/api/guilds/${s.guildId}/roles`)).json() as Role[];
    expect(roles.map((r) => r.name)).toEqual(['Yönetici', '@everyone']);
    expect(roles[1]!.id).toBe(s.ctx.guild.id);
    expect(roles[0]!.permissions).toBe(P.ADMINISTRATOR);
    expect(s.rolesOf(s.owner.user.id)).toEqual([roles[0]!.id]);
    expect(s.owner.user.isAdmin).toBe(true);
    expect(s.ctx.store.getGuild(s.guildId)!.ownerId).toBe(s.owner.user.id);
  });

  it('everyone/here adlı rol oluşturulamaz ya da bu adla yeniden adlandırılamaz (büyük/küçük duyarsız)', async () => {
    for (const name of ['everyone', 'Here', 'EVERYONE', '@here']) {
      const res = await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name });
      expect(res.statusCode).toBe(400);
    }
    const ok = await s.createRole(s.owner.token, { name: 'Ekip' });
    const patched = await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${ok.id}`, { name: 'Here' });
    expect(patched.statusCode).toBe(400);
    const fine = await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${ok.id}`, { name: 'Herkes' });
    expect(fine.statusCode).toBe(200);
  });

  it('rolleri yalnızca MANAGE_ROLES yetkilisi yönetir; kimse kendinde olmayan yetkiyi veremez', async () => {
    const member = await s.member('uye');
    expect((await s.req(member.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name: 'x' })).statusCode).toBe(403);

    const mod = await s.member('mod');
    const modRole = await s.createRole(s.owner.token, { name: 'Moderatör', permissions: P.MANAGE_ROLES | P.KICK_MEMBERS });
    expect(await s.giveRole(s.owner.token, mod.user.id, modRole.id)).toBe(200);

    // Moderatör kendi yetkileri içinde rol oluşturabilir, fazlasını veremez
    expect((await s.req(mod.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name: 'a', permissions: P.KICK_MEMBERS })).statusCode).toBe(201);
    expect((await s.req(mod.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name: 'b', permissions: P.BAN_MEMBERS })).statusCode).toBe(403);
    expect((await s.req(mod.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name: 'c', permissions: P.ADMINISTRATOR })).statusCode).toBe(
      403,
    );
    // Geçersiz renk reddedilir
    expect((await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/roles`, { name: 'd', color: 'kırmızı' })).statusCode).toBe(400);
  });

  it('hiyerarşi: kendi en üst rolünün üstündeki rolleri ve üyeleri yönetemez', async () => {
    const mod = await s.member('mod');
    const member = await s.member('uye');
    const modRole = await s.createRole(s.owner.token, { name: 'Moderatör', permissions: P.MANAGE_ROLES });
    const helper = await s.createRole(s.owner.token, { name: 'Yardımcı', color: '#2ecc71' });
    // Yeni roller en alta eklenir: sıra Yönetici > Moderatör > Yardımcı
    expect(s.ctx.store.getRole(modRole.id)!.position).toBeGreaterThan(s.ctx.store.getRole(helper.id)!.position);
    await s.giveRole(s.owner.token, mod.user.id, modRole.id);

    // Kendi rolünü ve üstündekini düzenleyemez, altındakini düzenler
    expect((await s.req(mod.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${modRole.id}`, { name: 'Süper' })).statusCode).toBe(403);
    expect((await s.req(mod.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${helper.id}`, { color: '#FF0000' })).json().color).toBe('#ff0000');
    // Altındaki rolü üyelere verir; kendi rolünü veremez
    expect(await s.giveRole(mod.token, member.user.id, helper.id)).toBe(200);
    expect(await s.giveRole(mod.token, member.user.id, modRole.id)).toBe(403);
    // Hedefin seviyesine bakılmaz (Discord gibi): altındaki rolü sahibe ve aynı seviyedeki üyeye de verir
    expect(await s.giveRole(mod.token, s.owner.user.id, helper.id)).toBe(200);
    const mod2 = await s.member('mod2');
    await s.giveRole(s.owner.token, mod2.user.id, modRole.id);
    expect(await s.giveRole(mod.token, mod2.user.id, helper.id)).toBe(200);
    expect(await s.giveRole(mod.token, mod2.user.id, modRole.id)).toBe(403);
    // Sıralamada kendi rolünün üstüne rol çıkaramaz
    const [admin] = (await s.req(s.owner.token, 'GET', `/api/guilds/${s.guildId}/roles`)).json() as Role[];
    const bad = await s.req(mod.token, 'PUT', `/api/guilds/${s.guildId}/roles/order`, { roleIds: [helper.id, admin!.id, modRole.id] });
    expect(bad.statusCode).toBe(403);
    // Sahip sıralamayı değiştirir
    const ok = await s.req(s.owner.token, 'PUT', `/api/guilds/${s.guildId}/roles/order`, { roleIds: [admin!.id, helper.id, modRole.id] });
    expect(ok.statusCode).toBe(200);
    expect(s.ctx.store.getRole(helper.id)!.position).toBeGreaterThan(s.ctx.store.getRole(modRole.id)!.position);
    // Artık Yardımcı moderatörün üstünde: üyeden alamaz
    expect((await s.req(mod.token, 'DELETE', `/api/guilds/${s.guildId}/members/${member.user.id}/roles/${helper.id}`)).statusCode).toBe(403);
    // Rol silinince üyelerden de kalkar
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/roles/${helper.id}`)).statusCode).toBe(204);
    expect(s.rolesOf(member.user.id)).toEqual([]);
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/roles/${s.ctx.guild.id}`)).statusCode).toBe(400);
  });

  it('ana sunucuda Yönetici rolü hesap yöneticiliği vermez (isAdmin hesabın kendi bayrağı)', async () => {
    const member = await s.member('uye');
    const admin = (await s.req(s.owner.token, 'GET', `/api/guilds/${s.guildId}/roles`)).json()[0] as Role;
    expect(await s.giveRole(s.owner.token, member.user.id, admin.id)).toBe(200);
    expect(s.ctx.store.getUser(member.user.id)!.isAdmin).toBe(false);
    // Yönetici, sahibin rollerine dokunamaz
    expect((await s.req(member.token, 'DELETE', `/api/guilds/${s.guildId}/members/${s.owner.user.id}/roles/${admin.id}`)).statusCode).toBe(403);
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${member.user.id}/roles/${admin.id}`)).statusCode).toBe(200);
    expect(s.ctx.store.getUser(member.user.id)!.isAdmin).toBe(false);
    expect(s.ctx.store.getUser(s.owner.user.id)!.isAdmin).toBe(true);
  });

  it('sunucu adı MANAGE_GUILD ister; sahipliği yalnızca sahip devreder', async () => {
    const member = await s.member('uye');
    expect((await s.req(member.token, 'PATCH', `/api/guilds/${s.guildId}`, { name: 'Yeni' })).statusCode).toBe(403);
    const manager = await s.createRole(s.owner.token, { name: 'Yönetim', permissions: P.MANAGE_GUILD });
    await s.giveRole(s.owner.token, member.user.id, manager.id);
    expect((await s.req(member.token, 'PATCH', `/api/guilds/${s.guildId}`, { name: 'Yeni Ad' })).json().name).toBe('Yeni Ad');
    expect((await s.req(member.token, 'PATCH', `/api/guilds/${s.guildId}`, { ownerId: member.user.id })).statusCode).toBe(403);

    const transfer = await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}`, { ownerId: member.user.id });
    expect(transfer.json().ownerId).toBe(member.user.id);
    expect(s.ctx.permissions.isOwner(s.guildId, member.user.id)).toBe(true);
    // Sahiplik hesap yöneticiliğini değiştirmez: ilk hesap yönetici kalır, yeni sahip yönetici olmaz
    expect(s.ctx.store.getUser(member.user.id)!.isAdmin).toBe(false);
    expect(s.ctx.store.getUser(s.owner.user.id)!.isAdmin).toBe(true);
  });
});

describe('kanal izinleri', () => {
  async function privateChannel(roleId: string): Promise<Channel> {
    const channel = (await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/channels`, { name: 'gizli', type: 'text' })).json() as Channel;
    const res = await s.req(s.owner.token, 'PATCH', `/api/channels/${channel.id}`, {
      overwrites: [
        { roleId: s.ctx.guild.id, allow: 0, deny: P.VIEW_CHANNEL },
        { roleId, allow: P.VIEW_CHANNEL, deny: 0 },
      ],
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Channel;
  }

  it('özel kanalı yalnızca izin verilen rol görür, okur ve yazar', async () => {
    const insider = await s.member('icerde');
    const outsider = await s.member('disarda');
    const vip = await s.createRole(s.owner.token, { name: 'VIP' });
    await s.giveRole(s.owner.token, insider.user.id, vip.id);
    const channel = await privateChannel(vip.id);
    expect(channel.overwrites).toHaveLength(2);

    const list = (token: string) => s.req(token, 'GET', '/api/channels').then((r) => (r.json() as Channel[]).map((c) => c.id));
    expect(await list(insider.token)).toContain(channel.id);
    expect(await list(outsider.token)).not.toContain(channel.id);

    const msg = (await s.req(insider.token, 'POST', `/api/channels/${channel.id}/messages`, { content: 'sır' })).json() as Message;
    expect((await s.req(outsider.token, 'GET', `/api/channels/${channel.id}/messages`)).statusCode).toBe(404);
    expect((await s.req(outsider.token, 'POST', `/api/channels/${channel.id}/messages`, { content: 'x' })).statusCode).toBe(
      404,
    );
    expect((await s.req(outsider.token, 'PUT', `/api/messages/${msg.id}/reactions/👍`)).statusCode).toBe(404);
    expect((await s.req(outsider.token, 'PATCH', `/api/channels/${channel.id}`, { name: 'x' })).statusCode).toBe(404);
    // Yönetici her kanalı görür
    expect((await s.req(s.owner.token, 'GET', `/api/channels/${channel.id}/messages`)).statusCode).toBe(200);
  });

  it('salt okunur kanal: mesaj ve yeni tepki engellenir, var olan tepkiye katılmak serbest', async () => {
    const member = await s.member('uye');
    const text = s.channel('text');
    const msg = (await s.req(s.owner.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'duyuru' })).json() as Message;
    await s.req(s.owner.token, 'PUT', `/api/messages/${msg.id}/reactions/👍`);
    await s.req(s.owner.token, 'PATCH', `/api/channels/${text.id}`, {
      overwrites: [{ roleId: s.ctx.guild.id, allow: 0, deny: P.SEND_MESSAGES | P.ADD_REACTIONS }],
    });

    const send = await s.req(member.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'selam' });
    expect(send.statusCode).toBe(403);
    expect((await s.req(member.token, 'PUT', `/api/messages/${msg.id}/reactions/😂`)).statusCode).toBe(403);
    expect((await s.req(member.token, 'PUT', `/api/messages/${msg.id}/reactions/👍`)).statusCode).toBe(204);
    expect((await s.req(member.token, 'POST', `/api/channels/${text.id}/attachments?name=a.txt`, 'x')).statusCode).toBe(403);
  });

  it('kanal izinlerini düzenlemek MANAGE_ROLES ister; yalnızca alttaki roller ve sahip olunan yetkiler değişir', async () => {
    const mod = await s.member('mod');
    const text = s.channel('text');
    const modRole = await s.createRole(s.owner.token, { name: 'Mod', permissions: P.MANAGE_ROLES | P.MANAGE_CHANNELS });
    const top = await s.createRole(s.owner.token, { name: 'Üst' });
    // Üst rolü moderatörün üstüne taşı
    const roles = (await s.req(s.owner.token, 'GET', `/api/guilds/${s.guildId}/roles`)).json() as Role[];
    const order = roles.filter((r) => r.id !== s.ctx.guild.id).map((r) => r.id);
    const reordered = [order[0]!, top.id, ...order.filter((id) => id !== order[0] && id !== top.id)];
    await s.req(s.owner.token, 'PUT', `/api/guilds/${s.guildId}/roles/order`, { roleIds: reordered });
    await s.giveRole(s.owner.token, mod.user.id, modRole.id);

    const patch = (overwrites: unknown) => s.req(mod.token, 'PATCH', `/api/channels/${text.id}`, { overwrites });
    // @everyone'dan mesaj göndermeyi alabilir (kendisinde var)
    expect((await patch([{ roleId: s.ctx.guild.id, allow: 0, deny: P.SEND_MESSAGES }])).statusCode).toBe(200);
    // Kendinde olmayan MANAGE_MESSAGES'ı veremez
    expect((await patch([{ roleId: s.ctx.guild.id, allow: P.MANAGE_MESSAGES, deny: 0 }])).statusCode).toBe(403);
    // Üstündeki rolün iznine dokunamaz
    expect((await patch([{ roleId: top.id, allow: 0, deny: P.VIEW_CHANNEL }])).statusCode).toBe(403);
    // Aynı yetki hem verilip hem engellenemez
    expect((await patch([{ roleId: s.ctx.guild.id, allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES }])).statusCode).toBe(400);
    // Metin kanalında ses yetkileri kaydedilmez
    const masked = await s.req(s.owner.token, 'PATCH', `/api/channels/${text.id}`, {
      overwrites: [{ roleId: s.ctx.guild.id, allow: 0, deny: P.CONNECT | P.SEND_MESSAGES }],
    });
    expect((masked.json() as Channel).overwrites).toEqual([{ roleId: s.ctx.guild.id, allow: 0, deny: P.SEND_MESSAGES }]);
  });
});

describe('metin yetkileri', () => {
  it('başkasının mesajını MANAGE_MESSAGES yetkilisi siler; herkes davet oluşturur, tümünü MANAGE_INVITES yönetir', async () => {
    const author = await s.member('yazar');
    const mod = await s.member('mod');
    const text = s.channel('text');
    const msg = (await s.req(author.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'x' })).json() as Message;
    expect((await s.req(mod.token, 'DELETE', `/api/messages/${msg.id}`)).statusCode).toBe(403);
    // CREATE_INVITE @everyone'da: herkes davet oluşturur, yalnızca kendi davetlerini görür ve siler
    const invites = `/api/guilds/${s.guildId}/invites`;
    const own = (await s.req(author.token, 'POST', invites, {})).json().code as string;
    const ownerInvite = (await s.req(s.owner.token, 'POST', invites, {})).json().code as string;
    expect(((await s.req(author.token, 'GET', invites)).json() as { code: string }[]).map((i) => i.code)).toEqual([own]);
    expect((await s.req(author.token, 'DELETE', `${invites}/${ownerInvite}`)).statusCode).toBe(403);
    expect((await s.req(author.token, 'DELETE', `${invites}/${own}`)).statusCode).toBe(204);

    const role = await s.createRole(s.owner.token, { name: 'Mod', permissions: P.MANAGE_MESSAGES | P.MANAGE_INVITES });
    await s.giveRole(s.owner.token, mod.user.id, role.id);
    expect((await s.req(mod.token, 'DELETE', `/api/messages/${msg.id}`)).statusCode).toBe(204);
    expect(((await s.req(mod.token, 'GET', invites)).json() as { code: string }[]).map((i) => i.code)).toContain(ownerInvite);
    expect((await s.req(mod.token, 'DELETE', `${invites}/${ownerInvite}`)).statusCode).toBe(204);

    // @everyone'dan CREATE_INVITE alınınca yetkisiz üye davet oluşturamaz
    await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${s.guildId}`, {
      permissions: s.ctx.store.getRole(s.guildId)!.permissions & ~P.CREATE_INVITE,
    });
    expect((await s.req(author.token, 'POST', invites, {})).statusCode).toBe(403);
    expect((await s.req(author.token, 'GET', invites)).statusCode).toBe(403);
    // Kanal oluşturmak ayrı yetki
    expect((await s.req(mod.token, 'POST', `/api/guilds/${s.guildId}/channels`, { name: 'x', type: 'text' })).statusCode).toBe(403);
  });

  it('@everyone yalnızca yetkili yazarda herkese bahsetme sayılır', async () => {
    const a = await s.member('ayse');
    const b = await s.member('bora');
    const text = s.channel('text');
    const first = (await s.req(a.token, 'POST', `/api/channels/${text.id}/messages`, { content: '@everyone akşam?' })).json();
    expect(first.mentionEveryone).toBe(true);
    expect(s.ctx.store.mentionCounts(b.user.id)).toEqual({ [text.id]: 1 });
    expect(s.ctx.store.mentionCounts(s.owner.user.id)).toEqual({ [text.id]: 1 });
    // Yazarın kendisi sayılmaz
    expect(s.ctx.store.mentionCounts(a.user.id)).toEqual({});

    await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/roles/${s.ctx.guild.id}`, {
      permissions: s.ctx.store.getRole(s.ctx.guild.id)!.permissions & ~P.MENTION_EVERYONE,
    });
    const second = (await s.req(a.token, 'POST', `/api/channels/${text.id}/messages`, { content: '@everyone tekrar' })).json();
    expect(second.mentionEveryone).toBe(false);
    expect(s.ctx.store.mentionCounts(b.user.id)).toEqual({ [text.id]: 1 });
  });

  it('bahsetme sözcükleri kullanıcı adı olamaz', async () => {
    const code = (await s.req(s.owner.token, 'POST', '/api/invites', {})).json().code as string;
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: code, username: 'everyone', password: 'sifre12345' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('ses yetkileri', () => {
  const join = async (token: string, channelId: string) => {
    const res = await s.req(token, 'POST', `/api/voice/${channelId}/join`);
    return { status: res.statusCode, video: res.statusCode === 200 ? (decodeJwt(res.json().token).video as Record<string, unknown>) : null };
  };

  it('jeton CONNECT, SPEAK ve STREAM yetkilerini yansıtır', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    expect((await join(member.token, voice.id)).video!.canPublishSources).toEqual([
      'microphone',
      'screen_share',
      'screen_share_audio',
    ]);

    const everyone = s.ctx.guild.id;
    const set = (deny: number) =>
      s.req(s.owner.token, 'PATCH', `/api/channels/${voice.id}`, { overwrites: [{ roleId: everyone, allow: 0, deny }] });

    await set(P.STREAM);
    expect((await join(member.token, voice.id)).video!.canPublishSources).toEqual(['microphone']);
    await set(P.SPEAK);
    expect((await join(member.token, voice.id)).video!.canPublishSources).toEqual(['screen_share', 'screen_share_audio']);
    await set(P.SPEAK | P.STREAM);
    const listener = (await join(member.token, voice.id)).video!;
    expect(listener.canPublish).toBe(false);
    expect(listener.canSubscribe).toBe(true);
    await set(P.CONNECT);
    expect((await join(member.token, voice.id)).status).toBe(403);
    await set(P.VIEW_CHANNEL);
    expect((await join(member.token, voice.id)).status).toBe(404);
    // Yönetici kanal izinlerinden etkilenmez
    expect((await join(s.owner.token, voice.id)).status).toBe(200);
  });
});
