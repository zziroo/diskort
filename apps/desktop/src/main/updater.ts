import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, net } from 'electron';
import electronUpdater from 'electron-updater';
import { compareVersions } from '@diskort/shared';
import type { UpdateState, UpdateSupport } from '../shared/bridge';
import { UPDATE_FEED_URL } from '../shared/distribution';
import { createLogger } from './log';

const BACKGROUND_CHECK_MS = 30 * 60_000;
const DOWNLOAD_ATTEMPTS = 3;
/** Kanal dosyası (latest-mac.yml) indirme sınırları */
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 1_000_000;

export const updateLog = createLogger('updater');

/**
 * Zorunlu güncelleme sistemi (Discord'daki Update.exe akışının karşılığı):
 * - Açılışta: denetle → varsa indir → kur → yeni sürümle yeniden aç (bkz. startup.ts).
 * - Çalışırken: 30 dakikada bir ya da sunucu "yeni sürüm var" dediğinde arka planda indirir;
 *   kurulum uygulama kapanınca, boştayken veya kullanıcı "Yeniden başlat" deyince yapılır.
 * - Sunucu, en son sürümden eski istemcilerin bağlanmasına izin vermez (UPDATE_REQUIRED).
 * Güncellemeler https://diskort.ziroo.net/updates adresinden gelir (sunucu dosyaları yönlendirir).
 */
export class UpdateManager {
  readonly support: UpdateSupport;
  private state: UpdateState = { kind: 'idle' };
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private download: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly feedUrl = process.env.DISKORT_UPDATE_URL || UPDATE_FEED_URL;

  constructor() {
    const testFeed = Boolean(process.env.DISKORT_UPDATE_URL);
    if (!app.isPackaged && !testFeed) this.support = 'none';
    else if (process.platform === 'darwin') this.support = 'manual';
    else this.support = 'auto';

    if (this.support === 'auto') {
      const u = electronUpdater.autoUpdater;
      u.logger = updateLog;
      u.autoDownload = false;
      // İndirilmiş güncelleme, kullanıcı uygulamadan çıkınca sessizce kurulur
      u.autoInstallOnAppQuit = true;
      u.allowDowngrade = false;
      u.disableWebInstaller = true;
      u.forceDevUpdateConfig = testFeed && !app.isPackaged;
      // Dosyalar GitHub'dan gelir; GitHub tek istekte birden çok bayt aralığını desteklemez
      // (fark indirmesinde bu açık kalırsa her seferinde tam indirmeye düşer).
      u.setFeedURL({ provider: 'generic', url: this.feedUrl, useMultipleRangeRequest: false });
      u.on('download-progress', (p) => {
        const version = 'version' in this.state ? this.state.version : '';
        this.set({ kind: 'downloading', version, percent: p.percent, transferred: p.transferred, total: p.total });
      });
      // Güncellemeden hemen sonra kurulum programı kendi dosyasını hâlâ kullanıyor olabilir; biraz bekle
      if (app.isPackaged) setTimeout(removeInstalledPending, 60_000).unref();
    }
    updateLog.info(`Diskort ${app.getVersion()} (${process.platform}), güncelleme: ${this.support} ${this.feedUrl}`);
  }

  getState(): UpdateState {
    return this.state;
  }

  onState(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Yeni sürüm varsa numarasını döner. Ağ hatasında hata fırlatır. */
  async check(): Promise<string | null> {
    if (this.support === 'none') return null;
    if (this.state.kind === 'ready' || this.state.kind === 'downloading' || this.state.kind === 'installing') {
      return this.state.version;
    }
    this.set({ kind: 'checking' });
    try {
      const version = this.support === 'auto' ? await this.checkAuto() : await this.checkManual();
      this.set(version ? { kind: 'available', version } : { kind: 'idle' });
      return version;
    } catch (err) {
      this.set({ kind: 'error', message: describe(err) });
      throw err;
    }
  }

  /** Denetlenmiş güncellemeyi indirir (birkaç kez dener); zaten iniyorsa aynı işi bekler. */
  downloadUpdate(): Promise<void> {
    if (this.support !== 'auto') return Promise.reject(new Error('Bu platformda otomatik güncelleme yok.'));
    if (this.state.kind === 'ready') return Promise.resolve();
    this.download ??= this.downloadWithRetry().finally(() => {
      this.download = null;
    });
    return this.download;
  }

  /** İndirilmiş güncellemeyi kurar ve uygulamayı yeni sürümle yeniden açar. */
  install(silent: boolean): void {
    if (this.state.kind !== 'ready') throw new Error('Kurulacak güncelleme yok.');
    updateLog.info(`${this.state.version} kuruluyor (sessiz: ${silent})`);
    this.set({ kind: 'installing', version: this.state.version });
    // Pencerelerin kapanıp kurulum başlamadan önce durumun gösterilebilmesi için kısa gecikme
    setTimeout(() => electronUpdater.autoUpdater.quitAndInstall(silent, true), 300);
  }

  /** Çalışırken düzenli denetim: yeni sürüm bulunursa arka planda indirilir. */
  startBackgroundChecks(): void {
    if (this.support === 'none' || this.timer) return;
    this.timer = setInterval(() => void this.checkInBackground(), BACKGROUND_CHECK_MS);
  }

  async checkInBackground(): Promise<void> {
    try {
      const version = await this.check();
      if (version && this.support === 'auto') await this.downloadUpdate();
    } catch (err) {
      updateLog.warn(`Arka plan denetimi başarısız: ${describe(err)}`);
    }
  }

  private async checkAuto(): Promise<string | null> {
    const result = await electronUpdater.autoUpdater.checkForUpdates();
    return result?.isUpdateAvailable ? result.updateInfo.version : null;
  }

  /** macOS: kanal dosyasındaki sürümü okuyup karşılaştırır (indirme kullanıcıya bırakılır). */
  private async checkManual(): Promise<string | null> {
    const res = await fetchText(`${this.feedUrl}/latest-mac.yml`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Sürüm bilgisi alınamadı (${res.status}).`);
    const version = /^version:\s*['"]?([^\s'"]+)/m.exec(res.body)?.[1];
    return version && compareVersions(version, app.getVersion()) > 0 ? version : null;
  }

  private async downloadWithRetry(): Promise<void> {
    const version = 'version' in this.state ? this.state.version : '';
    for (let attempt = 1; ; attempt++) {
      try {
        this.set({ kind: 'downloading', version, percent: 0, transferred: 0, total: 0 });
        const files = await electronUpdater.autoUpdater.downloadUpdate();
        updateLog.info(`${version} indirildi: ${files.join(', ')}`);
        this.set({ kind: 'ready', version });
        return;
      } catch (err) {
        updateLog.warn(`İndirme denemesi ${attempt} başarısız: ${describe(err)}`);
        if (attempt >= DOWNLOAD_ATTEMPTS) {
          this.set({ kind: 'error', message: describe(err) });
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    if (state.kind !== 'downloading') updateLog.info(`durum: ${JSON.stringify(state)}`);
    for (const listener of this.listeners) listener(state);
  }
}

/**
 * Küçük bir metin dosyasını Chromium ağ yığınıyla indirir. `net.fetch` kullanılmıyor: Electron'un fetch sarmalayıcısı
 * 200–599 dışı bir durum kodu (ör. kesilen bağlantıda 0) gelince `new Response` içinde RangeError fırlatıyor ve bu
 * hata promise'e değil ana sürecin yakalanmamış hata penceresine düşüyordu (0.9.6'da canlıda görüldü).
 */
function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', cache: 'no-store' });
    // Chromium'da genel okuma zaman aşımı yok: yanıt vermeyen sunucuda istek sonsuza dek beklemesin
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error('Sürüm bilgisi zaman aşımına uğradı (ETIMEDOUT).');
      req.abort();
    }, FETCH_TIMEOUT_MS);
    const fail = (err: Error): void => {
      clearTimeout(timer);
      reject(failure ?? err);
    };
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > FETCH_MAX_BYTES) {
          failure = new Error('Sürüm bilgisi beklenenden büyük.');
          req.abort();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (err: Error) => fail(err));
      res.on('aborted', () => fail(new Error('Bağlantı kesildi.')));
    });
    req.on('error', fail);
    req.on('abort', () => fail(new Error('İstek iptal edildi.')));
    req.end();
  });
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return 'İnternet bağlantısı yok ya da sunucuya ulaşılamıyor.';
  }
  return message.split('\n')[0]!.slice(0, 200);
}

/**
 * Kurulan güncellemenin indirme kopyası ("pending" klasörü, ~100 MB) bir sonraki güncellemeye kadar
 * boşuna yer kaplar; sürümü şu an çalışan sürümden yeni değilse silinir. (Önbellekteki installer.exe
 * kalır: sonraki güncellemede yalnızca değişen blokların indirilmesi için gerekir.)
 */
function removeInstalledPending(): void {
  try {
    const config = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const cacheName = /^updaterCacheDirName:\s*['"]?([^\s'"]+)/m.exec(config)?.[1];
    if (!cacheName) return;
    const base =
      process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
    const pending = join(base, cacheName, 'pending');
    const info = JSON.parse(readFileSync(join(pending, 'update-info.json'), 'utf8')) as { fileName?: string };
    const version = /(\d+\.\d+\.\d+)/.exec(info.fileName ?? '')?.[1];
    if (version && compareVersions(version, app.getVersion()) <= 0) {
      rmSync(pending, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
      updateLog.info(`Kurulmuş güncellemenin indirme kopyası silindi (${version})`);
    }
  } catch (err) {
    // Bekleyen güncelleme yoksa (ENOENT) sessiz geç; başka hata günlüğe yazılır, sonraki açılışta yeniden denenir
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') updateLog.warn(`İndirme kopyası silinemedi: ${String(err)}`);
  }
}
