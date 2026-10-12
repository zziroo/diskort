import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission as P, roleMentionToken, type Channel, type GuildData, type Message } from '@diskort/shared';
import { startServer, type Account, type TestServer } from './helpers.js';

let s: TestServer;

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  await s.close();
});

const post = async (account: Account, channelId: string, content: string): Promise<Message> => {
  const res = await s.req(account.token, 'POST', `/api/channels/${channelId}/messages`, { content });
  expect(res.statusCode).toBe(201);
  return res.json() as Message;
};

const counts = (account: Account): Record<string, number> => s.ctx.store.mentionCounts(account.user.id);

describe('rol etiketi', () => {
  it('o role sahip, kanalı gören üyelere bahsetme sayılır; yazara, rolde olmayana ve kanalı göremeyene değil', async () => {
    const author = await s.member('yazar');
    const inRole = await s.member('ekipten');
    const notInRole = await s.member('disarida');
    const blind = await s.member('goremez');
    const ekip = await s.createRole(s.owner.token, { name: 'Oyun Ekibi' });
    const vip = await s.createRole(s.owner.token, { name: 'VIP' });
    for (const a of [author, inRole, blind]) await s.giveRole(s.owner.token, a.user.id, ekip.id);
    for (const a of [author, inRole, notInRole]) await s.giveRole(s.owner.token, a.user.id, vip.id);
    // Kanalı yalnızca VIP görür: `blind` rolde ama kanalı göremez
    const channel = (await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/channels`, { name: 'vip', type: 'text' })).json() as Channel;
    const patched = await s.req(s.owner.token, 'PATCH', `/api/channels/${channel.id}`, {
      overwrites: [
        { roleId: s.guildId, allow: 0, deny: P.VIEW_CHANNEL },
        { roleId: vip.id, allow: P.VIEW_CHANNEL, deny: 0 },
      ],
    });
    expect(patched.statusCode).toBe(200);
    const notify = vi.spyOn(s.ctx.push, 'notifyMention');

    // Rol etiketi ek yetki istemez (yazar yalnızca üye)
    const message = await post(author, channel.id, `${roleMentionToken(ekip.id)} akşam oyun?`);
    expect(message.content).toBe(`<@&${ekip.id}> akşam oyun?`);
    expect(counts(inRole)).toEqual({ [channel.id]: 1 });
    expect(counts(author)).toEqual({});
    expect(counts(notInRole)).toEqual({});
    expect(counts(blind)).toEqual({});
    expect(counts(s.owner)).toEqual({});
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: message.id }), [inRole.user.id], channel.name, s.guildId);

    // Aynı mesajda kullanıcı adıyla da bahsedilen bir kez sayılır
    await post(author, channel.id, `${roleMentionToken(ekip.id)} @ekipten`);
    expect(counts(inRole)).toEqual({ [channel.id]: 2 });
  });

  it('geçersiz, @everyone, başka sunucunun ve kod içindeki rol etiketleri yok sayılır', async () => {
    const author = await s.member('yazar');
    const other = await s.member('diger');
    const ekip = await s.createRole(s.owner.token, { name: 'Ekip' });
    await s.giveRole(s.owner.token, other.user.id, ekip.id);
    // Başka bir sunucu ve rolü (diğer üye orada da o rolde)
    const second = (await s.req(other.token, 'POST', '/api/guilds', { name: 'Başka' })).json() as GuildData;
    const foreignRole = (
      await s.req(other.token, 'POST', `/api/guilds/${second.guild.id}/roles`, { name: 'Yabancı', color: null, hoist: false, permissions: 0 })
    ).json() as { id: string };
    expect(foreignRole.id).toBeTruthy();
    const given = await s.req(other.token, 'PUT', `/api/guilds/${second.guild.id}/members/${other.user.id}/roles/${foreignRole.id}`);
    expect(given.statusCode).toBeLessThan(300);
    const text = s.channel('text');
    const notify = vi.spyOn(s.ctx.push, 'notifyMention');

    await post(author, text.id, `${roleMentionToken('yokboyle')} ${roleMentionToken(s.guildId)} ${roleMentionToken(foreignRole.id)}`);
    await post(author, text.id, `\`${roleMentionToken(ekip.id)}\` ve \`\`\`\n${roleMentionToken(ekip.id)}\n\`\`\``);
    expect(counts(other)).toEqual({});
    expect(counts(s.owner)).toEqual({});
    for (const call of notify.mock.calls) expect(call[1]).toEqual([]);
  });

  it('bir mesajda en fazla 3 farklı rol etiketi bildirim üretir (ilk 3, metin sırasıyla); fazlası yok sayılır', async () => {
    const author = await s.member('yazar');
    const members: Account[] = [];
    const roles: { id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await s.member(`uye${i}`);
      const r = await s.createRole(s.owner.token, { name: `Rol${i}` });
      await s.giveRole(s.owner.token, m.user.id, r.id);
      members.push(m);
      roles.push(r);
    }
    const text = s.channel('text');
    const message = await post(author, text.id, roles.map((r) => roleMentionToken(r.id)).join(' '));
    // Metin bozulmaz
    expect(message.content).toBe(roles.map((r) => `<@&${r.id}>`).join(' '));
    for (const m of members.slice(0, 3)) expect(counts(m)).toEqual({ [text.id]: 1 });
    expect(counts(members[3]!)).toEqual({});

    // Tekrarlayan aynı rol sınıra bir kez sayılır
    await post(author, text.id, `${roleMentionToken(roles[0]!.id)} ${roleMentionToken(roles[0]!.id)} ${roleMentionToken(roles[3]!.id)}`);
    expect(counts(members[3]!)).toEqual({ [text.id]: 1 });
  });

  it('prototip anahtarı (<@&constructor>) rol sayılmaz', async () => {
    const author = await s.member('yazar');
    const other = await s.member('diger');
    const text = s.channel('text');
    await post(author, text.id, '<@&constructor> <@&toString>');
    expect(counts(other)).toEqual({});
  });
});
