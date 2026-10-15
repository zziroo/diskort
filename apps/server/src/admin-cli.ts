// Hesap yöneticilerini sunucuda komut satırından listeleme, ekleme ve çıkarma aracı.
//
//   docker compose exec api node dist/admin-cli.js list [--json]
//   docker compose exec api node dist/admin-cli.js grant <kullanıcı adı>
//   docker compose exec api node dist/admin-cli.js revoke <kullanıcı adı>
//   docker compose exec api node dist/admin-cli.js intro-sound-remove <kullanıcı adı | kimlik>
//
// Hesap yöneticiliği hesabın kendi bayrağıdır (users.is_admin), hiçbir sunucuya bağlı değildir: geri
// bildirimleri yönetir, sıfırlama kodu üretir, hesap siler, hesap daveti oluşturur. Son yönetici
// çıkarılamaz. Veritabanını doğrudan açar (<DATA_DIR>/diskort.db; ya da --db <dosya>); sunucu çalışırken
// de güvenlidir (WAL) ve yetki denetimleri bayrağı her istekte okuduğundan değişiklik hemen geçerlidir.
// Açık uygulamalardaki arayüz (Ayarlar > Yönetim) yeniden bağlanınca güncellenir.
//
// intro-sound-remove: uygunsuz kişisel giriş sesini kaldırır (sütunu boşaltır, <veri klasörü>/intro-sounds'taki
// dosyayı siler). Araç sunucunun gateway'ine bağlı değildir: ses adresi hemen 404 döner, ama açık
// istemciler kullanıcının yeni hâlini sonraki USER_UPDATE'te ya da yeniden bağlanınca alır. Anında yayılsın
// isteniyorsa yönetici uç noktası kullanılır: DELETE /api/users/<kimlik>/intro-sound.

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** users.is_admin'in doğruluk kaynağı olduğu şema (göç 17) */
const MIN_SCHEMA = 17;
/** users.intro_sound_hash'in geldiği şema (göç 27) */
const INTRO_SOUND_SCHEMA = 27;

const USAGE = `Kullanım: node dist/admin-cli.js <komut> [seçenekler]

Komutlar:
  list [--json]              Hesap yöneticileri
  grant <kullanıcı adı>      Hesap yöneticisi yapar
  revoke <kullanıcı adı>     Hesap yöneticiliğini alır (son yönetici alınamaz)
  intro-sound-remove <kullanıcı adı | kimlik>
                             Kişisel giriş sesini kaldırır (dosyası da silinir)

Seçenek:  --db <dosya>  (varsayılan: $DATA_DIR/diskort.db)`;

class CliError extends Error {}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  is_admin: number;
  created_at: number;
  intro_sound_hash?: string | null;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '--help' || arg === '-h') {
      flags.set(arg.replace(/^-+/, ''), true);
    } else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const value = inline ?? argv[++i];
      if (value === undefined) throw new CliError(`--${name} için değer eksik.`);
      flags.set(name, value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const [command, username] = args.positional;
  if (!command || args.flags.has('help') || args.flags.has('h') || command === 'help') {
    console.log(USAGE);
    return;
  }
  const dbFlag = args.flags.get('db');
  const dbFile = typeof dbFlag === 'string' ? dbFlag : path.join(path.resolve(process.env.DATA_DIR ?? 'data'), 'diskort.db');
  if (!fs.existsSync(dbFile)) throw new CliError(`Veritabanı bulunamadı: ${dbFile}`);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version < MIN_SCHEMA) {
      throw new CliError(
        `Veritabanı şeması ${version}: hesap yöneticileri şema ${MIN_SCHEMA} ile gelir. Önce sunucuyu güncelleyip bir kez başlat.`,
      );
    }
    const admins = (): UserRow[] =>
      db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at, rowid').all() as unknown as UserRow[];
    const find = (): UserRow => {
      if (!username) throw new CliError('Kullanıcı adı ver (ör. grant ziroo).');
      const byId = db.prepare('SELECT * FROM users WHERE id = ?').get(username) as UserRow | undefined;
      const row =
        byId ??
        (db.prepare('SELECT * FROM users WHERE username = ?').get(username.replace(/^@/, '').toLowerCase()) as
          | UserRow
          | undefined);
      if (!row) throw new CliError(`"${username}" adlı hesap yok.`);
      return row;
    };

    switch (command) {
      case 'list': {
        const list = admins();
        if (args.flags.has('json')) {
          console.log(JSON.stringify(list.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })), null, 2));
        } else if (list.length === 0) {
          console.log('Hesap yöneticisi yok.');
        } else {
          for (const u of list) console.log(`@${u.username}  (${u.display_name})  ${u.id}`);
        }
        return;
      }
      case 'grant': {
        const user = find();
        if (user.is_admin === 1) {
          console.log(`@${user.username} zaten hesap yöneticisi.`);
          return;
        }
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
        console.log(`@${user.username} artık hesap yöneticisi.`);
        return;
      }
      case 'revoke': {
        const user = find();
        if (user.is_admin !== 1) {
          console.log(`@${user.username} zaten hesap yöneticisi değil.`);
          return;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const count = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
          if (count <= 1) throw new CliError(`@${user.username} son hesap yöneticisi; yöneticiliği alınamaz.`);
          db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(user.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        console.log(`@${user.username} artık hesap yöneticisi değil.`);
        return;
      }
      case 'intro-sound-remove': {
        if (version < INTRO_SOUND_SCHEMA) {
          throw new CliError(`Veritabanı şeması ${version}: giriş sesleri şema ${INTRO_SOUND_SCHEMA} ile gelir.`);
        }
        const user = find();
        const hash = user.intro_sound_hash ?? null;
        if (!hash) {
          console.log(`@${user.username} kullanıcısının giriş sesi yok.`);
          return;
        }
        db.prepare('UPDATE users SET intro_sound_hash = NULL WHERE id = ?').run(user.id);
        // Dosya veritabanının yanındaki intro-sounds klasöründe (<DATA_DIR>/intro-sounds); silinemezse
        // sunucunun temizlik görevi bir saat sonra siler
        if (/^[0-9a-f]{32}$/.test(hash)) {
          fs.rmSync(path.join(path.dirname(dbFile), 'intro-sounds', `${hash}.mp3`), { force: true });
        }
        console.log(
          `@${user.username} kullanıcısının giriş sesi kaldırıldı. Açık uygulamalar yeniden bağlanınca güncellenir.`,
        );
        return;
      }
      default:
        throw new CliError(`Bilinmeyen komut "${command}".\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exitCode = 1;
  } else throw err;
}
