import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { dayKey } from './counters.js';
import { hostNetSample, parseDefaultGateway, readHostNet, type HostNetCounters } from './hostNetwork.js';
import { isPartialProbeOutage, NicSilenceDetector, OutageLog, type NicSilence, type Outage } from './netOutages.js';
import type { ProbeOutage } from './netProbe.js';

// Bağlantı teşhisi: sunucu ağının saniyelik kaydı (uçuş kaydedicisi) ve makinenin TEK ağ örnekleyicisi.
// Bir yayın donduğunda "sunucu mu, sağlayıcı yolu mu" sorusunu yanıtlamak için saniye çözünürlüğü gerekir.
// Her saniye /proc'tan birkaç küçük dosya okunur (mikrosaniyeler):
// - net/dev, net/snmp: NIC hızı ve paket hızı, NIC düşen/hatalı paket, UDP InErrors/RcvbufErrors/SndbufErrors,
//   NoPorts, InCsumErrors
// - net/softnet_stat: çekirdek ağ kuyruğu düşüşleri ve time_squeeze
// - sys/net/netfilter/nf_conntrack_count|max: bağlantı izleme tablosunun doluluğu
// - pressure/cpu: işlemci baskısı (PSI, "some" = en az bir iş beklemede olan sürenin yüzdesi)
// - LiveKit süreç CPU'su: Prometheus ölçümünden (en son değer; kapsayıcıdan başka sürecin /proc'u görünmez)
// Dosyalar okunamıyorsa (Windows'ta geliştirme, eksik modül) ilgili alanlar boş kalır; hiçbir şey başlatmayı
// engellemez.
//
// Buradan türeyenler:
// - Son 30 dk bellekte (halka): panelin canlı görünümü, olay kanıtı (freezeDiagnosis.ts), 15 sn'lik geçmiş.
// - "NIC sessizliği" dedektörü (netOutages.ts) ve dış sonda kesintileriyle ortak kesinti kaydı (outages.jsonl).
// - Diske yalnızca anormal saniyelerin çevresi (±30 sn) yazılır: netsec-YYYY-AA-GG.jsonl (7 gün). Sağlıklı
//   sunucuda bu dosya oluşmaz. Yönetim ucu aralığı halkadan ya da bu dosyalardan okur.
// - Her dakikanın özeti: netmin-YYYY-AA-GG.jsonl (14 gün). Olay kayıtları kendi satırlarını ayrıca saklar
//   (freezeDiagnosis.ts, freeze-rows.jsonl).

/** Bir saniyelik satır. Anahtarlar dosya küçük kalsın diye kısa; eksik ölçüm null/yok */
export interface SecondRow {
  /** Ölçüm anı (ms); satır bu ana kadarki ~1 saniyeyi kapsar */
  t: number;
  /** NIC hızı (Mbit/sn) */
  rx: number | null;
  tx: number | null;
  /** NIC paket hızı (paket/sn) */
  rxp: number | null;
  txp: number | null;
  /** Bu aralıkta NIC'te düşen + hatalı paket (rx_drop + rx_err + tx_drop + tx_err) */
  nd: number;
  /** UDP hataları (paket): InErrors, RcvbufErrors, SndbufErrors */
  ue: number;
  ur: number;
  us: number;
  /** softnet: çekirdek kuyruğunda düşen paket; okunamadıysa null */
  sd: number | null;
  /** softnet time_squeeze (bütçe dolduğu için yarım kalan tur); okunamadıysa yok */
  sq?: number | null;
  /** UDP: dinleyeni olmayan porta gelen (NoPorts) ve sağlama toplamı hatalı datagram */
  un?: number;
  uc?: number;
  /** Bağlantı izleme tablosu: giriş sayısı ve üst sınır; okunamadıysa yok */
  ct?: number | null;
  ctm?: number | null;
  /** CPU baskısı (PSI some, %0-100); okunamadıysa null */
  psi: number | null;
  /** LiveKit süreci CPU'su (çekirdek oranı; 1 = bir çekirdek); bilinmiyorsa null */
  lk: number | null;
  /** Sesteki kişi sayısı (0 ise yazılmaz) */
  vp?: number;
  /** Kesinti işaretleri (bit): 1 = dış sonda kesintisi, 2 = NIC sessizliği (adayı; birkaç saniye gecikmeyle işlenir) */
  o?: number;
  /** Dış sondalar: hedef etiketi → RTT (ms) ya da -1 (yanıt gelmedi); yalnızca o saniyede gönderilenler */
  p?: Record<string, number>;
}

export const OUTAGE_BIT_PROBE = 1;
export const OUTAGE_BIT_NIC = 2;

export interface SoftnetCounters {
  processed: number;
  dropped: number;
  squeezed: number;
}

/** /proc/net/softnet_stat: CPU başına satır, sütunlar onaltılık (işlenen, düşen, time_squeeze ...); toplamı */
export function parseSoftnetStat(text: string): SoftnetCounters | null {
  let processed = 0;
  let dropped = 0;
  let squeezed = 0;
  let rows = 0;
  for (const line of text.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 3) continue;
    const [a, b, d] = [c[0]!, c[1]!, c[2]!].map((x) => Number.parseInt(x, 16));
    if (![a, b, d].every((n) => Number.isFinite(n))) continue;
    processed += a!;
    dropped += b!;
    squeezed += d!;
    rows++;
  }
  return rows === 0 ? null : { processed, dropped, squeezed };
}

/** /proc/pressure/cpu: "some ... total=<µs>" (en az bir işin CPU beklediği toplam süre, µs); yoksa null */
export function parsePsiCpu(text: string): number | null {
  const m = /^some\b.*\btotal=(\d+)/m.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Tek sayılık /proc dosyası (ör. nf_conntrack_count); okunamadıysa null */
export function parseCount(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const v = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Bir anda okunan ham sayaçlar */
export interface RawSecond {
  net: HostNetCounters | null;
  softnet: SoftnetCounters | null;
  /** PSI some toplamı (µs) */
  psiUs: number | null;
  /** Bağlantı izleme tablosu (anlık değerler) */
  conntrack?: { count: number; max: number | null } | null;
  at: number;
}

export interface ProcFiles {
  dev: string | null;
  route: string | null;
  snmp: string | null;
  softnet: string | null;
  psi: string | null;
  /** sys/net/netfilter/nf_conntrack_count ve nf_conntrack_max */
  ctCount?: string | null;
  ctMax?: string | null;
}

export function readRaw(files: ProcFiles, at: number): RawSecond {
  const count = parseCount(files.ctCount);
  return {
    at,
    net: readHostNet(files, at),
    softnet: files.softnet ? parseSoftnetStat(files.softnet) : null,
    psiUs: files.psi ? parsePsiCpu(files.psi) : null,
    conntrack: count === null ? null : { count, max: parseCount(files.ctMax) },
  };
}

const round = (v: number | null, digits = 1): number | null => (v === null ? null : Number(v.toFixed(digits)));

/** İki ham okumadan bir saniyelik satır; aralık anlamsızsa (arayüz değişti, sayaç geri gitti) ilgili alanlar boş */
export function rowBetween(cur: RawSecond, prev: RawSecond, livekitCpu: number | null): SecondRow | null {
  const dt = (cur.at - prev.at) / 1000;
  if (dt <= 0 || dt > 10) return null;
  const pos = (c: number | undefined, p: number | undefined): number | null =>
    c === undefined || p === undefined || c < p ? null : c - p;
  let rx: number | null = null;
  let tx: number | null = null;
  let rxp: number | null = null;
  let txp: number | null = null;
  let nd = 0;
  let ue = 0;
  let ur = 0;
  let us = 0;
  let un = 0;
  let uc = 0;
  if (cur.net && prev.net) {
    const s = hostNetSample(cur.net, prev.net);
    if (s) {
      rx = round(s.rxMbps);
      tx = round(s.txMbps);
      rxp = round(s.rxPps, 0);
      txp = round(s.txPps, 0);
    }
    if (cur.net.iface === prev.net.iface) {
      const c = cur.net.dev;
      const p = prev.net.dev;
      nd = (pos(c.rxDrop, p.rxDrop) ?? 0) + (pos(c.rxErrs, p.rxErrs) ?? 0) + (pos(c.txDrop, p.txDrop) ?? 0) + (pos(c.txErrs, p.txErrs) ?? 0);
    }
    if (cur.net.udp && prev.net.udp) {
      ue = pos(cur.net.udp.inErrors, prev.net.udp.inErrors) ?? 0;
      ur = pos(cur.net.udp.rcvbufErrors, prev.net.udp.rcvbufErrors) ?? 0;
      us = pos(cur.net.udp.sndbufErrors, prev.net.udp.sndbufErrors) ?? 0;
      un = pos(cur.net.udp.noPorts, prev.net.udp.noPorts) ?? 0;
      uc = pos(cur.net.udp.inCsumErrors, prev.net.udp.inCsumErrors) ?? 0;
    }
  }
  const both = cur.softnet && prev.softnet;
  const sd = both ? pos(cur.softnet!.dropped, prev.softnet!.dropped) : null;
  const sq = both ? pos(cur.softnet!.squeezed, prev.softnet!.squeezed) : null;
  const psiDelta = pos(cur.psiUs ?? undefined, prev.psiUs ?? undefined);
  const psi = psiDelta === null ? null : Math.min(100, round((psiDelta / (dt * 1_000_000)) * 100, 1)!);
  const row: SecondRow = { t: cur.at, rx, tx, rxp, txp, nd, ue, ur, us, sd, psi, lk: round(livekitCpu, 2) };
  if (both) row.sq = sq;
  if (un > 0) row.un = un;
  if (uc > 0) row.uc = uc;
  if (cur.conntrack) {
    row.ct = cur.conntrack.count;
    row.ctm = cur.conntrack.max;
  }
  return row;
}

// ---------- Özetler (olay kanıtı) ----------

export interface ProbeSummary {
  sent: number;
  lost: number;
  lossPct: number;
  rttMed: number | null;
  rttMax: number | null;
}

/** Kayıptan hemen önceki trafik patlaması (yayında sahne değişimi gibi): sağlayıcı hız sınırını tetikleyebilir */
export interface Burst {
  /** Tepe saniyesi */
  at: number;
  txMbps: number | null;
  txPps: number | null;
  rxMbps: number | null;
  /** Öncesindeki olağan giden/gelen hız (ortanca) */
  baseTxMbps: number | null;
  baseRxMbps: number | null;
  /** Tepe, kaybın başlangıcından kaç saniye önce (kayıp anı bilinmiyorsa null) */
  secBeforeLoss: number | null;
}

/** Bir zaman aralığındaki sunucu ağı özeti (olay kanıtı). Eski kayıtlarda yeni alanlar bulunmayabilir. */
export interface ServerSummary {
  /** Aralıkta kaç saniyelik satır var (beklenen: süre) ve süre (sn) */
  seconds: number;
  expectedSeconds: number;
  txMbpsMax: number | null;
  rxMbpsMax: number | null;
  /** Paket hızının en düşük ve en yüksek değeri (paket/sn) ve toplam paket */
  rxPpsMin: number | null;
  rxPpsMax: number | null;
  txPpsMin: number | null;
  txPpsMax: number | null;
  rxPackets: number;
  txPackets: number;
  /** Gelen paket hızının, önceki 10 saniyenin ortancasına göre en derin çöküşü (kesintinin asıl imzası) */
  rxDip: { at: number; pps: number; baseline: number; pct: number } | null;
  /** En yüksek giden hızın saniyesi */
  txPeak: { at: number; mbps: number; pps: number | null } | null;
  /** Kayıptan önceki patlama (varsa) */
  burst: Burst | null;
  /** NIC düşen+hatalı paket toplamı */
  nicDrops: number;
  udpInErr: number;
  udpRcvbufErr: number;
  udpSndbufErr: number;
  udpNoPorts: number;
  udpCsumErr: number;
  /** softnet düşüşü ve time_squeeze; okunamadıysa null */
  softnetDrops: number | null;
  softnetSqueezed: number | null;
  /** Bağlantı izleme tablosu: en yüksek giriş sayısı, üst sınır ve doluluk (%); okunamadıysa null */
  conntrack: { max: number; limit: number | null; usedPct: number | null } | null;
  /** CPU baskısı en yüksek (%); okunamadıysa null */
  psiMax: number | null;
  /** LiveKit CPU'su en yüksek (çekirdek oranı) ve makinedeki çekirdek sayısı */
  livekitCpuMax: number | null;
  cores: number;
  /** Hedef etiketi → sonda özeti */
  probes: Record<string, ProbeSummary>;
  /** Dış hedeflerin (ağ geçidi dışındakiler) toplam kayıp yüzdesi; yeterli sonda yoksa null */
  probeLossPct: number | null;
  /** Belirgin kayıp görülen dış hedefler (en az 2 yanıtsız sonda ve %5 üstü) */
  probeLossyTargets: string[];
  /** Aralıkla kesişen kesintiler (dış sonda / NIC sessizliği) */
  outages: Outage[];
}

/** Bu etiket ağ geçidi sondası mı (kayıp yargısına katılmaz: yanıt vermeyebilir) */
export const GATEWAY_LABEL = 'ağ geçidi';

const median = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const nums = (v: (number | null | undefined)[]): number[] => v.filter((n): n is number => n !== null && n !== undefined);
const maxOf = (v: (number | null | undefined)[]): number | null => {
  const x = nums(v);
  return x.length === 0 ? null : Math.max(...x);
};
const minOf = (v: (number | null | undefined)[]): number | null => {
  const x = nums(v);
  return x.length === 0 ? null : Math.min(...x);
};

/**
 * Kayıptan önceki trafik patlaması. `lossAt` biliniyorsa (kesinti ya da çöküş anı) öncesindeki 10 saniyeye,
 * bilinmiyorsa tüm satırlara bakılır. Patlama: tepe, öncesindeki 35 saniyenin ortancasının en az 1,8 katı ve
 * giden için +5 Mbps (gelen için +3 Mbps) üstünde.
 */
export function findBurst(rows: SecondRow[], lossAt: number | null): Burst | null {
  const scope = lossAt === null ? rows : rows.filter((r) => r.t >= lossAt - 10_000 && r.t <= lossAt + 1_000);
  let best: { row: SecondRow; score: number; baseTx: number | null; baseRx: number | null } | null = null;
  for (const r of scope) {
    const before = rows.filter((x) => x.t >= r.t - 40_000 && x.t <= r.t - 5_000);
    if (before.length < 5) continue;
    const baseTx = median(nums(before.map((x) => x.tx)));
    const baseRx = median(nums(before.map((x) => x.rx)));
    const txJump = r.tx !== null && baseTx !== null && r.tx >= baseTx * 1.8 && r.tx - baseTx >= 5 ? r.tx - baseTx : 0;
    const rxJump = r.rx !== null && baseRx !== null && r.rx >= baseRx * 1.8 && r.rx - baseRx >= 3 ? r.rx - baseRx : 0;
    const score = Math.max(txJump, rxJump);
    if (score > 0 && (!best || score > best.score)) best = { row: r, score, baseTx, baseRx };
  }
  if (!best) return null;
  const r = best.row;
  return {
    at: r.t,
    txMbps: r.tx,
    txPps: r.txp,
    rxMbps: r.rx,
    baseTxMbps: best.baseTx,
    baseRxMbps: best.baseRx,
    secBeforeLoss: lossAt === null ? null : Math.max(0, Math.round((lossAt - r.t) / 1000)),
  };
}

export interface SummaryExtra {
  /** Aralıkla kesişen kesintiler */
  outages?: Outage[];
  /** Patlama araması için aralığın öncesini de içeren satırlar (verilmezse aralığın kendisi) */
  context?: SecondRow[];
}

export function summarizeRows(
  rows: SecondRow[],
  from: number,
  to: number,
  cores = os.availableParallelism?.() ?? 1,
  extra: SummaryExtra = {},
): ServerSummary {
  const probes: Record<string, { sent: number; lost: number; rtts: number[] }> = {};
  for (const r of rows) {
    for (const [label, v] of Object.entries(r.p ?? {})) {
      const p = (probes[label] ??= { sent: 0, lost: 0, rtts: [] });
      p.sent++;
      if (v < 0) p.lost++;
      else p.rtts.push(v);
    }
  }
  const out: Record<string, ProbeSummary> = {};
  const lossy: string[] = [];
  let sent = 0;
  let lost = 0;
  for (const [label, p] of Object.entries(probes)) {
    out[label] = {
      sent: p.sent,
      lost: p.lost,
      lossPct: p.sent === 0 ? 0 : round((p.lost / p.sent) * 100, 1)!,
      rttMed: round(median(p.rtts)),
      rttMax: round(p.rtts.length === 0 ? null : Math.max(...p.rtts)),
    };
    if (label !== GATEWAY_LABEL) {
      sent += p.sent;
      lost += p.lost;
      if (p.lost >= 2 && p.lost / p.sent >= 0.05) lossy.push(label);
    }
  }
  const sum = (pick: (r: SecondRow) => number): number => rows.reduce((n, r) => n + pick(r), 0);
  const sdRows = rows.filter((r) => r.sd !== null);
  const sqRows = rows.filter((r) => r.sq !== null && r.sq !== undefined);
  // En derin çöküş: her saniye, kendinden önceki (en çok) 10 saniyenin ortancasına oranlanır
  let rxDip: ServerSummary['rxDip'] = null;
  let deepest = Number.POSITIVE_INFINITY;
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rxp === null) continue;
    const base = median(nums(rows.slice(Math.max(0, i - 10), i).map((x) => x.rxp)));
    if (base === null || base < 20) continue;
    const pct = (r.rxp / base) * 100;
    if (pct < deepest) {
      deepest = pct;
      rxDip = { at: r.t, pps: r.rxp, baseline: Math.round(base), pct: round(pct, 1)! };
    }
  }
  const peak = rows.reduce<SecondRow | null>((best, r) => (r.tx !== null && (best === null || r.tx > (best.tx ?? -1)) ? r : best), null);
  const outages = extra.outages ?? [];
  const lossAt = outages[0]?.at ?? (rxDip && rxDip.pct < 30 ? rxDip.at - 1_000 : null);
  const ctMax = maxOf(rows.map((r) => r.ct));
  const ctLimit = maxOf(rows.map((r) => r.ctm));
  return {
    seconds: rows.length,
    expectedSeconds: Math.max(0, Math.round((to - from) / 1000)),
    txMbpsMax: maxOf(rows.map((r) => r.tx)),
    rxMbpsMax: maxOf(rows.map((r) => r.rx)),
    rxPpsMin: minOf(rows.map((r) => r.rxp)),
    rxPpsMax: maxOf(rows.map((r) => r.rxp)),
    txPpsMin: minOf(rows.map((r) => r.txp)),
    txPpsMax: maxOf(rows.map((r) => r.txp)),
    rxPackets: sum((r) => r.rxp ?? 0),
    txPackets: sum((r) => r.txp ?? 0),
    rxDip,
    txPeak: peak && peak.tx !== null ? { at: peak.t, mbps: peak.tx, pps: peak.txp } : null,
    burst: findBurst(extra.context ?? rows, lossAt),
    nicDrops: sum((r) => r.nd),
    udpInErr: sum((r) => r.ue),
    udpRcvbufErr: sum((r) => r.ur),
    udpSndbufErr: sum((r) => r.us),
    udpNoPorts: sum((r) => r.un ?? 0),
    udpCsumErr: sum((r) => r.uc ?? 0),
    softnetDrops: sdRows.length === 0 ? null : sdRows.reduce((n, r) => n + (r.sd ?? 0), 0),
    softnetSqueezed: sqRows.length === 0 ? null : sqRows.reduce((n, r) => n + (r.sq ?? 0), 0),
    conntrack:
      ctMax === null ? null : { max: ctMax, limit: ctLimit, usedPct: ctLimit ? round((ctMax / ctLimit) * 100, 1) : null },
    psiMax: maxOf(rows.map((r) => r.psi)),
    livekitCpuMax: maxOf(rows.map((r) => r.lk)),
    cores,
    probes: out,
    probeLossPct: sent >= 5 ? round((lost / sent) * 100, 1) : null,
    probeLossyTargets: lossy,
    outages,
  };
}

// ---------- Dakikalık özet ve 15 sn'lik geçmiş ----------

/** Bir dakikanın özeti (netmin-*.jsonl satırı). Hızlar [ortalama, en yüksek], paket hızları [en düşük, ortalama, en yüksek] */
export interface MinuteRow {
  /** Dakikanın başı (ms) */
  at: number;
  /** Dakikadaki saniyelik satır sayısı */
  n: number;
  rx: [number, number] | null;
  tx: [number, number] | null;
  rxp: [number, number, number] | null;
  txp: [number, number, number] | null;
  /** Toplamlar: NIC düşen/hatalı, UDP InErrors/Rcvbuf/Sndbuf/NoPorts/Csum, softnet düşüşü ve time_squeeze */
  nd: number;
  ue: number;
  ur: number;
  us: number;
  un: number;
  uc: number;
  sd: number | null;
  sq: number | null;
  /** En yüksekler: CPU baskısı, LiveKit CPU'su, conntrack girişi (ve üst sınırı), sesteki kişi */
  psi: number | null;
  lk: number | null;
  ct: number | null;
  ctm: number | null;
  vp: number;
  /** Kesinti işareti taşıyan saniye sayısı */
  o: number;
  /** Hedef etiketi → [gönderilen, yanıtsız, en yüksek RTT (ms) ya da -1] */
  p?: Record<string, [number, number, number]>;
}

const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

export function minuteOf(at: number, rows: SecondRow[]): MinuteRow {
  const pair = (pick: (r: SecondRow) => number | null): [number, number] | null => {
    const v = nums(rows.map(pick));
    return v.length === 0 ? null : [round(avg(v), 2)!, round(Math.max(...v), 2)!];
  };
  const triple = (pick: (r: SecondRow) => number | null): [number, number, number] | null => {
    const v = nums(rows.map(pick));
    return v.length === 0 ? null : [Math.min(...v), Math.round(avg(v)), Math.max(...v)];
  };
  const sum = (pick: (r: SecondRow) => number | null | undefined): number => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const nullableSum = (pick: (r: SecondRow) => number | null | undefined): number | null =>
    rows.some((r) => pick(r) !== null && pick(r) !== undefined) ? sum(pick) : null;
  const p: Record<string, [number, number, number]> = {};
  for (const r of rows) {
    for (const [label, v] of Object.entries(r.p ?? {})) {
      const x = (p[label] ??= [0, 0, -1]);
      x[0]++;
      if (v < 0) x[1]++;
      else x[2] = Math.max(x[2], Math.round(v));
    }
  }
  return {
    at,
    n: rows.length,
    rx: pair((r) => r.rx),
    tx: pair((r) => r.tx),
    rxp: triple((r) => r.rxp),
    txp: triple((r) => r.txp),
    nd: sum((r) => r.nd),
    ue: sum((r) => r.ue),
    ur: sum((r) => r.ur),
    us: sum((r) => r.us),
    un: sum((r) => r.un),
    uc: sum((r) => r.uc),
    sd: nullableSum((r) => r.sd),
    sq: nullableSum((r) => r.sq),
    psi: maxOf(rows.map((r) => r.psi)),
    lk: maxOf(rows.map((r) => r.lk)),
    ct: maxOf(rows.map((r) => r.ct)),
    ctm: maxOf(rows.map((r) => r.ctm)),
    vp: Math.max(0, ...rows.map((r) => r.vp ?? 0)),
    o: rows.filter((r) => (r.o ?? 0) > 0).length,
    ...(Object.keys(p).length > 0 ? { p } : {}),
  };
}

// ---------- Halka + kalıcı kayıt ----------

export interface SamplerOptions {
  procRoot: string;
  /** Kayıt klasörü (netsec-/netmin-YYYY-AA-GG.jsonl, outages.jsonl); null: yazılmaz */
  dir: string | null;
  offsetMin?: number;
  /** LiveKit süreç CPU'su (çekirdek oranı) */
  livekitCpu?: () => number | null;
  /** Doğrulanmış bir kesinti (tam / sonda) kaydedildiğinde ya da bir aday doğrulandığında */
  onOutage?: (o: Outage) => void;
  /** Sesteki kişi ve yayın sayısı (NIC sessizliği dedektörü için) */
  participants?: () => number | null;
  streams?: () => number | null;
  /** Testler: /proc okuması yerine */
  readFiles?: () => ProcFiles;
  log?: { warn(obj: object, msg: string): void };
}

const RING_MS = 30 * 60_000;
/** Bir satır değerlendirilmeden önce beklenen süre: sonda yanıtları ve (iki satır gecikmeli) sessizlik işareti işlensin */
const PERSIST_LAG_MS = 3_000;
/** Bekleyen satırlar en geç bu kadar sürede diske yazılır (olay sırasında kanıt kaybolmasın) */
const FLUSH_EVERY_MS = 15_000;
const PERSIST_AROUND_MS = 30_000;
const DAY_MAX_BYTES = 40 * 1024 * 1024;
const SECONDS_RETENTION_DAYS = 7;
const MINUTES_RETENTION_DAYS = 14;
const MINUTE = 60_000;
/** Sonda sonucu, satırı henüz oluşmadıysa en çok bu kadar bekletilir */
const PROBE_BUFFER_MAX = 64;

/** Bir satır "anormal" mi (çevresi diske yazılır) */
export function isAbnormalRow(r: SecondRow, recent: SecondRow[]): boolean {
  if (r.nd >= 5 || r.ue > 0 || r.ur > 0 || r.us > 0 || (r.sd ?? 0) > 0) return true;
  if ((r.psi ?? 0) >= 30) return true;
  if ((r.o ?? 0) > 0) return true;
  if (r.ct != null && r.ctm != null && r.ctm > 0 && r.ct / r.ctm >= 0.9) return true;
  const external = (x: SecondRow): [string, number][] => Object.entries(x.p ?? {}).filter(([label]) => label !== GATEWAY_LABEL);
  // Aynı saniyede iki farklı hedef yanıtsız: kısa kesinti olabilir
  if (external(r).filter(([, v]) => v < 0).length >= 2) return true;
  // Sonda kaybı dalgası: son 10 saniyede dış sondaların en az %30'u yanıtsız (tek tük kayıp normaldir)
  let sent = 0;
  let lost = 0;
  for (const x of recent) {
    for (const [, v] of external(x)) {
      sent++;
      if (v < 0) lost++;
    }
  }
  if (sent >= 4 && lost / sent >= 0.3) return true;
  return external(r).some(([, v]) => v >= 400);
}

/** Sessizlik, satırdan sonraki bu kadar satır geldikten sonra değerlendirilir: sonda sonuçları (zaman aşımı ~0,5 sn) işlensin */
const SILENCE_LAG_ROWS = 2;
/** Sessizliği doğrulayan yanıtsız sondalar için bakılan çevre (ms): öncesi ve sonrası */
const CORROBORATE_BEFORE_MS = 2_000;
const CORROBORATE_AFTER_MS = 1_000;

/** Satırdaki yanıtsız dış sondaların hedefleri (ağ geçidi hariç; yoklanamayan hedefler satıra hiç yazılmaz) */
const lostExternal = (r: SecondRow): string[] =>
  Object.entries(r.p ?? {})
    .filter(([label, v]) => label !== GATEWAY_LABEL && v < 0)
    .map(([label]) => label);

/**
 * Saniyelik satırları NIC sessizliği dedektörüne GECİKMELİ verir: bir satır, kendisinden sonraki iki satır da
 * geldikten sonra değerlendirilir. Böylece o saniyelerde gönderilip zaman aşımına uğrayan sondalar satırlara
 * işlenmiş olur ve sessizlik "dış sondalar da yanıtsızdı" bilgisiyle birlikte yargılanır. Sessiz saniyelerin
 * satırları işaretlenir (o |= 2). Örnekleyici ve gerçek veriyle yeniden oynatma testi aynı sınıfı kullanır.
 */
export class SilenceScanner {
  private readonly detector: NicSilenceDetector;
  private pending: { row: SecondRow; participants: number | null; streams: number | null; intervalMs: number }[] = [];
  private before: SecondRow[] = [];

  constructor(onSilence: (s: NicSilence) => void) {
    this.detector = new NicSilenceDetector(onSilence);
  }

  push(row: SecondRow, participants: number | null = null, streams: number | null = null, intervalMs = 1000): void {
    this.pending.push({ row, participants, streams, intervalMs });
    while (this.pending.length > SILENCE_LAG_ROWS) this.evaluate();
  }

  /** Bekleyen satırları da değerlendirir (yeniden oynatmanın sonunda) */
  drain(): void {
    while (this.pending.length > 0) this.evaluate();
  }

  private evaluate(): void {
    const cur = this.pending.shift()!;
    const { row } = cur;
    const near = [...this.before, row, ...this.pending.map((p) => p.row)].filter(
      (r) => r.t >= row.t - CORROBORATE_BEFORE_MS && r.t <= row.t + CORROBORATE_AFTER_MS,
    );
    const lostLabels = near.flatMap(lostExternal);
    const silent = this.detector.push({
      t: row.t,
      intervalMs: cur.intervalMs,
      rxp: row.rxp,
      txp: row.txp,
      participants: cur.participants,
      streams: cur.streams,
      probesLost: lostLabels.length,
      probeTargets: [...new Set(lostLabels)],
    });
    if (silent) row.o = (row.o ?? 0) | OUTAGE_BIT_NIC;
    this.before.push(row);
    if (this.before.length > 3) this.before.shift();
  }

  /** Süren sessizlik (adayı) */
  open(): ReturnType<NicSilenceDetector['open']> {
    return this.detector.open();
  }
}

type PendingLine = { kind: 'netsec' | 'netmin'; day: string; line: string };

export class SecondSampler {
  private rows: SecondRow[] = [];
  private prev: RawSecond | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evaluatedT = 0;
  private writtenT = 0;
  private keepUntil = 0;
  private buffer: PendingLine[] = [];
  private lastFlushAt = 0;
  private dayBytes = new Map<string, number>();
  private flushing: Promise<void> | null = null;
  private lastCleanup = 0;
  private warned = false;
  private minuteAt: number | null = null;
  private probeBuffer: { label: string; sentAt: number; rtt: number | null }[] = [];
  private readonly silence: SilenceScanner;
  private tickErrors = 0;
  /** Kesinti kaydı (dış sonda kesintileri + NIC sessizliği) */
  readonly outages: OutageLog;
  /** Hangi /proc dosyaları okunabiliyor (panel için) */
  readable = { net: false, snmp: false, softnet: false, psi: false, conntrack: false };
  iface: string | null = null;
  gateway: string | null = null;
  dropped = 0;
  persistedRows = 0;

  constructor(private readonly opts: SamplerOptions) {
    this.outages = new OutageLog({
      dir: opts.dir,
      offsetMin: opts.offsetMin ?? 180,
      participants: () => this.opts.participants?.() ?? null,
      ...(opts.log ? { log: opts.log } : {}),
    });
    this.silence = new SilenceScanner((s) => this.notify(this.outages.addNic(s)));
  }

  private get offsetMin(): number {
    return this.opts.offsetMin ?? 180;
  }

  start(): void {
    if (this.timer) return;
    // Ölçümdeki bir hata API sürecini düşürmemeli: yakalanır, seyrek günlüğe yazılır
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        if (this.tickErrors++ % 300 === 0) this.opts.log?.warn({ err: String(err), count: this.tickErrors }, 'saniyelik ağ ölçümü hata verdi');
      }
    }, 1_000);
    this.timer.unref();
    this.outages.start();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([this.flush(), this.outages.stop()]);
  }

  private files(): ProcFiles {
    if (this.opts.readFiles) return this.opts.readFiles();
    const root = this.opts.procRoot;
    const read = (file: string): string | null => {
      try {
        return fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        return null;
      }
    };
    return {
      dev: read('net/dev'),
      route: read('net/route'),
      snmp: read('net/snmp'),
      softnet: read('net/softnet_stat'),
      psi: read('pressure/cpu'),
      ctCount: read('sys/net/netfilter/nf_conntrack_count'),
      ctMax: read('sys/net/netfilter/nf_conntrack_max'),
    };
  }

  /** Bir ölçüm al (her saniye; testler `files` ve `now` verir) */
  tick(now = Date.now(), files = this.files()): SecondRow | null {
    const cur = readRaw(files, now);
    this.readable = {
      net: files.dev !== null && cur.net !== null,
      snmp: cur.net?.udp != null,
      softnet: cur.softnet !== null,
      psi: cur.psiUs !== null,
      conntrack: cur.conntrack != null,
    };
    this.iface = cur.net?.iface ?? null;
    if (files.route) this.gateway = parseDefaultGateway(files.route);
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return null;
    const row = rowBetween(cur, prev, this.opts.livekitCpu?.() ?? null);
    if (!row) return null;
    const participants = this.opts.participants?.() ?? null;
    if (participants) row.vp = participants;
    this.rows.push(row);
    // Bu saniyede gönderilip sonuçlanmış sondalar satıra işlenir
    const held = this.probeBuffer;
    this.probeBuffer = [];
    for (const p of held) this.addProbe(p.label, p.sentAt, p.rtt);
    // NIC sessizliği iki satır gecikmeyle değerlendirilir (o saniyelerin sonda sonuçları işlensin)
    this.silence.push(row, participants, this.opts.streams?.() ?? null, cur.at - prev.at);
    const from = now - RING_MS;
    let cut = 0;
    while (cut < this.rows.length && this.rows[cut]!.t < from) cut++;
    if (cut > 0) this.rows.splice(0, cut);
    this.minutePass(now);
    this.persistPass(now);
    return row;
  }

  /**
   * Bir sondanın sonucu: gönderildiği saniyeyi kapsayan satıra işlenir (rtt null: yanıt yok). Satır `t` anına
   * kadarki saniyeyi kapsar; o saniyenin satırı henüz oluşmadıysa sonuç bir sonraki ölçüme kadar bekletilir.
   */
  addProbe(label: string, sentAt: number, rttMs: number | null): void {
    const last = this.rows[this.rows.length - 1];
    if (!last || sentAt > last.t) {
      if (this.probeBuffer.length < PROBE_BUFFER_MAX) this.probeBuffer.push({ label, sentAt, rtt: rttMs });
      return;
    }
    let target: SecondRow | null = null;
    for (let i = this.rows.length - 1; i >= 0 && i >= this.rows.length - 8; i--) {
      const r = this.rows[i]!;
      if (r.t < sentAt) break;
      target = r;
    }
    if (target) (target.p ??= {})[label] = rttMs === null ? -1 : Number(rttMs.toFixed(1));
  }

  /** Dış sonda kesintisi (netProbe.ts): kayda geçer ve o saniyelerin satırları işaretlenir */
  addProbeOutage(o: ProbeOutage): Outage {
    const end = o.at + o.durationMs;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.t <= o.at) break;
      if (r.t - 1_000 < end) r.o = (r.o ?? 0) | OUTAGE_BIT_PROBE;
    }
    return this.notify(this.outages.addProbe(o));
  }

  private notify(o: Outage): Outage {
    // Aday ve yalnız tek protokolün sonda kesintisi olay kaydı istemez
    if (o.kind !== 'aday' && !isPartialProbeOutage(o)) {
      try {
        this.opts.onOutage?.(o);
      } catch (err) {
        this.opts.log?.warn({ err: String(err) }, 'kesinti bildirimi başarısız');
      }
    }
    return o;
  }

  /** Süren NIC sessizliği (adayı) */
  openSilence(): ReturnType<SilenceScanner['open']> {
    return this.silence.open();
  }

  /** [from, to] aralığındaki satırlar (halkadan) */
  window(from: number, to: number): SecondRow[] {
    return this.rows.filter((r) => r.t >= from && r.t <= to);
  }

  /** Halkadaki en son satır (panel) */
  latest(): SecondRow | null {
    return this.rows[this.rows.length - 1] ?? null;
  }

  /** Halkanın son n saniyesi */
  recent(seconds: number, now = Date.now()): SecondRow[] {
    return this.window(now - seconds * 1000, now);
  }

  /** Halkadaki satır sayısı */
  get size(): number {
    return this.rows.length;
  }

  /** Varsayılan yol arayüzünün IPv4 adresi (sağlayıcıya rapor için); bulunamazsa null */
  serverIp(): string | null {
    if (!this.iface) return null;
    try {
      return os.networkInterfaces()[this.iface]?.find((a) => a.family === 'IPv4' && !a.internal)?.address ?? null;
    } catch {
      return null;
    }
  }

  /** Biten dakikaların özetini kuyruğa ekler (sonda yanıtları işlensin diye birkaç saniye gecikmeli) */
  private minutePass(now: number): void {
    const current = Math.floor((now - PERSIST_LAG_MS) / MINUTE) * MINUTE;
    if (this.minuteAt === null) {
      this.minuteAt = current;
      return;
    }
    // Uzun bir aradan sonra (süreç duraklatıldı) yalnızca son dakika özetlenir
    if (current - this.minuteAt > 10 * MINUTE) this.minuteAt = current - MINUTE;
    while (this.minuteAt < current) {
      const at = this.minuteAt;
      this.minuteAt += MINUTE;
      const rows = this.rows.filter((r) => r.t > at && r.t <= at + MINUTE);
      if (rows.length === 0 || !this.opts.dir) continue;
      this.buffer.push({ kind: 'netmin', day: dayKey(at, this.offsetMin), line: JSON.stringify(minuteOf(at, rows)) });
    }
  }

  /** Gecikmeli değerlendirme: anormal satırın ±30 sn çevresini diske yazar */
  private persistPass(now: number): void {
    if (!this.opts.dir) return;
    const limit = now - PERSIST_LAG_MS;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]!;
      if (r.t <= this.evaluatedT) continue;
      if (r.t > limit) break;
      this.evaluatedT = r.t;
      const recent = this.rows.slice(Math.max(0, i - 9), i + 1);
      if (isAbnormalRow(r, recent)) {
        // Önce geriye dönük çevre (henüz yazılmamış satırlar)
        for (let j = 0; j < i; j++) {
          const b = this.rows[j]!;
          if (b.t > this.writtenT && b.t >= r.t - PERSIST_AROUND_MS) this.write(b);
        }
        this.keepUntil = r.t + PERSIST_AROUND_MS;
      }
      if (r.t <= this.keepUntil && r.t > this.writtenT) this.write(r);
    }
    if (this.buffer.length >= 30 || (this.buffer.length > 0 && now - this.lastFlushAt >= FLUSH_EVERY_MS)) void this.flush(now);
  }

  private write(r: SecondRow): void {
    this.writtenT = r.t;
    this.buffer.push({ kind: 'netsec', day: dayKey(r.t, this.offsetMin), line: JSON.stringify(r) });
    this.persistedRows++;
  }

  flush(now = Date.now()): Promise<void> {
    const dir = this.opts.dir;
    if (!dir || this.buffer.length === 0) return this.flushing ?? Promise.resolve();
    const run = async (): Promise<void> => {
      const pending = this.buffer;
      this.buffer = [];
      this.lastFlushAt = now;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const byFile = new Map<string, PendingLine[]>();
        for (const p of pending) {
          const name = `${p.kind}-${p.day}.jsonl`;
          const l = byFile.get(name);
          if (l) l.push(p);
          else byFile.set(name, [p]);
        }
        for (const [name, list] of byFile) {
          const file = path.join(dir, name);
          let lines = list.map((p) => p.line);
          // Saniyelik kayıt gün başına boyut sınırlıdır (dakikalık özet zaten küçüktür)
          if (list[0]!.kind === 'netsec') {
            let size = this.dayBytes.get(name);
            if (size === undefined) size = (await fs.promises.stat(file).catch(() => null))?.size ?? 0;
            const kept: string[] = [];
            for (const line of lines) {
              const bytes = Buffer.byteLength(line) + 1;
              if (size + bytes > DAY_MAX_BYTES) {
                this.dropped++;
                continue;
              }
              size += bytes;
              kept.push(line);
            }
            this.dayBytes.set(name, size);
            lines = kept;
          }
          if (lines.length > 0) await fs.promises.appendFile(file, lines.join('\n') + '\n');
        }
        if (now - this.lastCleanup > 6 * 3_600_000) {
          this.lastCleanup = now;
          await this.removeOldFiles(now);
        }
      } catch (err) {
        if (!this.warned) this.opts.log?.warn({ err: String(err) }, 'saniyelik ağ kaydı yazılamadı');
        this.warned = true;
      }
    };
    const p: Promise<void> = (this.flushing ?? Promise.resolve()).then(run).finally(() => {
      if (this.flushing === p) this.flushing = null;
    });
    this.flushing = p;
    return p;
  }

  /**
   * Saklama süresini aşan dosyaları siler. Eski biçimlerin (network-*: dakikalık özet, micro-*: kısa kesinti
   * dedektörü) artık yazılmayan dosyaları da süreleri dolunca buradan temizlenir.
   */
  async removeOldFiles(now = Date.now()): Promise<void> {
    const dir = this.opts.dir;
    if (!dir) return;
    const oldest = (days: number): string => dayKey(now - (days - 1) * 86_400_000, this.offsetMin);
    const limits: Record<string, string> = {
      netsec: oldest(SECONDS_RETENTION_DAYS),
      netmin: oldest(MINUTES_RETENTION_DAYS),
      network: oldest(MINUTES_RETENTION_DAYS),
      micro: oldest(SECONDS_RETENTION_DAYS),
    };
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const m = /^(netsec|netmin|network|micro)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (m && m[2]! < limits[m[1]!]!) {
        await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
        this.dayBytes.delete(name);
      }
    }
  }

  // ---------- Okuma (yönetim uçları) ----------

  private async readLines<T>(file: string, keep: (v: T) => boolean | 'stop', max: number): Promise<T[]> {
    const out: T[] = [];
    if (!fs.existsSync(file)) return out;
    const stream = fs.createReadStream(file, 'utf8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        let v: T;
        try {
          v = JSON.parse(line) as T;
        } catch {
          continue;
        }
        const k = keep(v);
        if (k === 'stop') break;
        if (k) out.push(v);
        if (out.length >= max) break;
      }
    } finally {
      // Döngüden erken çıkılınca readline akışı kapatmaz: dosya tanıtıcısı sızmasın
      rl.close();
      stream.destroy();
    }
    return out;
  }

  /**
   * [from, to] aralığının saniyelik satırları: halkada olanlar bellekten, daha eskisi diskteki (yalnızca anormal
   * saniyelerin çevresini içeren) kayıttan. En çok `max` satır.
   */
  async seconds(from: number, to: number, max = 900): Promise<SecondRow[]> {
    const ring = this.window(from, to);
    const ringStart = this.rows[0]?.t ?? Number.POSITIVE_INFINITY;
    const dir = this.opts.dir;
    if (!dir || from >= ringStart) return ring.slice(0, max);
    await this.flush();
    const until = Math.min(to, ringStart - 1);
    const disk: SecondRow[] = [];
    for (let day = from; disk.length < max; day += 86_400_000) {
      const key = dayKey(Math.min(day, until), this.offsetMin);
      const rows = await this.readLines<SecondRow>(
        path.join(dir, `netsec-${key}.jsonl`),
        (r) => (typeof r.t !== 'number' ? false : r.t > until ? 'stop' : r.t >= from),
        max - disk.length,
      );
      disk.push(...rows);
      if (key === dayKey(until, this.offsetMin)) break;
    }
    return [...disk, ...ring].slice(0, max);
  }

  /** Bir günün (YYYY-AA-GG, istatistik saat dilimi) dakikalık özetleri */
  async minutes(day: string): Promise<MinuteRow[]> {
    const dir = this.opts.dir;
    if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    await this.flush();
    return this.readLines<MinuteRow>(path.join(dir, `netmin-${day}.jsonl`), (r) => typeof r.at === 'number', 1_600);
  }

  /** Dakikalık özeti bulunan günler (yeniden eskiye) */
  async minuteDays(): Promise<string[]> {
    const dir = this.opts.dir;
    if (!dir) return [];
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    return names
      .map((n) => /^netmin-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse();
  }
}
