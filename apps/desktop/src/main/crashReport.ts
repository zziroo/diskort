import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, crashReporter, dialog, ipcMain, type BrowserWindow } from 'electron';
import type { CrashContext } from '../shared/bridge';
import { buildDetail, CrashStore, EMPTY_CONTEXT, listDumps, parseCrashContext, pruneDumps, scrubPaths } from './crashStore';
import { createLogger } from './log';

/**
 * Süreç düzeyindeki çökmelerin bildirimi. Ana süreç şunları yakalar: arayüz süreci gitti (render-process-gone),
 * yardımcı süreç gitti (child-process-gone: GPU, ses/ağ hizmeti…), pencere yanıt vermiyor / yeniden yanıt
 * veriyor, ana süreçte yakalanmamış hata ve reddedilen söz. Her bildirim önce diske yazılır (bkz. crashStore.ts),
 * arayüz hazır olunca mevcut istemci hatası yoluyla sunucuya gönderir (POST /api/client-errors; oturum jetonu
 * arayüzdedir) ve gönderileni kuyruktan sildirir. Çökme gönderime engel olursa bildirim sonraki açılışta gider.
 *
 * Electron'un crashReporter'ı yalnızca yerel döküm (minidump) yazmak için açılır (uploadToServer: false):
 * döküm hiçbir yere gönderilmez; bildirime yalnızca dosya adı ve boyutu girer. Mesaj ve yığındaki yerel yollar
 * (kullanıcı adını taşır) saklanmadan önce yer tutucularla değiştirilir. Davranış değişmez: arayüz
 * çökünce yeniden yükleme yapılmaz, ana süreç hatasında Electron'un varsayılan hata penceresi yine gösterilir.
 */

const log = createLogger('crash');

/** Saklanan en fazla yerel döküm */
const KEEP_DUMPS = 10;
/** Döküm dosyası olaydan kısa süre sonra yazılır: bu kadar beklenip aranır */
const DUMP_LOOKUP_DELAY_MS = 2_500;
/** Olaydan en çok bu kadar önce yazılmış döküm o olaya ait sayılır */
const DUMP_MATCH_MS = 30_000;
/** Oturum başına en fazla "yanıt vermiyor" bildirimi */
const MAX_UNRESPONSIVE = 5;
/** Oturum başına en fazla ana süreç hatası bildirimi (döngüdeki hata diski ve sunucuyu doldurmasın) */
const MAX_MAIN_ERRORS = 10;

let store: CrashStore | null = null;
let context: CrashContext = EMPTY_CONTEXT;
let getWindow: () => BrowserWindow | null = () => null;
let isQuitting: () => boolean = () => false;
let mainErrors = 0;
const seenMainErrors = new Set<string>();
/** Bu süre içinde birden çok 'killed' olayı = uygulama dışarıdan kapatılıyor, bildirilmez */
const KILLED_BURST_MS = 2_000;
let lastKilledAt = 0;
let killedTimer: NodeJS.Timeout | null = null;

const dumpDir = (): string | null => {
  try {
    return app.getPath('crashDumps');
  } catch {
    return null;
  }
};

/** Ortam: sürümler, işletim sistemi, ekran kartı özellik durumu, süreçlerin bellek/işlemci özeti, ses durumu */
function environment(): Record<string, unknown> {
  const info: Record<string, unknown> = {
    at: new Date().toISOString(),
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    os: `${process.platform} ${process.getSystemVersion()} ${process.arch}`,
    uptimeSec: Math.round(process.uptime()),
    context,
  };
  try {
    info.mainRssMb = Math.round(process.memoryUsage().rss / 1048576);
  } catch {
    // okunamadı
  }
  try {
    info.processes = app.getAppMetrics().map((m) => ({
      t: m.type,
      ...(m.serviceName || m.name ? { n: m.serviceName ?? m.name } : {}),
      memMb: Math.round(m.memory.workingSetSize / 1024),
      cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    }));
  } catch {
    // uygulama hazır değilken okunamaz
  }
  try {
    info.gpu = app.getGPUFeatureStatus();
  } catch {
    // uygulama hazır değilken okunamaz
  }
  return info;
}

/**
 * Bildirimi diske yazar ve arayüze haber verir (hazırsa hemen gönderir). `notify` false ise haber verilmez:
 * süreç çökmelerinde önce döküm dosyası aranır (bkz. attachDumpLater), bildirim adıyla birlikte gider.
 */
function report(where: string, message: string, extra: Record<string, unknown> = {}, stack?: string, notify = true): string | null {
  if (!store) return null;
  try {
    const id = store.add(where, message, buildDetail({ ...extra, ...environment() }, stack));
    log.warn(`${where}: ${message}`);
    if (notify) notifyRenderer();
    return id;
  } catch (err) {
    log.error(err);
    return null;
  }
}

function notifyRenderer(): void {
  const wc = getWindow()?.webContents;
  if (wc && !wc.isDestroyed() && !wc.isCrashed()) wc.send('crash:pending');
}

/**
 * Olaydan sonra yazılan döküm dosyasını bulup bildirime ekler, sonra arayüze haber verir. Bildirim bu arada
 * diskte durur: uygulama o sırada kapanırsa sonraki açılışta (dökümsüz) gider.
 */
function attachDumpLater(id: string | null, since: number): void {
  if (!id) return;
  setTimeout(() => {
    try {
      const dir = dumpDir();
      const dump = dir ? listDumps(dir).find((d) => d.mtimeMs >= since - DUMP_MATCH_MS) : undefined;
      if (dump) store?.attachDump(id, dump);
    } catch (err) {
      log.warn(err);
    }
    notifyRenderer();
  }, DUMP_LOOKUP_DELAY_MS);
}

/**
 * 'killed' olayları: süreç dışarıdan sonlandırıldı. Aynı anda birden çok süreç gidiyorsa uygulama kapatılıyordur
 * (oturum kapatma, SIGTERM, görev yöneticisi; `isQuitting` henüz true olmadan gelir): canlıda 0.9.6'da bütün
 * çocuk süreçler aynı anda "killed" bildiriyordu, gürültüydü. Tek başına gelen 'killed' ise bellek baskısı
 * (macOS jetsam, Linux OOM) ya da yanıt vermeyen sürecin öldürülmesi olabilir: bildirilir. Bunun için olay
 * kısa süre bekletilir; o sürede başka 'killed' gelirse hepsi atılır. Diğer nedenler hemen bildirilir.
 */
function maybeKilled(reason: string, emit: () => void): void {
  if (reason !== 'killed') {
    emit();
    return;
  }
  const now = Date.now();
  const burst = now - lastKilledAt < KILLED_BURST_MS;
  lastKilledAt = now;
  if (killedTimer) {
    clearTimeout(killedTimer);
    killedTimer = null;
  }
  if (burst) return;
  killedTimer = setTimeout(() => {
    killedTimer = null;
    if (!isQuitting()) emit();
  }, KILLED_BURST_MS);
}

function reportMainError(kind: 'hata' | 'reddedilen söz', error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const key = `${kind}:${err.message}`;
  if (seenMainErrors.has(key) || mainErrors >= MAX_MAIN_ERRORS) return;
  seenMainErrors.add(key);
  mainErrors++;
  report('masaustu-ana', `Ana süreçte yakalanmamış ${kind}: ${err.message}`, { type: kind === 'hata' ? 'uncaughtException' : 'unhandledRejection' }, err.stack);
}

/**
 * Uygulama hazır olmadan önce çağrılır: yerel döküm yazımını açar ve ana sürecin yakalanmamış hatalarını
 * dinlemeye başlar.
 */
export function startCrashCapture(): void {
  try {
    crashReporter.start({ uploadToServer: false, productName: 'Diskort', compress: true });
  } catch (err) {
    log.warn(err);
  }
  // Hata mesajı ve yığınındaki mutlak yollar (işletim sistemi kullanıcı adını taşır) bildirime girmez
  const places: [string, string][] = [];
  try {
    places.push([app.getAppPath(), '<app>']);
  } catch {
    // uygulama yolu okunamadı
  }
  places.push([homedir(), '~']);
  store = new CrashStore(join(app.getPath('userData'), 'crash-reports.json'), Date.now, (text) => scrubPaths(text, places));

  process.on('uncaughtException', (error) => {
    reportMainError('hata', error);
    // Dinleyici eklemek Electron'un varsayılan hata penceresini kapatır: aynısı gösterilir (davranış değişmesin)
    try {
      const stack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
      dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${stack}`);
    } catch {
      // pencere gösterilemedi
    }
  });
  process.on('unhandledRejection', (reason) => {
    reportMainError('reddedilen söz', reason);
    // Dinleyici yokken Node uyarıyı konsola yazar: aynısı
    console.error('Unhandled promise rejection:', reason);
  });
}

/** Uygulama hazır olunca: süreç olayları, arayüzle IPC ve önceki oturumdan kalan dökümler */
export function registerCrashReporting(opts: { getWindow: () => BrowserWindow | null; isQuitting: () => boolean }): void {
  getWindow = opts.getWindow;
  isQuitting = opts.isQuitting;

  app.on('render-process-gone', (_e, wc, details) => {
    if (details.reason === 'clean-exit' || isQuitting()) return;
    const at = Date.now();
    let frame = 'arayüz';
    try {
      if (wc !== getWindow()?.webContents) frame = 'alt çerçeve';
    } catch {
      // pencere kapanmış olabilir
    }
    maybeKilled(details.reason, () => {
      const id = report(
        'masaustu-surec',
        `Arayüz süreci sonlandı (${frame}): ${details.reason} (çıkış kodu ${details.exitCode})`,
        { type: 'render-process-gone', reason: details.reason, exitCode: details.exitCode },
        undefined,
        false,
      );
      attachDumpLater(id, at);
    });
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || isQuitting()) return;
    const at = Date.now();
    const named = details.serviceName ?? details.name;
    const name = named && named !== details.type ? named : undefined;
    maybeKilled(details.reason, () => {
      const id = report(
        'masaustu-surec',
        `${details.type}${name ? ` (${name})` : ''} süreci sonlandı: ${details.reason} (çıkış kodu ${details.exitCode})`,
        { type: 'child-process-gone', process: details.type, name: name ?? null, reason: details.reason, exitCode: details.exitCode },
        undefined,
        false,
      );
      attachDumpLater(id, at);
    });
  });

  ipcMain.on('crash:context', (_e, value: unknown) => {
    const next = parseCrashContext(value);
    if (next) context = next;
  });
  ipcMain.handle('crash:pending', () => store?.pending() ?? []);
  ipcMain.handle('crash:ack', (_e, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    store?.ack(ids.filter((id): id is string => typeof id === 'string').slice(0, 100));
  });

  // Önceki oturumdan kalan, bildirilmemiş dökümler (ör. ana süreç yerel olarak çöktü); eskiler silinir
  const dir = dumpDir();
  if (dir && store) {
    try {
      const added = store.reportNewDumps(listDumps(dir).slice(0, KEEP_DUMPS), buildDetail({ type: 'previous-session-dump', ...environment() }));
      if (added > 0) log.warn(`önceki oturumdan ${added} çökme dökümü bulundu`);
      pruneDumps(dir, KEEP_DUMPS);
    } catch (err) {
      log.warn(err);
    }
  }
}

/** Pencere oluşturulunca: "yanıt vermiyor" / "yeniden yanıt veriyor" */
export function watchWindowForHangs(win: BrowserWindow): void {
  let since: number | null = null;
  let count = 0;
  win.on('unresponsive', () => {
    if (since !== null || isQuitting()) return;
    since = Date.now();
    if (++count > MAX_UNRESPONSIVE) return;
    report('masaustu-yanitsiz', 'Pencere yanıt vermiyor', { type: 'unresponsive' });
  });
  win.on('responsive', () => {
    if (since === null) return;
    const sec = Math.round((Date.now() - since) / 100) / 10;
    since = null;
    if (count > MAX_UNRESPONSIVE) return;
    report('masaustu-yanitsiz', `Pencere yeniden yanıt veriyor (${sec} sn sonra)`, { type: 'responsive', hangSec: sec });
  });
}
