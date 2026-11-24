import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission as P, type User } from '@diskort/shared';
import { buildApp } from '../src/app.js';
import { auth, config, connectGateway, startServer, type Account, type TestServer } from './helpers.js';

// Hesap yöneticiliği hesabın kendi bayrağıdır (users.is_admin): hiçbir sunucunun sahipliğine ya da
// rollerine bağlı değildir. Geri bildirim yönetimi, sıfırlama kodları, hesap silme ve hesap davetleri
// yalnızca hesap yöneticilerine açıktır.

let s: TestServer;

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  await s.close();
});

/** Hesap yöneticilerine açık uçların hepsi 403 dönmeli */
async function expectNoAdminAccess(account: Account, targetId: string): Promise<void> {
  for (const [method, url] of [
    ['GET', '/api/feedback'],
    ['GET', '/api/feedback/stats'],
    ['GET', '/api/admins'],
    ['GET', '/api/users'],
    ['GET', '/api/invites'],
    ['POST', '/api/invites'],
    ['PUT', `/api/admins/${account.user.id}`],
    ['POST', `/api/users/${targetId}/reset-code`],
    ['DELETE', `/api/users/${targetId}`],
  ] as const) {
    const res = await s.req(account.token, method, url, method === 'POST' ? {} : undefined);
    expect([method, url, res.statusCode]).toEqual([method, url, 403]);
  }
}

describe('hesap yöneticileri', () => {
  it('ilk hesap yöneticidir; başka sunucunun sahibi ya da ana sunucuda Yönetici rolü olan değildir', async () => {
    expect(s.owner.user.isAdmin).toBe(true);
    const guildOwner = await s.member('kurucu');
    const created = await s.req(guildOwner.token, 'POST', '/api/guilds', { name: 'Kendi Sunucum' });
    expect(created.statusCode).toBe(201);
    const roleAdmin = await s.member('rolyonetici');
    const role = await s.createRole(s.owner.token, { name: 'Yönetim', permissions: P.ADMINISTRATOR | P.MANAGE_GUILD });
    expect(await s.giveRole(s.owner.token, roleAdmin.user.id, role.id)).toBe(200);
    const victim = await s.member('kurban');

    for (const account of [guildOwner, roleAdmin]) {
      expect(s.ctx.store.getUser(account.user.id)!.isAdmin).toBe(false);
      expect(s.ctx.permissions.isInstanceAdmin(account.user.id)).toBe(false);
      await expectNoAdminAccess(account, victim.user.id);
    }
    const admins = (await s.req(s.owner.token, 'GET', '/api/admins')).json() as User[];
    expect(admins.map((u) => u.username)).toEqual(['sahip']);
  });

  it('yönetici başka birine yöneticilik verir; verilen hesap sunucu yetkisi olmadan yönetebilir', async () => {
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const member = await s.member('uye');
    const other = await s.member('diger');
    const gMember = await connectGateway(s.app, member.token);

    // Bilinmeyen hesap
    expect((await s.req(s.owner.token, 'PUT', '/api/admins/yok')).statusCode).toBe(404);
    const granted = await s.req(s.owner.token, 'PUT', `/api/admins/${member.user.id}`);
    expect(granted.statusCode).toBe(200);
    expect((granted.json() as User).isAdmin).toBe(true);
    // Tekrar vermek zararsızdır
    expect((await s.req(s.owner.token, 'PUT', `/api/admins/${member.user.id}`)).statusCode).toBe(200);
    await gMember.settle();
    expect(gMember.of('USER_UPDATE').filter((u) => u.id === member.user.id).map((u) => u.isAdmin)).toEqual([true]);
    gMember.ws.close();

    expect((await s.req(member.token, 'GET', '/api/feedback')).statusCode).toBe(200);
    expect((await s.req(member.token, 'GET', '/api/users')).json()).toHaveLength(3);
    expect((await s.req(member.token, 'POST', '/api/invites', {})).statusCode).toBe(201);
    expect((await s.req(member.token, 'POST', `/api/users/${other.user.id}/reset-code`)).statusCode).toBe(200);
    expect(((await s.req(member.token, 'GET', '/api/admins')).json() as User[]).map((u) => u.username)).toEqual([
      'sahip',
      'uye',
    ]);

    // Yöneticiler birbirinin şifresini sıfırlayamaz, hesabını silemez
    expect((await s.req(member.token, 'POST', `/api/users/${s.owner.user.id}/reset-code`)).statusCode).toBe(403);
    expect((await s.req(s.owner.token, 'DELETE', `/api/users/${member.user.id}`)).statusCode).toBe(403);

    // Yöneticilik alınınca yetkiler de gider
    expect((await s.req(s.owner.token, 'DELETE', `/api/admins/${member.user.id}`)).statusCode).toBe(204);
    expect(s.ctx.store.getUser(member.user.id)!.isAdmin).toBe(false);
    await expectNoAdminAccess(member, other.user.id);
    expect((await s.req(s.owner.token, 'DELETE', `/api/users/${member.user.id}`)).statusCode).toBe(204);
  });

  it('son yöneticinin yöneticiliği alınamaz (kendisi de bırakamaz)', async () => {
    expect((await s.req(s.owner.token, 'DELETE', `/api/admins/${s.owner.user.id}`)).json()).toMatchObject({
      error: 'last_admin',
    });
    const member = await s.member('uye');
    await s.req(s.owner.token, 'PUT', `/api/admins/${member.user.id}`);
    // İki yönetici varken biri kendini bırakabilir; kalan son yönetici bırakamaz
    expect((await s.req(s.owner.token, 'DELETE', `/api/admins/${s.owner.user.id}`)).statusCode).toBe(204);
    expect((await s.req(member.token, 'DELETE', `/api/admins/${member.user.id}`)).statusCode).toBe(400);
    expect(s.ctx.store.listAdmins().map((u) => u.username)).toEqual(['uye']);
    // Eski yönetici artık hiçbir şeyi yönetemez
    expect((await s.req(s.owner.token, 'GET', '/api/admins')).statusCode).toBe(403);
  });

  it('sunucu sahipliğini devretmek hesap yöneticiliğini değiştirmez', async () => {
    const member = await s.member('uye');
    const res = await s.req(s.owner.token, 'PATCH', `/api/guilds/${s.guildId}`, { ownerId: member.user.id });
    expect(res.statusCode).toBe(200);
    expect(s.ctx.store.getUser(member.user.id)!.isAdmin).toBe(false);
    expect(s.ctx.store.getUser(s.owner.user.id)!.isAdmin).toBe(true);
  });
});

describe('komut satırı aracı (admin-cli)', () => {
  it('list, grant ve revoke; son yönetici alınamaz', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-admin-cli-'));
    try {
      const { app, ctx } = await buildApp(config, { dbFile: path.join(dataDir, 'diskort.db'), logger: false });
      const register = async (inviteCode: string, username: string) =>
        app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode, username, password: 'sifre12345' } });
      const owner = (await register(ctx.store.ensureBootstrapInvite()!.code, 'ziroo')).json() as Account;
      const code = (
        await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner.token), payload: {} })
      ).json().code as string;
      await register(code, 'veli');
      await app.close();

      const cli = (...args: string[]) =>
        spawnSync(process.execPath, ['--import', 'tsx', 'src/admin-cli.ts', ...args], {
          cwd: path.resolve(import.meta.dirname, '..'),
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATA_DIR: dataDir },
          encoding: 'utf8',
        });
      const listed = () => (JSON.parse(cli('list', '--json').stdout) as { username: string }[]).map((u) => u.username);

      expect(listed()).toEqual(['ziroo']);
      // Yardımcıyken bekleyen kodu olan hesap yönetici yapılınca yardımcılığı ve kodu temizlenir
      const db = new DatabaseSync(path.join(dataDir, 'diskort.db'));
      const veliId = (db.prepare(`SELECT id FROM users WHERE username = 'veli'`).get() as { id: string }).id;
      db.prepare('UPDATE users SET is_account_helper = 1 WHERE id = ?').run(veliId);
      db.prepare('INSERT INTO reset_codes (code, user_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'KODKODKO',
        veliId,
        null,
        Date.now() + 3_600_000,
        Date.now(),
      );
      db.close();
      expect(cli('grant', 'VELI').status).toBe(0);
      expect(listed()).toEqual(['ziroo', 'veli']);
      const after = new DatabaseSync(path.join(dataDir, 'diskort.db'));
      expect(after.prepare('SELECT is_admin, is_account_helper FROM users WHERE id = ?').get(veliId)).toEqual({
        is_admin: 1,
        is_account_helper: 0,
      });
      expect(after.prepare('SELECT COUNT(*) AS n FROM reset_codes WHERE user_id = ?').get(veliId)).toEqual({ n: 0 });
      after.close();
      expect(cli('grant', 'yok').status).toBe(1);
      expect(cli('revoke', 'ziroo').status).toBe(0);
      const last = cli('revoke', 'veli');
      expect(last.status).toBe(1);
      expect(last.stderr).toContain('son hesap yöneticisi');
      expect(listed()).toEqual(['veli']);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
