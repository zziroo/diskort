// Etkinlik: oynanan oyunların algılanması (yalnızca Windows). Tarayıcının bulduğu süreçler sınıflandırılır,
// açık oyunlar (en son başlatılan ilk sırada) arayüze bildirilir; arayüz de sunucuya iletir. Ayarlar (açık/kapalı, elle eklenen
// ve gizlenen oyunlar, daha önce algılananlar) bu bilgisayara özgüdür: kullanıcı verilerinde activity.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { ActivityGame, ActivityProgram, ActivitySettings, ActivityState } from '../../shared/bridge';
import { createLogger } from '../log';
import { currentGames, detectGames, exeBaseName, programName, type DetectedGame, type ScannedProcess } from './classify';
import { IconStore } from './icons';
import { EMPTY_LIBRARIES, loadGameLibraries, pathKey, type GameLibraries, type LibraryGame } from './libraries';
import {
  addManualGame,
  defaultPrefs,
  isKnownPath,
  knownGames,
  rememberSeenGame,
  removeManualGame,
  sanitizePrefs,
  setGameHidden,
  type ActivityPrefs,
} from './prefs';
import { ActivityScanner } from './scanner';

/** Kurulu oyun kayıtları bu sıklıkta yeniden okunur (yeni kurulan oyun) */
const LIBRARY_REFRESH_MS = 10 * 60_000;
/** Ayar açılınca tarayıcı bu kadar sonra başlatılır: art arda aç/kapa her seferinde süreç başlatmasın */
const START_DELAY_MS = 1000;
/** Bundan yeni bir tarama varsa "Oyun ekle" yenisini istemez */
const FRESH_SCAN_MS = 1000;
/** "Oyun ekle" açılınca taze tarama bu kadar beklenir */
const PROGRAM_SCAN_WAIT_MS = 2500;
/** Yeni açılan oyunun ikonu en çok bu kadar beklenir (arayüze tek seferde, ikonuyla bildirilsin diye) */
const ICON_WAIT_MS = 1500;
/** Blizzard oyunlarının kurulum klasöründe bulunan dosya (Battle.net oyunları ortak bir klasöre kurulmaz) */
const BLIZZARD_MARKER = '.build.info';

const log = createLogger('activity');

export class ActivityMonitor {
  readonly supported = process.platform === 'win32';
  private prefs: ActivityPrefs = defaultPrefs();
  private started = false;
  /** Uygulamada oturum açık mı: giriş yapılmamışken kimseye bildirilecek bir şey yok, tarayıcı çalışmaz */
  private active = false;
  private procs: ScannedProcess[] = [];
  /** Açık oyunlar (en son başlatılan ilk sırada) ve süreçleri */
  private games: (ActivityGame & { pid: number })[] = [];
  private steamPath: string | null = null;
  private libraries: GameLibraries = EMPTY_LIBRARIES;
  private librariesAt = 0;
  /** exe yolu → Blizzard oyun klasörü (yoksa null); her yol bir kez yoklanır */
  private readonly blizzardDirs = new Map<string, string | null>();
  /** Başlangıç zamanı okunamayan süreçler için ilk görülme anı */
  private readonly firstSeen = new Map<string, number>();
  /** Taramalar sırayla işlenir */
  private queue: Promise<void> = Promise.resolve();
  private scanWaiters: (() => void)[] = [];
  private lastScanAt = 0;
  private startTimer: NodeJS.Timeout | null = null;
  private readonly scanner: ActivityScanner;
  private readonly icons: IconStore;

  constructor(private readonly emit: (state: ActivityState) => void) {
    this.scanner = new ActivityScanner({
      onReady: (steamPath) => {
        this.steamPath = steamPath;
        this.librariesAt = 0;
      },
      onScan: (procs) => {
        this.queue = this.queue.then(() => this.handleScan(procs, true)).catch((err) => log.warn(err));
      },
      onLog: (message) => log.info(message),
    });
    this.icons = new IconStore(join(app.getPath('userData'), 'activity-icons'), (path) => this.scanner.icon(path));
  }

  get state(): ActivityState {
    return { enabled: this.prefs.enabled, games: this.games.map(({ pid: _pid, ...game }) => game) };
  }

  start(): void {
    this.started = true;
    this.prefs = this.loadPrefs();
    this.updateRunning();
  }

  stop(): void {
    this.started = false;
    this.cancelStart();
    this.scanner.stop();
  }

  async settings(): Promise<ActivitySettings> {
    const games = await Promise.all(
      knownGames(this.prefs).map(async (game) => ({ ...game, icon: await this.icons.preview(game.path) })),
    );
    return { enabled: this.prefs.enabled, games };
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.updateRunning();
  }

  setEnabled(enabled: boolean): void {
    if (this.prefs.enabled === enabled) return;
    this.update({ ...this.prefs, enabled });
    this.updateRunning();
  }

  /** Çalışan programlardan birini oyun olarak ekler; yalnızca son taramada görülen yollar kabul edilir */
  addGame(path: string): void {
    const proc = this.procs.find((p) => pathKey(p.path) === pathKey(path));
    if (!proc || this.isSelf(proc)) return;
    this.update(addManualGame(this.prefs, { path: proc.path, name: programName(proc) }));
    this.rescan();
  }

  removeGame(path: string): void {
    this.update(removeManualGame(this.prefs, path));
    this.rescan();
  }

  /** Yalnızca bilinen oyunlar ve şu an çalışan programlar gizlenebilir */
  setHidden(path: string, hidden: boolean): void {
    if (!isKnownPath(this.prefs, this.procs.map((p) => p.path), path)) return;
    this.update(setGameHidden(this.prefs, path, hidden));
    this.rescan();
  }

  /** Görünür penceresi olan, henüz oyun sayılmayan programlar (taze bir taramadan) */
  async programs(): Promise<ActivityProgram[]> {
    if (!this.supported || !this.prefs.enabled || !this.active) return [];
    await this.freshScan();
    const games = new Set(detectGames(this.procs, this.context()).map((g) => pathKey(g.path)));
    const hidden = new Set(this.prefs.hidden.map(pathKey));
    const seen = new Set<string>();
    const list = this.procs.filter((proc) => {
      const key = pathKey(proc.path);
      if (seen.has(key) || games.has(key) || hidden.has(key) || this.isSelf(proc)) return false;
      seen.add(key);
      return true;
    });
    const programs = await Promise.all(
      list.map(async (proc) => ({ path: proc.path, name: programName(proc), icon: await this.icons.preview(proc.path) })),
    );
    return programs.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  iconBytes(key: string): Promise<Buffer | null> {
    return this.icons.bytes(key);
  }

  private isSelf(proc: ScannedProcess): boolean {
    return pathKey(proc.path) === pathKey(process.execPath) || exeBaseName(proc.path).toLowerCase() === 'diskort';
  }

  private context() {
    return { libraries: this.libraries, manual: this.prefs.manual, hidden: this.prefs.hidden, selfPath: process.execPath };
  }

  private updateRunning(): void {
    if (!this.started || !this.supported) return;
    this.cancelStart();
    if (this.prefs.enabled && this.active) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (this.started && this.prefs.enabled && this.active) this.scanner.start();
      }, START_DELAY_MS);
    } else {
      // Kapatma (ya da çıkış) beklemez: oyun hemen bildirilmez olur
      this.scanner.stop();
      this.procs = [];
      this.games = [];
      this.emit(this.state);
    }
  }

  private cancelStart(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /** Ayar değişti: aynı süreçler yeni ayarlarla yeniden değerlendirilir */
  private rescan(): void {
    const procs = this.procs;
    this.queue = this.queue.then(() => this.handleScan(procs)).catch((err) => log.warn(err));
  }

  private freshScan(): Promise<void> {
    if (Date.now() - this.lastScanAt < FRESH_SCAN_MS) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.scanWaiters = this.scanWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, PROGRAM_SCAN_WAIT_MS);
      this.scanWaiters.push(done);
      this.scanner.requestScan();
    });
  }

  private async handleScan(procs: ScannedProcess[], fresh = false): Promise<void> {
    if (!this.prefs.enabled || !this.active) return;
    const now = Date.now();
    // Başlangıcı okunamayan süreç ilk görüldüğü anda başlamış sayılır
    const live = new Set<string>();
    this.procs = procs.map((proc) => {
      if (proc.startedAt > 0 && proc.startedAt <= now) return proc;
      const id = `${proc.pid}|${pathKey(proc.path)}`;
      live.add(id);
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, now);
      return { ...proc, startedAt: this.firstSeen.get(id)! };
    });
    for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);

    await this.refreshLibraries(now);
    const found = currentGames(detectGames(this.procs, this.context()));
    let prefs = this.prefs;
    for (const game of found) {
      if (game.source !== 'manual') prefs = rememberSeenGame(prefs, { path: game.path, name: game.name }, now);
    }
    this.update(prefs);
    await this.setGames(found);
    if (fresh) this.lastScanAt = Date.now();
    for (const waiter of [...this.scanWaiters]) waiter();
  }

  /** Mağaza kayıtlarını (gerekirse) yeniden okur; Blizzard klasörleri yeni görülen exe'ler için yoklanır */
  private async refreshLibraries(now: number): Promise<void> {
    let changed = false;
    let stores = this.libraries.games.filter((g) => g.source !== 'battlenet');
    if (!this.librariesAt || now - this.librariesAt > LIBRARY_REFRESH_MS) {
      stores = [...(await loadGameLibraries(this.steamPath, process.env.ProgramData)).games];
      this.librariesAt = now;
      changed = true;
    }
    for (const proc of this.procs) {
      const key = pathKey(proc.path);
      if (this.blizzardDirs.has(key)) continue;
      if (this.blizzardDirs.size > 2000) this.blizzardDirs.clear();
      this.blizzardDirs.set(key, await blizzardGameDir(proc.path));
      changed = true;
    }
    if (!changed) return;
    const blizzard = new Set([...this.blizzardDirs.values()].filter((dir) => dir !== null));
    const games: LibraryGame[] = [...stores, ...[...blizzard].map((dir) => ({ dir, name: null, source: 'battlenet' as const }))];
    this.libraries = { games };
  }

  /**
   * Açık oyunların listesini günceller; yalnızca gerçekten değiştiyse arayüze bildirir (sunucu sık
   * bildirimi sınırlar). Süren oyunun ikonu ve başlangıcı korunur; yeni oyunun ikonu kısa süre beklenir,
   * yetişmezse bir sonraki taramada eklenir.
   */
  private async setGames(found: readonly DetectedGame[]): Promise<void> {
    const previous = this.games;
    const next = await Promise.all(
      found.map(async (game) => {
        const same = previous.find((g) => g.pid === game.pid && pathKey(g.path) === pathKey(game.path));
        const icon = same?.icon ?? (await withTimeout(this.icons.keyFor(game.path), ICON_WAIT_MS));
        return {
          pid: game.pid,
          path: game.path,
          name: game.name,
          startedAt: same?.startedAt ?? game.startedAt,
          icon,
          steamAppId: game.steamAppId,
        };
      }),
    );
    if (!this.prefs.enabled || !this.active) return; // beklerken kapatıldı
    const unchanged =
      next.length === previous.length &&
      next.every((g, i) => {
        const p = previous[i]!;
        return (
          g.pid === p.pid &&
          g.path === p.path &&
          g.name === p.name &&
          g.icon === p.icon &&
          g.startedAt === p.startedAt &&
          g.steamAppId === p.steamAppId
        );
      });
    if (unchanged) return;
    this.games = next;
    this.emit(this.state);
  }

  private update(prefs: ActivityPrefs): void {
    if (prefs === this.prefs) return;
    this.prefs = prefs;
    try {
      writeFileSync(this.prefsFile(), JSON.stringify(prefs, null, 2));
    } catch (err) {
      log.warn(err); // kaydedilemezse ayar bu oturumda geçerli kalır
    }
  }

  private prefsFile(): string {
    return join(app.getPath('userData'), 'activity.json');
  }

  private loadPrefs(): ActivityPrefs {
    try {
      const file = this.prefsFile();
      return existsSync(file) ? sanitizePrefs(JSON.parse(readFileSync(file, 'utf8'))) : defaultPrefs();
    } catch {
      return defaultPrefs();
    }
  }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Exe'nin kendi klasöründe ya da en çok iki üstünde Blizzard kurulum dosyası varsa o klasör (pathKey) */
async function blizzardGameDir(exePath: string): Promise<string | null> {
  let dir = dirname(exePath);
  for (let depth = 0; depth < 3; depth++) {
    const parent = dirname(dir);
    if (parent === dir) return null; // sürücünün kökü
    try {
      await access(join(dir, BLIZZARD_MARKER));
      return pathKey(dir);
    } catch {
      dir = parent;
    }
  }
  return null;
}

export function registerActivityIpc(monitor: ActivityMonitor): void {
  ipcMain.handle('activity:get-state', () => monitor.state);
  ipcMain.handle('activity:get-settings', () => monitor.settings());
  ipcMain.handle('activity:set-active', (_e, active: unknown) => {
    if (typeof active === 'boolean') monitor.setActive(active);
  });
  ipcMain.handle('activity:set-enabled', (_e, enabled: unknown) => {
    if (typeof enabled === 'boolean') monitor.setEnabled(enabled);
    return monitor.settings();
  });
  ipcMain.handle('activity:list-programs', () => monitor.programs());
  ipcMain.handle('activity:add-game', (_e, path: unknown) => {
    if (typeof path === 'string') monitor.addGame(path);
    return monitor.settings();
  });
  ipcMain.handle('activity:remove-game', (_e, path: unknown) => {
    if (typeof path === 'string') monitor.removeGame(path);
    return monitor.settings();
  });
  ipcMain.handle('activity:set-hidden', (_e, path: unknown, hidden: unknown) => {
    if (typeof path === 'string' && typeof hidden === 'boolean') monitor.setHidden(path, hidden);
    return monitor.settings();
  });
  ipcMain.handle('activity:icon', async (_e, key: unknown): Promise<Uint8Array | null> => {
    const png = typeof key === 'string' ? await monitor.iconBytes(key) : null;
    return png ? new Uint8Array(png) : null;
  });
}
