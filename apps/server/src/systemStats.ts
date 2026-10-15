import fs from 'node:fs';
import path from 'node:path';

// Sunucu makinesinin yükü (yönetim paneli): CPU, bellek, disk ve aylık trafik sayacı. Linux'ta /proc'tan okunur
// (API kapsayıcısı host ağında çalıştığından /proc/net/dev makinenin gerçek arayüzlerini gösterir; /proc/stat,
// /proc/meminfo ve /proc/loadavg kapsayıcıda da makinenin değerleridir). /proc yoksa (Windows'ta geliştirme)
// yalnızca `available: false` döner. Testler sahte bir /proc klasörü verir (procRoot).
// Anlık ağ hızı burada ölçülmez (tek ağ örnekleyicisi netSeconds.ts'tedir); /proc/net/dev yalnızca aylık kota
// sayacı için okunur.

/** /proc/stat ilk satırından: toplam ve boşta geçen CPU süresi (jiffy) */
export interface CpuTimes {
  total: number;
  idle: number;
}

export function parseCpu(text: string): { times: CpuTimes; cores: number } | null {
  const lines = text.split('\n');
  const first = lines.find((l) => l.startsWith('cpu '));
  if (!first) return null;
  const v = first.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal (guest ve guest_nice zaten user'ın içinde)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  const cores = lines.filter((l) => /^cpu\d+\s/.test(l)).length;
  return {
    times: { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait },
    cores: Math.max(cores, 1),
  };
}

/** İki ölçüm arasındaki CPU kullanımı (0..1); ölçülemiyorsa null */
export function cpuUsage(prev: CpuTimes, cur: CpuTimes): number | null {
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

/** Bayt cinsinden toplam ve kullanılabilir bellek */
export function parseMeminfo(text: string): { total: number; available: number } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  if (!total) return null;
  // Çok eski çekirdeklerde MemAvailable yok: boş + önbellekler yaklaşık değerdir
  const available = kb('MemAvailable') ?? (kb('MemFree') ?? 0) + (kb('Buffers') ?? 0) + (kb('Cached') ?? 0);
  return { total, available: Math.min(available, total) };
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const v = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return v.length === 3 && v.every((n) => Number.isFinite(n)) ? [v[0]!, v[1]!, v[2]!] : null;
}

export function parseUptime(text: string): number | null {
  const v = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(v) ? v : null;
}

export type NetCounters = Record<string, { rx: number; tx: number }>;

/** /proc/net/dev: arayüz başına alınan (rx) ve gönderilen (tx) bayt sayaçları */
export function parseNetDev(text: string): NetCounters {
  const result: NetCounters = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || name.includes('|') || fields.length < 9) continue;
    const rx = fields[0]!;
    const tx = fields[8]!;
    if (Number.isFinite(rx) && Number.isFinite(tx)) result[name] = { rx, tx };
  }
  return result;
}

/** /proc/net/route: varsayılan yolun (0.0.0.0/0) geçtiği arayüzler */
export function defaultRouteInterfaces(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n').slice(1)) {
    const [iface, destination] = line.trim().split(/\s+/);
    if (iface && destination === '00000000') names.add(iface);
  }
  return [...names];
}

const VIRTUAL_INTERFACE = /^(lo|docker|veth|br-|virbr|cni|flannel|kube|tun|tap|wg|tailscale|zt)/;

/**
 * Trafiği sayılacak arayüzler: varsayılan yolun geçtiği (dış) arayüzler; bulunamazsa sanal olmayanlar.
 * Kapsayıcı köprüleri (docker0, veth…) sayılmaz: onların trafiği zaten dış arayüzden de geçer.
 */
export function pickInterfaces(counters: NetCounters, routeText: string | null): string[] {
  const routed = routeText ? defaultRouteInterfaces(routeText).filter((n) => n in counters) : [];
  if (routed.length > 0) return routed.sort();
  return Object.keys(counters)
    .filter((n) => !VIRTUAL_INTERFACE.test(n))
    .sort();
}

// ---------- Aylık trafik sayacı ----------

export interface TrafficMonth {
  /** YYYY-AA (UTC) */
  month: string;
  rx: number;
  tx: number;
}

/** Kalıcı trafik durumu (<dataDir>/traffic.json) */
export interface TrafficState {
  v: 1;
  /** Makinenin açılış kimliği (/proc/sys/kernel/random/boot_id): değişince sayaçlar sıfırdan başlamıştır */
  bootId: string | null;
  /** Arayüz başına son okunan sayaçlar */
  counters: NetCounters;
  month: string;
  rx: number;
  tx: number;
  /** Bu ayın sayımının başladığı an (ay başı ya da takibin başladığı an) */
  since: number;
  /** Önceki aylar, eskiden yeniye (en fazla 12) */
  history: TrafficMonth[];
}

export const monthKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const monthStart = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/**
 * Sayaçların son okumadan bu yana artışını bu ayın toplamına ekler. Makine yeniden başladıysa (açılış kimliği
 * değişti) ya da bir sayaç geriye gittiyse (arayüz yeniden kuruldu) sayaç sıfırdan başlamıştır: o arayüzün
 * şu anki değerinin tamamı eklenir. Yeni görülen arayüzün sayacı da açılıştan beri olan trafiktir. Takip ilk
 * kez başlarken makine bu ay açıldıysa (`bootedAt`) sayaçların tamamı bu ayındır, `since` açılış anı olur;
 * yoksa önceki trafik bilinemediğinden sıfırdan başlanır (`since` o an). Ay değişince biten ay geçmişe yazılır.
 */
export function updateTraffic(
  state: TrafficState | null,
  bootId: string | null,
  counters: NetCounters,
  now: number,
  bootedAt: number | null = null,
): TrafficState {
  const month = monthKey(now);
  if (!state) {
    if (bootedAt !== null && bootedAt <= now && monthKey(bootedAt) === month) {
      const sum = Object.values(counters).reduce((s, c) => ({ rx: s.rx + c.rx, tx: s.tx + c.tx }), { rx: 0, tx: 0 });
      return { v: 1, bootId, counters, month, ...sum, since: Math.round(bootedAt), history: [] };
    }
    return { v: 1, bootId, counters, month, rx: 0, tx: 0, since: now, history: [] };
  }
  let { rx, tx, since, history } = state;
  if (state.month !== month) {
    history = [...history, { month: state.month, rx, tx }].slice(-12);
    rx = 0;
    tx = 0;
    since = monthStart(now);
  }
  // Açılış kimliği okunamıyorsa yeniden başlatma sayacın geriye gitmesinden anlaşılır
  const sameBoot = bootId === null || state.bootId === null || bootId === state.bootId;
  for (const [name, cur] of Object.entries(counters)) {
    const prev = sameBoot ? state.counters[name] : undefined;
    rx += prev && cur.rx >= prev.rx ? cur.rx - prev.rx : cur.rx;
    tx += prev && cur.tx >= prev.tx ? cur.tx - prev.tx : cur.tx;
  }
  return { v: 1, bootId: bootId ?? state.bootId, counters, month, rx, tx, since, history };
}

function isTrafficState(value: unknown): value is TrafficState {
  const s = value as Partial<TrafficState> | null;
  return (
    !!s &&
    s.v === 1 &&
    typeof s.month === 'string' &&
    typeof s.rx === 'number' &&
    typeof s.tx === 'number' &&
    typeof s.since === 'number' &&
    typeof s.counters === 'object' &&
    s.counters !== null &&
    Array.isArray(s.history)
  );
}

/** Dosyaya bozulmadan yazar (önce geçici dosya, sonra yeniden adlandırma) */
let tmpSeq = 0;

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  // Her yazışın kendi geçici dosyası: eşzamanlı iki yazış (ör. kapanırken) birbirinin dosyasını bozmaz
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(value));
  await fs.promises.rename(tmp, file);
}

/** Başlangıçta bir kez, küçük dosya: eşzamanlı okunur. Yoksa ya da bozuksa null. */
export function readJsonSync(file: string | null): unknown {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// ---------- Ölçüm ----------

/** Geçmişteki bir ölçüm (panelin küçük grafikleri) */
export interface SystemSample {
  at: number;
  /** CPU kullanımı 0..1 */
  cpu: number | null;
  /** Kullanılan bellek (bayt) */
  memUsed: number | null;
  /** Bağlı hesaplar ve sesteki kişiler */
  online: number;
  voice: number;
}

export interface SystemSnapshot {
  /** /proc okunabildi (Linux) */
  available: boolean;
  sampledAt: number | null;
  cpu: { cores: number; usage: number | null; load: [number, number, number] | null } | null;
  memory: { total: number; available: number } | null;
  /** Veri klasörünün (veritabanı, dosyalar) bulunduğu disk */
  disk: { total: number; used: number; free: number } | null;
  /** Aylık trafiği sayılan (dış) arayüzler */
  network: { interfaces: string[] } | null;
  traffic: {
    month: string;
    rx: number;
    tx: number;
    since: number;
    /** Aylık kota (bayt; yalnızca giden trafik sayılır) */
    quota: number;
    history: TrafficMonth[];
  } | null;
  /** Makinenin açık kaldığı süre (sn) */
  hostUptimeSec: number | null;
}

export interface SystemMonitorOptions {
  /** /proc kökü (testlerde sahte klasör) */
  procRoot: string;
  /** Doluluğu ölçülecek disk üzerindeki bir yol (veri klasörü) */
  diskPath: string;
  /** Aylık trafik durumunun dosyası; null ise kalıcı değil (testler) */
  stateFile: string | null;
  /** Aylık trafik kotası (bayt) */
  quotaBytes: number;
  /** Geçmişte tutulan ölçüm sayısı */
  historySize?: number;
  log?: { warn(obj: object, msg: string): void };
}

/** Trafik dosyası en fazla bu sıklıkla yazılır (yeniden başlatmada en çok bu kadarlık trafik kaybolur) */
const PERSIST_INTERVAL_MS = 60_000;

export class SystemMonitor {
  private readonly history: SystemSample[] = [];
  private prev: { at: number; cpu: CpuTimes | null } | null = null;
  private latest: SystemSnapshot = {
    available: false,
    sampledAt: null,
    cpu: null,
    memory: null,
    disk: null,
    network: null,
    traffic: null,
    hostUptimeSec: null,
  };
  private traffic: TrafficState | null;
  private lastPersist = 0;
  private dirty = false;
  private inflight: Promise<void> | null = null;
  private persistWarned = false;

  constructor(private readonly opts: SystemMonitorOptions) {
    const saved = readJsonSync(opts.stateFile);
    this.traffic = isTrafficState(saved) ? saved : null;
  }

  private read(file: string): Promise<string | null> {
    return fs.promises.readFile(path.join(this.opts.procRoot, file), 'utf8').catch(() => null);
  }

  /** Son ölçüm `maxAgeMs`'ten yeni mi */
  fresh(maxAgeMs: number, now = Date.now()): boolean {
    return this.latest.sampledAt !== null && now - this.latest.sampledAt < maxAgeMs;
  }

  /** Yeni bir ölçüm alır (aynı anda gelen çağrılar aynı ölçümü bekler). */
  sample(counts: { online: number; voice: number }, now = Date.now()): Promise<void> {
    this.inflight ??= this.doSample(counts, now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doSample(counts: { online: number; voice: number }, now: number): Promise<void> {
    const [stat, meminfo, loadavg, uptime, netdev, route, bootRaw, disk] = await Promise.all([
      this.read('stat'),
      this.read('meminfo'),
      this.read('loadavg'),
      this.read('uptime'),
      this.read('net/dev'),
      this.read('net/route'),
      this.read('sys/kernel/random/boot_id'),
      fs.promises.statfs(this.opts.diskPath).catch(() => null),
    ]);
    const bootId = bootRaw?.trim() || null;
    const uptimeSec = uptime ? parseUptime(uptime) : null;
    const cpu = stat ? parseCpu(stat) : null;
    const memory = meminfo ? parseMeminfo(meminfo) : null;
    const counters = netdev ? parseNetDev(netdev) : null;
    const interfaces = counters ? pickInterfaces(counters, route) : [];
    const picked: NetCounters = {};
    for (const name of interfaces) picked[name] = counters![name]!;

    const prev = this.prev;
    const usage = prev?.cpu && cpu ? cpuUsage(prev.cpu, cpu.times) : null;
    this.prev = { at: now, cpu: cpu?.times ?? null };

    if (counters) {
      this.traffic = updateTraffic(this.traffic, bootId, picked, now, uptimeSec !== null ? now - uptimeSec * 1000 : null);
      this.dirty = true;
    }

    this.latest = {
      available: cpu !== null,
      sampledAt: now,
      cpu: cpu ? { cores: cpu.cores, usage, load: loadavg ? parseLoadavg(loadavg) : null } : null,
      memory,
      // df gibi: kullanılan = toplam - boş; kullanılabilir = ayrılmış bloklar hariç boş
      disk: disk
        ? { total: disk.blocks * disk.bsize, used: (disk.blocks - disk.bfree) * disk.bsize, free: disk.bavail * disk.bsize }
        : null,
      network: counters ? { interfaces } : null,
      traffic: this.traffic
        ? {
            month: this.traffic.month,
            rx: this.traffic.rx,
            tx: this.traffic.tx,
            since: this.traffic.since,
            quota: this.opts.quotaBytes,
            history: this.traffic.history,
          }
        : null,
      hostUptimeSec: uptimeSec,
    };
    this.history.push({
      at: now,
      cpu: usage,
      memUsed: memory ? memory.total - memory.available : null,
      online: counts.online,
      voice: counts.voice,
    });
    const max = this.opts.historySize ?? 180;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);

    if (now - this.lastPersist >= PERSIST_INTERVAL_MS) await this.persist(now);
  }

  snapshot(): { system: SystemSnapshot; history: SystemSample[] } {
    return { system: this.latest, history: [...this.history] };
  }

  /** Trafik durumunu dosyaya yazar (değiştiyse) */
  async persist(now = Date.now()): Promise<void> {
    if (!this.opts.stateFile || !this.dirty || !this.traffic) return;
    this.lastPersist = now;
    this.dirty = false;
    try {
      await writeJsonAtomic(this.opts.stateFile, this.traffic);
    } catch (err) {
      if (!this.persistWarned) this.opts.log?.warn({ err: String(err) }, 'trafik sayacı kaydedilemedi');
      this.persistWarned = true;
    }
  }
}
