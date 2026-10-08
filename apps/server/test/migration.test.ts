import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, hasPermission, Permission as P } from '@diskort/shared';
import { MIGRATIONS, Store } from '../src/db.js';
import { FeedbackStore } from '../src/feedbackStore.js';
import { PermissionService } from '../src/permissions.js';
import { ADMIN_HISTORY_MIGRATION, VoiceSessionRecorder } from '../src/voiceHistory.js';
import { VoiceStateStore } from '../src/voiceState.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 0.3.2 sürümündeki (şema 7, üretimdeki) gibi bir veritabanı: iki yönetici, bir üye */
function legacyDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-goc-'));
  dirs.push(dir);
  const file = path.join(dir, 'diskort.db');
  const db = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 7)) db.exec(sql);
  db.exec('PRAGMA user_version = 7');
  db.exec(`INSERT INTO guilds (id, name, created_at) VALUES ('g1', 'Eski', 1)`);
  const user = db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_color, is_admin, created_at)
     VALUES (?, ?, ?, 'x', '#5865f2', ?, ?)`,
  );
  user.run('uye', 'uye', 'Üye', 0, 100);
  user.run('ikinci', 'ikinci', 'İkinci Yönetici', 1, 300);
  user.run('kurucu', 'kurucu', 'Kurucu', 1, 200);
  db.exec(`UPDATE users SET avatar_hash = 'abc123' WHERE id = 'kurucu'`);
  db.exec(`INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES ('t1', 'g1', 'genel', 'text', 0, 1)`);
  db.close();
  return file;
}

describe('göç 8: roller', () => {
  it('yöneticiler Yönetici rolüne geçer, en eski yönetici sahip olur, herkes bugünkü yetkilerini korur', () => {
    const store = new Store(legacyDatabase());
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      const guild = store.ensureGuild('Yeni ad yok sayılır');
      expect(guild).toEqual({ id: 'g1', name: 'Eski', ownerId: 'kurucu', iconUrl: null });

      const roles = store.guildRoles('g1').sort((a, b) => b.position - a.position);
      expect(roles.map((r) => [r.name, r.position])).toEqual([
        ['Yönetici', 1],
        ['@everyone', 0],
      ]);
      const [admin, everyone] = roles;
      expect(everyone!.id).toBe('g1');
      // Göç 14 herkese davet oluşturma yetkisini ekler
      expect(everyone!.permissions & P.CREATE_INVITE).toBe(P.CREATE_INVITE);
      expect(admin!.permissions).toBe(P.ADMINISTRATOR);
      expect(admin!.hoist).toBe(true);

      expect(store.getUser('kurucu')).toMatchObject({ isAdmin: true, avatarUrl: '/api/avatars/kurucu/abc123.webp' });
      expect(store.getMember('g1', 'kurucu')).toMatchObject({ roles: [admin!.id], removed: false });
      expect(store.getUser('ikinci')).toMatchObject({ isAdmin: true });
      expect(store.getMember('g1', 'ikinci')).toMatchObject({ roles: [admin!.id] });
      expect(store.getUser('uye')).toMatchObject({ isAdmin: false });
      expect(store.getMember('g1', 'uye')).toMatchObject({ roles: [], removed: false });

      const perms = new PermissionService(store);
      expect(perms.base('g1', 'ikinci')).toBe(ALL_PERMISSIONS);
      const member = perms.inChannel('uye', 't1');
      for (const flag of [P.VIEW_CHANNEL, P.SEND_MESSAGES, P.ATTACH_FILES, P.ADD_REACTIONS]) {
        expect(hasPermission(member, flag)).toBe(true);
      }
      for (const flag of [P.MANAGE_MESSAGES, P.MANAGE_CHANNELS, P.MANAGE_INVITES, P.KICK_MEMBERS]) {
        expect(hasPermission(perms.base('g1', 'uye'), flag)).toBe(false);
      }
      expect(perms.outranks('g1', 'kurucu', 'ikinci')).toBe(true);
      expect(perms.outranks('g1', 'ikinci', 'kurucu')).toBe(false);
      expect(store.listChannels('g1')[0]!.overwrites).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('göç tekrar açılışta yeniden çalışmaz; is_admin (göç 17 ile) rollerden bağımsızdır', () => {
    const file = legacyDatabase();
    new Store(file).close();
    const store = new Store(file);
    try {
      store.ensureGuild('x');
      expect(store.guildRoles('g1')).toHaveLength(2);
      const adminRole = store.guildRoles('g1').find((r) => r.name === 'Yönetici')!;
      store.removeMemberRole('ikinci', adminRole.id);
      const flags = store.db.prepare('SELECT id, is_admin FROM users ORDER BY id').all();
      expect(flags).toEqual([
        { id: 'ikinci', is_admin: 1 },
        { id: 'kurucu', is_admin: 1 },
        { id: 'uye', is_admin: 0 },
      ]);
    } finally {
      store.close();
    }
  });
});

/** 0.4.x sürümündeki (şema 8, üretimdeki) gibi bir veritabanı: kanallara bağlı her türden kayıt */
function schema8Database(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-goc9-'));
  dirs.push(dir);
  const file = path.join(dir, 'diskort.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
  db.exec('PRAGMA user_version = 8');
  db.exec(`
    INSERT INTO guilds (id, name, created_at) VALUES ('g1', 'Eski', 1);
    INSERT INTO roles (id, guild_id, name, position, permissions, created_at) VALUES ('g1', 'g1', '@everyone', 0, 0, 1);
    INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at)
      VALUES ('u1', 'ali', 'Ali', 'x', '#5865f2', 1), ('u2', 'veli', 'Veli', 'x', '#5865f2', 2);
    INSERT INTO channels (id, guild_id, name, type, position, created_at)
      VALUES ('t1', 'g1', 'genel', 'text', 0, 1), ('v1', 'g1', 'Ses', 'voice', 1, 1);
    INSERT INTO channel_overwrites (channel_id, role_id, allow, deny) VALUES ('t1', 'g1', 0, 128);
    INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('t1', 'u1', 'selam', 5), ('t1', 'u2', 'naber', 6);
    INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (1, 'u2', '👍', 7);
    INSERT INTO attachments (id, message_id, channel_id, uploader_id, name, size, content_type, created_at)
      VALUES ('a1', 1, 't1', 'u1', 'not.txt', 3, 'text/plain', 5);
    INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ('u2', 't1', 1, 1);
  `);
  db.close();
  return file;
}

describe('göç 9: direkt mesajlar', () => {
  it('kanallar tablosu yeniden kurulurken kanala bağlı hiçbir kayıt kaybolmaz', () => {
    const store = new Store(schema8Database());
    try {
      const db = store.db;
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(count('channels')).toBe(2);
      expect(count('messages')).toBe(2);
      expect(count('reactions')).toBe(1);
      expect(count('attachments')).toBe(1);
      expect(count('read_states')).toBe(1);
      expect(store.listChannels('g1').map((c) => [c.id, c.type, c.overwrites.length])).toEqual([
        ['t1', 'text', 1],
        ['v1', 'voice', 0],
      ]);
      expect(
        store.listMessages('t1', null, 10, 'u1').map((m) => [m.content, m.reactions.length, m.attachments.length]),
      ).toEqual([
        ['selam', 1, 1],
        ['naber', 0, 0],
      ]);

      // Yeni tür ve kurallar: DM topluluğa bağlı olamaz, topluluk kanalı bağsız olamaz
      expect(() =>
        db.exec(`INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES ('d1', 'g1', '', 'dm', 0, 1)`),
      ).toThrow();
      expect(() =>
        db.exec(`INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES ('t2', NULL, 'x', 'text', 0, 1)`),
      ).toThrow();
      const { dm } = store.openDirectDm('u1', 'u2');
      expect(store.getChannel(dm.id)).toBeNull();
      expect(store.listChannels('g1')).toHaveLength(2);
      expect(new PermissionService(store).inChannel('u2', dm.id)).toBeGreaterThan(0);

      // Yabancı anahtarlar yeni tabloya bağlı: kanal silinince mesajları da gider
      store.deleteChannel('t1');
      expect(count('messages')).toBe(0);
      expect(count('read_states')).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('göç 10: yanıtlar', () => {
  it('şema 8 veritabanı 9 ve 10 ile göçer; eski mesajlar yanıt değildir, yeni yanıtlar özetiyle okunur', () => {
    const store = new Store(schema8Database());
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      const [first, second] = store.listMessages('t1', null, 50, 'u1');
      expect(first).toMatchObject({ content: 'selam', replyToId: null, referencedMessage: null, replyMentionUserId: null });
      expect(second).toMatchObject({ content: 'naber', replyToId: null });
      expect(first!.attachments).toHaveLength(1);
      expect(first!.reactions).toHaveLength(1);
      const reply = store.createMessage(
        't1',
        'u2',
        'yanıt',
        [],
        { userIds: ['u1'], everyone: false },
        { toId: Number(first!.id), mentionUserId: 'u1' },
      )!;
      expect(reply).toMatchObject({
        replyToId: first!.id,
        replyMentionUserId: 'u1',
        referencedMessage: { id: first!.id, authorId: 'u1', content: 'selam', hasAttachments: true },
      });
      expect(store.mentionCounts('u1')).toEqual({ t1: 1 });
    } finally {
      store.close();
    }
  });
});

describe('göç 11: GIF ve videolar', () => {
  it('şema 8 veritabanı 9, 10 ve 11 ile göçer; eski kayıtlar korunur, GIF ve video bilgisi saklanır', () => {
    const store = new Store(schema8Database());
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const [first, second] = store.listMessages('t1', null, 50, 'u1');
      expect(first).toMatchObject({ content: 'selam', embeds: [], replyToId: null });
      expect(first!.attachments).toEqual([
        expect.objectContaining({ id: 'a1', name: 'not.txt', contentType: 'text/plain', duration: null }),
      ]);
      expect(first!.reactions).toHaveLength(1);
      expect(second).toMatchObject({ content: 'naber', embeds: [] });

      // GIF mesajı ve ona yanıt: özette bağlantı yerine "GIF"
      const gif = store.createMessage('t1', 'u1', 'https://giphy.com/gifs/kedi1', [], { userIds: [], everyone: false })!;
      const embed = {
        type: 'gif' as const,
        provider: 'giphy' as const,
        id: 'kedi1',
        url: 'https://giphy.com/gifs/kedi1',
        title: '',
        width: 480,
        height: 270,
        gif: 'https://media.giphy.com/media/kedi1/giphy.gif',
        mp4: null,
        webp: null,
        still: null,
      };
      store.setMessageEmbeds(Number(gif.id), [embed]);
      expect(store.getMessage(Number(gif.id))!.embeds).toEqual([embed]);
      const reply = store.createMessage('t1', 'u2', 'güzel', [], { userIds: [], everyone: false }, {
        toId: Number(gif.id),
        mentionUserId: null,
      })!;
      expect(reply.referencedMessage).toEqual({ id: gif.id, authorId: 'u1', content: 'GIF', hasAttachments: false });

      store.createAttachment({
        id: 'b'.repeat(32),
        channelId: 't1',
        uploaderId: 'u1',
        name: 'v.mp4',
        size: 10,
        contentType: 'video/mp4',
        width: 1920,
        height: 1080,
        duration: 12.5,
      });
      expect(store.getAttachment('b'.repeat(32))!.attachment).toMatchObject({ duration: 12.5, width: 1920 });
    } finally {
      store.close();
    }
  });
});

/** 0.5.0 sürümündeki (şema 11, üretimdeki) gibi bir veritabanı: kanal mesajı, yanıt, DM konuşması, video */
function schema11Database(): string {
  const file = schema8Database();
  const db = new DatabaseSync(file);
  // Göç 9 tabloyu yeniden kurduğundan yabancı anahtar denetimi kapalıyken (Store.migrate gibi)
  db.exec('PRAGMA foreign_keys = OFF');
  for (const sql of MIGRATIONS.slice(8, 11)) db.exec(sql);
  db.exec('PRAGMA user_version = 11');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES ('d1', NULL, '', 'dm', 0, 8);
    INSERT INTO dm_channels (channel_id, pair_key, owner_id) VALUES ('d1', 'u1:u2', NULL);
    INSERT INTO dm_participants (channel_id, user_id, joined_at, open) VALUES ('d1', 'u1', 8, 1), ('d1', 'u2', 8, 1);
    INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('d1', 'u2', 'özel', 9);
    UPDATE messages SET reply_to_id = 1 WHERE id = 2;
    UPDATE attachments SET duration = 3.5 WHERE id = 'a1';
  `);
  db.close();
  return file;
}

describe('göç 12: geri bildirimler', () => {
  it('şema 11 veritabanı 12 ile göçer; önceki veriler (DM, yanıt, video) korunur, geri bildirim yazılır', () => {
    const store = new Store(schema11Database());
    try {
      const db = store.db;
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect([count('channels'), count('messages'), count('dm_participants'), count('reactions')]).toEqual([3, 3, 2, 1]);
      const [first, second] = store.listMessages('t1', null, 50, 'u1');
      expect(first!.attachments[0]).toMatchObject({ id: 'a1', duration: 3.5 });
      expect(second).toMatchObject({ content: 'naber', replyToId: first!.id });
      expect(store.listMessages('d1', null, 50, 'u1').map((m) => m.content)).toEqual(['özel']);

      const feedback = new FeedbackStore(db);
      expect(feedback.ready()).toBe(true);
      const created = feedback.create({
        userId: 'u1',
        type: 'hata',
        title: null,
        body: 'Göçten sonra',
        context: { platform: 'desktop', view: 'direkt mesaj' },
        screenshotIds: [],
      });
      expect(feedback.list()).toEqual([created]);
      // Hesap silinince geri bildirim kalır, gönderen boşalır
      store.deleteUser('u1');
      expect(feedback.get(created.id)!.userId).toBeNull();
    } finally {
      store.close();
    }
  });

  it('yeniden açılışta göç tekrar çalışmaz; çalışsa da zararsızdır (IF NOT EXISTS)', () => {
    const file = schema11Database();
    new Store(file).close();
    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(() => store.db.exec(MIGRATIONS[11]!)).not.toThrow();
    } finally {
      store.close();
    }
  });
});

/** 0.5.x sürümündeki (şema 12, üretimdeki) gibi bir veritabanı: @everyone bahsetmeli bir mesaj da var */
function schema12Database(): string {
  const file = schema11Database();
  const db = new DatabaseSync(file);
  db.exec(MIGRATIONS[11]!);
  db.exec('PRAGMA user_version = 12');
  db.exec(`
    INSERT INTO messages (channel_id, author_id, content, created_at, mention_everyone) VALUES ('t1', 'u1', '@everyone @here', 10, 1);
  `);
  db.close();
  return file;
}

describe('göç 13: @here', () => {
  it('şema 12 veritabanı 13 ile göçer; eski mesajlar @here sayılmaz, yenileri saklanır', () => {
    const store = new Store(schema12Database());
    try {
      const db = store.db;
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect([count('channels'), count('messages'), count('dm_participants'), count('reactions')]).toEqual([3, 4, 2, 1]);
      const messages = store.listMessages('t1', null, 50, 'u1');
      expect(messages.map((m) => [m.content, m.mentionEveryone, m.mentionHere])).toEqual([
        ['selam', false, false],
        ['naber', false, false],
        ['@everyone @here', true, false],
      ]);
      expect(messages[1]).toMatchObject({ replyToId: messages[0]!.id });

      const here = store.createMessage('t1', 'u1', '@here', [], { userIds: ['u2'], everyone: false, here: true })!;
      expect(here).toMatchObject({ mentionHere: true, mentionEveryone: false });
      expect(store.getMessage(Number(here.id))).toMatchObject({ mentionHere: true });
      expect(store.mentionCounts('u2')).toEqual({ t1: 2 });
    } finally {
      store.close();
    }
  });

  it('yeniden açılışta göç tekrar çalışmaz', () => {
    const file = schema12Database();
    new Store(file).close();
    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.listMessages('t1', null, 50, 'u1')).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});

/**
 * 0.5.3 sürümündeki (şema 13, üretimdeki) gibi bir veritabanı: tek topluluk; sahip, yönetici, rollü üye,
 * rolsüz üye, atılan ve yasaklanan hesaplar, sunucuda susturulan üye, özel kanal, davetler, DM, mesajlar.
 */
function schema13Database(): string {
  const file = schema12Database();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATIONS[12]!);
  db.exec('PRAGMA user_version = 13');
  const everyone = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.CONNECT | P.SPEAK | P.MENTION_EVERYONE;
  db.exec(`
    UPDATE roles SET permissions = ${everyone} WHERE id = 'g1';
    UPDATE guilds SET owner_id = 'u1' WHERE id = 'g1';
    INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at) VALUES
      ('admin', 'g1', 'Yönetici', '#e67e22', 2, 1, ${P.ADMINISTRATOR}, 1),
      ('dj', 'g1', 'DJ', '#123456', 1, 0, ${P.MOVE_MEMBERS | P.MANAGE_INVITES}, 1);
    INSERT INTO users (id, username, display_name, password_hash, avatar_color, is_admin, created_at, removed_at, banned_at, ban_reason, server_mute, server_deaf)
      VALUES ('u3', 'atilan', 'Atılan', 'x', '#5865f2', 0, 3, 50, NULL, NULL, 0, 0),
             ('u4', 'yasakli', 'Yasaklı', 'x', '#5865f2', 0, 4, 60, 60, 'spam', 0, 0),
             ('u5', 'yonetici', 'Yönetici', 'x', '#5865f2', 1, 5, NULL, NULL, NULL, 1, 0);
    UPDATE users SET server_deaf = 1 WHERE id = 'u2';
    INSERT INTO member_roles (user_id, role_id) VALUES ('u5', 'admin'), ('u2', 'dj');
    INSERT INTO channel_overwrites (channel_id, role_id, allow, deny) VALUES ('v1', 'dj', ${P.VIEW_CHANNEL}, 0);
    INSERT INTO invites (code, created_by, max_uses, uses, expires_at, created_at, grants_admin) VALUES
      ('ESKIDAVT', 'u1', 5, 1, NULL, 7, 0),
      ('BASLANGC', NULL, 1, 1, NULL, 1, 1);
    INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('t1', 'u3', 'atılmadan önce', 11);
  `);
  db.close();
  return file;
}

describe('göç 14: çoklu sunucu', () => {
  it('herkes ana sunucuya bugünkü üyeliği, rolleri, yasakları ve susturmalarıyla taşınır; hiçbir kayıt kaybolmaz', () => {
    const before = new DatabaseSync(schema13Database());
    const file = (before.prepare('PRAGMA database_list').get() as { file: string }).file;
    const count = (db: DatabaseSync, table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const tables = ['users', 'channels', 'messages', 'reactions', 'attachments', 'read_states', 'roles', 'member_roles',
      'channel_overwrites', 'dm_channels', 'dm_participants', 'invites'];
    const counts = Object.fromEntries(tables.map((t) => [t, count(before, t)]));
    const legacyUsers = before.prepare('SELECT * FROM users ORDER BY id').all();
    before.close();

    const store = new Store(file);
    try {
      const db = store.db;
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const t of tables) expect([t, count(db, t)]).toEqual([t, counts[t]]);
      // Eski sütunlar olduğu gibi durur (eski sürüme dönülürse diye). is_admin'i göç 17 bugünkü hesap
      // yöneticilerine (ana sunucunun sahibi u1 ve Yönetici rolündeki u5) göre yazar.
      const admins = new Set(['u1', 'u5']);
      expect(db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(
        (legacyUsers as { id: string }[]).map((u) => ({
          ...u,
          is_admin: admins.has(u.id) ? 1 : 0,
          // göç 21: profil süsleri boş başlar
          banner_hash: null,
          theme_primary: null,
          theme_accent: null,
          profile_effect: null,
          avatar_decoration: null,
          profile_frame: null,
          // göç 22: isim plakası boş başlar
          nameplate: null,
        })),
      );

      // Üyelikler: herkes ana sunucuda; atılan ve yasaklanan eski üye
      expect(store.primaryGuildId()).toBe('g1');
      expect(store.getGuild('g1')).toEqual({ id: 'g1', name: 'Eski', ownerId: 'u1', iconUrl: null });
      expect(store.listMembers('g1')).toEqual([
        { userId: 'u1', roles: [], joinedAt: 1, removed: false },
        { userId: 'u2', roles: ['dj'], joinedAt: 2, removed: false },
        { userId: 'u3', roles: [], joinedAt: 3, removed: true },
        { userId: 'u4', roles: [], joinedAt: 4, removed: true },
        { userId: 'u5', roles: ['admin'], joinedAt: 5, removed: false },
      ]);
      expect(['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => store.memberStatus('g1', id))).toEqual([
        'member',
        'member',
        'removed',
        'banned',
        'member',
      ]);
      expect(store.listBans('g1')).toEqual([expect.objectContaining({ reason: 'spam', bannedAt: 60, user: expect.objectContaining({ id: 'u4' }) })]);
      expect(store.serverVoiceFlags('g1', 'u5')).toEqual({ serverMute: true, serverDeaf: false });
      expect(store.serverVoiceFlags('g1', 'u2')).toEqual({ serverMute: false, serverDeaf: true });
      expect(store.userGuildIds('u3')).toEqual([]);

      // Yetkiler: rollerin yetkileri aynı, @everyone'a yalnızca CREATE_INVITE eklenir
      const roles = Object.fromEntries(store.guildRoles('g1').map((r) => [r.id, r.permissions]));
      expect(roles).toEqual({
        g1: P.VIEW_CHANNEL | P.SEND_MESSAGES | P.CONNECT | P.SPEAK | P.MENTION_EVERYONE | P.CREATE_INVITE,
        admin: P.ADMINISTRATOR,
        dj: P.MOVE_MEMBERS | P.MANAGE_INVITES,
      });
      const perms = new PermissionService(store);
      expect(perms.base('g1', 'u5')).toBe(ALL_PERMISSIONS);
      expect(perms.base('g1', 'u3')).toBe(0);
      expect(perms.base('g1', 'u4')).toBe(0);
      expect(perms.canView('u2', 'v1')).toBe(true);
      expect(perms.canView('u3', 't1')).toBe(false);
      expect(perms.isOwner('g1', 'u1')).toBe(true);
      // Hesap yöneticileri: sahip ve Yönetici rolündekiler (is_admin sütunu da aynı kalır)
      expect(['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => store.getUser(id)!.isAdmin)).toEqual([true, false, false, false, true]);

      // Davetler: eskiler ana sunucunun daveti, başlangıç daveti hesap daveti olarak kalır
      expect(store.getInvite('ESKIDAVT')).toMatchObject({ guildId: 'g1', uses: 1, maxUses: 5 });
      expect(store.getInvite('BASLANGC')).toMatchObject({ guildId: null });
      expect(store.listInvites('g1').map((i) => i.code)).toEqual(['ESKIDAVT']);

      // Mesajlar, DM'ler ve atılanın mesajı yerinde
      expect(store.listMessages('t1', null, 50, 'u1').map((m) => m.content)).toEqual([
        'selam',
        'naber',
        '@everyone @here',
        'atılmadan önce',
      ]);
      expect(store.listMessages('d1', null, 50, 'u1').map((m) => m.content)).toEqual(['özel']);
      expect(store.listDms('u2').map((d) => d.id)).toEqual(['d1']);
      expect(perms.inChannel('u2', 'd1')).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('eski üye yeni davetle döner (roller gelmez), yasaklı dönemez; yeni sunucular ana sunucudan ayrıdır', () => {
    const store = new Store(schema13Database());
    try {
      const join = store.joinWithInvite('ESKIDAVT', 'u3');
      expect(join).toEqual({ ok: true, guildId: 'g1', alreadyMember: false });
      expect(store.getMember('g1', 'u3')).toMatchObject({ removed: false, roles: [] });
      expect(store.joinWithInvite('ESKIDAVT', 'u4')).toMatchObject({ ok: false, reason: 'banned' });
      expect(store.joinWithInvite('eskidavt', 'u1')).toEqual({ ok: true, guildId: 'g1', alreadyMember: true });

      const other = store.createGuild('u3', 'Başka Grup');
      expect(store.primaryGuildId()).toBe('g1');
      expect(store.userGuildIds('u3')).toEqual(['g1', other.id]);
      expect(store.listMembers(other.id).map((m) => m.userId)).toEqual(['u3']);
      expect(store.listChannels(other.id).map((c) => [c.name, c.type])).toEqual([
        ['genel-sohbet', 'text'],
        ['Genel', 'voice'],
      ]);
      const perms = new PermissionService(store);
      // Başka sunucunun sahibi ana sunucuda yetki kazanmaz, hesap yöneticisi olmaz
      expect(perms.base(other.id, 'u3')).toBe(ALL_PERMISSIONS);
      expect(perms.base('g1', 'u3') & P.ADMINISTRATOR).toBe(0);
      expect(store.getUser('u3')!.isAdmin).toBe(false);
      // Ana sunucunun üyesi yeni sunucuyu göremez
      expect(perms.base(other.id, 'u1')).toBe(0);
      expect(perms.visibleChannelIds('u1').size).toBe(store.listChannels('g1').length);
    } finally {
      store.close();
    }
  });

  it('yeniden açılışta göç tekrar çalışmaz', () => {
    const file = schema13Database();
    new Store(file).close();
    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM guild_members').get()).toEqual({ n: 5 });
      expect(store.guildRoles('g1').find((r) => r.id === 'g1')!.permissions & P.CREATE_INVITE).toBe(P.CREATE_INVITE);
    } finally {
      store.close();
    }
  });
});

/** Üretimdeki (0.6.13) gibi şema 19 veritabanı: çoklu sunucu, durum, sabitlemeler, arama dizini */
function schema19Database(): string {
  const file = schema13Database();
  const db = new DatabaseSync(file);
  for (let v = 13; v < 19; v++) db.exec(MIGRATIONS[v]!);
  db.exec('PRAGMA user_version = 19');
  db.close();
  return file;
}

describe('göç 20: ses geçmişi ve davet kullanımları', () => {
  it('şema 19 veritabanı 20 ile göçer; önceki veriler korunur, oturumlar ve davet kullanımları yazılır', () => {
    const file = schema19Database();
    const before = new DatabaseSync(file);
    const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const tables = ['users', 'guilds', 'guild_members', 'channels', 'messages', 'invites', 'roles', 'messages_fts'];
    const counts = Object.fromEntries(tables.map((t) => [t, count(before, t)]));
    before.close();

    const store = new Store(file);
    try {
      const db = store.db;
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(Object.fromEntries(tables.map((t) => [t, count(db, t)]))).toEqual(counts);
      const indexes = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('voice_sessions', 'invite_uses') ORDER BY name`)
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes).toEqual(['invite_uses_by_time', 'voice_sessions_by_end', 'voice_sessions_by_start', 'voice_sessions_by_user']);
      expect(count(db, 'voice_sessions')).toBe(0);
      expect(count(db, 'invite_uses')).toBe(0);

      // Davetle geri dönen üye: kim, kimin daveti, hangi sunucu
      expect(store.joinWithInvite('ESKIDAVT', 'u3')).toMatchObject({ ok: true });
      expect(db.prepare('SELECT code, guild_id, inviter_id, user_id, kind FROM invite_uses').all()).toEqual([
        { code: 'ESKIDAVT', guild_id: 'g1', inviter_id: 'u1', user_id: 'u3', kind: 'join' },
      ]);

      // Ses oturumu: katılma, yayın, ayrılma
      const voice = new VoiceStateStore();
      const recorder = new VoiceSessionRecorder(db, (id) => store.getChannel(id)?.guildId ?? null);
      recorder.attach(voice);
      voice.join('u1', 'v1');
      voice.setStreaming('u1', 'v1', true);
      voice.leave('u1', 'v1');
      expect(db.prepare('SELECT user_id, guild_id, channel_id, kind, end_reason FROM voice_sessions ORDER BY id').all()).toEqual([
        { user_id: 'u1', guild_id: 'g1', channel_id: 'v1', kind: 'voice', end_reason: 'leave' },
        { user_id: 'u1', guild_id: 'g1', channel_id: 'v1', kind: 'stream', end_reason: 'leave' },
      ]);

      // Göç yeniden çalışsa da zararsızdır; hesap silinse de geçmiş kalır (kişi boş olur)
      db.exec(ADMIN_HISTORY_MIGRATION);
      expect(count(db, 'voice_sessions')).toBe(2);
      db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
      expect(db.prepare('SELECT DISTINCT user_id FROM voice_sessions').all()).toEqual([{ user_id: null }]);
    } finally {
      store.close();
    }
  });

  it('yeniden açılışta göç tekrar çalışmaz', () => {
    const file = schema19Database();
    new Store(file).close();
    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    } finally {
      store.close();
    }
  });
});

describe('göç 21: profil süsleri', () => {
  it('şema 20 veritabanı 21 ile göçer; kullanıcılar korunur, süsler boş başlar', () => {
    const file = schema19Database();
    // Önce 20'ye getirilir (göç 20), sonra sürüm 20'ye çekilip 21 yeniden uygulanmış gibi denenir
    new Store(file).close();
    const db = new DatabaseSync(file);
    const users = db.prepare('SELECT id, username, avatar_hash FROM users ORDER BY id').all();
    for (const column of ['banner_hash', 'theme_primary', 'theme_accent', 'profile_effect', 'avatar_decoration', 'profile_frame']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${column} IS NOT NULL`).get()).toEqual({ n: 0 });
    }
    db.close();
    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.db.prepare('SELECT id, username, avatar_hash FROM users ORDER BY id').all()).toEqual(users);
      const user = store.listUsers()[0]!;
      expect(user).toMatchObject({
        bannerUrl: null,
        profileTheme: null,
        profileEffect: null,
        avatarDecoration: null,
        profileFrame: null,
      });
    } finally {
      store.close();
    }
  });
});

describe('göç 22: isim plakası', () => {
  it('şema 21 veritabanı 22 ile göçer; süsler korunur, plaka boş başlar, set efekti ayrı alanda okunur', () => {
    const file = schema19Database();
    const db = new DatabaseSync(file);
    for (let v = 19; v < 21; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 21');
    const [first, second] = db.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[];
    db.prepare(`UPDATE users SET profile_effect = 'kuzey' WHERE id = ?`).run(first!.id);
    db.prepare(`UPDATE users SET profile_effect = 'karadelik', avatar_decoration = 'anim:buz' WHERE id = ?`).run(second!.id);
    db.close();

    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.getUser(first!.id)).toMatchObject({
        profileEffect: null,
        animatedEffect: 'kuzey',
        avatarDecoration: null,
        nameplate: null,
      });
      // Eski istemciler tanımadıkları efekt kimliğinde çöker: set efekti profileEffect'te hiç görünmez
      expect(store.getUser(second!.id)).toMatchObject({
        profileEffect: null,
        animatedEffect: 'karadelik',
        avatarDecoration: 'anim:buz',
        nameplate: null,
      });
      // Bilinmeyen plaka (ör. ileride kaldırılmış bir set) gösterilmez
      store.db.prepare(`UPDATE users SET nameplate = 'eski-set' WHERE id = ?`).run(first!.id);
      expect(store.getUser(first!.id)!.nameplate).toBeNull();
      expect(store.updateUser(first!.id, { nameplate: 'sakura' })!.nameplate).toBe('sakura');
    } finally {
      store.close();
    }
  });
});

describe('göç 23: eski kozmetikler kaldırıldı', () => {
  it('şema 22 veritabanında eski efekt, katalog dekorasyonu ve çerçeve silinir; set parçaları korunur', () => {
    const file = schema19Database();
    const db = new DatabaseSync(file);
    for (let v = 19; v < 22; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 22');
    const ids = (db.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[]).map((u) => u.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const [first, second, third, fourth] = ids as [string, string, string, string];
    const set = db.prepare(
      'UPDATE users SET profile_effect = ?, avatar_decoration = ?, profile_frame = ?, nameplate = ? WHERE id = ?',
    );
    set.run('snow', 'crown', 'gold', 'neon', first);
    set.run('karadelik', 'anim:buz', 'floral', null, second);
    set.run('sparkles', 'anim:olmayan', null, null, third);
    set.run('petals', null, 'gold', 'sakura', fourth);
    const others = db.prepare('SELECT id, username, display_name, avatar_color, theme_primary FROM users ORDER BY id').all();
    db.close();

    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(MIGRATIONS.length).toBe(26);
      expect(
        store.db.prepare('SELECT id, profile_effect, avatar_decoration, profile_frame, nameplate FROM users ORDER BY id').all(),
      ).toEqual(
        ids.map((id) => ({
          id,
          profile_effect: id === second ? 'karadelik' : null,
          // anim: ile başlayan kalır; bilinmeyen set (ör. ileride kaldırılmış) okunurken gösterilmez
          avatar_decoration: id === second ? 'anim:buz' : id === third ? 'anim:olmayan' : null,
          profile_frame: null,
          nameplate: id === first ? 'neon' : id === fourth ? 'sakura' : null,
        })),
      );
      // Diğer alanlara dokunulmaz
      expect(
        store.db.prepare('SELECT id, username, display_name, avatar_color, theme_primary FROM users ORDER BY id').all(),
      ).toEqual(others);

      const legacy = { profileEffect: null, profileFrame: null };
      expect(store.getUser(first)).toMatchObject({ ...legacy, animatedEffect: null, avatarDecoration: null, nameplate: 'neon' });
      expect(store.getUser(second)).toMatchObject({ ...legacy, animatedEffect: 'karadelik', avatarDecoration: 'anim:buz' });
      expect(store.getUser(third)).toMatchObject({ ...legacy, animatedEffect: null, avatarDecoration: null });

      // Göç tekrar çalışsa da zararsızdır
      expect(() => store.db.exec(MIGRATIONS[22]!)).not.toThrow();
      expect(store.getUser(second)).toMatchObject({ animatedEffect: 'karadelik', avatarDecoration: 'anim:buz' });
    } finally {
      store.close();
    }
  });
});

describe('göç 24: kanal medyası dizini', () => {
  it('şema 23 veritabanına dizin eklenir, medya sorgusu onu kullanır; tekrar çalışsa da zararsızdır', () => {
    const file = schema19Database();
    const db = new DatabaseSync(file);
    for (let v = 19; v < 23; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 23');
    db.close();

    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      const index = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'attachments_by_channel_message'")
        .get();
      expect(index).toEqual({ name: 'attachments_by_channel_message' });
      const plan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
           WHERE a.channel_id = ? AND a.message_id IS NOT NULL AND a.content_type IN ('image/png')
           ORDER BY a.message_id DESC, a.position ASC LIMIT 10`,
        )
        .all('k') as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' | ')).toContain('attachments_by_channel_message');
      expect(() => store.db.exec(MIGRATIONS[23]!)).not.toThrow();
    } finally {
      store.close();
    }
  });
});

describe('göç 25: engellemeler ve arama kayıtları', () => {
  it('şema 24 veritabanına yalnızca ekleme yapar: eski mesajlar sıradan kalır, engel ve arama kaydı yazılır', () => {
    const file = schema19Database();
    const db = new DatabaseSync(file);
    for (let v = 19; v < 24; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 24');
    const before = db.prepare('SELECT id, channel_id, author_id, content, created_at FROM messages ORDER BY id').all();
    const userIds = (db.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[]).map((u) => u.id);
    db.close();
    expect(before.length).toBeGreaterThan(0);

    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(MIGRATIONS.length).toBe(26);
      // Var olan mesajlar olduğu gibi; türleri yok (sıradan mesaj biçimi değişmez)
      expect(store.db.prepare('SELECT id, channel_id, author_id, content, created_at FROM messages ORDER BY id').all()).toEqual(before);
      const old = store.getMessage(Number((before[0] as { id: number }).id))!;
      expect(old.type).toBeUndefined();
      expect('call' in old).toBe(false);

      // Engel tablosu boş başlar, yazılır ve hesap silinince satır gider
      const [a, b] = userIds as [string, string];
      expect(store.blockedUserIds(a)).toEqual([]);
      expect(store.block(a, b, 5)).toBe(true);
      expect(store.block(a, b, 6)).toBe(false);
      expect(store.hasBlocked(a, b)).toBe(true);
      expect(store.hasBlocked(b, a)).toBe(false);
      expect(store.blockedEither(b, a)).toBe(true);
      expect(store.listBlocks(a)).toMatchObject([{ userId: b, createdAt: 5 }]);
      store.deleteUser(b);
      expect(store.blockedUserIds(a)).toEqual([]);

      // Arama kaydı: tür ve bilgisi okunur, güncellenir (düzenlenmiş sayılmaz)
      const channel = (store.db.prepare("SELECT id FROM channels WHERE type = 'text' LIMIT 1").get() as { id: string }).id;
      const call = store.createCallMessage(channel, a, [], 1000);
      expect(call).toMatchObject({ type: 'call', call: { participantIds: [a], endedAt: null }, content: '📞 Arama başlattı.' });
      expect(store.openCallMessage(channel)?.id).toBe(call.id);
      const ended = store.updateCallMessage(Number(call.id), { participantIds: [a, 'x'], endedAt: 1000 + 5 * 60_000 })!;
      expect(ended).toMatchObject({ editedAt: null, call: { endedAt: 301_000 }, content: '📞 Arama başlattı · 5 dk sürdü.' });
      expect(store.openCallMessage(channel)).toBeNull();
      expect(store.openCallMessages()).toEqual([]);

      // Göç tekrar çalıştırılamaz (sütun ekler) ama açılışta tekrar çalışmaz
      store.close();
      const again = new Store(file);
      expect(again.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 });
      again.close();
    } finally {
      try {
        store.close();
      } catch {
        // zaten kapalı
      }
    }
  });
});

describe('göç 26: arkadaşlar', () => {
  it('şema 25 veritabanına yalnızca ekleme yapar: istek, kabul, engel ve hesap silme tabloları tutarlı bırakır', () => {
    const file = schema19Database();
    const db = new DatabaseSync(file);
    for (let v = 19; v < 25; v++) db.exec(MIGRATIONS[v]!);
    db.exec('PRAGMA user_version = 25');
    const userIds = (db.prepare('SELECT id FROM users ORDER BY id').all() as { id: string }[]).map((u) => u.id);
    db.close();
    expect(userIds.length).toBeGreaterThanOrEqual(2);

    const store = new Store(file);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 26 });
      const [a, b] = userIds as [string, string];
      const permissions = new PermissionService(store);
      expect(store.listFriends(a)).toEqual({ friends: [], incoming: [], outgoing: [] });
      expect(store.sendFriendRequest(a, b, 1)).toBe('requested');
      expect(store.sendFriendRequest(a, b, 2)).toBe('pending');
      expect(store.listFriends(b).incoming).toMatchObject([{ userId: a, createdAt: 1 }]);
      // Karşı yönden istek kabul sayılır; iki yönde de istek kalmaz
      expect(store.sendFriendRequest(b, a, 3)).toBe('accepted');
      expect(store.areFriends(a, b) && store.areFriends(b, a)).toBe(true);
      expect(permissions.areFriends(a, b)).toBe(true);
      expect(store.listFriends(a)).toMatchObject({ friends: [{ userId: b, createdAt: 3 }], incoming: [], outgoing: [] });
      expect(store.sendFriendRequest(a, b, 4)).toBe('friends');
      // Kendine istek veritabanında da reddedilir
      expect(() => store.db.prepare('INSERT INTO friend_requests VALUES (?, ?, 1)').run(a, a)).toThrow();
      // Engel arkadaşlığı kaldırır
      store.block(b, a);
      expect(store.areFriends(a, b)).toBe(false);
      expect(permissions.areFriends(a, b)).toBe(false);
      store.unblock(b, a);
      expect(store.sendFriendRequest(a, b, 5)).toBe('requested');
      store.deleteUser(b);
      expect(store.listFriends(a)).toEqual({ friends: [], incoming: [], outgoing: [] });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM friend_requests').get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });
});
