import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  SOUNDBOARD_MAX_SOUNDS,
  SOUNDBOARD_SOUND_MAX_BYTES,
  SOUNDBOARD_SOUND_MAX_SECONDS,
  type GuildSound,
} from '@diskort/shared';
import { UploadError } from './attachments.js';
import { AVATAR_HASH, readLimited } from './avatars.js';
import type { Store } from './db.js';
import {
  ffmpegTranscode,
  INTRO_SOUND_MAX_START,
  INTRO_SOUND_MIN_SECONDS,
  SOUND_ORPHAN_GRACE_MS,
  SOUND_OUTPUT_MAX_BYTES,
  type IntroSoundTranscode,
} from './introSounds.js';

/** Diskteki ve adresteki ad: sunucuya ve içeriğe göre özet (128 bit, küçük harf onaltılık; giriş sesleriyle aynı biçim) */
export const SOUND_HASH = AVATAR_HASH;
/** Diskte en az bu kadar yer kalmalı (dosya ekleriyle aynı eşik) */
const MIN_FREE_BYTES = 1024 ** 3;

export interface SoundUploadOptions {
  name: string;
  emoji: string | null;
  startSec?: number;
  durationSec?: number;
}

/**
 * Sunucuların ses paneli (bkz. docs/ses-paneli.md). Yüklenen ses giriş sesiyle aynı ffmpeg hattından geçer
 * (en çok 5 sn, ses yüksekliği eşitlenmiş 48 kHz mono MP3) ve <dir>/<özet>.mp3'e yazılır; özet sunucu
 * kimliğini de içerdiğinden aynı dosya başka sunucudan sunulamaz. Kayıt veritabanında (guild_sounds), sunucu
 * başına en çok SOUNDBOARD_MAX_SOUNDS. Dosya ses silinince, sunucu silinince ve temizlikte (artık dosyalar)
 * silinir.
 */
export class SoundboardService {
  /** İşlemler sırayla: aynı anda tek ffmpeg çalışır ve dosya/veritabanı güncellemeleri çakışmaz */
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

  /**
   * Gövdeyi okur, dönüştürür ve sunucunun ses paneline ekler. Ad ve emoji çağıran tarafından doğrulanmış
   * olmalı (bkz. routes/soundboard.ts). Hatalar UploadError: 400 invalid_start|invalid_duration|unsupported|
   * empty, 404 not_found (sunucu silindi), 409 sound_limit, 413 too_large, 503 unavailable, 507 no_space.
   */
  async upload(
    guildId: string,
    uploaderId: string | null,
    body: Readable,
    declaredSize: number | null,
    opts: SoundUploadOptions,
  ): Promise<GuildSound> {
    const startSec = opts.startSec ?? 0;
    const durationSec = opts.durationSec ?? SOUNDBOARD_SOUND_MAX_SECONDS;
    if (!Number.isFinite(startSec) || startSec < 0 || startSec > INTRO_SOUND_MAX_START) {
      throw new UploadError(400, 'invalid_start', 'Başlangıç noktası geçersiz.');
    }
    if (!Number.isFinite(durationSec) || durationSec < INTRO_SOUND_MIN_SECONDS || durationSec > SOUNDBOARD_SOUND_MAX_SECONDS) {
      throw new UploadError(400, 'invalid_duration', 'Süre geçersiz.');
    }
    if (this.store.countSounds(guildId) >= SOUNDBOARD_MAX_SOUNDS) throw limitReached();
    await this.ensureSpace(SOUNDBOARD_SOUND_MAX_BYTES);
    let input: Buffer;
    try {
      input = await readLimited(body, declaredSize, SOUNDBOARD_SOUND_MAX_BYTES, 'Ses dosyası');
    } catch (err) {
      if (err instanceof UploadError && err.code === 'empty_file') throw new UploadError(400, 'empty', 'Ses dosyası boş.');
      throw err;
    }
    return this.serial(async () => {
      let output: Buffer;
      try {
        output = await this.transcode(input, startSec, durationSec);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.log?.warn({ err: String(err) }, 'ffmpeg bulunamadı; ses paneli sesi işlenemiyor');
          throw new UploadError(503, 'unavailable', 'Ses şu an işlenemiyor, sonra yeniden dene.');
        }
        this.log?.info({ err: String(err) }, 'ses paneli sesi dönüştürülemedi');
        throw unsupported();
      }
      if (output.length === 0 || output.length > SOUND_OUTPUT_MAX_BYTES) throw unsupported();
      const hash = createHash('sha256').update(`sound:${guildId}`).update('\0').update(output).digest('hex').slice(0, 32);
      await fs.promises.mkdir(this.dir, { recursive: true });
      const temp = path.join(this.dir, `${randomBytes(8).toString('hex')}.tmp`);
      try {
        await fs.promises.writeFile(temp, output, { flag: 'wx' });
        await fs.promises.rename(temp, this.pathOf(hash));
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        throw err;
      }
      // Süre çıktıdan tahmin edilir (96 kb/sn), en çok istenen süre; 100 ms'ye yuvarlanır
      const durationMs = Math.min(Math.max(100, Math.round(((output.length * 8) / 96000) * 10) * 100), Math.round(durationSec * 1000));
      const result = this.store.insertSound(
        guildId,
        { name: opts.name, emoji: opts.emoji, hash, size: output.length, durationMs, uploaderId },
        SOUNDBOARD_MAX_SOUNDS,
      );
      if (result === null || result === 'limit') {
        // Sunucu bu arada silindi ya da sınır eşzamanlı yüklemeyle doldu: dosya başka sese ait değilse silinir
        if (!this.store.soundHashes().has(hash)) await this.removeFile(hash);
        if (result === null) throw new UploadError(404, 'not_found', 'Sunucu bulunamadı.');
        throw limitReached();
      }
      return result;
    });
  }

  /** Ad ve/veya emoji değişir (disk işi yok); ses yoksa null */
  rename(guildId: string, soundId: string, patch: { name?: string; emoji?: string | null }): GuildSound | null {
    return this.store.renameSound(guildId, soundId, patch);
  }

  /** Sesi siler (dosyasıyla); ses yoksa null */
  remove(guildId: string, soundId: string): Promise<GuildSound | null> {
    return this.serial(async () => {
      const sound = this.store.getSound(soundId, guildId);
      if (!sound) return null;
      const hash = this.store.deleteSound(guildId, soundId);
      if (hash) await this.removeFile(hash);
      return sound;
    });
  }

  /** Silinen sunucunun dosyaları (özetler sunucu silinmeden önce alınır). */
  removeDeleted(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return Promise.resolve();
    return this.serial(async () => {
      const used = this.store.soundHashes();
      for (const hash of new Set(hashes)) if (!used.has(hash)) await this.removeFile(hash);
    });
  }

  /** Temizlik: hiçbir sesin kullanmadığı (yarım kalmış, eski yedekten kalan) dosyaları siler. */
  sweep(now = Date.now()): Promise<number> {
    return this.serial(async () => {
      const files = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
      const used = this.store.soundHashes();
      let removed = 0;
      for (const file of files) {
        const match = /^([0-9a-f]{32})\.mp3$/.exec(file);
        if (match ? used.has(match[1]!) : !/^[0-9a-f]{16}\.tmp$/.test(file)) continue; // bize ait olmayanlara dokunulmaz
        const full = path.join(this.dir, file);
        const stat = await fs.promises.stat(full).catch(() => null);
        if (!stat || now - stat.mtimeMs < SOUND_ORPHAN_GRACE_MS) continue;
        await fs.promises.rm(full, { force: true });
        removed++;
      }
      if (removed > 0) this.log?.info({ removed }, 'kullanılmayan ses paneli sesleri silindi');
      return removed;
    });
  }

  private async ensureSpace(bytes: number): Promise<void> {
    const stats = await fs.promises.statfs(this.dir).catch(() => null);
    if (stats && stats.bavail * stats.bsize - bytes < MIN_FREE_BYTES) {
      throw new UploadError(507, 'no_space', 'Sunucuda yer kalmadı, ses yüklenemiyor.');
    }
  }

  private async removeFile(hash: string): Promise<void> {
    if (SOUND_HASH.test(hash)) await fs.promises.rm(this.pathOf(hash), { force: true });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const unsupported = (): UploadError => new UploadError(400, 'unsupported', 'Ses dosyası okunamadı.');
const limitReached = (): UploadError =>
  new UploadError(409, 'sound_limit', `Sunucuda en çok ${SOUNDBOARD_MAX_SOUNDS} ses olabilir.`);
