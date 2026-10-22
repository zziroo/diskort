import fs from 'node:fs';
import path from 'node:path';
import type { ProbeOutage } from './netProbe.js';

// Bağlantı teşhisi: kısa kesintilerin kaydı. İki bağımsız işaret birleştirilir:
//  - "sonda" kesintisi (netProbe.ts): sunucudan dışarıya art arda sondalar yanıtsız (≥2 farklı hedef),
//  - "NIC sessizliği" (aşağıda): sunucuya gelen paket hızı neredeyse SIFIRA iniyor ve sonra geri geliyor.
// NIC sessizliği tek başına yalnızca bir ADAYDIR ("aday"): hiçbir sağlayıcı yargısını tek başına seçmez. Aynı
// saniyelerde dış sondalar da yanıtsız kaldıysa (kayıtlı sonda kesintisi ya da en az bir yanıtsız sonda) iki
// bağımsız işaret örtüşmüştür: tam kesinti (sağlayıcı/hipervizör ağı). Yalnızca sonda: dış yol kesik ama NIC'e
// paket gelmeye devam etmiş (ya da trafik dedektörün çalışamayacağı kadar azdı).
//
// Neden "neredeyse sıfır": gerçek sunucu verisinde gelen paket hızı kesinti olmadan da çok oynar (konuşma
// durunca ~250 → ~30 pk/sn, yayında ekran durağanlaşınca ~1100 → ~80 pk/sn). Ama biri bağlıyken canlı tutma /
// RTCP trafiği sessizlikte bile ~28 pk/sn'nin altına inmez; gerçek kesintilerde ise tek haneye düşer. Bu yüzden
// ölçüt ortancaya oran değil, canlı tutma tabanına göre mutlak bir "neredeyse sıfır" eşiğidir.
// Kayıt: <dataDir>/telemetry/outages.jsonl (çalışırken kırpılır; 14 gün). Saatler istatistik saat dilimiyle
// (STATS_UTC_OFFSET_MIN) okunaklı olarak da yazılır.

/** NIC sessizliği: gelen paket hızı neredeyse sıfıra indi ve geri geldi */
export interface NicSilence {
  /** Çöküşün başladığı an (ms; saniye çözünürlüğünde) */
  at: number;
  durationMs: number;
  /** Sessizlik sırasındaki en düşük paket/sn ve öncesindeki taban (son ~45 sn'nin %10'luk dilimi: canlı tutma tabanı) */
  rxpMin: number;
  baseline: number;
  /** O an sesteki kişi sayısı (bilinmiyorsa null) */
  participants: number | null;
  /**
   * Aynı saniyelerde (−2/+1 sn) yanıtsız kalan dış sonda sayısı ve hedefleri. Sessizlik ancak en az iki farklı
   * hedeften en az iki yanıtsız sondayla doğrulanmış sayılır (bkz. isCorroborated)
   */
  probesLost: number;
  probeTargets?: string[];
  /** Giden paket hızı da çöktü mü (SFU'nun iletecek bir şeyi kalmadı, TCP ACK saatleri durdu): destekleyici işaret */
  txCollapsed: boolean;
}

/** tam: NIC sessizliği + dış sondalar · sonda: yalnızca dış sondalar · aday: yalnızca NIC sessizliği (doğrulanmamış) */
export type OutageKind = 'tam' | 'sonda' | 'aday';

export const OUTAGE_KIND_LABELS: Record<OutageKind, string> = {
  tam: 'tam kesinti',
  sonda: 'yalnız sonda',
  aday: 'aday (yalnız NIC)',
};

export interface Outage {
  id: string;
  at: number;
  durationMs: number;
  /** Başlangıcın yerel saati, ör. "2026-10-01 01:23:47.200 +03:00" */
  t: string;
  kind: OutageKind;
  probe: ProbeOutage | null;
  nic: NicSilence | null;
  /**
   * Boş odada (seste kimse yokken) görülen aday: dosyaya yazılmaz, listelerde/özetlerde görünmez; yalnızca kısa süre
   * bellekte tutulur ki geç gelen bir sonda kesintisiyle birleşip tam kesinti olabilsin (o zaman alan silinir)
   */
  idle?: true;
}

/** NIC sessizliği yanıtsız sondalarla doğrulanmış mı: en az 2 yanıtsız sonda, en az 2 farklı hedef */
export const isCorroborated = (s: Pick<NicSilence, 'probesLost' | 'probeTargets'>): boolean => s.probesLost >= 2 && (s.probeTargets?.length ?? 0) >= 2;

/**
 * Yalnızca bir protokolün sondaları kesildi (proto: udp / tcp), NIC sessizliği yok: tüm dış yol kesintisi DEĞİL.
 * Sağlayıcı kesintisi yargısını seçmez, olay kaydı istemez; teşhiste ayrı ve zayıf bir işaret olarak anılır.
 */
export const isPartialProbeOutage = (o: Pick<Outage, 'kind' | 'probe'>): boolean =>
  o.kind === 'sonda' && (o.probe?.proto === 'udp' || o.probe?.proto === 'tcp');

/** Kesinti doğrulanmış mı (dış sondalarla); "aday" tek başına bir yargıyı seçemez */
export const isConfirmedOutage = (o: Pick<Outage, 'kind'>): boolean => o.kind === 'tam' || o.kind === 'sonda';

/** ms → "YYYY-AA-GG SS:DD:SN.mmm +03:00" (verilen saat dilimiyle) */
export function localStamp(ms: number, offsetMin: number): string {
  const iso = new Date(ms + offsetMin * 60_000).toISOString();
  const abs = Math.abs(offsetMin);
  const zone = `${offsetMin < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} ${zone}`;
}

// ---------- NIC sessizliği dedektörü (saf; saniyelik satırlarla sırayla beslenir) ----------

/** Verilen yüzdelik (0..1) */
const percentile = (v: number[], p: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

/** Taban için bakılan saniye sayısı ve en az gereken örnek */
const BASELINE_ROWS = 45;
const BASELINE_MIN_ROWS = 10;
/** Taban: son saniyelerin bu yüzdelik dilimi (en düşüklere yakın: konuşma/yayın yokkenki canlı tutma trafiği) */
const BASELINE_PERCENTILE = 0.1;
/**
 * Sessizlik eşiği (paket/sn): mutlak "neredeyse sıfır". Taban çok yüksekse (kalabalık sunucu) onun küçük bir
 * oranı kadar yükselir, ama üst sınırı geçmez.
 */
const SILENCE_ABS = 8;
const SILENCE_RATIO = 0.05;
const SILENCE_MAX = 40;
/** Dedektörün çalışması için gereken taban (paket/sn): bunun altında "neredeyse sıfır" olağan trafikten ayrılamaz */
const BASELINE_MIN = 20;
/** Giden yönün de çöktüğü: giden tabanın bu oranının (ve mutlak sınırın) altı */
const TX_COLLAPSE_RATIO = 0.3;
const TX_COLLAPSE_ABS = 25;
/** Geri gelme: sessizlik bittikten sonra bu kadar saniye içinde tabanın yarısına dönmeli */
const RECOVERY_RATIO = 0.5;
const RECOVERY_ROWS = 5;
/** Bundan uzun süren "sessizlik" kesinti değil seviye değişimidir (herkes çıktı) */
const MAX_SILENCE_ROWS = 60;
/** Satırlar arasında bundan uzun boşluk varsa (kayıt kesik) taban baştan kurulur */
const GAP_RESET_MS = 5_000;
/**
 * Sesteki kişi ya da yayın sayısı azaldıktan sonraki bu süre içinde başlayan çöküş kesinti sayılmaz: trafik
 * birinin çıkması / yayını kapatması yüzünden azalmıştır.
 */
const VOICE_CHANGE_MS = 3_000;

interface SilenceState {
  start: number;
  end: number;
  rows: number;
  min: number;
  txMin: number | null;
  baseline: number;
  txBaseline: number | null;
  threshold: number;
  participants: number | null;
  probesLost: number;
  probeTargets: Set<string>;
  /** Sessizlik bitti, geri gelme bekleniyor: geçen saniye */
  waited: number | null;
}

/** Sessizlik eşiği (paket/sn) */
export function silenceThreshold(baseline: number): number {
  return Math.min(SILENCE_MAX, Math.max(SILENCE_ABS, baseline * SILENCE_RATIO));
}

export interface SilenceInput {
  /** Satırın anı (ms) ve kapsadığı süre */
  t: number;
  intervalMs?: number;
  /** Gelen / giden paket hızı (paket/sn) */
  rxp: number | null;
  txp?: number | null;
  /** Sesteki kişi ve yayın sayısı (biliniyorsa) */
  participants?: number | null;
  streams?: number | null;
  /** Bu saniyenin çevresinde (−2/+1 sn) yanıtsız kalan dış sonda sayısı ve hedefleri */
  probesLost?: number;
  probeTargets?: string[];
}

export class NicSilenceDetector {
  private history: { rxp: number; txp: number | null }[] = [];
  private cur: SilenceState | null = null;
  private lastLoad: { participants: number; streams: number } | null = null;
  private loadDroppedAt = Number.NEGATIVE_INFINITY;
  private lastT: number | null = null;

  constructor(private readonly onSilence: (s: NicSilence) => void) {}

  private reset(): void {
    this.history = [];
    this.cur = null;
  }

  private remember(rxp: number, txp: number | null): void {
    this.history.push({ rxp, txp });
    if (this.history.length > BASELINE_ROWS) this.history.shift();
  }

  private finish(cur: SilenceState): NicSilence {
    return {
      at: cur.start,
      durationMs: Math.max(0, cur.end - cur.start),
      rxpMin: cur.min,
      baseline: Math.round(cur.baseline),
      participants: cur.participants,
      probesLost: cur.probesLost,
      probeTargets: [...cur.probeTargets],
      txCollapsed: cur.txMin !== null && cur.txBaseline !== null && cur.txMin <= Math.max(TX_COLLAPSE_ABS, cur.txBaseline * TX_COLLAPSE_RATIO),
    };
  }

  /** Bir saniyelik ölçüm. Dönen değer: bu saniye sessizlik (adayı) mı. */
  push(input: SilenceInput): boolean {
    const { t, rxp } = input;
    const txp = input.txp ?? null;
    const participants = input.participants ?? null;
    const lost = input.probesLost ?? 0;
    if (this.lastT !== null && t - this.lastT > GAP_RESET_MS) this.reset();
    this.lastT = t;
    if (rxp === null) {
      this.reset();
      return false;
    }
    // Sesteki kişi / yayın sayısı azaldı mı (trafiğin olağan nedenle azalması)
    if (participants !== null) {
      const load = { participants, streams: input.streams ?? 0 };
      if (this.lastLoad && (load.participants < this.lastLoad.participants || load.streams < this.lastLoad.streams)) this.loadDroppedAt = t;
      this.lastLoad = load;
    }
    const voiceChanged = t - this.loadDroppedAt <= VOICE_CHANGE_MS;
    if (voiceChanged && this.cur && this.cur.waited === null && this.cur.rows <= VOICE_CHANGE_MS / 1000) {
      // Çöküş başladıktan hemen sonra birinin çıktığı / yayını kapattığı öğrenildi: kesinti değil
      this.reset();
      this.remember(rxp, txp);
      return false;
    }
    const cur = this.cur;
    const extend = (c: SilenceState): void => {
      c.end = t;
      c.min = Math.min(c.min, rxp);
      if (txp !== null) c.txMin = c.txMin === null ? txp : Math.min(c.txMin, txp);
      c.probesLost = Math.max(c.probesLost, lost);
      for (const label of input.probeTargets ?? []) c.probeTargets.add(label);
    };
    if (cur && cur.waited === null) {
      if (rxp <= cur.threshold) {
        cur.rows++;
        extend(cur);
        if (cur.rows > MAX_SILENCE_ROWS) {
          // Seviye değişimi: taban yeni trafikle baştan kurulur
          this.reset();
          this.remember(rxp, txp);
          return false;
        }
        return true;
      }
      cur.waited = 0;
    }
    if (cur && cur.waited !== null) {
      if (rxp >= cur.baseline * RECOVERY_RATIO) {
        this.cur = null;
        this.onSilence(this.finish(cur));
        this.remember(rxp, txp);
        return false;
      }
      if (rxp <= cur.threshold) {
        // Yeniden çöktü: aynı sessizliğin devamı
        cur.rows += cur.waited + 1;
        extend(cur);
        cur.waited = null;
        return true;
      }
      if (++cur.waited >= RECOVERY_ROWS) {
        // Geri gelmedi: kesinti değil, trafik azaldı
        this.reset();
        this.remember(rxp, txp);
      }
      return false;
    }
    if (this.history.length >= BASELINE_MIN_ROWS) {
      const baseline = percentile(this.history.map((h) => h.rxp), BASELINE_PERCENTILE);
      const threshold = silenceThreshold(baseline);
      if (baseline >= BASELINE_MIN && rxp <= threshold) {
        if (voiceChanged) {
          this.reset();
        } else {
          const tx = this.history.map((h) => h.txp).filter((v): v is number => v !== null);
          this.cur = {
            start: t - (input.intervalMs ?? 1000),
            end: t,
            rows: 1,
            min: rxp,
            txMin: txp,
            baseline,
            txBaseline: tx.length >= BASELINE_MIN_ROWS ? percentile(tx, BASELINE_PERCENTILE) : null,
            threshold,
            participants,
            probesLost: lost,
            probeTargets: new Set(input.probeTargets ?? []),
            waited: null,
          };
          return true;
        }
      }
    }
    this.remember(rxp, txp);
    return false;
  }

  /** Süren sessizlik (henüz geri gelmedi: aday); yoksa null */
  open(): { at: number; seconds: number; baseline: number; rxpMin: number; probesLost: number } | null {
    const c = this.cur;
    return c && c.waited === null ? { at: c.start, seconds: c.rows, baseline: Math.round(c.baseline), rxpMin: c.min, probesLost: c.probesLost } : null;
  }
}

// ---------- Kayıt ----------

export interface OutageLogOptions {
  /** <dataDir>/telemetry; null: yalnızca bellekte */
  dir: string | null;
  offsetMin?: number;
  now?: () => number;
  log?: { warn(obj: object, msg: string): void };
  /** Kayıt dosyaya yazılmadan önce beklenen süre (ms): öbür işaret gelip birleşebilsin */
  settleMs?: number;
  maxFileLines?: number;
  /** Seste şu an kaç kişi var (bilinmiyorsa null): boş odadaki adaylar kayda geçmez */
  participants?: () => number | null;
}

/** İki işaret bu kadar yakınsa (ms) aynı kesinti sayılır (NIC satırları saniye çözünürlüğündedir) */
const MERGE_SLACK_MS = 2_000;
const KEEP_MS = 14 * 86_400_000;
const MEMORY_MAX = 1_000;
const FILE_MAX_LINES = 2_000;
/** Boş odadaki aday bellekte en çok bu kadar tutulur (geç gelen sonda kesintisiyle birleşebilsin) */
const IDLE_KEEP_MS = 60_000;

function isOutage(v: unknown): v is Outage {
  const o = v as Partial<Outage> | null;
  return !!o && typeof o.id === 'string' && typeof o.at === 'number' && typeof o.durationMs === 'number' && typeof o.kind === 'string';
}

export class OutageLog {
  private items: Outage[] = [];
  /** Henüz dosyaya yazılmamış kayıtlar ve son değiştikleri an */
  private readonly unsaved = new Map<string, number>();
  private fileLines = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private warned = false;
  private readonly now: () => number;

  constructor(private readonly opts: OutageLogOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private get file(): string | null {
    return this.opts.dir ? path.join(this.opts.dir, 'outages.jsonl') : null;
  }

  private load(): void {
    const file = this.file;
    if (!file) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter(Boolean);
    const since = this.now() - KEEP_MS;
    // Birleşen kayıt dosyaya ikinci kez eklenmiş olabilir: aynı kimlikte son satır geçerlidir
    const byId = new Map<string, Outage>();
    for (const line of lines) {
      try {
        const v = JSON.parse(line) as unknown;
        if (isOutage(v) && v.at >= since) {
          byId.delete(v.id);
          byId.set(v.id, v);
        }
      } catch {
        // bozuk satır atlanır
      }
    }
    this.items = [...byId.values()].sort((a, b) => a.at - b.at).slice(-MEMORY_MAX);
    // Yeni kimlikler dosyadakilerle çakışmasın
    this.seq = this.items.length;
    this.fileLines = lines.length;
  }

  start(): void {
    if (this.timer) return;
    // flush kendi hatasını yakalar; zamanlayıcıdan dışarı hiçbir şey sızmamalı
    this.timer = setInterval(() => void this.flush().catch(() => undefined), 5_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(true);
  }

  private add(at: number, durationMs: number, part: { probe: ProbeOutage } | { nic: NicSilence }): Outage {
    const end = at + durationMs;
    const isProbe = 'probe' in part;
    // Öbür türden, zamanı çakışan ve bu türü henüz taşımayan kayıt varsa onunla birleşir
    const match = this.items.findLast(
      (o) => (isProbe ? o.probe === null : o.nic === null) && o.at - MERGE_SLACK_MS <= end && at - MERGE_SLACK_MS <= o.at + o.durationMs,
    );
    let o: Outage;
    if (match) {
      o = match;
      const from = Math.min(o.at, at);
      o.durationMs = Math.max(o.at + o.durationMs, end) - from;
      o.at = from;
      if (isProbe) o.probe = part.probe;
      else o.nic = part.nic;
    } else {
      o = {
        id: `${Math.round(at).toString(36)}-${(this.seq++).toString(36)}`,
        at,
        durationMs,
        t: '',
        kind: 'sonda',
        probe: isProbe ? part.probe : null,
        nic: isProbe ? null : part.nic,
      };
      // Eski boş-oda adayları atılır (birleşme penceresi geçti)
      this.items = this.items.filter((x) => !x.idle || x.at + x.durationMs >= at - IDLE_KEEP_MS);
      this.items.push(o);
      if (this.items.length > MEMORY_MAX) this.items.splice(0, this.items.length - MEMORY_MAX);
    }
    // NIC sessizliği yalnızca dış sondalarla doğrulanırsa (kayıtlı sonda kesintisi ya da aynı saniyelerde en az iki
    // farklı hedeften yanıtsız sonda) tam kesintidir; tek başına adaydır
    o.kind = o.nic ? (o.probe || isCorroborated(o.nic) ? 'tam' : 'aday') : 'sonda';
    o.t = localStamp(o.at, this.opts.offsetMin ?? 180);
    // Aday yalnızca seste biri varken kayda geçer (boş odadaki kısa çöküşler rapor gürültüsü); tam/sonda her zaman
    if (o.kind === 'aday' && (o.nic?.participants ?? this.opts.participants?.() ?? null) === 0) {
      o.idle = true;
      return o;
    }
    delete o.idle;
    if (this.file) this.unsaved.set(o.id, this.now());
    return o;
  }

  addProbe(p: ProbeOutage): Outage {
    return this.add(p.at, p.durationMs, { probe: p });
  }

  addNic(s: NicSilence): Outage {
    return this.add(s.at, s.durationMs, { nic: s });
  }

  /** Durulmuş kayıtları dosyaya ekler (all: hepsini). Sınır aşılınca dosya bellekteki listeyle yeniden yazılır. */
  flush(all = false): Promise<void> {
    const file = this.file;
    if (!file || this.unsaved.size === 0) return this.writing;
    const now = this.now();
    const settle = this.opts.settleMs ?? 8_000;
    const ready: Outage[] = [];
    for (const [id, changedAt] of this.unsaved) {
      if (!all && now - changedAt < settle) continue;
      this.unsaved.delete(id);
      const o = this.items.find((x) => x.id === id);
      if (o) ready.push(o);
    }
    if (ready.length === 0) return this.writing;
    this.fileLines += ready.length;
    const trim = this.fileLines > (this.opts.maxFileLines ?? FILE_MAX_LINES);
    let snapshot: string | null = null;
    if (trim) {
      const since = now - KEEP_MS;
      const pending = new Set(this.unsaved.keys());
      const kept = this.items.filter((o) => o.at >= since && !o.idle && !pending.has(o.id));
      this.fileLines = kept.length;
      snapshot = kept.map((o) => JSON.stringify(o)).join('\n') + '\n';
    }
    const lines = ready.map((o) => JSON.stringify(o)).join('\n') + '\n';
    this.writing = this.writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        if (snapshot !== null) await fs.promises.writeFile(file, snapshot);
        else await fs.promises.appendFile(file, lines);
      })
      .catch((err: unknown) => {
        if (!this.warned) this.opts.log?.warn({ err: String(err) }, 'kesinti kaydı yazılamadı');
        this.warned = true;
      });
    return this.writing;
  }

  /** En yeniler önce */
  list(since: number): Outage[] {
    return this.items.filter((o) => !o.idle && o.at + o.durationMs >= since).sort((a, b) => b.at - a.at);
  }

  /** [from, to] aralığıyla kesişenler, eskiden yeniye */
  between(from: number, to: number): Outage[] {
    return this.items.filter((o) => !o.idle && o.at <= to && o.at + o.durationMs >= from).sort((a, b) => a.at - b.at);
  }
}
