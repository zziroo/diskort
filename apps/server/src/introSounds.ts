import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { INTRO_SOUND_MAX_BYTES, INTRO_SOUND_MAX_SECONDS, type User } from '@diskort/shared';
import { UploadError } from './attachments.js';
import { AVATAR_HASH, readLimited } from './avatars.js';
import type { Store } from './db.js';

/** Diskteki ve adresteki ad: kullanıcıya ve içeriğe göre özet (128 bit, küçük harf onaltılık; profil fotoğraflarıyla aynı biçim) */
export const INTRO_SOUND_HASH = AVATAR_HASH;
/** İstemcinin seçebileceği en geç başlangıç noktası (saniye) */
export const INTRO_SOUND_MAX_START = 3600;
/** Dönüştürülmüş sesin en büyük boyutu: 5 sn × 96 kbps ≈ 60 KB; bunun çok üstü bozuk çıktı demektir */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MIN_OUTPUT_BYTES = 1000;
/** ffmpeg'in en uzun çalışma süresi; aşılırsa süreç öldürülür */
const TRANSCODE_TIMEOUT_MS = 20_000;
/** Veritabanında karşılığı olmayan dosyalar için bekleme süresi (yarım kalan işlem, eski yedek) */
const ORPHAN_GRACE_MS = 60 * 60_000;

/** Yüklenen sesi `startSec`'ten başlayarak en fazla INTRO_SOUND_MAX_SECONDS saniyelik MP3'e çevirir. */
export type IntroSoundTranscode = (input: Buffer, startSec: number) => Promise<Buffer>;

/**
 * Varsayılan dönüştürücü: ffmpeg (yol FFMPEG_PATH, yoksa PATH'teki ffmpeg). Girdi geçici dosyaya yazılır:
 * MP4/M4A'da "moov" bölümü dosyanın sonunda olabilir ve borudan (stdin) okununca bulunamaz. Ses 48 kHz mono,
 * ses yüksekliği eşitlenmiş (loudnorm), son 0,3 sn'de kısılan 96 kbps MP3 olur; üst veriler (ID3 etiketleri,
 * kapak resmi) atılır. TRANSCODE_TIMEOUT_MS'de bitmezse süreç öldürülür.
 */
export function ffmpegTranscode(ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'): IntroSoundTranscode {
  return async (input, startSec) => {
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diskort-intro-'));
    const inFile = path.join(work, 'input');
    const outFile = path.join(work, 'output.mp3');
    try {
      await fs.promises.writeFile(inFile, input);
      const fadeStart = INTRO_SOUND_MAX_SECONDS - 0.3;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        // Girdi güvenilmez: m3u8 gibi çalma listeleri ffmpeg'e http adresleri indirtebilir (SSRF);
        // yalnızca yerel dosya protokolü ve bilinen ses/kapsayıcı biçimleri açılır.
        '-protocol_whitelist', 'file',
        '-format_whitelist', 'mp3,wav,ogg,mov,mp4,m4a,matroska,webm,aac,flac,aiff',
        '-ss', startSec.toFixed(3),
        '-i', inFile,
        '-t', String(INTRO_SOUND_MAX_SECONDS),
        '-vn', '-sn', '-dn', '-map_metadata', '-1',
        '-ac', '1', '-ar', '48000',
        '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${fadeStart}:d=0.3`,
        '-c:a', 'libmp3lame', '-b:a', '96k',
        '-f', 'mp3', '-y', outFile,
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let timedOut = false;
        // Zaman aşımında yalnızca öldürülür; reddetme 'close'ta olur ki geçici klasör süreç bitmeden silinmesin
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, TRANSCODE_TIMEOUT_MS);
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 2000) stderr += chunk.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error('ffmpeg zaman aşımı'));
          else if (code === 0) resolve();
          else reject(new Error(`ffmpeg çıkış kodu ${code}: ${stderr.trim().slice(0, 500)}`));
        });
      });
      const stat = await fs.promises.stat(outFile);
      // Sınırın üstündeki çıktı belleğe okunmaz; servis boşu da sınırı aşanı da reddeder
      // Başlangıç noktası girdinin sonunu geçerse yalnızca başlık içeren (sesi olmayan) bir MP3 çıkar
      if (stat.size < MIN_OUTPUT_BYTES) throw unsupported();
      if (stat.size > MAX_OUTPUT_BYTES) return Buffer.alloc(MAX_OUTPUT_BYTES + 1);
      return await fs.promises.readFile(outFile);
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  };
}

/** `start` sorgu değerini doğrular: boşsa 0, değilse 0..INTRO_SOUND_MAX_START arası sonlu sayı; geçersizse null. */
export function parseIntroStart(value: unknown): number | null {
  if (value === undefined || value === '') return 0;
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= INTRO_SOUND_MAX_START ? n : null;
}

/**
 * Kişisel giriş sesleri: yüklenen ses (MP3, WAV, OGG, M4A, WebM, AAC, FLAC; ne olduğuna ffmpeg bakar)
 * istenen başlangıç noktasından en fazla 5 sn'lik, ses yüksekliği eşitlenmiş 48 kHz mono MP3'e çevrilir ve
 * <dir>/<özet>.mp3'e yazılır. Yeniden kodlandığı için üst veri kalmaz. Eski dosya ses değişince, kaldırılınca
 * ve hesap silinince silinir; özet kullanıcı kimliğini de içerdiğinden aynı dosyayı başka hesap kullanamaz.
 */
export class IntroSoundService {
  /** İşlemler sırayla: aynı anda tek ffmpeg çalışır (işlemci) ve dosya/veritabanı güncellemeleri çakışmaz */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    readonly dir: string,
    private readonly transcode: IntroSoundTranscode = ffmpegTranscode(),
    private readonly log?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void },
  ) {}

  pathOf(hash: string): string {
    return path.join(this.dir, `${hash}.mp3`);
  }

  /** Gövdeyi okur, dönüştürür ve kullanıcının giriş sesi yapar; eskisini siler. */
  async upload(userId: string, body: Readable, declaredSize: number | null, startSec = 0): Promise<User> {
    if (!Number.isFinite(startSec) || startSec < 0 || startSec > INTRO_SOUND_MAX_START) {
      throw new UploadError(400, 'invalid_start', 'Başlangıç noktası geçersiz.');
    }
    const input = await readLimited(body, declaredSize, INTRO_SOUND_MAX_BYTES, 'Ses dosyası');
    return this.serial(async () => {
      let output: Buffer;
      try {
        output = await this.transcode(input, startSec);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.log?.warn({ err: String(err) }, 'ffmpeg bulunamadı; giriş sesi işlenemiyor');
          throw new UploadError(503, 'unavailable', 'Giriş sesi şu an işlenemiyor, sonra yeniden dene.');
        }
        this.log?.info({ err: String(err) }, 'giriş sesi dönüştürülemedi');
        throw unsupported();
      }
      if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) throw unsupported();
      const hash = createHash('sha256').update(`intro:${userId}`).update('\0').update(output).digest('hex').slice(0, 32);
      await fs.promises.mkdir(this.dir, { recursive: true });
      const temp = path.join(this.dir, `${randomBytes(8).toString('hex')}.tmp`);
      try {
        await fs.promises.writeFile(temp, output, { flag: 'wx' });
        await fs.promises.rename(temp, this.pathOf(hash));
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        throw err;
      }
      const result = this.store.setIntroSound(userId, hash);
      if (!result) {
        // Hesap bu arada silindi
        await this.removeFile(hash);
        throw new UploadError(404, 'not_found', 'Kullanıcı bulunamadı.');
      }
      if (result.previous && result.previous !== hash) await this.removeFile(result.previous);
      return result.user;
    });
  }

  /** Giriş sesini kaldırır (genel katılma sesine dönülür); kullanıcı yoksa null. */
  remove(userId: string): Promise<User | null> {
    return this.serial(async () => {
      const result = this.store.setIntroSound(userId, null);
      if (!result) return null;
      if (result.previous) await this.removeFile(result.previous);
      return result.user;
    });
  }

  /** Silinen hesabın dosyası (özet hesap silinmeden önce alınır). */
  removeDeleted(hash: string | null): Promise<void> {
    if (!hash) return Promise.resolve();
    return this.serial(() => this.removeFile(hash));
  }

  /** Temizlik: hiçbir kullanıcının kullanmadığı (yarım kalmış, eski yedekten kalan) dosyaları siler. */
  sweep(now = Date.now()): Promise<number> {
    return this.serial(async () => {
      const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
      const used = this.store.introSoundHashes();
      let removed = 0;
      for (const file of files) {
        const match = /^([0-9a-f]{32})\.mp3$/.exec(file);
        if (match ? used.has(match[1]!) : !/^[0-9a-f]{16}\.tmp$/.test(file)) continue; // bize ait olmayanlara dokunulmaz
        const full = path.join(this.dir, file);
        const stat = await fs.promises.stat(full).catch(() => null);
        if (!stat || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
        await fs.promises.rm(full, { force: true });
        removed++;
      }
      if (removed > 0) this.log?.info({ removed }, 'kullanılmayan giriş sesleri silindi');
      return removed;
    });
  }

  private async removeFile(hash: string): Promise<void> {
    if (INTRO_SOUND_HASH.test(hash)) await fs.promises.rm(this.pathOf(hash), { force: true });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const unsupported = (): UploadError => new UploadError(400, 'unsupported', 'Ses dosyası okunamadı.');
