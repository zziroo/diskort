import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nanoid, customAlphabet } from 'nanoid';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  extractMentions,
  extractMessageUrls,
  hasPermission,
  INLINE_IMAGE_TYPES,
  INLINE_VIDEO_TYPES,
  isGifMessage,
  MAX_GUILDS_PER_USER,
  MESSAGE_MAX_REACTIONS,
  MAX_PINS_PER_CHANNEL,
  Permission,
  basePermissions,
  type Attachment,
  type Channel,
  type ChannelLinkItem,
  type ChannelMediaItem,
  type ChannelType,
  type DmChannel,
  type Embed,
  type Guild,
  type GuildMember,
  type Invite,
  type LinkEmbed,
  type Message,
  type MessageCall,
  callMessageText,
  type UserBlock,
  type FriendEntry,
  type FriendsList,
  type PermissionContext,
  type PermissionOverwrite,
  type PinnedMessage,
  type Reaction,
  type ReactionUsersPage,
  type ReadStateUpdate,
  type ReferencedMessage,
  type Role,
  type User,
  referenceOf,
  SEARCH_TOTAL_CAP,
  type SearchHas,
} from '@diskort/shared';
import {
  animatedDecorationId,
  AVATAR_COLORS,
  type AnimatedDecoration,
  type CosmeticSetId,
  isCosmeticSet,
  type ProfileTheme,
} from '@diskort/shared';
import { FEEDBACK_MIGRATION } from './feedbackStore.js';
import { ADMIN_HISTORY_MIGRATION } from './voiceHistory.js';

/**
 * Göç 8'de @everyone'a verilen yetkiler: rollerden önce herkesin yapabildikleri (+ yeni @everyone
 * bahsetmesi). Bit değerleri kalıcı olduğundan göç her zaman aynı sonucu verir.
 */
const V8_EVERYONE =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.MENTION_EVERYONE |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM;

/** Göçte ve yeni toplulukta oluşturulan yönetici rolü */
const ADMIN_ROLE_NAME = 'Yönetici';
const ADMIN_ROLE_COLOR = '#e67e22';

/**
 * Mesaj araması için SQLite FTS5 dizini (göç 19). Dizinde mesaj metninin arama için katlanmış kopyası
 * durur (rowid = mesaj kimliği); tetikleyiciler ekleme/düzenleme/silmede (kanal ya da konuşma silinince
 * zincirleme silinenler dahil) dizini güncel tutar, göç var olan mesajları baştan dizinler.
 * Sözcük ayırıcı unicode61 + remove_diacritics 2: büyük/küçük harf ve aksan duyarsız (ç=c, ş=s, ğ=g, ö=o,
 * ü=u, İ=i). Türkçedeki noktasız ı'yı unicode61 i'ye indirmez; bu yüzden metin dizine ı→i çevrilerek yazılır
 * (sorgu da aynı katlamayla kurulur, bkz. @diskort/shared foldSearchText). Yeniden çalışsa da zararsızdır.
 */
export const SEARCH_MIGRATION = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
  DROP TRIGGER IF EXISTS messages_fts_insert;
  DROP TRIGGER IF EXISTS messages_fts_update;
  DROP TRIGGER IF EXISTS messages_fts_delete;
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.id, replace(new.content, 'ı', 'i'));
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts (rowid, body) VALUES (new.id, replace(new.content, 'ı', 'i'));
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END;
  DELETE FROM messages_fts;
  INSERT INTO messages_fts (rowid, body) SELECT id, replace(content, 'ı', 'i') FROM messages;
`;

/** Testler eski şemadan göçü sınayabilsin diye dışa açık */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color  TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE invites (
    code         TEXT PRIMARY KEY,
    created_by   TEXT,
    max_uses     INTEGER,
    uses         INTEGER NOT NULL DEFAULT 0,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL,
    grants_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE guilds (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE channels (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('voice', 'text')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 2: şifre sıfırlama kodları; şifre değişince eski oturumları geçersiz kılmak için zaman damgası
  `
  ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE reset_codes (
    code       TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 3: metin kanalları — mesajlar ve kullanıcı başına okunma durumu; mevcut topluluğa bir metin kanalı
  `
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at  INTEGER
  );
  CREATE INDEX messages_by_channel ON messages(channel_id, id);
  CREATE TABLE read_states (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
  );
  INSERT INTO channels (id, guild_id, name, type, position, created_at)
    SELECT lower(hex(randomblob(6))), g.id, 'genel-sohbet', 'text', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM guilds g WHERE NOT EXISTS (SELECT 1 FROM channels WHERE type = 'text');
  `,
  // 4: telefonlara bildirim göndermek için cihaz jetonları (FCM / APNs)
  `
  CREATE TABLE push_tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE INDEX push_tokens_by_user ON push_tokens(user_id);
  `,
  // 5: mesaj tepkileri — kullanıcı başına, emoji başına bir kayıt
  `
  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX reactions_by_user ON reactions(user_id);
  `,
  // 6: dosya ekleri. Dosyanın kendisi <DATA_DIR>/attachments/<id>; message_id boşsa yüklenmiş ama
  // henüz bir mesaja eklenmemiştir (bir saat içinde eklenmezse silinir).
  `
  CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    uploader_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    width        INTEGER,
    height       INTEGER,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX attachments_by_message ON attachments(message_id, position);
  CREATE INDEX attachments_by_channel ON attachments(channel_id);
  CREATE INDEX attachments_by_uploader ON attachments(uploader_id);
  `,
  // 7: profil fotoğrafı. Dosyanın kendisi <DATA_DIR>/avatars/<özet>.webp; boşsa baş harfler gösterilir.
  `
  ALTER TABLE users ADD COLUMN avatar_hash TEXT;
  `,
  // 8: roller ve yetkiler. @everyone rolünün kimliği topluluğun kimliğidir. Yöneticiler "Yönetici" rolüne
  // (ADMINISTRATOR) geçer, en eski yönetici topluluğun sahibi olur; diğer herkesin bugünkü yetkileri
  // @everyone'da kalır. users.is_admin artık rollerden hesaplanıp güncel tutulur (eski sürüme dönülürse
  // diye). Atılan/yasaklanan hesap silinmez (mesajları adıyla kalsın): removed_at doluysa üye değildir.
  `
  CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL,
    hoist       INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE member_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  ) WITHOUT ROWID;
  CREATE INDEX member_roles_by_role ON member_roles(role_id);
  CREATE TABLE channel_overwrites (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
  ) WITHOUT ROWID;
  ALTER TABLE guilds ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN removed_at INTEGER;
  ALTER TABLE users ADD COLUMN banned_at INTEGER;
  ALTER TABLE users ADD COLUMN ban_reason TEXT;
  ALTER TABLE users ADD COLUMN server_mute INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN server_deaf INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
  INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at)
    SELECT g.id, g.id, '@everyone', NULL, 0, 0, ${V8_EVERYONE}, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM guilds g;
  INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at)
    SELECT lower(hex(randomblob(6))), g.id, '${ADMIN_ROLE_NAME}', '${ADMIN_ROLE_COLOR}', 1, 1, ${Permission.ADMINISTRATOR},
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM guilds g;
  INSERT INTO member_roles (user_id, role_id)
    SELECT u.id, r.id FROM users u JOIN roles r ON r.position = 1 AND r.name = '${ADMIN_ROLE_NAME}'
    WHERE u.is_admin = 1;
  UPDATE guilds SET owner_id = (SELECT id FROM users ORDER BY is_admin DESC, created_at, rowid LIMIT 1);
  `,
  // 9: direkt mesajlar. Konuşma da bir kanaldır (type 'dm', topluluğa bağlı değil: guild_id boş); mesajlar,
  // dosyalar, tepkiler ve okunma durumu kanallarınkiyle aynı tablolardadır. Tür denetimi değiştiğinden
  // channels tablosu SQLite'ın önerdiği yolla yeniden kurulur (yeni tablo, kopya, eskisini sil, yeniden
  // adlandır); bu yüzden göçler yabancı anahtar denetimi kapalıyken çalışır (bkz. migrate).
  // dm_channels.pair_key: bire bir konuşmada iki kimliğin sıralı birleşimi (aynı iki kişiye tek konuşma);
  // grupta boş. dm_participants.open: konuşma kişinin listesinde mi (kapatılan konuşma yeni mesajla açılır).
  `
  CREATE TABLE channels_new (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('voice', 'text', 'dm')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK ((type = 'dm') = (guild_id IS NULL))
  );
  INSERT INTO channels_new (id, guild_id, name, type, position, created_at)
    SELECT id, guild_id, name, type, position, created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;
  CREATE TABLE dm_channels (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    pair_key   TEXT UNIQUE,
    owner_id   TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE dm_participants (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  INTEGER NOT NULL,
    open       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX dm_participants_by_user ON dm_participants(user_id);
  `,
  // 10: mesaj yanıtları. reply_to_id yanıt verilen mesajdır; bilerek yabancı anahtar değildir: asıl mesaj
  // silinince yanıt "asıl mesaj silindi" olarak kalır (kimlikler AUTOINCREMENT, yeniden kullanılmaz).
  // reply_mention_user_id: yanıtta bildirilen asıl yazar ("@ AÇIK"), asıl mesaj silinse de kalır.
  // Asıl mesajın özeti saklanmaz; her okumada asıl mesajdan üretilir (bkz. withDetails).
  `
  ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
  ALTER TABLE messages ADD COLUMN reply_mention_user_id TEXT;
  `,
  // 11: GIF'ler ve videolar. embeds: mesaja sunucunun eklediği gömülü içerik (GIPHY GIF'i; JSON dizi,
  // yoksa boş). duration: videonun süresi (saniye).
  `
  ALTER TABLE messages ADD COLUMN embeds TEXT;
  ALTER TABLE attachments ADD COLUMN duration REAL;
  `,
  // 12: geri bildirimler (feedbackStore.ts). Kendi başınadır ve yeniden çalışsa da zararsızdır (IF NOT EXISTS).
  FEEDBACK_MIGRATION,
  // 13: @here bahsetmesi. mention_here: yazarın yetkisi olan bir @here (o an çevrimiçi olanlara bildirim
  // gitti); eski mesajlarda 0. Kime bildirim gittiği ayrıca saklanmaz, okunmamış bahsetme sayısına yazılır.
  `
  ALTER TABLE messages ADD COLUMN mention_here INTEGER NOT NULL DEFAULT 0;
  `,
  // 14: çoklu sunucu. Üyelik artık sunucu başınadır (guild_members): bugüne kadar hesap = tek topluluğun
  // üyeliğiydi (users.removed_at/banned_at/server_mute/server_deaf). Her hesap ana sunucuya (ilk kurulan)
  // o bilgilerle taşınır: atılan/yasaklanan eski üye olarak kalır, susturmalar sürer; roller (member_roles)
  // zaten rollere, roller sunuculara bağlıdır. users'taki eski sütunlar silinmez (eski sürüme dönülürse
  // diye) ama artık okunmaz. Davetler sunucuya bağlanır (guild_id; boşsa yalnızca hesap açtıran davet);
  // var olan davetler ana sunucunun davetleri olur. Yeni CREATE_INVITE yetkisi her sunucuda @everyone'a
  // verilir. guilds.icon_hash: sunucu simgesi (<DATA_DIR>/avatars/<özet>.webp).
  `
  CREATE TABLE guild_members (
    guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    removed_at  INTEGER,
    banned_at   INTEGER,
    ban_reason  TEXT,
    server_mute INTEGER NOT NULL DEFAULT 0,
    server_deaf INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX guild_members_by_user ON guild_members(user_id);
  INSERT INTO guild_members (guild_id, user_id, joined_at, removed_at, banned_at, ban_reason, server_mute, server_deaf)
    SELECT g.id, u.id, u.created_at, u.removed_at, u.banned_at, u.ban_reason, u.server_mute, u.server_deaf
    FROM users u JOIN (SELECT id FROM guilds ORDER BY created_at, rowid LIMIT 1) g;
  ALTER TABLE guilds ADD COLUMN icon_hash TEXT;
  ALTER TABLE invites ADD COLUMN guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE;
  UPDATE invites SET guild_id = (SELECT id FROM guilds ORDER BY created_at, rowid LIMIT 1) WHERE grants_admin = 0;
  CREATE INDEX invites_by_guild ON invites(guild_id);
  UPDATE roles SET permissions = permissions | ${Permission.CREATE_INVITE} WHERE id = guild_id;
  `,
  // 15: kullanıcı durumu. Hesap başına tek satır (hiç ayarlamamış hesapta yok = 'online', özel durum yok).
  // status_expires_at / custom_expires_at: süre dolunca sunucu satırı varsayılana çeker (bkz. presence.ts);
  // okurken de süresi geçmiş değer yok sayılır.
  `
  CREATE TABLE user_status (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
    status_expires_at INTEGER,
    custom_text       TEXT,
    custom_emoji      TEXT,
    custom_expires_at INTEGER,
    updated_at        INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX user_status_status_expiry ON user_status(status_expires_at) WHERE status_expires_at IS NOT NULL;
  CREATE INDEX user_status_custom_expiry ON user_status(custom_expires_at) WHERE custom_expires_at IS NOT NULL;
  `,
  // 16: bağlantı önizlemeleri. Önizlemeler mesajın embeds sütununa (GIF'lerle birlikte) yazılır;
  // suppress_embeds: yazar ya da yönetici önizlemeyi kaldırdı (düzenlense de yeniden eklenmez).
  // link_previews: adres başına önbellek (embed boşsa önizleme yok / alınamadı); süresi dolanlar silinir.
  `
  ALTER TABLE messages ADD COLUMN suppress_embeds INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE link_previews (
    url        TEXT PRIMARY KEY,
    embed      TEXT,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX link_previews_expiry ON link_previews(expires_at);
  `,
  // 17: hesap yöneticiliği hesabın kendi bayrağıdır (users.is_admin), sunucu rollerinden hesaplanmaz. Bugün
  // hesap yöneticisi olan herkes (ana sunucunun sahibi ve orada Yönetici yetkisi olan üyeler) öyle kalır;
  // diğer herkesinki sıfırlanır. Bundan sonra yalnızca yöneticiler (Ayarlar) ya da admin-cli değiştirir.
  `
  UPDATE users SET is_admin = CASE WHEN id IN (
    SELECT g.owner_id FROM (SELECT id, owner_id FROM guilds ORDER BY created_at, rowid LIMIT 1) g
    WHERE g.owner_id IS NOT NULL
    UNION
    SELECT m.user_id FROM guild_members m
      JOIN (SELECT id FROM guilds ORDER BY created_at, rowid LIMIT 1) g ON g.id = m.guild_id
    WHERE m.removed_at IS NULL AND (
      EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
              WHERE mr.user_id = m.user_id AND r.guild_id = g.id AND (r.permissions & ${Permission.ADMINISTRATOR}) != 0)
      OR EXISTS (SELECT 1 FROM roles r WHERE r.id = g.id AND (r.permissions & ${Permission.ADMINISTRATOR}) != 0)
    )
  ) THEN 1 ELSE 0 END;
  CREATE INDEX IF NOT EXISTS users_admins ON users(is_admin) WHERE is_admin = 1;
  `,
  // 18: sabitlenmiş mesajlar. Mesaj başına en fazla bir kayıt; mesaj (ya da kanalı) silinince kayıt da
  // gider. channel_id sorgular için mesajınkinin kopyasıdır. Yeni PIN_MESSAGES yetkisi MANAGE_MESSAGES
  // yetkili rollere ve kanal izinlerine (izin/engel) aynen yansıtılır; @everyone'da kapalı kalır (Yönetici
  // ve sahip zaten her yetkiye sahip). Tekrar çalışsa da zararsızdır (IF NOT EXISTS, bit OR'u).
  `
  CREATE TABLE IF NOT EXISTS message_pins (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    pinned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    pinned_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS message_pins_by_channel ON message_pins(channel_id, pinned_at);
  UPDATE roles SET permissions = permissions | ${Permission.PIN_MESSAGES}
    WHERE (permissions & ${Permission.MANAGE_MESSAGES}) != 0;
  UPDATE channel_overwrites SET allow = allow | ${Permission.PIN_MESSAGES}
    WHERE (allow & ${Permission.MANAGE_MESSAGES}) != 0;
  UPDATE channel_overwrites SET deny = deny | ${Permission.PIN_MESSAGES}
    WHERE (deny & ${Permission.MANAGE_MESSAGES}) != 0;
  `,
  // 19: mesaj araması (bkz. SEARCH_MIGRATION)
  SEARCH_MIGRATION,
  // 20: yönetim paneli geçmişi — ses/yayın oturumları ve davet kullanımları (bkz. voiceHistory.ts)
  ADMIN_HISTORY_MIGRATION,
  // 21: profil süsleri. banner_hash: afiş (<DATA_DIR>/avatars/<özet>.webp, profil fotoğraflarıyla aynı
  // klasör); theme_primary/theme_accent: profil kartının iki rengi ("#rrggbb", ikisi birlikte ya da hiç);
  // profile_effect: kartta oynayan efektin kimliği (bkz. PROFILE_EFFECTS); avatar_decoration ve
  // profile_frame: kozmetik kataloğundaki dekorasyon ve çerçeve (katalog göç 23 ile kaldırıldı). Hepsi boş
  // başlar.
  `
  ALTER TABLE users ADD COLUMN banner_hash TEXT;
  ALTER TABLE users ADD COLUMN theme_primary TEXT;
  ALTER TABLE users ADD COLUMN theme_accent TEXT;
  ALTER TABLE users ADD COLUMN profile_effect TEXT;
  ALTER TABLE users ADD COLUMN avatar_decoration TEXT;
  ALTER TABLE users ADD COLUMN profile_frame TEXT;
  `,
  // 22: hareketli kozmetik setleri. nameplate: üye listesindeki isim plakası (bkz. NAMEPLATES), boş başlar.
  // Set efektleri profile_effect'e, hareketli dekorasyonlar (anim:<set>) avatar_decoration'a yazılır.
  `
  ALTER TABLE users ADD COLUMN nameplate TEXT;
  `,
  // 23: eski kozmetikler kaldırıldı (parçacıklı efektler, katalog dekorasyonları, profil çerçeveleri).
  // Saklanan eski değerler silinir; yalnızca set efektleri ve hareketli dekorasyonlar (anim:<set>) kalır.
  // profile_frame sütunu artık okunmaz ve yazılmaz, boş durur (eski sürüme dönülürse diye silinmez).
  // Tekrar çalışsa da zararsızdır.
  `
  UPDATE users SET profile_effect = NULL WHERE profile_effect IN ('snow', 'sparkles', 'petals');
  UPDATE users SET avatar_decoration = NULL WHERE avatar_decoration NOT LIKE 'anim:%';
  UPDATE users SET profile_frame = NULL WHERE profile_frame IS NOT NULL;
  `,
  // 24: kanal panelinin "Medya" sekmesi (bkz. listChannelMedia): kanalın dosyaları mesaj ve sıra düzeninde,
  // sıralamasız okunur. Tekrar çalışsa da zararsızdır (IF NOT EXISTS).
  `
  CREATE INDEX IF NOT EXISTS attachments_by_channel_message ON attachments(channel_id, message_id, position);
  `,
  // 25: engelleme ve DM aramaları. user_blocks: blocker_id, blocked_id'yi engelledi (hesap silinince satır da
  // gider). messages.type: NULL sıradan mesaj, 'call' arama kaydı; call_data: aramanın bilgisi (JSON:
  // katılanlar, bitiş). Yalnızca ekleme yapar; eski sürüme dönülürse yeni sütunlar ve tablo yok sayılır
  // (arama kayıtları düz metin mesajı olarak görünür).
  `
  CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS user_blocks_by_blocked ON user_blocks(blocked_id);
  ALTER TABLE messages ADD COLUMN type TEXT;
  ALTER TABLE messages ADD COLUMN call_data TEXT;
  CREATE INDEX IF NOT EXISTS messages_calls ON messages(channel_id, id) WHERE type = 'call';
  `,
  // 26: arkadaşlar. friend_requests: from_id, to_id'ye istek gönderdi (aynı yönde tek istek; karşı yönde
  // bekleyen istek varken gönderilen istek kabul sayılır, iki yönde aynı anda istek kalmaz). friendships: iki
  // yönlü arkadaşlık, çift başına tek satır (user_a < user_b). Hesap silinince satırlar da gider. Yalnızca
  // ekleme yapar; eski sürüme dönülürse tablolar yok sayılır.
  `
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id != to_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS friend_requests_by_to ON friend_requests(to_id);
  CREATE TABLE IF NOT EXISTS friendships (
    user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS friendships_by_b ON friendships(user_b);
  `,
];

type Param = string | number | null;

/** Kanal panelinin "Bağlantılar" sayfasında bir istekte taranan en fazla mesaj (bkz. listChannelLinks) */
const CHANNEL_LINKS_SCAN_WINDOW = 2000;

/** user_status satırı */
export interface StatusRow {
  user_id: string;
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  status_expires_at: number | null;
  custom_text: string | null;
  custom_emoji: string | null;
  custom_expires_at: number | null;
  updated_at: number;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  is_admin: number;
  sessions_valid_after: number;
  avatar_hash: string | null;
  banner_hash: string | null;
  theme_primary: string | null;
  theme_accent: string | null;
  profile_effect: string | null;
  avatar_decoration: string | null;
  nameplate: string | null;
}

/**
 * Kullanıcının dışarı verilen avatar rengi (fotoğrafsız baş harf avatarının zemini, profil kartı yedek rengi).
 * Ayrı bir "profil rengi" seçimi yok: profil teması varsa onun ana rengi, yoksa hesapta saklı renk.
 * Kullanıcıyı dışarı veren tek yer toUser olduğundan tüm istemciler (yayımlanmış eski sürümler dahil)
 * avatarColor alanını okuyarak bunu istemci mantığı olmadan alır. Saklı renk yedek olarak kalır.
 */
const effectiveAvatarColor = (r: Pick<UserRow, 'avatar_color' | 'theme_primary' | 'theme_accent'>): string =>
  r.theme_primary && r.theme_accent ? r.theme_primary : r.avatar_color;

interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: string | null;
  position: number;
  hoist: number;
  permissions: number;
}

const toRole = (r: RoleRow): Role => ({
  id: r.id,
  name: r.name,
  color: r.color,
  position: r.position,
  hoist: r.hoist === 1,
  permissions: r.permissions,
});

interface GuildRow {
  id: string;
  name: string;
  owner_id: string | null;
  icon_hash: string | null;
  created_at: number;
}

const toGuild = (r: GuildRow): Guild => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id,
  iconUrl: r.icon_hash ? `/api/guild-icons/${r.id}/${r.icon_hash}.webp` : null,
});

interface MemberRow {
  guild_id: string;
  user_id: string;
  joined_at: number;
  removed_at: number | null;
  banned_at: number | null;
  ban_reason: string | null;
  server_mute: number;
  server_deaf: number;
}

/** Yetki denetimi için bir DM'in katılımcıları */
export interface DmAccess {
  participantIds: readonly string[];
  group: boolean;
}

/** Bir sunucunun yetki hesaplaması için anlık görüntüsü */
export interface GuildPermissionData extends PermissionContext {
  /** Üye → rolleri (@everyone hariç); rolü olmayan üye listede yoktur */
  memberRoles: ReadonlyMap<string, readonly string[]>;
  /** Şu anki üyeler (ayrılan, atılan, yasaklanan hariç) */
  members: ReadonlySet<string>;
  /** Sunucunun kanalları, izinleriyle */
  channels: ReadonlyMap<string, Channel>;
}

/** Yetki hesaplaması için tüm sunucuların anlık görüntüsü (her yazma işleminden sonra yeniden okunur) */
export interface PermissionData {
  /** Sunucular, kuruluş sırasıyla (ilki ana sunucu) */
  guilds: ReadonlyMap<string, GuildPermissionData>;
  /** Kanal → sunucusu (DM'ler hariç) */
  channelGuild: ReadonlyMap<string, string>;
  /** Kullanıcı → üye olduğu sunucular */
  userGuilds: ReadonlyMap<string, ReadonlySet<string>>;
  /** Direkt mesaj konuşmaları: kimlik → katılımcılar */
  dms: ReadonlyMap<string, DmAccess>;
  /** Engeller: blockKey(engelleyen, engellenen) */
  blocks: ReadonlySet<string>;
  /** Arkadaşlıklar: kullanıcı → arkadaşları (iki yönlü) */
  friends: ReadonlyMap<string, ReadonlySet<string>>;
  /** Ana sunucu: ilk kurulan (hesap açtıran ilk kişi ve yönetici davetleri buraya katılır) */
  primaryGuildId: string | null;
}

export interface BanRow {
  user: User;
  reason: string | null;
  bannedAt: number;
}

/** Hesabın bir sunucudaki durumu */
export type MembershipStatus = 'member' | 'removed' | 'banned' | 'none';

interface InviteRow {
  code: string;
  guild_id: string | null;
  created_by: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  created_at: number;
  grants_admin: number;
}

interface ChannelRow {
  id: string;
  guild_id: string;
  name: string;
  type: ChannelType;
  position: number;
}

interface DmRow {
  id: string;
  name: string;
  created_at: number;
  pair_key: string | null;
  owner_id: string | null;
  last_id: number | null;
  last_at: number | null;
}

/** Engelin anahtarı (PermissionData.blocks): yönlüdür */
export const blockKey = (blocker: string, blocked: string): string => `${blocker}>${blocked}`;

/** Bire bir konuşmanın anahtarı: iki kimliğin sıralı birleşimi */
const pairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Konuşma satırlarını (son mesaj bilgisiyle) seçen sorgunun başı; WHERE ile tamamlanır */
const DM_SELECT = `
  SELECT c.id, c.name, c.created_at, d.pair_key, d.owner_id,
    (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id) AS last_id,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
  FROM channels c JOIN dm_channels d ON d.channel_id = c.id`;

const toInvite = (r: InviteRow): Invite => ({
  code: r.code,
  guildId: r.guild_id,
  createdBy: r.created_by ?? '',
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

interface MessageRow {
  id: number;
  channel_id: string;
  author_id: string | null;
  content: string;
  created_at: number;
  edited_at: number | null;
  mention_everyone: number;
  mention_here: number;
  reply_to_id: number | null;
  reply_mention_user_id: string | null;
  embeds: string | null;
  suppress_embeds: number;
  type: string | null;
  call_data: string | null;
}

/** Saklanan arama bilgisi (sunucunun kendi yazdığı JSON); okunamazsa sürmüyor ve katılan yok sayılır */
function parseCall(raw: string | null): MessageCall {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<MessageCall>) : null;
    return {
      participantIds: Array.isArray(value?.participantIds) ? value.participantIds.filter((id) => typeof id === 'string') : [],
      endedAt: typeof value?.endedAt === 'number' ? value.endedAt : null,
    };
  } catch {
    return { participantIds: [], endedAt: null };
  }
}

/** Saklanan gömülü içerik (sunucunun kendi yazdığı JSON); okunamazsa boş */
function parseEmbeds(raw: string | null): Embed[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as Embed[]) : [];
  } catch {
    return [];
  }
}

const toMessage = (r: MessageRow): Message => ({
  id: String(r.id),
  channelId: r.channel_id,
  authorId: r.author_id,
  content: r.content,
  createdAt: r.created_at,
  editedAt: r.edited_at,
  attachments: [],
  reactions: [],
  mentionEveryone: r.mention_everyone === 1,
  mentionHere: r.mention_here === 1,
  embeds: parseEmbeds(r.embeds),
  suppressEmbeds: r.suppress_embeds === 1,
  replyToId: r.reply_to_id === null ? null : String(r.reply_to_id),
  referencedMessage: null,
  replyMentionUserId: r.reply_mention_user_id,
  // Tür yalnızca sıradan olmayan mesajda gelir (sıradan mesajların biçimi değişmez)
  ...(r.type === 'call' ? { type: 'call' as const, call: parseCall(r.call_data) } : {}),
});

/** Yanıt verilecek mesaj: aynı kanalda ve hâlâ duruyorsa */
export interface ReplyTarget {
  id: number;
  authorId: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: number | null;
  channel_id: string;
  uploader_id: string | null;
  name: string;
  size: number;
  content_type: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  name: r.name,
  size: r.size,
  contentType: r.content_type,
  width: r.width,
  height: r.height,
  duration: r.duration ?? null,
  url: `/api/attachments/${r.id}/${encodeURIComponent(r.name)}`,
});

export type AddReactionResult = 'added' | 'exists' | 'limit';

export type PinResult = 'pinned' | 'exists' | 'limit' | 'missing';

const toChannel = (r: ChannelRow, overwrites: PermissionOverwrite[] = []): Channel => ({
  id: r.id,
  guildId: r.guild_id,
  name: r.name,
  type: r.type,
  position: r.position,
  overwrites,
});

const inviteCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

export type InviteCheck = { ok: true; invite: InviteRow } | { ok: false; reason: string };

export type RegisterResult =
  | { ok: true; user: User; guildId: string | null }
  | { ok: false; reason: 'invite' | 'username' | 'banned'; message: string };

export type JoinResult =
  | { ok: true; guildId: string; alreadyMember: boolean }
  | { ok: false; reason: 'invite' | 'banned' | 'account_invite' | 'too_many'; message: string };

/** Yeni sunucunun kanalları */
const NEW_GUILD_CHANNELS: [string, ChannelType][] = [
  ['genel-sohbet', 'text'],
  ['Genel', 'voice'],
];

/** SQLite (node:sqlite) üzerinde kalıcı veri erişimi. */
export class Store {
  readonly db: DatabaseSync;
  /** Yetki anlık görüntüsü; her yazma işleminde silinir, gerekince yeniden okunur */
  private permissionCache: PermissionData | null = null;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (current >= MIGRATIONS.length) return;
    // Tabloyu yeniden kuran göçler (9) yabancı anahtar denetimi kapalıyken çalışmalı: açıkken eski tablonun
    // silinmesi ona bağlı satırları (mesajları!) da siler. Denetim işlem içinde değiştirilemediğinden
    // göçlerin tamamı için dışarıda kapatılır; göçler yalnızca var olan satırları taşır.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (let v = current; v < MIGRATIONS.length; v++) {
        this.tx(() => {
          this.db.exec(MIGRATIONS[v]!);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        });
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private tx<T>(fn: () => T): T {
    this.permissionCache = null;
    // İç içe çağrı (ör. bir işlemin içinden başka bir yazma yöntemi) dıştaki işlemin parçasıdır
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      // İşlem sırasında okunan (geri alınan) durum önbellekte kalmasın
      this.permissionCache = null;
      throw err;
    }
  }

  private one<T>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: Param[]): number {
    this.permissionCache = null;
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private toUser(r: UserRow): User {
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarColor: effectiveAvatarColor(r),
      avatarUrl: r.avatar_hash ? `/api/avatars/${r.id}/${r.avatar_hash}.webp` : null,
      bannerUrl: r.banner_hash ? `/api/banners/${r.id}/${r.banner_hash}.webp` : null,
      profileTheme: r.theme_primary && r.theme_accent ? { primary: r.theme_primary, accent: r.theme_accent } : null,
      // Eski kozmetiklerin alanları (0.8.x istemciler okur) her zaman null: eski istemciler tanımadıkları
      // efekt kimliğinde çöker, set efekti bu yüzden ayrı alanda gider. Alanlar gönderilmeseydi de aynı
      // sonuç çıkardı (USER_UPDATE profili bütünüyle değiştirir); açıkça null olmaları daha güvenli.
      profileEffect: null,
      // Set seçimleri yalnızca kimlik şu an biliniyorsa (yerleşik ya da yayında olan paket) gider: yayından
      // kaldırılan paketin kimliği saklı kalır ama gönderilmez (paket yeniden yayınlanırsa geri gelir)
      animatedEffect: this.knownCosmeticSet(r.profile_effect) ? r.profile_effect : null,
      avatarDecoration: this.knownCosmeticSet(animatedDecorationId(r.avatar_decoration)) ? r.avatar_decoration : null,
      profileFrame: null,
      nameplate: this.knownCosmeticSet(r.nameplate) ? r.nameplate : null,
      isAdmin: r.is_admin === 1,
    };
  }

  /**
   * Set kimliği şu an seçilebilir mi. Varsayılan: yalnızca yerleşik setler; uygulama kurulurken kozmetik
   * paketleri deposuna bağlanır (yerleşik ∪ yayında olan paketler, bkz. CosmeticPackStore.knows).
   */
  knownCosmeticSet: (id: string | null | undefined) => boolean = isCosmeticSet;

  // ---------- Kullanıcılar ----------

  countUsers(): number {
    return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  }

  getUser(id: string): User | null {
    const row = this.one<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? this.toUser(row) : null;
  }

  getUserAuthByUsername(username: string): (User & { passwordHash: string }) | null {
    const row = this.one<UserRow>('SELECT * FROM users WHERE username = ?', username);
    return row ? { ...this.toUser(row), passwordHash: row.password_hash } : null;
  }

  /** Tüm hesaplar */
  listUsers(): User[] {
    return this.all<UserRow>('SELECT * FROM users ORDER BY created_at').map((r) => this.toUser(r));
  }

  /** Verilen hesapların profilleri (olmayanlar atlanır) */
  usersByIds(ids: Iterable<string>): User[] {
    const list = [...new Set(ids)];
    if (list.length === 0) return [];
    const rows: UserRow[] = [];
    // SQLite parametre sınırına takılmamak için parçalar hâlinde
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      rows.push(...this.all<UserRow>(`SELECT * FROM users WHERE id IN (${part.map(() => '?').join(',')})`, ...part));
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id)).map((r) => this.toUser(r));
  }

  /**
   * Kullanıcının görebildiği hesapların kimlikleri: kendisi, üye olduğu sunucuların üyeleri ve eski üyeleri
   * (mesajlarında adları görünsün diye), direkt mesaj konuşmalarındaki kişiler ve arkadaşları.
   */
  visibleUserIds(userId: string): Set<string> {
    const ids = new Set<string>([userId]);
    for (const r of this.all<{ id: string }>(
      `SELECT DISTINCT o.user_id AS id FROM guild_members m JOIN guild_members o ON o.guild_id = m.guild_id
       WHERE m.user_id = ? AND m.removed_at IS NULL`,
      userId,
    )) {
      ids.add(r.id);
    }
    for (const r of this.all<{ id: string }>(
      `SELECT DISTINCT o.user_id AS id FROM dm_participants p JOIN dm_participants o ON o.channel_id = p.channel_id
       WHERE p.user_id = ?`,
      userId,
    )) {
      ids.add(r.id);
    }
    for (const id of this.friendIds(userId)) ids.add(id);
    return ids;
  }

  /**
   * Kullanıcıyı görebilenler (profil değişikliğini alacaklar): kendisi, kaydı (eski üyelik dahil) olan
   * sunucuların şu anki üyeleri, direkt mesaj konuşmalarındaki kişiler ve arkadaşları.
   */
  observerIds(userId: string): Set<string> {
    const ids = new Set<string>([userId]);
    for (const r of this.all<{ id: string }>(
      `SELECT DISTINCT o.user_id AS id FROM guild_members m JOIN guild_members o ON o.guild_id = m.guild_id
       WHERE m.user_id = ? AND o.removed_at IS NULL`,
      userId,
    )) {
      ids.add(r.id);
    }
    for (const r of this.all<{ id: string }>(
      `SELECT DISTINCT o.user_id AS id FROM dm_participants p JOIN dm_participants o ON o.channel_id = p.channel_id
       WHERE p.user_id = ?`,
      userId,
    )) {
      ids.add(r.id);
    }
    for (const id of this.friendIds(userId)) ids.add(id);
    return ids;
  }

  /** Bu andan önce verilmiş oturum jetonları geçersizdir (ms, saniyeye yuvarlanmış). */
  getSessionsValidAfter(userId: string): number | null {
    return this.one<{ v: number }>('SELECT sessions_valid_after AS v FROM users WHERE id = ?', userId)?.v ?? null;
  }

  /** Şifreyi değiştirir ve kullanıcının diğer tüm oturumlarını geçersiz kılar. */
  setPassword(userId: string, passwordHash: string): void {
    const validAfter = Math.floor(Date.now() / 1000) * 1000;
    this.run('UPDATE users SET password_hash = ?, sessions_valid_after = ? WHERE id = ?', passwordHash, validAfter, userId);
    this.run('DELETE FROM reset_codes WHERE user_id = ?', userId);
  }

  deleteUser(userId: string): boolean {
    return this.tx(() => {
      const deleted = this.run('DELETE FROM users WHERE id = ?', userId) > 0;
      return deleted;
    });
  }

  // ---------- Hesap yöneticileri (users.is_admin; sunuculardan bağımsız) ----------

  /** Hesap yöneticisi mi (her çağrıda veritabanından: komut satırı aracının değişikliği de hemen geçerli) */
  isAdmin(userId: string): boolean {
    return this.one<{ a: number }>('SELECT is_admin AS a FROM users WHERE id = ?', userId)?.a === 1;
  }

  /** Hesap yöneticileri, en eski hesap önce */
  listAdmins(): User[] {
    return this.all<UserRow>('SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at, rowid').map((r) => this.toUser(r));
  }

  /**
   * Hesap yöneticiliğini verir ya da alır. Son yönetici yöneticilikten çıkarılamaz ('last_admin').
   * Değişmediyse 'unchanged'; hesap yoksa 'not_found'.
   */
  setAdmin(userId: string, admin: boolean): 'ok' | 'unchanged' | 'not_found' | 'last_admin' {
    return this.tx(() => {
      const row = this.one<{ a: number }>('SELECT is_admin AS a FROM users WHERE id = ?', userId);
      if (!row) return 'not_found';
      if ((row.a === 1) === admin) return 'unchanged';
      if (!admin && this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')!.n <= 1) {
        return 'last_admin';
      }
      this.run('UPDATE users SET is_admin = ? WHERE id = ?', admin ? 1 : 0, userId);
      return 'ok';
    });
  }

  /** Kullanıcı için yeni tek kullanımlık sıfırlama kodu (öncekiler geçersiz olur). */
  createResetCode(userId: string, createdBy: string, ttlMs: number): { code: string; expiresAt: number } {
    const code = inviteCode();
    const expiresAt = Date.now() + ttlMs;
    this.tx(() => {
      this.run('DELETE FROM reset_codes WHERE user_id = ?', userId);
      this.run(
        'INSERT INTO reset_codes (code, user_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        code,
        userId,
        createdBy,
        expiresAt,
        Date.now(),
      );
    });
    return { code, expiresAt };
  }

  /** Kod bu kullanıcıya aitse ve süresi geçmemişse tüketir ve kullanıcı kimliğini döner. */
  consumeResetCode(username: string, code: string): string | null {
    return this.tx(() => {
      const row = this.one<{ user_id: string; expires_at: number }>(
        `SELECT r.user_id, r.expires_at FROM reset_codes r JOIN users u ON u.id = r.user_id
         WHERE r.code = ? AND u.username = ?`,
        code.trim().toUpperCase(),
        username,
      );
      if (!row) return null;
      this.run('DELETE FROM reset_codes WHERE code = ?', code.trim().toUpperCase());
      return row.expires_at >= Date.now() ? row.user_id : null;
    });
  }

  updateUser(
    id: string,
    patch: {
      displayName?: string;
      avatarColor?: string;
      profileTheme?: ProfileTheme | null;
      profileEffect?: CosmeticSetId | null;
      avatarDecoration?: AnimatedDecoration | null;
      nameplate?: CosmeticSetId | null;
    },
  ): User | null {
    if (patch.displayName !== undefined) this.run('UPDATE users SET display_name = ? WHERE id = ?', patch.displayName, id);
    if (patch.avatarColor !== undefined) this.run('UPDATE users SET avatar_color = ? WHERE id = ?', patch.avatarColor, id);
    if (patch.profileTheme !== undefined) {
      this.run(
        'UPDATE users SET theme_primary = ?, theme_accent = ? WHERE id = ?',
        patch.profileTheme?.primary ?? null,
        patch.profileTheme?.accent ?? null,
        id,
      );
    }
    if (patch.profileEffect !== undefined) this.run('UPDATE users SET profile_effect = ? WHERE id = ?', patch.profileEffect, id);
    if (patch.avatarDecoration !== undefined) {
      this.run('UPDATE users SET avatar_decoration = ? WHERE id = ?', patch.avatarDecoration, id);
    }
    if (patch.nameplate !== undefined) this.run('UPDATE users SET nameplate = ? WHERE id = ?', patch.nameplate, id);
    return this.getUser(id);
  }

  /** Kullanıcının şu anki afişinin özeti (yoksa ya da kullanıcı yoksa null). */
  getBannerHash(userId: string): string | null {
    return this.one<{ h: string | null }>('SELECT banner_hash AS h FROM users WHERE id = ?', userId)?.h ?? null;
  }

  /** Afişi değiştirir ya da kaldırır (null); önceki özet diskten silinmek üzere döner. Kullanıcı yoksa null. */
  setBanner(userId: string, hash: string | null): { user: User; previous: string | null } | null {
    return this.tx(() => {
      const row = this.one<{ h: string | null }>('SELECT banner_hash AS h FROM users WHERE id = ?', userId);
      if (!row) return null;
      this.run('UPDATE users SET banner_hash = ? WHERE id = ?', hash, userId);
      return { user: this.getUser(userId)!, previous: row.h };
    });
  }

  /** Kullanıcının şu anki profil fotoğrafının özeti (yoksa ya da kullanıcı yoksa null). */
  getAvatarHash(userId: string): string | null {
    return this.one<{ h: string | null }>('SELECT avatar_hash AS h FROM users WHERE id = ?', userId)?.h ?? null;
  }

  /**
   * Profil fotoğrafını değiştirir ya da kaldırır (null); önceki özet diskten silinmek üzere döner.
   * Kullanıcı yoksa (bu arada silinmişse) null.
   */
  setAvatar(userId: string, hash: string | null): { user: User; previous: string | null } | null {
    return this.tx(() => {
      const row = this.one<{ h: string | null }>('SELECT avatar_hash AS h FROM users WHERE id = ?', userId);
      if (!row) return null;
      this.run('UPDATE users SET avatar_hash = ? WHERE id = ?', hash, userId);
      return { user: this.getUser(userId)!, previous: row.h };
    });
  }

  /** Kullanılan tüm profil fotoğrafı, afiş ve sunucu simgesi özetleri (artık dosyaların temizliği için) */
  avatarHashes(): Set<string> {
    return new Set(
      this.all<{ h: string }>(
        `SELECT avatar_hash AS h FROM users WHERE avatar_hash IS NOT NULL
         UNION SELECT banner_hash AS h FROM users WHERE banner_hash IS NOT NULL
         UNION SELECT icon_hash AS h FROM guilds WHERE icon_hash IS NOT NULL`,
      ).map((r) => r.h),
    );
  }

  /**
   * Davet kodunu kullanarak hesap oluşturur; kodu aynı işlemde tüketir. Yeni hesap yalnızca hesap davetiyle
   * açılır (sunucu daveti reddedilir). İlk kullanıcı (ya da yönetici davetiyle gelen) hesap yöneticisi olur, ana
   * sunucuya katılır ve oradaki yönetici rolünü alır; ana sunucu sahipsizse sahibi olur.
   */
  registerWithInvite(input: {
    code: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }): RegisterResult {
    return this.tx((): RegisterResult => {
      const check = this.checkInvite(input.code);
      if (!check.ok) return { ok: false, reason: 'invite', message: check.reason };
      if (this.getUserAuthByUsername(input.username)) {
        return { ok: false, reason: 'username', message: 'Bu kullanıcı adı alınmış.' };
      }
      const founder = check.invite.grants_admin === 1 || this.countUsers() === 0;
      // Sisteme yeni hesap yalnızca hesap daveti (hesap yöneticileri oluşturur) ile girer; sunucu davetleri,
      // kim oluşturmuş olursa olsun, yalnızca hesabı olanları sunucuya katar.
      if (check.invite.guild_id && !founder) {
        return {
          ok: false,
          reason: 'invite',
          message:
            'Bu davetle yalnızca Diskort hesabı olanlar sunucuya katılabilir. Hesap açmak için bir hesap yöneticisinden hesap daveti iste.',
        };
      }
      const id = nanoid(16);
      const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
      this.run(
        `INSERT INTO users (id, username, display_name, password_hash, avatar_color, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.username,
        input.displayName,
        input.passwordHash,
        color,
        founder ? 1 : 0,
        Date.now(),
      );
      let guildId = check.invite.guild_id;
      if (founder) {
        const primary = this.primaryGuildId();
        if (primary) {
          guildId = primary;
          this.run('UPDATE guilds SET owner_id = ? WHERE id = ? AND owner_id IS NULL', id, primary);
          const adminRole = this.one<{ id: string }>(
            `SELECT id FROM roles WHERE guild_id = ? AND (permissions & ${Permission.ADMINISTRATOR}) != 0
             ORDER BY position DESC LIMIT 1`,
            primary,
          );
          if (adminRole) this.run('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)', id, adminRole.id);
        }
      }
      if (guildId) this.insertMember(guildId, id);
      this.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', check.invite.code);
      this.recordInviteUse(check.invite, id, guildId, 'register');
      return { ok: true, user: this.getUser(id)!, guildId };
    });
  }

  /**
   * Var olan hesap davet koduyla sunucuya katılır (ya da ayrıldığı/atıldığı sunucuya geri döner). Yasaklı
   * hesap dönemez; roller geri gelmez (Discord'daki gibi). Zaten üyeyse davet tüketilmez.
   */
  joinWithInvite(code: string, userId: string): JoinResult {
    return this.tx((): JoinResult => {
      const check = this.checkInvite(code);
      if (!check.ok) return { ok: false, reason: 'invite', message: check.reason };
      const guildId = check.invite.guild_id;
      if (!guildId) {
        return { ok: false, reason: 'account_invite', message: 'Bu bir hesap daveti; bir sunucuya katılmak için sunucu daveti gerekli.' };
      }
      const status = this.memberStatus(guildId, userId);
      if (status === 'member') return { ok: true, guildId, alreadyMember: true };
      if (status === 'banned') return { ok: false, reason: 'banned', message: 'Bu sunucudan yasaklandın.' };
      if (this.userGuildIds(userId).length >= MAX_GUILDS_PER_USER) {
        return { ok: false, reason: 'too_many', message: `En fazla ${MAX_GUILDS_PER_USER} sunucuya üye olabilirsin.` };
      }
      this.insertMember(guildId, userId);
      this.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', check.invite.code);
      this.recordInviteUse(check.invite, userId, guildId, 'join');
      return { ok: true, guildId, alreadyMember: false };
    });
  }

  /** Davet kullanımı (yönetim paneli: kim kimi davet etti) */
  private recordInviteUse(invite: InviteRow, userId: string, guildId: string | null, kind: 'register' | 'join'): void {
    this.run(
      'INSERT INTO invite_uses (code, guild_id, inviter_id, user_id, kind, used_at) VALUES (?, ?, ?, ?, ?, ?)',
      invite.code,
      guildId,
      invite.created_by,
      userId,
      kind,
      Date.now(),
    );
  }

  /** Üyeliği ekler ya da eski üyeyi geri getirir (yasaklıysa dokunmaz) */
  private insertMember(guildId: string, userId: string): void {
    this.run(
      `INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET removed_at = NULL, joined_at = excluded.joined_at
       WHERE banned_at IS NULL AND removed_at IS NOT NULL`,
      guildId,
      userId,
      Date.now(),
    );
  }

  // ---------- Üyelikler ----------

  /** Hesabın sunucudaki durumu */
  memberStatus(guildId: string, userId: string): MembershipStatus {
    const row = this.one<{ removed_at: number | null; banned_at: number | null }>(
      'SELECT removed_at, banned_at FROM guild_members WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId,
    );
    if (!row) return 'none';
    if (row.removed_at === null) return 'member';
    return row.banned_at === null ? 'removed' : 'banned';
  }

  /** Kullanıcının üye olduğu sunucular, katılma sırasıyla */
  userGuildIds(userId: string): string[] {
    return this.all<{ id: string }>(
      'SELECT guild_id AS id FROM guild_members WHERE user_id = ? AND removed_at IS NULL ORDER BY joined_at, guild_id',
      userId,
    ).map((r) => r.id);
  }

  /** Sunucunun şu anki üyeleri */
  guildMemberIds(guildId: string): string[] {
    return [...(this.permissionData().guilds.get(guildId)?.members ?? [])];
  }

  /** Sunucunun üyeleri; eski üyeler (ayrılan, atılan, yasaklanan) `removed` olarak */
  listMembers(guildId: string): GuildMember[] {
    const data = this.permissionData().guilds.get(guildId);
    return this.all<MemberRow>('SELECT * FROM guild_members WHERE guild_id = ? ORDER BY joined_at, user_id', guildId).map(
      (r) => this.toMember(r, data),
    );
  }

  /** Üyelik kaydı (eski üye dahil); kaydı yoksa null */
  getMember(guildId: string, userId: string): GuildMember | null {
    const row = this.one<MemberRow>('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);
    return row ? this.toMember(row, this.permissionData().guilds.get(guildId)) : null;
  }

  private toMember(r: MemberRow, data: GuildPermissionData | undefined): GuildMember {
    const removed = r.removed_at !== null;
    return {
      userId: r.user_id,
      roles: removed ? [] : [...(data?.memberRoles.get(r.user_id) ?? [])],
      joinedAt: r.joined_at,
      removed,
    };
  }

  /** Sunucunun şu anki üye sayısı */
  memberCount(guildId: string): number {
    return this.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ? AND removed_at IS NULL',
      guildId,
    )!.n;
  }

  /**
   * Üyeyi sunucudan çıkarır (ayrılma ya da atma), `ban` verilirse yasaklar. Hesap ve mesajları kalır;
   * o sunucudaki rolleri silinir. Üye değilse (ve yasaklanmıyorsa) false.
   */
  removeMember(guildId: string, userId: string, ban: { reason: string | null } | null = null): boolean {
    const now = Date.now();
    return this.tx(() => {
      const status = this.memberStatus(guildId, userId);
      if (ban) {
        if (status === 'banned') return false;
        this.run(
          `INSERT INTO guild_members (guild_id, user_id, joined_at, removed_at, banned_at, ban_reason)
           VALUES (?1, ?2, ?3, ?3, ?3, ?4)
           ON CONFLICT (guild_id, user_id) DO UPDATE SET
             removed_at = COALESCE(removed_at, ?3), banned_at = ?3, ban_reason = ?4`,
          guildId,
          userId,
          now,
          ban.reason,
        );
      } else {
        if (status !== 'member') return false;
        this.run('UPDATE guild_members SET removed_at = ? WHERE guild_id = ? AND user_id = ?', now, guildId, userId);
      }
      this.run(
        'DELETE FROM member_roles WHERE user_id = ? AND role_id IN (SELECT id FROM roles WHERE guild_id = ?)',
        userId,
        guildId,
      );
      return true;
    });
  }

  /** Yasağı kaldırır: hesap yeni bir davetle geri dönebilir. */
  unban(guildId: string, userId: string): boolean {
    return (
      this.run(
        'UPDATE guild_members SET banned_at = NULL, ban_reason = NULL WHERE guild_id = ? AND user_id = ? AND banned_at IS NOT NULL',
        guildId,
        userId,
      ) > 0
    );
  }

  listBans(guildId: string): BanRow[] {
    return this.all<UserRow & { ban_reason: string | null; banned_at: number }>(
      `SELECT u.*, m.ban_reason, m.banned_at FROM guild_members m JOIN users u ON u.id = m.user_id
       WHERE m.guild_id = ? AND m.banned_at IS NOT NULL ORDER BY m.banned_at DESC`,
      guildId,
    ).map((r) => ({ user: this.toUser(r), reason: r.ban_reason, bannedAt: r.banned_at }));
  }

  /** Sunucu tarafı susturma/sağırlaştırma (o sunucuda kalıcı: kanaldan çıkıp girince de sürer) */
  setServerVoiceFlags(guildId: string, userId: string, flags: { serverMute: boolean; serverDeaf: boolean }): void {
    this.run(
      'UPDATE guild_members SET server_mute = ?, server_deaf = ? WHERE guild_id = ? AND user_id = ?',
      flags.serverMute ? 1 : 0,
      flags.serverDeaf ? 1 : 0,
      guildId,
      userId,
    );
  }

  serverVoiceFlags(guildId: string, userId: string): { serverMute: boolean; serverDeaf: boolean } {
    const row = this.one<{ server_mute: number; server_deaf: number }>(
      'SELECT server_mute, server_deaf FROM guild_members WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId,
    );
    return { serverMute: row?.server_mute === 1, serverDeaf: row?.server_deaf === 1 };
  }

  // ---------- Roller ve yetkiler ----------

  /** Yetki hesaplaması için sunucular, roller, üyelikler, kanal izinleri ve DM'ler (önbellekli). */
  permissionData(): PermissionData {
    if (this.permissionCache) return this.permissionCache;
    type MutableGuild = {
      guildId: string;
      ownerId: string | null;
      roles: Record<string, Role>;
      memberRoles: Map<string, string[]>;
      members: Set<string>;
      channels: Map<string, Channel>;
    };
    const guilds = new Map<string, MutableGuild>();
    for (const g of this.all<{ id: string; owner_id: string | null }>(
      'SELECT id, owner_id FROM guilds ORDER BY created_at, rowid',
    )) {
      guilds.set(g.id, {
        guildId: g.id,
        ownerId: g.owner_id,
        roles: {},
        memberRoles: new Map(),
        members: new Set(),
        channels: new Map(),
      });
    }
    for (const r of this.all<RoleRow>('SELECT * FROM roles')) {
      const g = guilds.get(r.guild_id);
      if (g) g.roles[r.id] = toRole(r);
    }
    for (const r of this.all<{ user_id: string; role_id: string; guild_id: string }>(
      `SELECT mr.user_id, mr.role_id, r.guild_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id
       ORDER BY r.position DESC`,
    )) {
      const g = guilds.get(r.guild_id);
      if (!g) continue;
      const list = g.memberRoles.get(r.user_id) ?? [];
      list.push(r.role_id);
      g.memberRoles.set(r.user_id, list);
    }
    const userGuilds = new Map<string, Set<string>>();
    for (const r of this.all<{ guild_id: string; user_id: string }>(
      'SELECT guild_id, user_id FROM guild_members WHERE removed_at IS NULL ORDER BY joined_at, guild_id',
    )) {
      const g = guilds.get(r.guild_id);
      if (!g) continue;
      g.members.add(r.user_id);
      let set = userGuilds.get(r.user_id);
      if (!set) userGuilds.set(r.user_id, (set = new Set()));
      set.add(r.guild_id);
    }
    const overwrites = new Map<string, PermissionOverwrite[]>();
    for (const r of this.all<{ channel_id: string; role_id: string; allow: number; deny: number }>(
      `SELECT o.channel_id, o.role_id, o.allow, o.deny FROM channel_overwrites o
       JOIN roles r ON r.id = o.role_id ORDER BY r.position`,
    )) {
      const list = overwrites.get(r.channel_id) ?? [];
      list.push({ roleId: r.role_id, allow: r.allow, deny: r.deny });
      overwrites.set(r.channel_id, list);
    }
    const channelGuild = new Map<string, string>();
    for (const r of this.all<ChannelRow>(
      "SELECT * FROM channels WHERE type != 'dm' ORDER BY position, created_at",
    )) {
      const g = guilds.get(r.guild_id);
      if (!g) continue;
      g.channels.set(r.id, toChannel(r, overwrites.get(r.id)));
      channelGuild.set(r.id, r.guild_id);
    }
    const dms = new Map<string, { participantIds: string[]; group: boolean }>();
    for (const r of this.all<{ id: string; pair_key: string | null }>(
      'SELECT channel_id AS id, pair_key FROM dm_channels',
    )) {
      dms.set(r.id, { participantIds: [], group: r.pair_key === null });
    }
    for (const r of this.all<{ channel_id: string; user_id: string }>(
      'SELECT channel_id, user_id FROM dm_participants ORDER BY joined_at, user_id',
    )) {
      dms.get(r.channel_id)?.participantIds.push(r.user_id);
    }
    const blocks = new Set<string>();
    for (const r of this.all<{ blocker_id: string; blocked_id: string }>('SELECT blocker_id, blocked_id FROM user_blocks')) {
      blocks.add(blockKey(r.blocker_id, r.blocked_id));
    }
    const friends = new Map<string, Set<string>>();
    const befriend = (a: string, b: string): void => {
      let set = friends.get(a);
      if (!set) friends.set(a, (set = new Set()));
      set.add(b);
    };
    for (const r of this.all<{ user_a: string; user_b: string }>('SELECT user_a, user_b FROM friendships')) {
      befriend(r.user_a, r.user_b);
      befriend(r.user_b, r.user_a);
    }
    const data: PermissionData = {
      guilds,
      channelGuild,
      userGuilds,
      dms,
      blocks,
      friends,
      primaryGuildId: guilds.keys().next().value ?? null,
    };
    this.permissionCache = data;
    return data;
  }

  getRole(id: string): (Role & { guildId: string }) | null {
    const row = this.one<RoleRow>('SELECT * FROM roles WHERE id = ?', id);
    return row ? { ...toRole(row), guildId: row.guild_id } : null;
  }

  /** Sunucunun rolleri (@everyone dahil) */
  guildRoles(guildId: string): Role[] {
    return Object.values(this.permissionData().guilds.get(guildId)?.roles ?? {});
  }

  /** Yeni rol en alta (@everyone'ın hemen üstüne) eklenir; diğerleri bir sıra yukarı kayar. */
  createRole(guildId: string, input: { name: string; color: string | null; hoist: boolean; permissions: number }): Role {
    const id = nanoid(12);
    this.tx(() => {
      this.run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', guildId);
      this.run(
        `INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        id,
        guildId,
        input.name,
        input.color,
        input.hoist ? 1 : 0,
        input.permissions & ALL_PERMISSIONS,
        Date.now(),
      );
    });
    return this.plainRole(id)!;
  }

  private plainRole(id: string): Role | null {
    const row = this.one<RoleRow>('SELECT * FROM roles WHERE id = ?', id);
    return row ? toRole(row) : null;
  }

  updateRole(
    id: string,
    patch: { name?: string; color?: string | null; hoist?: boolean; permissions?: number },
  ): Role | null {
    this.tx(() => {
      if (patch.name !== undefined) this.run('UPDATE roles SET name = ? WHERE id = ?', patch.name, id);
      if (patch.color !== undefined) this.run('UPDATE roles SET color = ? WHERE id = ?', patch.color, id);
      if (patch.hoist !== undefined) this.run('UPDATE roles SET hoist = ? WHERE id = ?', patch.hoist ? 1 : 0, id);
      if (patch.permissions !== undefined) {
        this.run('UPDATE roles SET permissions = ? WHERE id = ?', patch.permissions & ALL_PERMISSIONS, id);
      }
    });
    return this.plainRole(id);
  }

  /** Rolü siler (@everyone silinemez); kalan rollerin sırası boşluksuz yeniden numaralanır. */
  deleteRole(guildId: string, id: string): boolean {
    if (id === guildId) return false;
    return this.tx(() => {
      if (this.run('DELETE FROM roles WHERE id = ? AND guild_id = ?', id, guildId) === 0) return false;
      const rest = this.all<{ id: string }>(
        'SELECT id FROM roles WHERE guild_id = ? AND id != ? ORDER BY position DESC',
        guildId,
        guildId,
      );
      rest.forEach((r, i) => this.run('UPDATE roles SET position = ? WHERE id = ?', rest.length - i, r.id));
      return true;
    });
  }

  /** Rollerin yeni sırası: `roleIds` yukarıdan aşağı, @everyone hariç sunucunun tüm rolleri. */
  setRoleOrder(guildId: string, roleIds: string[]): void {
    this.tx(() => {
      roleIds.forEach((id, i) =>
        this.run('UPDATE roles SET position = ? WHERE id = ? AND guild_id = ?', roleIds.length - i, id, guildId),
      );
    });
  }

  /** Üyeye rol verir; zaten varsa false. */
  addMemberRole(userId: string, roleId: string): boolean {
    return this.tx(() => {
      const added = this.run('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)', userId, roleId) > 0;
      return added;
    });
  }

  /** Üyeden rolü alır; yoksa false. */
  removeMemberRole(userId: string, roleId: string): boolean {
    return this.tx(() => {
      const removed = this.run('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?', userId, roleId) > 0;
      return removed;
    });
  }

  /** Kanalın tüm rol izinlerini verilenlerle değiştirir (boş izinler kaydedilmez). */
  setChannelOverwrites(channelId: string, overwrites: PermissionOverwrite[]): Channel | null {
    this.tx(() => {
      this.run('DELETE FROM channel_overwrites WHERE channel_id = ?', channelId);
      for (const o of overwrites) {
        if (o.allow === 0 && o.deny === 0) continue;
        this.run(
          'INSERT INTO channel_overwrites (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)',
          channelId,
          o.roleId,
          o.allow,
          o.deny,
        );
      }
    });
    return this.getChannel(channelId);
  }

  private overwritesByChannel(guildId: string): Map<string, PermissionOverwrite[]> {
    const map = new Map<string, PermissionOverwrite[]>();
    for (const r of this.all<{ channel_id: string; role_id: string; allow: number; deny: number }>(
      `SELECT o.channel_id, o.role_id, o.allow, o.deny FROM channel_overwrites o
       JOIN channels c ON c.id = o.channel_id JOIN roles r ON r.id = o.role_id
       WHERE c.guild_id = ? ORDER BY r.position`,
      guildId,
    )) {
      const list = map.get(r.channel_id) ?? [];
      list.push({ roleId: r.role_id, allow: r.allow, deny: r.deny });
      map.set(r.channel_id, list);
    }
    return map;
  }

  // ---------- Davetler ----------

  /** `guildId` null: yalnızca hesap açtıran davet (hesap yöneticileri oluşturur) */
  createInvite(opts: {
    guildId: string | null;
    createdBy: string | null;
    maxUses: number | null;
    expiresAt: number | null;
    grantsAdmin?: boolean;
  }): Invite {
    const code = inviteCode();
    this.run(
      `INSERT INTO invites (code, guild_id, created_by, max_uses, uses, expires_at, created_at, grants_admin)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      code,
      opts.guildId,
      opts.createdBy,
      opts.maxUses,
      opts.expiresAt,
      Date.now(),
      opts.grantsAdmin ? 1 : 0,
    );
    return this.getInvite(code)!;
  }

  getInvite(code: string): Invite | null {
    const row = this.one<InviteRow>('SELECT * FROM invites WHERE code = ?', code.trim().toUpperCase());
    return row ? toInvite(row) : null;
  }

  /** Sunucunun davetleri; `createdBy` verilirse yalnızca onun oluşturdukları */
  listInvites(guildId: string, createdBy?: string): Invite[] {
    return (
      createdBy === undefined
        ? this.all<InviteRow>('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC', guildId)
        : this.all<InviteRow>(
            'SELECT * FROM invites WHERE guild_id = ? AND created_by = ? ORDER BY created_at DESC',
            guildId,
            createdBy,
          )
    ).map(toInvite);
  }

  /** Yalnızca hesap açtıran davetler (başlangıç daveti hariç) */
  listAccountInvites(): Invite[] {
    return this.all<InviteRow>(
      'SELECT * FROM invites WHERE guild_id IS NULL AND grants_admin = 0 ORDER BY created_at DESC',
    ).map(toInvite);
  }

  deleteInvite(code: string): boolean {
    return this.run('DELETE FROM invites WHERE code = ?', code.trim().toUpperCase()) > 0;
  }

  checkInvite(code: string): InviteCheck {
    const row = this.one<InviteRow>('SELECT * FROM invites WHERE code = ?', code.trim().toUpperCase());
    if (!row) return { ok: false, reason: 'Davet kodu geçersiz.' };
    if (row.expires_at !== null && row.expires_at < Date.now()) {
      return { ok: false, reason: 'Davet kodunun süresi dolmuş.' };
    }
    if (row.max_uses !== null && row.uses >= row.max_uses) {
      return { ok: false, reason: 'Davet kodunun kullanım hakkı dolmuş.' };
    }
    return { ok: true, invite: row };
  }

  /** Hiç kullanıcı yoksa ilk yöneticinin kaydolabilmesi için tek kullanımlık davet döner. */
  ensureBootstrapInvite(): Invite | null {
    if (this.countUsers() > 0) return null;
    const existing = this.one<InviteRow>(
      'SELECT * FROM invites WHERE grants_admin = 1 AND uses = 0 ORDER BY created_at DESC LIMIT 1',
    );
    if (existing) return toInvite(existing);
    return this.createInvite({ guildId: null, createdBy: null, maxUses: 1, expiresAt: null, grantsAdmin: true });
  }

  // ---------- Sunucular (guild) ve kanallar ----------

  /** Ana sunucu: ilk kurulan (hesap açtıran ilk kişi ve yönetici davetleri buraya katılır) */
  primaryGuildId(): string | null {
    return this.one<{ id: string }>('SELECT id FROM guilds ORDER BY created_at, rowid LIMIT 1')?.id ?? null;
  }

  /**
   * İlk açılışta ana sunucuyu, kanallarını ve rollerini (@everyone, Yönetici) oluşturur; varsa onu döner.
   */
  ensureGuild(name: string): Guild {
    const primary = this.primaryGuildId();
    if (primary) {
      this.ensureRoles(primary, true);
      return this.getGuild(primary)!;
    }
    const id = nanoid(12);
    this.tx(() => {
      this.run('INSERT INTO guilds (id, name, created_at) VALUES (?, ?, ?)', id, name, Date.now());
      this.ensureRoles(id, true);
      const defaults: [string, ChannelType][] = [
        ['genel-sohbet', 'text'],
        ['Genel', 'voice'],
        ['Oyun', 'voice'],
        ['Müzik', 'voice'],
      ];
      defaults.forEach(([channelName, type], i) => this.insertChannel(id, channelName, type, i));
    });
    return this.getGuild(id)!;
  }

  /**
   * Kullanıcının kurduğu yeni sunucu: sahibi üyesidir; @everyone rolü ile bir metin ve bir ses kanalı
   * oluşturulur.
   */
  createGuild(ownerId: string, name: string): Guild {
    const id = nanoid(12);
    this.tx(() => {
      // Aynı milisaniyede kurulan sunucuların sırası belli olsun (ana sunucu hep ilk kalır)
      const last = this.one<{ t: number }>('SELECT COALESCE(MAX(created_at), 0) AS t FROM guilds')!.t;
      this.run(
        'INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)',
        id,
        name,
        ownerId,
        Math.max(Date.now(), last + 1),
      );
      this.ensureRoles(id, false);
      NEW_GUILD_CHANNELS.forEach(([channelName, type], i) => this.insertChannel(id, channelName, type, i));
      this.insertMember(id, ownerId);
    });
    return this.getGuild(id)!;
  }

  /** Kullanıcının sahibi olduğu sunucular */
  ownedGuildIds(userId: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM guilds WHERE owner_id = ? ORDER BY created_at', userId).map(
      (r) => r.id,
    );
  }

  /** @everyone yoksa oluşturur; `withAdmin` ise ve başka rol yoksa yönetici rolünü de (ana sunucu). */
  private ensureRoles(guildId: string, withAdmin: boolean): void {
    if (this.one('SELECT 1 FROM roles WHERE id = ?', guildId)) return;
    const now = Date.now();
    this.run(
      `INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at)
       VALUES (?, ?, '@everyone', NULL, 0, 0, ?, ?)`,
      guildId,
      guildId,
      DEFAULT_EVERYONE_PERMISSIONS,
      now,
    );
    if (!withAdmin || this.one('SELECT 1 FROM roles WHERE guild_id = ? AND id != ?', guildId, guildId)) return;
    this.run(
      `INSERT INTO roles (id, guild_id, name, color, position, hoist, permissions, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      nanoid(12),
      guildId,
      ADMIN_ROLE_NAME,
      ADMIN_ROLE_COLOR,
      Permission.ADMINISTRATOR,
      now,
    );
  }

  getGuild(id: string): Guild | null {
    const row = this.one<GuildRow>('SELECT * FROM guilds WHERE id = ?', id);
    return row ? toGuild(row) : null;
  }

  updateGuild(id: string, patch: { name?: string; ownerId?: string }): Guild | null {
    this.tx(() => {
      if (patch.name !== undefined) this.run('UPDATE guilds SET name = ? WHERE id = ?', patch.name, id);
      if (patch.ownerId !== undefined) this.run('UPDATE guilds SET owner_id = ? WHERE id = ?', patch.ownerId, id);
    });
    return this.getGuild(id);
  }

  /** Sunucu simgesinin özeti (yoksa null) */
  getGuildIconHash(guildId: string): string | null {
    return this.one<{ h: string | null }>('SELECT icon_hash AS h FROM guilds WHERE id = ?', guildId)?.h ?? null;
  }

  /** Simgeyi değiştirir ya da kaldırır (null); önceki özet diskten silinmek üzere döner. Sunucu yoksa null. */
  setGuildIcon(guildId: string, hash: string | null): { guild: Guild; previous: string | null } | null {
    return this.tx(() => {
      const row = this.one<{ h: string | null }>('SELECT icon_hash AS h FROM guilds WHERE id = ?', guildId);
      if (!row) return null;
      this.run('UPDATE guilds SET icon_hash = ? WHERE id = ?', hash, guildId);
      return { guild: this.getGuild(guildId)!, previous: row.h };
    });
  }

  /**
   * Sunucuyu kanalları, mesajları, rolleri, üyelikleri ve davetleriyle siler. Diskten silinecek dosya
   * eklerinin kimlikleri ve simgenin özeti döner.
   */
  deleteGuild(guildId: string): { files: string[]; icon: string | null } | null {
    return this.tx(() => {
      const icon = this.getGuildIconHash(guildId);
      if (!this.one('SELECT 1 FROM guilds WHERE id = ?', guildId)) return null;
      const files = this.all<{ id: string }>(
        'SELECT a.id FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.guild_id = ?',
        guildId,
      ).map((r) => r.id);
      this.run('DELETE FROM guilds WHERE id = ?', guildId);
      return { files, icon };
    });
  }

  listChannels(guildId: string): Channel[] {
    const overwrites = this.overwritesByChannel(guildId);
    return this.all<ChannelRow>(
      'SELECT * FROM channels WHERE guild_id = ? ORDER BY position, created_at',
      guildId,
    ).map((r) => toChannel(r, overwrites.get(r.id)));
  }

  /** Sunucunun kanalı; DM'ler burada yoktur (bkz. getDm), kanal yönetimi onlara hiç ulaşamaz. */
  getChannel(id: string): Channel | null {
    const row = this.one<ChannelRow>("SELECT * FROM channels WHERE id = ? AND type != 'dm'", id);
    if (!row) return null;
    const overwrites = this.all<{ role_id: string; allow: number; deny: number }>(
      `SELECT o.role_id, o.allow, o.deny FROM channel_overwrites o JOIN roles r ON r.id = o.role_id
       WHERE o.channel_id = ? ORDER BY r.position`,
      id,
    ).map((o) => ({ roleId: o.role_id, allow: o.allow, deny: o.deny }));
    return toChannel(row, overwrites);
  }

  private insertChannel(guildId: string, name: string, type: ChannelType, position: number): string {
    const id = nanoid(12);
    this.run(
      'INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      guildId,
      name,
      type,
      position,
      Date.now(),
    );
    return id;
  }

  createChannel(guildId: string, name: string, type: ChannelType): Channel {
    const max = this.one<{ p: number }>(
      'SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE guild_id = ?',
      guildId,
    )!;
    return this.getChannel(this.insertChannel(guildId, name, type, max.p + 1))!;
  }

  updateChannel(id: string, patch: { name?: string; position?: number }): Channel | null {
    if (patch.name !== undefined) this.run('UPDATE channels SET name = ? WHERE id = ?', patch.name, id);
    if (patch.position !== undefined) this.run('UPDATE channels SET position = ? WHERE id = ?', patch.position, id);
    return this.getChannel(id);
  }

  /** Sunucunun kanallarını verilen sıraya göre 0'dan başlayarak yeniden numaralar. */
  setChannelOrder(guildId: string, channelIds: readonly string[]): void {
    this.tx(() => {
      channelIds.forEach((id, i) =>
        this.run("UPDATE channels SET position = ? WHERE id = ? AND guild_id = ? AND type != 'dm'", i, id, guildId),
      );
    });
  }

  deleteChannel(id: string): boolean {
    return this.run("DELETE FROM channels WHERE id = ? AND type != 'dm'", id) > 0;
  }

  // ---------- Direkt mesajlar ----------
  // Yetki burada denetlenmez: çağıran (routes/dms.ts, routes/messages.ts) kişinin katılımcı olduğuna bakar.

  private toDm(r: DmRow, participantIds: string[]): DmChannel {
    const group = r.pair_key === null;
    const dm: DmChannel = {
      id: r.id,
      participantIds,
      group,
      name: group && r.name ? r.name : null,
      ownerId: group ? r.owner_id : null,
      createdAt: r.created_at,
      lastMessageId: r.last_id === null ? null : String(r.last_id),
      lastActivityAt: r.last_at ?? r.created_at,
    };
    // Bire bir konuşmada iki yönden biri engellediyse salt okunur (yön söylenmez); alan yalnızca true iken
    if (!group && participantIds.length === 2 && this.blockedEither(participantIds[0]!, participantIds[1]!)) {
      dm.readOnly = true;
    }
    return dm;
  }

  /** Konuşmaların katılımcıları, katılma sırasıyla */
  private participantsByDm(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return map;
    for (const r of this.all<{ channel_id: string; user_id: string }>(
      `SELECT channel_id, user_id FROM dm_participants WHERE channel_id IN (${ids.map(() => '?').join(',')})
       ORDER BY joined_at, user_id`,
      ...ids,
    )) {
      map.get(r.channel_id)?.push(r.user_id);
    }
    return map;
  }

  getDm(id: string): DmChannel | null {
    const row = this.one<DmRow>(`${DM_SELECT} WHERE c.id = ?`, id);
    return row ? this.toDm(row, this.participantsByDm([id]).get(id)!) : null;
  }

  isDm(id: string): boolean {
    return this.one('SELECT 1 FROM dm_channels WHERE channel_id = ?', id) !== undefined;
  }

  /** Kullanıcının listesinde açık konuşmaları */
  listDms(userId: string): DmChannel[] {
    const rows = this.all<DmRow>(
      `${DM_SELECT} JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = ? AND p.open = 1`,
      userId,
    );
    const participants = this.participantsByDm(rows.map((r) => r.id));
    return rows.map((r) => this.toDm(r, participants.get(r.id)!));
  }

  /** Kullanıcının katıldığı tüm konuşmaların kimlikleri (listesinde kapalı olanlar dahil) */
  dmIdsOf(userId: string): string[] {
    return this.all<{ id: string }>('SELECT channel_id AS id FROM dm_participants WHERE user_id = ?', userId).map(
      (r) => r.id,
    );
  }

  /** İki kişi arasındaki bire bir konuşmanın kimliği (yoksa null) */
  directDmId(a: string, b: string): string | null {
    return this.one<{ id: string }>('SELECT channel_id AS id FROM dm_channels WHERE pair_key = ?', pairKey(a, b))?.id ?? null;
  }

  /**
   * İki kişi arasındaki bire bir konuşmayı bulur, yoksa oluşturur. Konuşma açan kişinin listesinde açılır;
   * karşı tarafın listesinde ilk mesaj gelince görünür (boş konuşma kimseyi rahatsız etmesin).
   * `opened`: konuşma açan kişinin listesine yeni girdi (yeni ya da önceden kapatılmıştı).
   */
  openDirectDm(userId: string, otherId: string): { dm: DmChannel; created: boolean; opened: boolean } {
    return this.tx(() => {
      const existing = this.directDmId(userId, otherId);
      if (existing) {
        // Hesap silinip yeniden kurulamayacağından kişi hâlâ katılımcıdır; yine de satır yoksa eklenir
        const opened =
          this.run(
            `INSERT INTO dm_participants (channel_id, user_id, joined_at, open) VALUES (?, ?, ?, 1)
             ON CONFLICT (channel_id, user_id) DO UPDATE SET open = 1 WHERE open = 0`,
            existing,
            userId,
            Date.now(),
          ) > 0;
        return { dm: this.getDm(existing)!, created: false, opened };
      }
      const id = this.insertDm(pairKey(userId, otherId), null, null);
      const now = Date.now();
      this.addParticipant(id, userId, now, true);
      this.addParticipant(id, otherId, now, false);
      return { dm: this.getDm(id)!, created: true, opened: true };
    });
  }

  /** Yeni grup konuşması; herkesin listesinde hemen görünür. */
  createGroupDm(ownerId: string, otherIds: string[], name: string | null): DmChannel {
    return this.tx(() => {
      const id = this.insertDm(null, ownerId, name);
      const now = Date.now();
      // Katılma sırası seçilme sırasıdır (sahiplik bu sırayla devredilir): aynı ana birer ms aralıkla
      this.addParticipant(id, ownerId, now, true);
      otherIds.forEach((userId, i) => this.addParticipant(id, userId, now + i + 1, true));
      return this.getDm(id)!;
    });
  }

  private insertDm(key: string | null, ownerId: string | null, name: string | null): string {
    const id = nanoid(12);
    this.run(
      "INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES (?, NULL, ?, 'dm', 0, ?)",
      id,
      name ?? '',
      Date.now(),
    );
    this.run('INSERT INTO dm_channels (channel_id, pair_key, owner_id) VALUES (?, ?, ?)', id, key, ownerId);
    return id;
  }

  private addParticipant(channelId: string, userId: string, joinedAt: number, open: boolean): boolean {
    return (
      this.run(
        'INSERT OR IGNORE INTO dm_participants (channel_id, user_id, joined_at, open) VALUES (?, ?, ?, ?)',
        channelId,
        userId,
        joinedAt,
        open ? 1 : 0,
      ) > 0
    );
  }

  /** Gruba katılımcı ekler (listesinde hemen açılır); zaten katılımcıysa false. */
  addDmParticipant(channelId: string, userId: string): boolean {
    return this.addParticipant(channelId, userId, Date.now(), true);
  }

  /** Konuşmayı kullanıcının listesinden kaldırır (bire bir konuşmada "kapat"); değiştiyse true. */
  closeDm(channelId: string, userId: string): boolean {
    return (
      this.run('UPDATE dm_participants SET open = 0 WHERE channel_id = ? AND user_id = ? AND open = 1', channelId, userId) >
      0
    );
  }

  /** Yeni mesaj geldiğinde: konuşmayı kapatmış katılımcıların listesinde yeniden açar; açılanları döner. */
  reopenDm(channelId: string): string[] {
    return this.tx(() => {
      const closed = this.all<{ user_id: string }>(
        'SELECT user_id FROM dm_participants WHERE channel_id = ? AND open = 0',
        channelId,
      ).map((r) => r.user_id);
      if (closed.length > 0) this.run('UPDATE dm_participants SET open = 1 WHERE channel_id = ? AND open = 0', channelId);
      return closed;
    });
  }

  renameDm(channelId: string, name: string | null): DmChannel | null {
    this.run("UPDATE channels SET name = ? WHERE id = ? AND type = 'dm'", name ?? '', channelId);
    return this.getDm(channelId);
  }

  /**
   * Katılımcı gruptan ayrılır; sahipse sahiplik sıradaki katılımcıya geçer. Kimse kalmazsa konuşma
   * silinir: diskten silinecek dosyalar döner.
   */
  leaveDm(channelId: string, userId: string): { deleted: boolean; files: string[] } {
    return this.tx(() => {
      this.run('DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?', channelId, userId);
      this.fixDmOwner(channelId);
      const files = this.deleteEmptyDms();
      return { deleted: !this.isDm(channelId), files };
    });
  }

  /** Grubun sahibi artık katılımcı değilse sahiplik en eski katılımcıya geçer. */
  private fixDmOwner(channelId: string): void {
    this.run(
      `UPDATE dm_channels SET owner_id = (
         SELECT user_id FROM dm_participants WHERE channel_id = ?1 ORDER BY joined_at, user_id LIMIT 1)
       WHERE channel_id = ?1 AND pair_key IS NULL AND (owner_id IS NULL OR owner_id NOT IN (
         SELECT user_id FROM dm_participants WHERE channel_id = ?1))`,
      channelId,
    );
  }

  /**
   * Hesap silindikten sonra: grupların sahipliğini düzeltir, katılımcısı kalmayan konuşmaları siler.
   * Diskten silinecek dosyalar döner.
   */
  cleanupDms(channelIds: string[]): string[] {
    return this.tx(() => {
      for (const id of channelIds) this.fixDmOwner(id);
      return this.deleteEmptyDms();
    });
  }

  private deleteEmptyDms(): string[] {
    const empty = this.all<{ id: string }>(
      `SELECT channel_id AS id FROM dm_channels d
       WHERE NOT EXISTS (SELECT 1 FROM dm_participants p WHERE p.channel_id = d.channel_id)`,
    ).map((r) => r.id);
    const files: string[] = [];
    for (const id of empty) {
      files.push(...this.channelAttachmentIds(id));
      this.run("DELETE FROM channels WHERE id = ? AND type = 'dm'", id);
    }
    return files;
  }

  /** Konuşmayı listesinde açık tutan katılımcılar (bire bir konuşmayı kapatan, yeni mesaja kadar görmez) */
  openDmParticipants(channelId: string): string[] {
    return this.all<{ user_id: string }>(
      'SELECT user_id FROM dm_participants WHERE channel_id = ? AND open = 1 ORDER BY joined_at, user_id',
      channelId,
    ).map((r) => r.user_id);
  }

  // ---------- Engellemeler ----------
  // Engel tek yönlüdür (blocker → blocked) ama etkisi iki yönlüdür: bire bir konuşma iki taraf için de salt
  // okunur olur, yeni bire bir konuşma açılamaz, arama yapılamaz (bkz. dmPermissions). Kimin kimi engellediğini
  // yalnızca engelleyen görür.

  /** `blocker`, `blocked`'ı engelledi mi */
  hasBlocked(blocker: string, blocked: string): boolean {
    return this.one('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blocker, blocked) !== undefined;
  }

  /** İki kişiden biri diğerini engelledi mi (yönü fark etmez) */
  blockedEither(a: string, b: string): boolean {
    return (
      this.one(
        'SELECT 1 FROM user_blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)',
        a,
        b,
      ) !== undefined
    );
  }

  /** Kullanıcının engelledikleri, en son engellenen önce */
  listBlocks(userId: string): UserBlock[] {
    const rows = this.all<{ blocked_id: string; created_at: number }>(
      'SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC, blocked_id',
      userId,
    );
    const users = new Map(this.usersByIds(rows.map((r) => r.blocked_id)).map((u) => [u.id, u]));
    return rows.map((r) => ({ userId: r.blocked_id, createdAt: r.created_at, user: users.get(r.blocked_id) ?? null }));
  }

  /** Kullanıcının engellediklerinin kimlikleri */
  blockedUserIds(userId: string): string[] {
    return this.all<{ id: string }>(
      'SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC, blocked_id',
      userId,
    ).map((r) => r.id);
  }

  /**
   * Engeller; zaten engelliyse false (tekrarlanabilir). İkisinin arkadaşlığı ve iki yöndeki bekleyen
   * istekleri de kaldırılır (bkz. clearFriendship).
   */
  block(blocker: string, blocked: string, now = Date.now()): boolean {
    return this.tx(() => {
      const added =
        this.run(
          'INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
          blocker,
          blocked,
          now,
        ) > 0;
      this.clearFriendship(blocker, blocked);
      return added;
    });
  }

  /** Engeli kaldırır; engelli değilse false */
  unblock(blocker: string, blocked: string): boolean {
    return this.run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blocker, blocked) > 0;
  }

  // ---------- Arkadaşlar ----------
  // Arkadaşlık iki yönlüdür (çift başına tek satır, user_a < user_b). İstek yönlüdür; iki yönde aynı anda
  // bekleyen istek olmaz: karşı yönde istek varken gönderilen istek kabul sayılır. Engel kontrolü burada
  // değil, çağıranda (routes/friends.ts); engellemek ise arkadaşlığı ve istekleri kaldırır (bkz. block).

  /** İki kişi arkadaş mı */
  areFriends(a: string, b: string): boolean {
    if (a === b) return false;
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.one('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?', x, y) !== undefined;
  }

  /** `from`, `to`'ya istek gönderdi ve istek bekliyor mu */
  hasFriendRequest(from: string, to: string): boolean {
    return this.one('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', from, to) !== undefined;
  }

  /** Kullanıcının arkadaşlarının kimlikleri */
  friendIds(userId: string): string[] {
    return this.all<{ id: string }>(
      `SELECT user_b AS id FROM friendships WHERE user_a = ?1
       UNION SELECT user_a AS id FROM friendships WHERE user_b = ?1`,
      userId,
    ).map((r) => r.id);
  }

  /** Arkadaşları ve bekleyen isteklerdeki (gelen ya da giden) kişiler */
  friendCounterpartIds(userId: string): string[] {
    return this.all<{ id: string }>(
      `SELECT to_id AS id FROM friend_requests WHERE from_id = ?1
       UNION SELECT from_id AS id FROM friend_requests WHERE to_id = ?1`,
      userId,
    )
      .map((r) => r.id)
      .concat(this.friendIds(userId));
  }

  /** Yanıt bekleyen giden isteklerin sayısı */
  outgoingFriendRequestCount(userId: string): number {
    return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?', userId)!.n;
  }

  /** Arkadaşlar (görünen ada göre) ve bekleyen istekler (en yeni önce), profilleriyle */
  listFriends(userId: string): FriendsList {
    const friends = this.all<{ id: string; created_at: number }>(
      `SELECT user_b AS id, created_at FROM friendships WHERE user_a = ?1
       UNION ALL SELECT user_a AS id, created_at FROM friendships WHERE user_b = ?1`,
      userId,
    );
    const incoming = this.all<{ id: string; created_at: number }>(
      'SELECT from_id AS id, created_at FROM friend_requests WHERE to_id = ? ORDER BY created_at DESC, from_id',
      userId,
    );
    const outgoing = this.all<{ id: string; created_at: number }>(
      'SELECT to_id AS id, created_at FROM friend_requests WHERE from_id = ? ORDER BY created_at DESC, to_id',
      userId,
    );
    const users = new Map(this.usersByIds([...friends, ...incoming, ...outgoing].map((r) => r.id)).map((u) => [u.id, u]));
    const entries = (rows: { id: string; created_at: number }[]): FriendEntry[] =>
      rows.flatMap((r) => {
        const user = users.get(r.id);
        return user ? [{ userId: r.id, createdAt: r.created_at, user }] : [];
      });
    return {
      friends: entries(friends).sort(
        (a, b) => a.user.displayName.localeCompare(b.user.displayName, 'tr') || a.userId.localeCompare(b.userId),
      ),
      incoming: entries(incoming),
      outgoing: entries(outgoing),
    };
  }

  /**
   * `from`, `to`'ya arkadaşlık isteği gönderir. Zaten arkadaşlarsa 'friends' (değişiklik yok); `to`'nun
   * `from`'a bekleyen isteği varsa kabul edilir: 'accepted'; yoksa istek eklenir: 'requested' (zaten
   * bekliyorsa 'pending', değişiklik yok).
   */
  sendFriendRequest(from: string, to: string, now = Date.now()): 'friends' | 'accepted' | 'requested' | 'pending' {
    return this.tx(() => {
      if (this.areFriends(from, to)) return 'friends';
      if (this.hasFriendRequest(to, from)) {
        this.acceptFriendRequest(from, to, now);
        return 'accepted';
      }
      return this.run(
        'INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)',
        from,
        to,
        now,
      ) > 0
        ? 'requested'
        : 'pending';
    });
  }

  /** `userId`, `fromId`'nin isteğini kabul eder; bekleyen istek yoksa false */
  acceptFriendRequest(userId: string, fromId: string, now = Date.now()): boolean {
    return this.tx(() => {
      if (this.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', fromId, userId) === 0) return false;
      // Karşı yönde istek kalmasın (olmamalı; tutarlılık için)
      this.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', userId, fromId);
      const [a, b] = userId < fromId ? [userId, fromId] : [fromId, userId];
      this.run('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)', a, b, now);
      return true;
    });
  }

  /** İki kişi arasındaki bekleyen isteği (hangi yönde olursa olsun) siler: reddet ya da geri çek */
  deleteFriendRequest(a: string, b: string): boolean {
    return (
      this.run(
        'DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)',
        a,
        b,
      ) > 0
    );
  }

  /** Arkadaşlığı kaldırır; arkadaş değillerse false */
  removeFriend(a: string, b: string): boolean {
    if (a === b) return false;
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.run('DELETE FROM friendships WHERE user_a = ? AND user_b = ?', x, y) > 0;
  }

  /** Arkadaşlığı ve iki yöndeki bekleyen istekleri kaldırır (engellenince); bir şey değiştiyse true */
  clearFriendship(a: string, b: string): boolean {
    return this.tx(() => {
      const removed = this.removeFriend(a, b);
      return this.deleteFriendRequest(a, b) || removed;
    });
  }

  // ---------- Kullanıcı durumu ----------

  /** Kaydedilmiş durum satırı (süresi geçmiş değerler dahil; yorumlama presence.ts'de) */
  getStatusRow(userId: string): StatusRow | undefined {
    return this.one<StatusRow>('SELECT * FROM user_status WHERE user_id = ?', userId);
  }

  saveStatusRow(row: Omit<StatusRow, 'updated_at'>): void {
    this.run(
      `INSERT INTO user_status (user_id, status, status_expires_at, custom_text, custom_emoji, custom_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, status_expires_at = excluded.status_expires_at,
         custom_text = excluded.custom_text, custom_emoji = excluded.custom_emoji,
         custom_expires_at = excluded.custom_expires_at, updated_at = excluded.updated_at`,
      row.user_id,
      row.status,
      row.status_expires_at,
      row.custom_text,
      row.custom_emoji,
      row.custom_expires_at,
      Date.now(),
    );
  }

  /**
   * Süresi dolan durumları 'online'a, süresi dolan özel durumları boşa çeker. Değişen hesapların
   * kimliklerini döner.
   */
  expireStatuses(now: number): string[] {
    return this.tx(() => {
      const ids = new Set<string>();
      for (const r of this.all<{ user_id: string }>(
        'SELECT user_id FROM user_status WHERE status_expires_at <= ? OR custom_expires_at <= ?',
        now,
        now,
      )) {
        ids.add(r.user_id);
      }
      if (ids.size === 0) return [];
      this.run(
        "UPDATE user_status SET status = 'online', status_expires_at = NULL, updated_at = ? WHERE status_expires_at <= ?",
        now,
        now,
      );
      this.run(
        `UPDATE user_status SET custom_text = NULL, custom_emoji = NULL, custom_expires_at = NULL, updated_at = ?
         WHERE custom_expires_at <= ?`,
        now,
        now,
      );
      return [...ids];
    });
  }

  /** Rahatsız Etmeyin'de olanlar (süresi geçmemiş); telefonlarına bildirim gitmez */
  dndUserIds(userIds: string[], now = Date.now()): Set<string> {
    if (userIds.length === 0) return new Set();
    // Rahatsız Etmeyin'deki hesap az olur: hepsi okunup süzülür (uzun IN listesi yerine)
    const wanted = new Set(userIds);
    return new Set(
      this.all<{ user_id: string }>(
        `SELECT user_id FROM user_status WHERE status = 'dnd' AND (status_expires_at IS NULL OR status_expires_at > ?)`,
        now,
      )
        .map((r) => r.user_id)
        .filter((id) => wanted.has(id)),
    );
  }

  // ---------- Bildirim jetonları ----------

  /** Cihaz jetonunu kaydeder; aynı cihaz başka hesaba geçtiyse jeton yeni hesaba taşınır. */
  savePushToken(userId: string, token: string, platform: string): void {
    const now = Date.now();
    this.run(
      `INSERT INTO push_tokens (token, user_id, platform, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, last_seen = excluded.last_seen`,
      token,
      userId,
      platform,
      now,
      now,
    );
  }

  removePushToken(token: string): void {
    this.run('DELETE FROM push_tokens WHERE token = ?', token);
  }

  /** Kullanıcının bütün bildirim jetonlarını siler (`keep` verilirse o jeton kalır); silinen sayısı */
  removeUserPushTokens(userId: string, keep?: string): number {
    return keep === undefined
      ? this.run('DELETE FROM push_tokens WHERE user_id = ?', userId)
      : this.run('DELETE FROM push_tokens WHERE user_id = ? AND token <> ?', userId, keep);
  }

  pushTokens(userIds: string[]): { token: string; userId: string; platform: string }[] {
    if (userIds.length === 0) return [];
    return this.all<{ token: string; user_id: string; platform: string }>(
      `SELECT token, user_id, platform FROM push_tokens WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
      ...userIds,
    ).map((r) => ({ token: r.token, userId: r.user_id, platform: r.platform }));
  }

  // ---------- Mesajlar ----------

  /**
   * En yeni mesajlardan geriye doğru bir sayfa; sonuç eskiden yeniye sıralıdır. Tepkilerdeki `me`
   * alanı `viewerId` kullanıcısına göredir.
   */
  listMessages(channelId: string, before: number | null, limit: number, viewerId: string | null = null): Message[] {
    const rows = before
      ? this.all<MessageRow>(
          'SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
          channelId,
          before,
          limit,
        )
      : this.all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', channelId, limit);
    return this.withDetails(rows.reverse().map(toMessage), viewerId);
  }

  /**
   * Mesaj araması, yeniden eskiye. `channelIds` aranacak kanallardır (çağıran, kullanıcının görebildikleriyle
   * sınırlar; boşsa sonuç yok). `match`: FTS5 sorgusu (yoksa yalnızca süzgeçler). `cursor`: bu kimlikten
   * eski mesajlar. Toplam sayı SEARCH_TOTAL_CAP'e kadar sayılır.
   */
  searchMessages(opts: {
    channelIds: readonly string[];
    match: string | null;
    authorIds: readonly string[] | null;
    has: readonly SearchHas[];
    before: number | null;
    after: number | null;
    cursor: number | null;
    limit: number;
    viewerId: string;
  }): { messages: Message[]; total: number; totalCapped: boolean; more: boolean } {
    const empty = { messages: [], total: 0, totalCapped: false, more: false };
    if (opts.channelIds.length === 0 || opts.authorIds?.length === 0) return empty;
    const where: string[] = [`m.channel_id IN (${opts.channelIds.map(() => '?').join(',')})`];
    const params: Param[] = [...opts.channelIds];
    if (opts.match) {
      where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      params.push(opts.match);
    }
    if (opts.authorIds) {
      where.push(`m.author_id IN (${opts.authorIds.map(() => '?').join(',')})`);
      params.push(...opts.authorIds);
    }
    for (const has of opts.has) {
      if (has === 'link') where.push(`(m.content LIKE '%http://%' OR m.content LIKE '%https://%')`);
      else if (has === 'file') where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');
      else if (has === 'video') {
        where.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'video/%')`);
      } else {
        // Resim: resim dosyası ya da GIF
        where.push(
          `(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')
            OR m.embeds LIKE '%"type":"gif"%')`,
        );
      }
    }
    if (opts.before !== null) {
      where.push('m.created_at < ?');
      params.push(opts.before);
    }
    if (opts.after !== null) {
      where.push('m.created_at >= ?');
      params.push(opts.after);
    }
    const filter = where.join(' AND ');
    const counted = this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m WHERE ${filter} LIMIT ${SEARCH_TOTAL_CAP + 1})`,
      ...params,
    )!.n;
    const pageWhere = opts.cursor !== null ? `${filter} AND m.id < ?` : filter;
    const pageParams = opts.cursor !== null ? [...params, opts.cursor] : params;
    const rows = this.all<MessageRow>(
      `SELECT m.* FROM messages m WHERE ${pageWhere} ORDER BY m.id DESC LIMIT ?`,
      ...pageParams,
      opts.limit + 1,
    );
    const more = rows.length > opts.limit;
    return {
      messages: this.withDetails(rows.slice(0, opts.limit).map(toMessage), opts.viewerId),
      total: Math.min(counted, SEARCH_TOTAL_CAP),
      totalCapped: counted > SEARCH_TOTAL_CAP,
      more,
    };
  }

  getMessage(id: number, viewerId: string | null = null): Message | null {
    const row = this.one<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    return row ? this.withDetails([toMessage(row)], viewerId)[0]! : null;
  }

  /** Mesajlara dosya eklerini ve tepkilerini ekler (her biri tek sorguda). */
  private withDetails(messages: Message[], viewerId: string | null): Message[] {
    if (messages.length === 0) return messages;
    const ids = messages.map((m) => Number(m.id));
    const marks = ids.map(() => '?').join(',');
    const attachments = new Map<string, Attachment[]>();
    for (const r of this.all<AttachmentRow>(
      `SELECT * FROM attachments WHERE message_id IN (${marks}) ORDER BY message_id, position`,
      ...ids,
    )) {
      const list = attachments.get(String(r.message_id)) ?? [];
      list.push(toAttachment(r));
      attachments.set(String(r.message_id), list);
    }
    const reactions = new Map<string, Reaction[]>();
    for (const r of this.all<{ message_id: number; emoji: string; n: number; me: number }>(
      `SELECT message_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS me, MIN(created_at) AS first
       FROM reactions WHERE message_id IN (${marks})
       GROUP BY message_id, emoji ORDER BY first, emoji`,
      viewerId,
      ...ids,
    )) {
      const list = reactions.get(String(r.message_id)) ?? [];
      list.push({ emoji: r.emoji, count: r.n, me: r.me === 1 });
      reactions.set(String(r.message_id), list);
    }
    const references = this.references(messages);
    const pinned = new Set(
      this.all<{ message_id: number }>(`SELECT message_id FROM message_pins WHERE message_id IN (${marks})`, ...ids).map((r) =>
        String(r.message_id),
      ),
    );
    return messages.map((m) => ({
      ...m,
      attachments: attachments.get(m.id) ?? [],
      reactions: reactions.get(m.id) ?? [],
      referencedMessage: (m.replyToId && references.get(m.replyToId)) || null,
      pinned: pinned.has(m.id),
    }));
  }

  // ---------- Sabitlenmiş mesajlar ----------

  /**
   * Mesajı kanalına sabitler. Zaten sabitliyse 'exists'; kanalda MAX_PINS_PER_CHANNEL sabitli mesaj varsa
   * 'limit'; mesaj yoksa 'missing'.
   */
  pinMessage(messageId: number, userId: string, now = Date.now()): PinResult {
    return this.tx((): PinResult => {
      const row = this.one<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', messageId);
      if (!row) return 'missing';
      if (this.one('SELECT 1 FROM message_pins WHERE message_id = ?', messageId)) return 'exists';
      const count = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM message_pins WHERE channel_id = ?', row.channel_id)!.n;
      if (count >= MAX_PINS_PER_CHANNEL) return 'limit';
      // Aynı milisaniyedeki sabitlemeler de sıralı kalsın (liste en son sabitlenenle başlar)
      const last = this.lastPinAt(row.channel_id);
      if (last !== null && now <= last) now = last + 1;
      this.run(
        'INSERT INTO message_pins (message_id, channel_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)',
        messageId,
        row.channel_id,
        userId,
        now,
      );
      return 'pinned';
    });
  }

  /** Sabitlemeyi kaldırır; sabitli değilse false */
  unpinMessage(messageId: number): boolean {
    return this.run('DELETE FROM message_pins WHERE message_id = ?', messageId) > 0;
  }

  /** Kanalın sabitlenmiş mesajları, en son sabitlenen önce */
  listPins(channelId: string, viewerId: string | null = null): PinnedMessage[] {
    const rows = this.all<MessageRow & { pinned_at: number; pinned_by: string | null }>(
      `SELECT m.*, p.pinned_at, p.pinned_by FROM message_pins p JOIN messages m ON m.id = p.message_id
       WHERE p.channel_id = ? ORDER BY p.pinned_at DESC, p.message_id DESC LIMIT ?`,
      channelId,
      MAX_PINS_PER_CHANNEL,
    );
    const pins = new Map(rows.map((r) => [String(r.id), { pinnedAt: r.pinned_at, pinnedBy: r.pinned_by }]));
    return this.withDetails(rows.map(toMessage), viewerId).map((m) => ({
      ...m,
      pinned: true as const,
      ...pins.get(m.id)!,
    }));
  }

  /**
   * Kanal panelinin "Medya" sekmesi: kanalda (konuşmada) mesaja eklenmiş resim ve videolar, yeniden eskiye
   * (aynı mesajdakiler sırasıyla). `after`: bir önceki sayfanın son öğesi (bu mesajın sonraki dosyaları ve
   * daha eski mesajlar gelir). Erişim denetimi çağırandadır.
   */
  listChannelMedia(
    channelId: string,
    after: { messageId: number; position: number } | null,
    limit: number,
  ): { items: (ChannelMediaItem & { position: number })[]; more: boolean } {
    return this.listChannelAttachments(channelId, after, limit, false);
  }

  /**
   * Kanal panelinin "Dosyalar" sekmesi: Medya'daki resim/video sınıflandırmasının tersi (belge, arşiv, ses,
   * APK vb.); sıralama, imleç ve dönüş biçimi aynıdır. Erişim denetimi çağırandadır.
   */
  listChannelFiles(
    channelId: string,
    after: { messageId: number; position: number } | null,
    limit: number,
  ): { items: (ChannelMediaItem & { position: number })[]; more: boolean } {
    return this.listChannelAttachments(channelId, after, limit, true);
  }

  private listChannelAttachments(
    channelId: string,
    after: { messageId: number; position: number } | null,
    limit: number,
    invert: boolean,
  ): { items: (ChannelMediaItem & { position: number })[]; more: boolean } {
    const types = [...INLINE_IMAGE_TYPES, ...INLINE_VIDEO_TYPES];
    const params: Param[] = [channelId, ...types];
    let page = '';
    if (after) {
      page = 'AND (a.message_id < ? OR (a.message_id = ? AND a.position > ?))';
      params.push(after.messageId, after.messageId, after.position);
    }
    const rows = this.all<AttachmentRow & { position: number; author_id: string | null; message_created_at: number }>(
      `SELECT a.*, m.author_id, m.created_at AS message_created_at
       FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.channel_id = ? AND a.message_id IS NOT NULL AND a.content_type ${invert ? 'NOT IN' : 'IN'} (${types.map(() => '?').join(',')}) ${page}
       ORDER BY a.message_id DESC, a.position ASC LIMIT ?`,
      ...params,
      limit + 1,
    );
    return {
      items: rows.slice(0, limit).map((r) => ({
        messageId: String(r.message_id),
        authorId: r.author_id,
        createdAt: r.message_created_at,
        attachment: toAttachment(r),
        position: r.position,
      })),
      more: rows.length > limit,
    };
  }

  /**
   * Kanal panelinin "Bağlantılar" sekmesi: bağlantı içeren mesajlar yeniden eskiye (en fazla `limit` mesaj,
   * `before` kimliğinden eskiler), mesaj başına bağlantıları. GIF mesajları (metni GIPHY bağlantısı) sayılmaz.
   * `last`: sonraki sayfanın imleci (ondan eskiler). Bir istekte en fazla `scanWindow` mesaj taranır; o
   * pencerede bağlantı bulunmasa da daha eskisi varsa `more` true, `last` pencerenin alt sınırıdır.
   * Erişim denetimi çağırandadır.
   */
  listChannelLinks(
    channelId: string,
    before: number | null,
    limit: number,
    /** Bir istekte en fazla bu kadar mesaj taranır (bağlantısız uzun geçmişte sorgu sınırlı kalsın) */
    scanWindow = CHANNEL_LINKS_SCAN_WINDOW,
  ): { items: ChannelLinkItem[]; more: boolean; last: number | null } {
    const range = before !== null ? 'AND id < ?' : '';
    const params: Param[] = before !== null ? [channelId, before] : [channelId];
    // Taranacak pencere: imleçten eskiye en fazla scanWindow mesaj (yalnızca dizinden okunur)
    const window = this.one<{ low: number | null; n: number }>(
      `SELECT MIN(id) AS low, COUNT(*) AS n FROM
         (SELECT id FROM messages WHERE channel_id = ? ${range} ORDER BY id DESC LIMIT ?)`,
      ...params,
      scanWindow,
    )!;
    if (window.n === 0 || window.low === null) return { items: [], more: false, last: null };
    const rows = this.all<Pick<MessageRow, 'id' | 'author_id' | 'content' | 'created_at' | 'embeds'>>(
      `SELECT id, author_id, content, created_at, embeds FROM messages
       WHERE channel_id = ? ${range} AND id >= ?
         AND (content LIKE '%http://%' OR content LIKE '%https://%')
       ORDER BY id DESC LIMIT ?`,
      ...params,
      window.low,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    // Sayfa dolduysa sonraki sayfa son mesajdan; dolmadıysa ama pencere dolduysa (daha eski mesaj var)
    // pencerenin alt sınırından sürer (sayfa boş olabilir; istemci kendiliğinden devam eder)
    if (rows.length > limit) {
      return { items: this.linkItems(page), more: true, last: page[page.length - 1]!.id };
    }
    const full = window.n >= scanWindow;
    return { items: this.linkItems(page), more: full, last: full ? window.low : null };
  }

  private linkItems(page: Pick<MessageRow, 'id' | 'author_id' | 'content' | 'created_at' | 'embeds'>[]): ChannelLinkItem[] {
    const items: ChannelLinkItem[] = [];
    for (const r of page) {
      const embeds = parseEmbeds(r.embeds);
      if (isGifMessage({ embeds })) continue;
      for (const url of extractMessageUrls(r.content)) {
        const preview = embeds.find((e): e is LinkEmbed => e.type === 'link' && e.url === url);
        items.push({
          messageId: String(r.id),
          authorId: r.author_id,
          createdAt: r.created_at,
          url,
          title: preview?.title ?? null,
          siteName: preview?.siteName ?? null,
        });
      }
    }
    return items;
  }

  /** Kanaldaki en son sabitlemenin zamanı (sabitli mesaj yoksa null) */
  lastPinAt(channelId: string): number | null {
    return this.one<{ at: number | null }>('SELECT MAX(pinned_at) AS at FROM message_pins WHERE channel_id = ?', channelId)!.at;
  }

  /**
   * Yanıtların üstünde gösterilen asıl mesaj özetleri (tek sorguda). Özet saklanmaz, her okumada
   * asıl mesajdan üretilir: düzenlenen mesajın yanıtları yeni metni gösterir, silinmişse listede yoktur.
   */
  private references(messages: Message[]): Map<string, ReferencedMessage> {
    const ids = [...new Set(messages.map((m) => m.replyToId).filter((id): id is string => Boolean(id)))];
    const map = new Map<string, ReferencedMessage>();
    if (ids.length === 0) return map;
    for (const r of this.all<{ id: number; author_id: string | null; content: string; embeds: string | null; files: number }>(
      `SELECT m.id, m.author_id, m.content, m.embeds,
         EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS files
       FROM messages m WHERE m.id IN (${ids.map(() => '?').join(',')})`,
      ...ids.map(Number),
    )) {
      const reference = referenceOf(
        { id: String(r.id), authorId: r.author_id, content: r.content, embeds: parseEmbeds(r.embeds) },
        r.files === 1,
      );
      map.set(reference.id, reference);
    }
    return map;
  }

  /** Yanıt verilecek mesaj: bu kanalda duruyorsa kimliği ve yazarı, yoksa null */
  replyTarget(channelId: string, messageId: number): ReplyTarget | null {
    const row = this.one<{ id: number; author_id: string | null }>(
      'SELECT id, author_id FROM messages WHERE id = ? AND channel_id = ?',
      messageId,
      channelId,
    );
    return row ? { id: row.id, authorId: row.author_id } : null;
  }

  /** Kullanıcının tepkisini ekler; mesajda en fazla MESSAGE_MAX_REACTIONS farklı emoji olabilir. */
  addReaction(messageId: number, userId: string, emoji: string): AddReactionResult {
    return this.tx((): AddReactionResult => {
      const known = this.one('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1', messageId, emoji);
      if (!known) {
        const distinct = this.one<{ n: number }>(
          'SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?',
          messageId,
        )!.n;
        if (distinct >= MESSAGE_MAX_REACTIONS) return 'limit';
      }
      const added = this.run(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
        messageId,
        userId,
        emoji,
        Date.now(),
      );
      return added > 0 ? 'added' : 'exists';
    });
  }

  /**
   * Mesajda bu emojiyle tepki verenler, tepki verilme sırasına göre (eşitlikte kullanıcı kimliğiyle).
   * `after` önceki sayfanın `next` imlecidir ("<zaman>_<kullanıcı>"); tepki bu arada geri alınsa da
   * imleç geçerli kalır. Hesabı silinenlerin tepkileri zaten silinmiştir.
   */
  reactionUsers(messageId: number, emoji: string, limit: number, after: { at: number; userId: string } | null): ReactionUsersPage {
    const rows = this.all<UserRow & { reacted_at: number }>(
      `SELECT u.*, r.created_at AS reacted_at FROM reactions r JOIN users u ON u.id = r.user_id
       WHERE r.message_id = ? AND r.emoji = ?
         AND (? IS NULL OR r.created_at > ? OR (r.created_at = ? AND r.user_id > ?))
       ORDER BY r.created_at, r.user_id LIMIT ?`,
      messageId,
      emoji,
      after?.at ?? null,
      after?.at ?? null,
      after?.at ?? null,
      after?.userId ?? null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      users: page.map((r) => this.toUser(r)),
      next: rows.length > limit && last ? `${last.reacted_at}_${last.id}` : null,
    };
  }

  /** Kullanıcının tepkisini kaldırır; yoksa false. */
  removeReaction(messageId: number, userId: string, emoji: string): boolean {
    return (
      this.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji) > 0
    );
  }

  /**
   * Mesajı kaydeder ve yüklenmiş dosyaları ona bağlar (dosyalar bu kullanıcının, bu kanala yüklediği ve
   * henüz kullanılmamış dosyalar olmalı; değilse null döner). Bahsedilen kullanıcıların okunmamış
   * bahsetme sayısını artırır. `reply` verilirse mesaj ona yanıttır (aynı kanalda olduğu önceden denetlenir).
   * `everyone` / `here`: yetkili bir @everyone / @here bahsetmesi (kime gittiği `userIds` içindedir).
   */
  createMessage(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[] = [],
    mentions: { userIds: string[]; everyone: boolean; here?: boolean } = {
      userIds: this.resolveMentions(content, authorId),
      everyone: false,
    },
    reply: { toId: number; mentionUserId: string | null } | null = null,
  ): Message | null {
    return this.tx((): Message | null => {
      for (const attachmentId of attachmentIds) {
        const row = this.one<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', attachmentId);
        if (!row || row.uploader_id !== authorId || row.channel_id !== channelId || row.message_id !== null) return null;
      }
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO messages (channel_id, author_id, content, created_at, mention_everyone, mention_here, reply_to_id, reply_mention_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            channelId,
            authorId,
            content,
            Date.now(),
            mentions.everyone ? 1 : 0,
            mentions.here ? 1 : 0,
            reply?.toId ?? null,
            reply?.mentionUserId ?? null,
          ).lastInsertRowid,
      );
      attachmentIds.forEach((attachmentId, position) => {
        this.run('UPDATE attachments SET message_id = ?, position = ? WHERE id = ?', id, position, attachmentId);
      });
      for (const userId of mentions.userIds) {
        this.run(
          `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, 0, 1)
           ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`,
          userId,
          channelId,
        );
      }
      return this.getMessage(id)!;
    });
  }

  // ---------- Arama kayıtları (DM) ----------

  /**
   * Konuşmaya arama kaydı yazar (type 'call'; yazarı aramayı başlatan, sürüyor). `notify`: okunmamış sayısı
   * artacak diğer katılımcılar (DM'deki her mesaj gibi).
   */
  createCallMessage(channelId: string, authorId: string, notify: string[], now = Date.now()): Message {
    return this.tx(() => {
      const call: MessageCall = { participantIds: [authorId], endedAt: null };
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO messages (channel_id, author_id, content, created_at, type, call_data)
             VALUES (?, ?, ?, ?, 'call', ?)`,
          )
          .run(channelId, authorId, callMessageText(call, now), now, JSON.stringify(call)).lastInsertRowid,
      );
      for (const userId of notify) {
        this.run(
          `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, 0, 1)
           ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`,
          userId,
          channelId,
        );
      }
      return this.getMessage(id)!;
    });
  }

  /** Arama kaydının bilgisini (ve metnini) günceller; kayıt yoksa (silindi) null. Düzenlenmiş sayılmaz. */
  updateCallMessage(id: number, call: MessageCall): Message | null {
    const row = this.one<{ created_at: number }>("SELECT created_at FROM messages WHERE id = ? AND type = 'call'", id);
    if (!row) return null;
    this.run(
      'UPDATE messages SET content = ?, call_data = ? WHERE id = ?',
      callMessageText(call, row.created_at),
      JSON.stringify(call),
      id,
    );
    return this.getMessage(id);
  }

  /** Konuşmanın en son arama kaydı, hâlâ bitmemiş görünüyorsa (sunucu yeniden başladı, arama sürüyor) */
  openCallMessage(channelId: string): Message | null {
    const row = this.one<MessageRow>(
      "SELECT * FROM messages WHERE channel_id = ? AND type = 'call' ORDER BY id DESC LIMIT 1",
      channelId,
    );
    if (!row || parseCall(row.call_data).endedAt !== null) return null;
    return this.getMessage(row.id);
  }

  /** Bitmemiş görünen arama kayıtları (sunucu yeniden başlarken süren aramalar bellekten gitmiş olabilir) */
  openCallMessages(): Message[] {
    return this.all<MessageRow>("SELECT * FROM messages WHERE type = 'call' AND json_extract(call_data, '$.endedAt') IS NULL")
      .map(toMessage);
  }

  /**
   * Metinde bahsedilen kullanıcıların kimlikleri; yazar hariç. `guildId` verilirse yalnızca o sunucunun
   * şu anki üyeleri (kanalı görüp görmedikleri ayrıca denetlenir).
   */
  resolveMentions(content: string, authorId: string | null, guildId?: string): string[] {
    const members = guildId === undefined ? null : this.permissionData().guilds.get(guildId)?.members;
    const ids: string[] = [];
    for (const username of extractMentions(content)) {
      const user = this.one<{ id: string }>('SELECT id FROM users WHERE username = ?', username);
      if (!user || user.id === authorId) continue;
      if (members !== null && !members?.has(user.id)) continue;
      ids.push(user.id);
    }
    return ids;
  }

  /** Mesajın gömülü içeriğini (GIF) değiştirir; boş dizi hepsini kaldırır. */
  setMessageEmbeds(id: number, embeds: Embed[]): void {
    this.run('UPDATE messages SET embeds = ? WHERE id = ?', embeds.length ? JSON.stringify(embeds) : null, id);
  }

  /**
   * Bağlantı önizlemelerini kaldırır ve bir daha eklenmemesini işaretler (GIF kalır). Mesaj yoksa false.
   */
  suppressEmbeds(id: number): boolean {
    const row = this.one<{ embeds: string | null }>('SELECT embeds FROM messages WHERE id = ?', id);
    if (!row) return false;
    const kept = parseEmbeds(row.embeds).filter((e) => e.type !== 'link');
    this.run(
      'UPDATE messages SET suppress_embeds = 1, embeds = ? WHERE id = ?',
      kept.length ? JSON.stringify(kept) : null,
      id,
    );
    return true;
  }

  // ---------- Bağlantı önizleme önbelleği ----------

  /** Önbellekteki önizleme: yoksa ya da süresi geçtiyse undefined, "önizleme yok" kaydıysa null */
  getLinkPreview(url: string, now = Date.now()): LinkEmbed | null | undefined {
    const row = this.one<{ embed: string | null; expires_at: number }>(
      'SELECT embed, expires_at FROM link_previews WHERE url = ?',
      url,
    );
    if (!row || row.expires_at <= now) return undefined;
    if (!row.embed) return null;
    try {
      const embed = JSON.parse(row.embed) as LinkEmbed;
      return embed?.type === 'link' ? embed : null;
    } catch {
      return null;
    }
  }

  setLinkPreview(url: string, embed: LinkEmbed | null, expiresAt: number, now = Date.now()): void {
    this.run(
      `INSERT INTO link_previews (url, embed, fetched_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET embed = excluded.embed, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      url,
      embed ? JSON.stringify(embed) : null,
      now,
      expiresAt,
    );
  }

  /** Süresi geçmiş önizlemeleri siler */
  sweepLinkPreviews(now = Date.now()): void {
    this.run('DELETE FROM link_previews WHERE expires_at <= ?', now);
  }

  updateMessage(id: number, content: string, viewerId: string | null = null): Message | null {
    this.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, Date.now(), id);
    return this.getMessage(id, viewerId);
  }

  /** Mesajı siler; diskten de silinmesi gereken dosya eklerinin kimliklerini döner. */
  deleteMessage(id: number): string[] {
    return this.tx(() => {
      const files = this.all<{ id: string }>('SELECT id FROM attachments WHERE message_id = ?', id).map((r) => r.id);
      this.run('DELETE FROM messages WHERE id = ?', id);
      return files;
    });
  }

  // ---------- Dosya ekleri ----------

  createAttachment(a: {
    id: string;
    channelId: string;
    uploaderId: string;
    name: string;
    size: number;
    contentType: string;
    width: number | null;
    height: number | null;
    /** Videolarda süre (saniye) */
    duration?: number | null;
  }): Attachment {
    this.run(
      `INSERT INTO attachments (id, channel_id, uploader_id, name, size, content_type, width, height, duration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.channelId,
      a.uploaderId,
      a.name,
      a.size,
      a.contentType,
      a.width,
      a.height,
      a.duration ?? null,
      Date.now(),
    );
    return this.getAttachment(a.id)!.attachment;
  }

  /** Ek ve bağlı olduğu mesaj (henüz bir mesaja eklenmediyse null). */
  getAttachment(id: string): { attachment: Attachment; messageId: number | null } | null {
    const row = this.one<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    return row ? { attachment: toAttachment(row), messageId: row.message_id } : null;
  }

  attachmentExists(id: string): boolean {
    return this.one('SELECT 1 FROM attachments WHERE id = ?', id) !== undefined;
  }

  /** Kanal silinmeden önce: diskten silinecek dosyalar */
  channelAttachmentIds(channelId: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM attachments WHERE channel_id = ?', channelId).map((r) => r.id);
  }

  /** Belirtilen andan önce yüklenip hiçbir mesaja eklenmemiş dosyalar */
  stalePendingAttachments(before: number): string[] {
    return this.all<{ id: string }>(
      'SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?',
      before,
    ).map((r) => r.id);
  }

  deleteAttachments(ids: string[]): void {
    for (const id of ids) this.run('DELETE FROM attachments WHERE id = ?', id);
  }

  /** Kanal başına en son mesaj kimliği (okunmamış göstergesi için). */
  lastMessageIds(): Record<string, string> {
    return Object.fromEntries(
      this.all<{ channel_id: string; id: number }>(
        'SELECT channel_id, MAX(id) AS id FROM messages GROUP BY channel_id',
      ).map((r) => [r.channel_id, String(r.id)]),
    );
  }

  /** Kullanıcı kanalın son mesajına kadar okumuş mu (mesaj yoksa da evet) */
  readUpToDate(userId: string, channelId: string): boolean {
    const row = this.one<{ last: number | null; read: number | null }>(
      `SELECT (SELECT MAX(id) FROM messages WHERE channel_id = ?1) AS last,
              (SELECT last_read_id FROM read_states WHERE user_id = ?2 AND channel_id = ?1) AS read`,
      channelId,
      userId,
    )!;
    return row.last === null || (row.read ?? 0) >= row.last;
  }

  readStates(userId: string): Record<string, string> {
    return Object.fromEntries(
      this.all<{ channel_id: string; last_read_id: number }>(
        'SELECT channel_id, last_read_id FROM read_states WHERE user_id = ?',
        userId,
      ).map((r) => [r.channel_id, String(r.last_read_id)]),
    );
  }

  mentionCounts(userId: string): Record<string, number> {
    return Object.fromEntries(
      this.all<{ channel_id: string; mention_count: number }>(
        'SELECT channel_id, mention_count FROM read_states WHERE user_id = ? AND mention_count > 0',
        userId,
      ).map((r) => [r.channel_id, r.mention_count]),
    );
  }

  /**
   * Okunma durumunu yalnızca ileri taşır; kanalın sonuna kadar okunduysa bahsetme sayısı sıfırlanır.
   * Durum değiştiyse yenisini döndürür (kullanıcının diğer cihazlarına READ_STATE_UPDATE), değişmediyse null.
   */
  ack(userId: string, channelId: string, messageId: number): ReadStateUpdate | null {
    type Row = { last_read_id: number; mention_count: number };
    const select = 'SELECT last_read_id, mention_count FROM read_states WHERE user_id = ? AND channel_id = ?';
    return this.tx(() => {
      const before = this.one<Row>(select, userId, channelId);
      this.run(
        `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET
           last_read_id = MAX(last_read_id, excluded.last_read_id),
           mention_count = CASE
             WHEN excluded.last_read_id >= (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = excluded.channel_id)
             THEN 0 ELSE mention_count END`,
        userId,
        channelId,
        messageId,
      );
      const after = this.one<Row>(select, userId, channelId)!;
      if (before && before.last_read_id === after.last_read_id && before.mention_count === after.mention_count) {
        return null;
      }
      return { channelId, lastReadId: String(after.last_read_id), mentionCount: after.mention_count };
    });
  }
}


