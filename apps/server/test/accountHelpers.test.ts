import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission as P, type Invite, type User } from '@diskort/shared';
import { connectGateway, startServer, type Account, type TestServer } from './helpers.js';

// Hesap yardımcısı (users.is_account_helper): hesap yöneticisinin atadığı dar yetkili rol. Hesap daveti
// oluşturur ve listeler, yalnızca kendi davetini siler, sıradan hesaplara (ve kendine) sıfırlama kodu üretir.
// Hesap silemez, yönetici/yardımcı atayamaz, yöneticiye ya da başka yardımcıya kod üretemez, yönetim
// paneline ve geri bildirimlere giremez.

let s: TestServer;

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  await s.close();
});

async function makeHelper(username: string): Promise<Account> {
  const account = await s.member(username);
  const res = await s.req(s.owner.token, 'PUT', `/api/helpers/${account.user.id}`);
  expect(res.statusCode).toBe(200);
  expect((res.json() as User).isAccountHelper).toBe(true);
  return account;
}

describe('hesap yardımcısı', () => {
  it('sıradan hesaba ve kendine sıfırlama kodu üretir; yöneticiye ve başka yardımcıya üretemez', async () => {
    const helper = await makeHelper('yardimci');
    const other = await makeHelper('yardimci2');
    const plain = await s.member('uye');

    const code = await s.req(helper.token, 'POST', `/api/users/${plain.user.id}/reset-code`);
    expect(code.statusCode).toBe(200);
    expect(code.json()).toMatchObject({ code: expect.any(String), expiresAt: expect.any(Number) });
    // Üreten kayıtta yardımcıdır (yöneticinin ürettiği kodla aynı desen)
    const row = s.ctx.store.db.prepare('SELECT created_by FROM reset_codes WHERE user_id = ?').get(plain.user.id) as {
      created_by: string;
    };
    expect(row.created_by).toBe(helper.user.id);
    expect((await s.req(helper.token, 'POST', `/api/users/${helper.user.id}/reset-code`)).statusCode).toBe(200);

    const toAdmin = await s.req(helper.token, 'POST', `/api/users/${s.owner.user.id}/reset-code`);
    expect(toAdmin.statusCode).toBe(403);
    expect(toAdmin.json().message).toContain('yöneticisinin');
    const toHelper = await s.req(helper.token, 'POST', `/api/users/${other.user.id}/reset-code`);
    expect(toHelper.statusCode).toBe(403);
    expect(toHelper.json().message).toContain('yardımcısının');
    expect((await s.req(helper.token, 'POST', '/api/users/yok/reset-code')).statusCode).toBe(404);

    // Yönetici yardımcıya kod üretebilir (yardımcı korunan hedef yalnızca yardımcılar için)
    expect((await s.req(s.owner.token, 'POST', `/api/users/${helper.user.id}/reset-code`)).statusCode).toBe(200);
    // Kod gerçekten çalışır
    const reset = await s.app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { username: plain.user.username, code: code.json().code, newPassword: 'yenisifre123' },
    });
    expect(reset.statusCode).toBe(200);
  });

  it('hesap silemez, yönetici ya da yardımcı atayıp alamaz, panel ve geri bildirimlere giremez', async () => {
    const helper = await makeHelper('yardimci');
    const other = await makeHelper('yardimci2');
    const plain = await s.member('uye');
    for (const [method, url] of [
      ['DELETE', `/api/users/${plain.user.id}`],
      ['GET', '/api/admins'],
      ['PUT', `/api/admins/${helper.user.id}`],
      ['PUT', `/api/admins/${plain.user.id}`],
      ['DELETE', `/api/admins/${s.owner.user.id}`],
      ['PUT', `/api/helpers/${plain.user.id}`],
      ['DELETE', `/api/helpers/${other.user.id}`],
      ['DELETE', `/api/helpers/${helper.user.id}`],
      ['GET', '/api/admin/dashboard'],
      ['GET', '/api/feedback'],
      ['GET', '/api/feedback/stats'],
    ] as const) {
      const res = await s.req(helper.token, method, url);
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    // Hiçbir şey değişmedi
    expect(s.ctx.store.getUser(plain.user.id)).not.toBeNull();
    expect(s.ctx.store.getUser(plain.user.id)!.isAdmin).toBe(false);
    expect(s.ctx.store.getUser(plain.user.id)!.isAccountHelper).toBe(false);
    expect(s.ctx.store.isAccountHelper(other.user.id)).toBe(true);
    expect(s.ctx.store.isAccountHelper(helper.user.id)).toBe(true);
    expect(s.ctx.store.listAdmins().map((u) => u.username)).toEqual(['sahip']);
    // Sunucu yetkileri de gelmez: yardımcı sunucu rolleriyle ilgili değil
    expect(s.ctx.permissions.isInstanceAdmin(helper.user.id)).toBe(false);
  });

  it('hesap daveti oluşturur ve listeler; yalnızca kendi davetini siler, yönetici hepsini siler', async () => {
    const helper = await makeHelper('yardimci');
    const other = await makeHelper('yardimci2');

    const own = (await s.req(helper.token, 'POST', '/api/invites', { maxUses: 1 })).json() as Invite;
    expect(own.createdBy).toBe(helper.user.id);
    expect(own.guildId).toBeNull();
    const adminInvite = (await s.req(s.owner.token, 'POST', '/api/invites', {})).json() as Invite;
    const otherInvite = (await s.req(other.token, 'POST', '/api/invites', {})).json() as Invite;

    const listed = (await s.req(helper.token, 'GET', '/api/invites')).json() as Invite[];
    // Yardımcı herkesin hesap davetini görür (s.member'ın açtığı davetler dahil)
    expect(listed.map((i) => i.code)).toEqual(expect.arrayContaining([own.code, adminInvite.code, otherInvite.code]));

    const denied = await s.req(helper.token, 'DELETE', `/api/invites/${adminInvite.code}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('kendi oluşturduğun');
    expect((await s.req(helper.token, 'DELETE', `/api/invites/${otherInvite.code}`)).statusCode).toBe(403);
    expect((await s.req(helper.token, 'DELETE', `/api/invites/${own.code}`)).statusCode).toBe(204);
    expect(s.ctx.store.getInvite(own.code)).toBeNull();
    // Sunucu davetleri bu uçtan silinmez (yokmuş gibi)
    const guildInvite = (await s.req(s.owner.token, 'POST', `/api/guilds/${s.guildId}/invites`, {})).json() as Invite;
    expect((await s.req(helper.token, 'DELETE', `/api/invites/${guildInvite.code}`)).statusCode).toBe(404);
    // Yönetici başkasının (yardımcının) davetini silebilir
    expect((await s.req(s.owner.token, 'DELETE', `/api/invites/${otherInvite.code}`)).statusCode).toBe(204);

    // Yardımcının daveti hesap açtırır
    const created = (await s.req(helper.token, 'POST', '/api/invites', {})).json() as Invite;
    const reg = await s.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: created.code, username: 'yeni', password: 'sifre12345' },
    });
    expect(reg.statusCode).toBe(201);
    expect((reg.json() as { user: User }).user).toMatchObject({ isAdmin: false, isAccountHelper: false });
  });

  it('hesap listesinde yalnızca gereken alanlar gelir; yönetici tam listeyi alır', async () => {
    const helper = await makeHelper('yardimci');
    await s.member('uye');
    const list = (await s.req(helper.token, 'GET', '/api/users')).json() as User[];
    expect(list.length).toBe(3);
    for (const u of list) {
      expect(Object.keys(u).sort()).toEqual(
        ['avatarColor', 'avatarUrl', 'displayName', 'id', 'isAccountHelper', 'isAdmin', 'username'].sort(),
      );
    }
    expect(list.find((u) => u.id === s.owner.user.id)).toMatchObject({ isAdmin: true, isAccountHelper: false });
    expect(list.find((u) => u.id === helper.user.id)).toMatchObject({ isAdmin: false, isAccountHelper: true });
    const full = (await s.req(s.owner.token, 'GET', '/api/users')).json() as User[];
    expect(Object.keys(full[0]!)).toContain('profileTheme');
  });

  it('yardımcılık alınınca yetkiler gider; değişiklik gateway ile anında yayılır', async () => {
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const plain = await s.member('uye');
    const helper = await s.member('yardimci');
    const gHelper = await connectGateway(s.app, helper.token);
    expect((await s.req(helper.token, 'GET', '/api/users')).statusCode).toBe(403);

    expect((await s.req(s.owner.token, 'PUT', '/api/helpers/yok')).statusCode).toBe(404);
    expect((await s.req(s.owner.token, 'PUT', `/api/helpers/${helper.user.id}`)).statusCode).toBe(200);
    // Tekrar vermek zararsızdır
    expect((await s.req(s.owner.token, 'PUT', `/api/helpers/${helper.user.id}`)).statusCode).toBe(200);
    expect((await s.req(helper.token, 'GET', '/api/users')).statusCode).toBe(200);
    expect((await s.req(helper.token, 'POST', `/api/users/${plain.user.id}/reset-code`)).statusCode).toBe(200);

    expect((await s.req(s.owner.token, 'DELETE', `/api/helpers/${helper.user.id}`)).statusCode).toBe(204);
    expect((await s.req(s.owner.token, 'DELETE', `/api/helpers/${helper.user.id}`)).statusCode).toBe(204);
    await gHelper.settle();
    expect(
      gHelper
        .of('USER_UPDATE')
        .filter((u) => u.id === helper.user.id)
        .map((u) => u.isAccountHelper),
    ).toEqual([true, false]);
    gHelper.ws.close();

    for (const [method, url] of [
      ['GET', '/api/users'],
      ['GET', '/api/invites'],
      ['POST', '/api/invites'],
      ['POST', `/api/users/${plain.user.id}/reset-code`],
      ['POST', `/api/users/${helper.user.id}/reset-code`],
    ] as const) {
      const res = await s.req(helper.token, method, url, method === 'POST' ? {} : undefined);
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
  });

  it('yardımcının ürettiği kod, hedef yönetici ya da yardımcı yapılınca ve yardımcılık alınınca geçersizleşir', async () => {
    const helper = await makeHelper('yardimci');
    const plain = await s.member('uye');
    const plain2 = await s.member('uye2');
    const plain3 = await s.member('uye3');
    const codeFor = async (target: Account): Promise<string> => {
      const res = await s.req(helper.token, 'POST', `/api/users/${target.user.id}/reset-code`);
      expect(res.statusCode).toBe(200);
      return res.json().code as string;
    };
    const redeem = (target: Account, code: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/auth/reset',
        payload: { username: target.user.username, code, newPassword: 'yenisifre123' },
      });

    // Sıradanken üretilen kod, hesap yönetici yapılınca işe yaramaz (yardımcı yöneticiyi ele geçiremez)
    const toAdmin = await codeFor(plain);
    expect((await s.req(s.owner.token, 'PUT', `/api/admins/${plain.user.id}`)).statusCode).toBe(200);
    expect((await redeem(plain, toAdmin)).statusCode).toBe(400);

    // Aynısı yardımcı yapılınca
    const toHelper = await codeFor(plain2);
    expect((await s.req(s.owner.token, 'PUT', `/api/helpers/${plain2.user.id}`)).statusCode).toBe(200);
    expect((await redeem(plain2, toHelper)).statusCode).toBe(400);

    // Yardımcılığı alınanın başkalarına ürettiği kodlar geçersizleşir; kendine ürettiği kalır
    const leftover = await codeFor(plain3);
    const own = await codeFor(helper);
    expect((await s.req(s.owner.token, 'DELETE', `/api/helpers/${helper.user.id}`)).statusCode).toBe(204);
    expect((await redeem(plain3, leftover)).statusCode).toBe(400);
    expect((await redeem(helper, own)).statusCode).toBe(200);
  });

  it('yöneticiye yardımcılık verilemez; yardımcı yönetici yapılınca yardımcılığı temizlenir', async () => {
    const admin = await s.member('yonetici');
    await s.req(s.owner.token, 'PUT', `/api/admins/${admin.user.id}`);
    const denied = await s.req(s.owner.token, 'PUT', `/api/helpers/${admin.user.id}`);
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: 'is_admin' });
    // Yöneticiden yardımcılık almak zararsızdır
    expect((await s.req(s.owner.token, 'DELETE', `/api/helpers/${admin.user.id}`)).statusCode).toBe(204);

    const helper = await makeHelper('yardimci');
    const promoted = (await s.req(s.owner.token, 'PUT', `/api/admins/${helper.user.id}`)).json() as User;
    expect(promoted).toMatchObject({ isAdmin: true, isAccountHelper: false });
    // Yöneticiliği alınınca yardımcılık geri gelmez: sıradan hesap olur
    expect((await s.req(s.owner.token, 'DELETE', `/api/admins/${helper.user.id}`)).statusCode).toBe(204);
    expect(s.ctx.store.getUser(helper.user.id)).toMatchObject({ isAdmin: false, isAccountHelper: false });
    expect((await s.req(helper.token, 'GET', '/api/invites')).statusCode).toBe(403);
  });

  it('sunucu sahibine ve sunucuda Yönetici yetkisi olana yardımcı kod üretemez, hesap yöneticisi üretir', async () => {
    const helper = await makeHelper('yardimci');
    // Herkes sunucu kurabilir: kendi sunucusunun sahibi (hesap yöneticisi değil)
    const guildOwner = await s.member('kurucu');
    expect((await s.req(guildOwner.token, 'POST', '/api/guilds', { name: 'Kendi Sunucum' })).statusCode).toBe(201);
    // Ana sunucuda Yönetici rolü taşıyan
    const roleAdmin = await s.member('rolyonetici');
    const role = await s.createRole(s.owner.token, { name: 'Yönetim', permissions: P.ADMINISTRATOR });
    expect(await s.giveRole(s.owner.token, roleAdmin.user.id, role.id)).toBe(200);
    // Yönetici yetkisi olmayan bir rol taşıyan sıradan kalır
    const modded = await s.member('mod');
    const modRole = await s.createRole(s.owner.token, { name: 'Mod', permissions: P.KICK_MEMBERS | P.MANAGE_MESSAGES });
    expect(await s.giveRole(s.owner.token, modded.user.id, modRole.id)).toBe(200);

    for (const target of [guildOwner, roleAdmin]) {
      const res = await s.req(helper.token, 'POST', `/api/users/${target.user.id}/reset-code`);
      expect([target.user.username, res.statusCode]).toEqual([target.user.username, 403]);
      expect(res.json().message).toBe('Sunucu sahibi ya da sunucu yöneticisi olan hesabı yalnızca hesap yöneticisi sıfırlayabilir.');
      expect((await s.req(s.owner.token, 'POST', `/api/users/${target.user.id}/reset-code`)).statusCode).toBe(200);
    }
    expect((await s.req(helper.token, 'POST', `/api/users/${modded.user.id}/reset-code`)).statusCode).toBe(200);
    // Yardımcı, sunucularda yetki kazanmaz
    expect((await s.req(helper.token, 'POST', `/api/guilds/${s.guildId}/channels`, { name: 'x', type: 'text' })).statusCode).toBe(
      403,
    );
  });

  it('silinen yardımcının başkalarına ürettiği kod geçersizleşir', async () => {
    const helper = await makeHelper('yardimci');
    const plain = await s.member('uye');
    const code = (await s.req(helper.token, 'POST', `/api/users/${plain.user.id}/reset-code`)).json().code as string;
    expect((await s.req(s.owner.token, 'DELETE', `/api/users/${helper.user.id}`)).statusCode).toBe(204);
    const reset = await s.app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { username: plain.user.username, code, newPassword: 'yenisifre123' },
    });
    expect(reset.statusCode).toBe(400);
  });

  it('yardımcılığı alınanın oluşturduğu hesap davetleri silinir; başkalarınınki kalır', async () => {
    const helper = await makeHelper('yardimci');
    const mine = (await s.req(helper.token, 'POST', '/api/invites', {})).json() as Invite;
    const mine2 = (await s.req(helper.token, 'POST', '/api/invites', { maxUses: 5 })).json() as Invite;
    const adminInvite = (await s.req(s.owner.token, 'POST', '/api/invites', {})).json() as Invite;
    expect((await s.req(s.owner.token, 'DELETE', `/api/helpers/${helper.user.id}`)).statusCode).toBe(204);
    expect(s.ctx.store.getInvite(mine.code)).toBeNull();
    expect(s.ctx.store.getInvite(mine2.code)).toBeNull();
    expect(s.ctx.store.getInvite(adminInvite.code)).not.toBeNull();
    const reg = await s.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: mine.code, username: 'yeni', password: 'sifre12345' },
    });
    expect(reg.statusCode).toBe(400);
  });
});
