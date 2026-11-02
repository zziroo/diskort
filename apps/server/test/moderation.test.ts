import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission as P } from '@diskort/shared';
import { TrackSource } from '../src/livekit.js';
import { connectGateway, joinGuild, startServer, type TestServer } from './helpers.js';

let s: TestServer;

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  await s.close();
});

const login = (username: string, password = 'sifre12345') =>
  s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

// "Kayıt ol" ekranı: yeni hesap hesap davetiyle açılıp sunucuya katılır; hesabı olan sunucu davetiyle
// kendi şifresiyle gelir (atılıp geri dönen)
const register = async (username: string, password = 'sifre12345') => {
  const existing = s.ctx.store.getUserAuthByUsername(username) !== null;
  const url = existing ? `/api/guilds/${s.guildId}/invites` : '/api/invites';
  const code = (await s.req(s.owner.token, 'POST', url, {})).json().code as string;
  if (existing) return s.app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username, password } });
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username, password } });
  if (res.statusCode === 201) await joinGuild(s.app, s.guildId, s.owner.token, res.json().token as string);
  return res;
};

const accept = async (token: string) => {
  const code = (await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/invites`, {})).json().code as string;
  return s.req(token, 'POST', `/api/invites/${code}/accept`);
};

const guildIds = async (token: string): Promise<string[]> =>
  ((await s.req(token, 'GET', '/api/guilds')).json() as { id: string }[]).map((g) => g.id);

describe('atma ve yasaklama', () => {
  it('atılan üye sunucuyu kaybeder ama hesabı durur; davetle geri döner (roller gelmez)', async () => {
    const member = await s.member('uye');
    const role = await s.createRole(s.owner.token, { name: 'Oyuncu' });
    await s.giveRole(s.owner.token, member.user.id, role.id);
    const text = s.channel('text');
    await s.req(member.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'merhaba' });

    expect((await s.req(member.token, 'DELETE', `/api/guilds/${s.guildId}/members/${s.owner.user.id}`)).statusCode).toBe(403);
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${member.user.id}`)).statusCode).toBe(204);
    // Hesap ve oturumu durur; sunucu listesinden kalkar, sunucunun hiçbir şeyine erişemez
    expect((await s.req(member.token, 'GET', '/api/me')).statusCode).toBe(200);
    expect(await guildIds(member.token)).toEqual([]);
    expect((await s.req(member.token, 'GET', `/api/channels/${text.id}/messages`)).statusCode).toBe(404);
    expect((await s.req(member.token, 'GET', `/api/guilds/${s.guildId}/roles`)).statusCode).toBe(404);
    expect(s.ctx.store.getMember(s.guildId, member.user.id)).toMatchObject({ removed: true, roles: [] });
    // Mesajı adıyla kalır
    expect(s.ctx.store.listMessages(text.id, null, 10).at(-1)!.authorId).toBe(member.user.id);
    expect((await login('uye')).statusCode).toBe(200);
    // Zaten üye olmayanı yeniden atmak anlamsız
    expect((await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${member.user.id}`)).statusCode).toBe(400);

    // Yeni davetle geri döner; roller gelmez
    const back = await accept(member.token);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ alreadyMember: false, guild: { id: s.guildId } });
    expect(s.ctx.store.getMember(s.guildId, member.user.id)).toMatchObject({ removed: false, roles: [] });
    expect(await guildIds(member.token)).toEqual([s.guildId]);
    // "Kayıt ol" ekranından kendi şifresiyle gelmek de olur (yanlış şifre: ad alınmış)
    expect((await register('uye', 'yanlis-sifre')).statusCode).toBe(409);
    expect((await register('uye')).statusCode).toBe(201);
  });

  it('yasaklanan sunucuya geri dönemez (hesabı durur, giriş yapabilir); yasak kalkınca davetle döner', async () => {
    const member = await s.member('uye');
    const mod = await s.member('mod');
    const modRole = await s.createRole(s.owner.token, { name: 'Mod', permissions: P.BAN_MEMBERS });
    await s.giveRole(s.owner.token, mod.user.id, modRole.id);

    expect((await s.req(mod.token, 'PUT', `/api/guilds/${s.guildId}/bans/${s.owner.user.id}`, {})).statusCode).toBe(403);
    expect((await s.req(mod.token, 'PUT', `/api/guilds/${s.guildId}/bans/${member.user.id}`, { reason: 'spam' })).statusCode).toBe(204);
    // Hesap durur, sunucuya dönemez
    expect((await login('uye')).statusCode).toBe(200);
    const again = await register('uye');
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toBe('banned');
    const refused = await accept(member.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('banned');

    const bans = (await s.req(mod.token, 'GET', `/api/guilds/${s.guildId}/bans`)).json();
    expect(bans).toEqual([expect.objectContaining({ reason: 'spam', user: expect.objectContaining({ id: member.user.id }) })]);
    // Yasaklanan artık üye değil: sunucu onun için yok
    expect((await s.req(member.token, 'GET', `/api/guilds/${s.guildId}/bans`)).statusCode).toBe(404);
    expect((await s.req(mod.token, 'PUT', `/api/guilds/${s.guildId}/bans/${member.user.id}`, {})).statusCode).toBe(400);

    expect((await s.req(mod.token, 'DELETE', `/api/guilds/${s.guildId}/bans/${member.user.id}`)).statusCode).toBe(204);
    expect((await accept(member.token)).statusCode).toBe(200);
  });

  it('atılan üye seste ise sesten çıkarılır; bahsedilemez', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    await s.req(s.owner.token, 'DELETE', `/api/guilds/${s.guildId}/members/${member.user.id}`);
    expect(s.ctx.voice.get(member.user.id)).toBeUndefined();
    expect(s.livekit.of('removeParticipant')).toContainEqual([voice.id, member.user.id]);
    expect(s.ctx.store.resolveMentions('@uye', s.owner.user.id, s.guildId)).toEqual([]);
  });
});

describe('seste yönetim', () => {
  it('sunucuda susturma: mikrofon susturulur, izni alınır, durum herkese görünür ve yeniden katılınca sürer', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);

    // Yetkisiz üye susturamaz
    expect((await s.req(member.token, 'PATCH', `/api/guilds/${s.guildId}/members/${s.owner.user.id}/voice`, { mute: true })).statusCode).toBe(403);

    expect((await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { mute: true })).statusCode).toBe(204);
    expect(s.ctx.voice.get(member.user.id)).toMatchObject({ serverMute: true, serverDeaf: false });
    expect(s.livekit.of('muteMicrophone')).toEqual([[voice.id, member.user.id]]);
    expect(s.livekit.of('setPublishSources').at(-1)).toEqual([
      voice.id,
      member.user.id,
      [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    ]);
    // Yeni jetonda da mikrofon yok
    expect(s.ctx.moderation.sources(member.user.id, voice.id)).not.toContain(TrackSource.MICROPHONE);

    // Kanaldan çıkıp girince sürer; veritabanında da saklı
    s.ctx.voice.leave(member.user.id, voice.id);
    s.ctx.voice.join(member.user.id, voice.id);
    expect(s.ctx.voice.get(member.user.id)!.serverMute).toBe(true);
    expect(s.ctx.store.serverVoiceFlags(s.guildId, member.user.id)).toEqual({ serverMute: true, serverDeaf: false });

    await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { mute: false, deaf: true });
    expect(s.ctx.voice.get(member.user.id)).toMatchObject({ serverMute: false, serverDeaf: true });
    await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { deaf: false });
    expect(s.livekit.of('setPublishSources').at(-1)![2]).toContain(TrackSource.MICROPHONE);
  });

  it('taşıma ve sesten çıkarma MOVE_MEMBERS ister; hedef kanala bağlanamayan taşınamaz', async () => {
    const member = await s.member('uye');
    const mover = await s.member('tasiyici');
    const [a, b] = s.ctx.store.listChannels(s.ctx.guild.id).filter((c) => c.type === 'voice');
    s.ctx.voice.join(member.user.id, a!.id);

    expect((await s.req(mover.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { channelId: b!.id })).statusCode).toBe(
      403,
    );
    const role = await s.createRole(s.owner.token, { name: 'DJ', permissions: P.MOVE_MEMBERS });
    await s.giveRole(s.owner.token, mover.user.id, role.id);

    // Taşıma istemci aracılığıyla: üyenin istemcisine VOICE_MOVE gider, kanalı istemci değiştirir
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const client = await connectGateway(s.app, member.token);
    expect((await s.req(mover.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { channelId: b!.id })).statusCode).toBe(
      204,
    );
    await client.settle();
    expect(client.of('VOICE_MOVE')).toEqual([{ channelId: b!.id }]);
    client.ws.close();
    // İstemci yeni kanala geçti (LiveKit bildirimi)
    s.ctx.voice.join(member.user.id, b!.id);
    expect(s.ctx.voice.get(member.user.id)!.channelId).toBe(b!.id);

    // Olayı tanımayan (eski) istemci süre dolunca sesten çıkarılır
    s.ctx.moderation.move(member.user.id, a!.id, 30);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.ctx.voice.get(member.user.id)).toBeUndefined();
    expect(s.livekit.of('removeParticipant')).toContainEqual([b!.id, member.user.id]);
    s.ctx.voice.join(member.user.id, b!.id);

    // Üye A kanalına bağlanamıyorsa oraya taşınamaz
    await s.req(s.owner.token, 'PATCH', `/api/channels/${a!.id}`, {
      overwrites: [{ roleId: s.ctx.guild.id, allow: 0, deny: P.CONNECT }, { roleId: role.id, allow: P.CONNECT, deny: 0 }],
    });
    const blocked = await s.req(mover.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { channelId: a!.id });
    expect(blocked.statusCode).toBe(403);

    // Sesten çıkarma
    expect((await s.req(mover.token, 'PATCH', `/api/guilds/${s.guildId}/members/${member.user.id}/voice`, { channelId: null })).statusCode).toBe(
      204,
    );
    expect(s.ctx.voice.get(member.user.id)).toBeUndefined();
    // Seste yönetim hiyerarşiye bakmaz: sahip de sesten çıkarılabilir (Discord gibi)
    s.ctx.voice.join(s.owner.user.id, b!.id);
    expect((await s.req(mover.token, 'PATCH', `/api/guilds/${s.guildId}/members/${s.owner.user.id}/voice`, { channelId: null })).statusCode).toBe(
      204,
    );
  });

  it('yetkiler değişince seste olanların izinleri güncellenir, bağlanma yetkisini kaybeden çıkarılır', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    s.livekit.calls = [];

    await s.req(s.owner.token, 'PATCH', `/api/channels/${voice.id}`, {
      overwrites: [{ roleId: s.ctx.guild.id, allow: 0, deny: P.SPEAK }],
    });
    expect(s.livekit.of('setPublishSources')).toContainEqual([
      voice.id,
      member.user.id,
      [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    ]);

    await s.req(s.owner.token, 'PATCH', `/api/channels/${voice.id}`, {
      overwrites: [{ roleId: s.ctx.guild.id, allow: 0, deny: P.CONNECT }],
    });
    expect(s.livekit.of('removeParticipant')).toContainEqual([voice.id, member.user.id]);
    expect(s.ctx.voice.get(member.user.id)).toBeUndefined();
    // Sahip etkilenmez
    expect(s.ctx.moderation.canConnect(s.owner.user.id, voice.id)).toBe(true);
  });
});

describe('ses izinleri: veritabanı hatası süreci düşürmez', () => {
  const dbLocked = (): never => {
    throw new Error('database is locked');
  };

  it('katılan üyenin izni uygulanamazsa ret yok, loglanır; sonraki eşitleme uygular', async () => {
    const ali = await s.member('ali');
    const channel = s.channel('voice');
    s.ctx.voice.join(ali.user.id, channel.id);
    const can = vi.spyOn(s.ctx.permissions, 'can').mockImplementationOnce(dbLocked);
    const warn = vi.spyOn(s.app.log, 'warn');

    await expect(s.ctx.moderation.onJoined(ali.user.id, channel.id)).resolves.toBeUndefined();
    expect(can).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'katılan üyenin izni uygulanamadı');
    expect(s.livekit.of('setPublishSources')).toEqual([]);

    await s.ctx.moderation.enforceAll();
    expect(s.livekit.of('setPublishSources').map((args) => args.slice(0, 2))).toEqual([[channel.id, ali.user.id]]);
  });

  it('DM aramasındaki kişi denetlenemezse ret yok, loglanır', async () => {
    const ali = await s.member('ali');
    const veli = await s.member('veli');
    const { dm } = s.ctx.store.openDirectDm(ali.user.id, veli.user.id);
    s.ctx.voice.join(ali.user.id, dm.id);
    const can = vi.spyOn(s.ctx.permissions, 'can').mockImplementationOnce(dbLocked);
    const warn = vi.spyOn(s.app.log, 'warn');

    await expect(s.ctx.moderation.enforceDmCalls()).resolves.toBeUndefined();
    expect(can).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'DM aramaları denetlenemedi');
  });

  it('kanalın DM olduğu okunamazsa da ret yok, loglanır', async () => {
    const ali = await s.member('ali');
    s.ctx.voice.join(ali.user.id, s.channel('voice').id);
    const isDm = vi.spyOn(s.ctx.permissions, 'isDm').mockImplementationOnce(dbLocked);
    const warn = vi.spyOn(s.app.log, 'warn');

    await expect(s.ctx.moderation.enforceDmCalls()).resolves.toBeUndefined();
    expect(isDm).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'DM aramaları denetlenemedi');
  });
});
