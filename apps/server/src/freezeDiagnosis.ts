import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { AlignedTrace } from './clientTrace.js';
import type { LkRow } from './infraStats.js';
import { isPartialProbeOutage, type Outage } from './netOutages.js';
import { GATEWAY_LABEL, summarizeRows, type SecondRow, type SecondSampler, type ServerSummary } from './netSeconds.js';
import type { TelemetryEntry } from './telemetry.js';
import { summarizeTraces, type TraceEvidence } from './traceEvidence.js';

// Bağlantı teşhisi: bir ses kanalında birden çok kullanıcı kayıp/donma bildirirse bunu tek bir olay olarak
// toplar; sunucunun saniyelik ağ kaydı, kesinti kaydı (dış sondalar + NIC sessizliği) ve LiveKit ölçümleriyle
// birlikte sınıflandırır. Amaç arızalı bölümü adıyla söylemek:
//   sağlayıcı ağı (tam kesinti) · sunucuya gelen yol · sunucudan giden yol · sunucu makinesi / ses sunucusu ·
//   yayıncının hattı ya da kodlayıcısı · tek kullanıcının hattı
// Çıktı: neden + düz Türkçe özet cümlesi + kanıt cümleleri + EKSİK kanıt listesi (neyin doğrulanamadığı).
// Sınıflandırıcı (diagnose) saf bir fonksiyondur (testlenir).
//
// Zaman çözünürlüğü: istemci özetleri ~30 sn'lik pencerelerdir (kalite bozulunca 10 sn'de bir). "Aynı anda"
// demek için kullanıcıların KÖTÜ pencerelerinin zamanda çakışması aranır (olay boyunca en kötü değerlere
// bakmak, dakikalar arayla kayıp gören kullanıcıları yanlışlıkla "ortak" sayardı). Saniye düzeyinde hizalama
// yalnızca sunucu tarafındaki kesinti kaydıyla yapılabilir.

export type FreezeCause =
  | 'saglayici_kesinti'
  | 'saglayici_gelen'
  | 'saglayici_giden'
  | 'sunucu_kaynak'
  /** İstemci ↔ sunucu yolu ya da ses sunucusu: istemcilerin STUN'u aynı anda yanıtsız, sunucu tarafında doğrulama yok */
  | 'sunucu_yolu'
  | 'yayinci_yukleme'
  | 'kodlayici'
  | 'tek_kullanici'
  | 'ayri_kullanicilar'
  /** Eski kayıtlar (artık üretilmez: yerini saglayici_gelen / saglayici_giden aldı) */
  | 'ortak_yol'
  | 'belirsiz';

export const FREEZE_CAUSE_LABELS: Record<FreezeCause, string> = {
  saglayici_kesinti: 'Sağlayıcı ağı: tam kesinti',
  saglayici_gelen: 'Sunucuya gelen yol (sağlayıcı)',
  saglayici_giden: 'Sunucudan giden yol',
  sunucu_kaynak: 'Sunucu kaynağı',
  sunucu_yolu: 'İstemci ↔ sunucu yolu / ses sunucusu',
  yayinci_yukleme: 'Yayıncının yükleme hattı',
  kodlayici: 'Kodlayıcı / kare hızı düşük',
  tek_kullanici: 'Tek kullanıcı hattı',
  ayri_kullanicilar: 'Kullanıcıların kendi hatları',
  ortak_yol: 'Ortak yol kaybı',
  belirsiz: 'Belirsiz',
};

/** Arızalı bölüm */
export type FreezeSegment = 'saglayici' | 'saglayici_gelen' | 'saglayici_giden' | 'sunucu' | 'sfu' | 'yol' | 'yayinci' | 'kullanici' | 'belirsiz';

/** Kayıp yüzdesi bu değerin üstündeyse kullanıcı "etkilendi" sayılır (assessReport uyarı eşiğiyle aynı) */
export const LOSS_PCT = 3;
/** Ping bu değerin altındaysa "normal" */
const RTT_NORMAL_MS = 150;
/** Yayın kare hızı bunun altındaysa kodlayıcı düşük (30 fps hedefinin %80'i) */
export const LOW_FPS = 24;
/** Kullanıcı başına saklanan özet penceresi (şerit grafiği ve eşzamanlılık için) */
const REPORTS_PER_USER = 60;

export type FreezeRole = 'yayıncı' | 'izleyici' | 'dinleyici';

/** Bir istemci özetinin teşhiste kullanılan kısmı */
export interface FreezeReport {
  /** Özetin anı (ms) ve kapsadığı pencere (sn): pencere [a - s·1000, a] */
  a: number;
  s: number;
  /** Giden / gelen kayıp (%), izlenen yayındaki donma sayısı, ortalama ping (ms) */
  o: number | null;
  i: number | null;
  f: number;
  r: number | null;
}

/** Bir kullanıcının olay süresince özeti */
export interface FreezeUser {
  userId: string;
  role: FreezeRole;
  reports: number;
  /** En yüksek kayıp yüzdeleri */
  lossOut: number | null;
  lossIn: number | null;
  rttAvg: number | null;
  rttMax: number | null;
  /** İzlenen yayında donma sayısı ve toplam süresi (sn) */
  freezes: number;
  freezeSec: number;
  /** Yayıncıysa gönderdiği yayın */
  screen: {
    fpsMin: number | null;
    fpsMax: number | null;
    bitrate: number | null;
    width: number | null;
    height: number | null;
    encoder: string | null;
    hardware: boolean | null;
    limitation: string;
    limitedRatio: number | null;
    encodeMs: number | null;
  } | null;
  /** İzleyiciyse izlediği yayının en düşük kare hızı */
  watchFpsMin: number | null;
  platform: string;
  /** Bağlantı yolu (aday türü · protokol); bilinmiyorsa null */
  route?: string | null;
  /** Özet pencereleri, eskiden yeniye (eski kayıtlarda yok) */
  w?: FreezeReport[];
}

/** Olay penceresindeki LiveKit ölçümlerinin özeti (düğüm geneli; katılımcı başına değil) */
export interface LiveKitSummary {
  samples: number;
  nackMax: number | null;
  pliMax: number | null;
  firMax: number | null;
  lossInPctMax: number | null;
  lossOutPctMax: number | null;
  packetsInMin: number | null;
  packetsInMax: number | null;
}

export interface Diagnosis {
  cause: FreezeCause;
  label: string;
  /** Arızalı bölüm ve düz Türkçe özet ("Sorun: …") */
  segment: FreezeSegment;
  summary: string;
  confidence: 'yüksek' | 'orta' | 'düşük';
  /** Ana nedenin yanında görülen başka etkenler */
  factors: string[];
  /** İnsan okunur kanıt cümleleri */
  evidence: string[];
  /** Doğrulanamayan / elde olmayan kanıtlar */
  missing: string[];
  /** Dış sondalar: sağlayıcı yolunda da kayıp var mıydı (en az iki hedef ya da kayıtlı kesinti) */
  probe: 'kayıp' | 'temiz' | 'yok';
}

const num = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined ? '?' : v.toFixed(digits).replace('.', ','));
const maxNullable = (a: number | null, b: number | null | undefined): number | null => (b === null || b === undefined ? a : a === null ? b : Math.max(a, b));
const minNullable = (a: number | null, b: number | null | undefined): number | null => (b === null || b === undefined ? a : a === null ? b : Math.min(a, b));
const sec = (ms: number): string => num(ms / 1000, 1);
/** Kesintinin yerel saati ("01:23:47") */
const clockOf = (o: Outage): string => o.t.slice(11, 19);

/**
 * Sunucu tarafında kaynak sorunu var mı. Sayılar trafiğe oranlanır: dakikalar içinde düşen birkaç on paket
 * (yüz binlerce paketin içinde) donmayı açıklamaz; yalnızca "önemli" olanlar nedeni sunucuya çevirir.
 */
export function serverResourceProblems(s: ServerSummary | null): { material: string[]; minor: string[]; sfu: boolean } {
  const out = { material: [] as string[], minor: [] as string[], sfu: false };
  if (!s) return out;
  const rx = Math.max(1, s.rxPackets ?? 0);
  const all = Math.max(1, (s.rxPackets ?? 0) + (s.txPackets ?? 0));
  const share = (n: number, of: number): string => `trafiğin %${num((n / of) * 100, n / of < 0.001 ? 3 : 2)}'i`;
  const judge = (n: number, of: number, text: string): void => {
    if (n <= 0) return;
    // Paket sayısı bilinmiyorsa (eski kayıt) mutlak eşik
    const known = (s.rxPackets ?? 0) + (s.txPackets ?? 0) > 0;
    const material = known ? n >= 20 && n / of >= 0.002 : n >= 20;
    if (material) out.material.push(known ? `${text} (${share(n, of)})` : text);
    else out.minor.push(known ? `${text} (${share(n, of)}: önemsiz)` : `${text} (önemsiz)`);
  };
  judge(s.nicDrops, all, `NIC'te ${s.nicDrops} paket düştü/hatalı`);
  judge(
    s.udpRcvbufErr + s.udpSndbufErr,
    rx,
    `UDP tampon hatası (alma ${s.udpRcvbufErr}, gönderme ${s.udpSndbufErr}): net.core.rmem/wmem_max düşük olabilir`,
  );
  judge(s.softnetDrops ?? 0, rx, `Çekirdek ağ kuyruğunda ${s.softnetDrops} paket düştü (softnet)`);
  if ((s.psiMax ?? 0) >= 50) out.material.push(`CPU baskısı %${num(s.psiMax)} (sunucu işlemci yetiştiremedi)`);
  if (s.livekitCpuMax !== null && s.livekitCpuMax / Math.max(1, s.cores) >= 0.85) {
    out.material.push(`LiveKit işlemcisi dolu (${num(s.livekitCpuMax * 100)}% / ${s.cores} çekirdek)`);
    out.sfu = true;
  }
  if ((s.conntrack?.usedPct ?? 0) >= 95) out.material.push(`Bağlantı izleme tablosu dolu (%${num(s.conntrack!.usedPct, 0)}): yeni akışlar düşürülür`);
  return out;
}

function probeVerdict(s: ServerSummary | null): { kind: Diagnosis['probe']; text: string } {
  if (!s || s.probeLossPct === null) return { kind: 'yok', text: 'Dış sonda verisi yok (sunucu ölçümü kapalı ya da yeni başladı).' };
  // Yalnız tek protokolün (UDP ya da TCP) sonda kesintisi tüm yolun kesildiğini göstermez: aşağıda ayrıca anılır
  const outage = (s.outages ?? []).find((o) => o.probe && !isPartialProbeOutage(o));
  const partial = (s.outages ?? []).find(isPartialProbeOutage);
  const corroborated = (s.outages ?? []).find((o) => o.kind === 'tam' && !o.probe && o.nic);
  if (!outage && corroborated?.nic) {
    return {
      kind: 'kayıp',
      text: `Sunucuya paket gelmeyen saniyelerde (${clockOf(corroborated)}) ${corroborated.nic.probesLost} dış sonda da yanıtsız kaldı: sunucunun dış yolu kesildi.`,
    };
  }
  if (outage?.probe) {
    const p = outage.probe;
    return {
      kind: 'kayıp',
      text: `Dış sondalar ${clockOf(outage)} anında ${sec(p.durationMs)} sn yanıtsız kaldı (${p.lost} sonda art arda; ${p.targets.join(', ')}${p.udp && p.tcp ? '; UDP ve TCP birlikte' : ''}): sunucunun dış yolu kesildi.`,
    };
  }
  const lossy = s.probeLossyTargets ?? [];
  const pct = (label: string): string => `${label} %${num(s.probes[label]?.lossPct, 1)}`;
  if (partial?.probe) {
    const p = partial.probe;
    const [only, other] = p.proto === 'udp' ? ['UDP', 'TCP'] : ['TCP', 'UDP'];
    return {
      kind: lossy.length >= 2 ? 'kayıp' : 'temiz',
      text:
        `Yalnız ${only} sondaları ${clockOf(partial)} anında ${sec(p.durationMs)} sn art arda yanıtsız kaldı (${p.lost} sonda; ${p.targets.join(', ')}), ${other} sondaları yanıt verdi: sunucunun dış yolu tümden kesilmedi; ${only}'ye özgü kayıp (sağlayıcı süzgeci / hız sınırı) olabilir.` +
        (lossy.length >= 2 ? ` Kayıplı hedefler: ${lossy.map(pct).join(', ')}.` : ''),
    };
  }
  if (lossy.length >= 2) {
    return { kind: 'kayıp', text: `Sunucudan birden çok dış hedefe kayıp var (${lossy.map(pct).join(', ')}): sağlayıcı/VPS ağ yolu.` };
  }
  const rtt = Object.entries(s.probes)
    .filter(([label]) => label !== GATEWAY_LABEL)
    .map(([, p]) => p.rttMax)
    .filter((v): v is number => v !== null);
  const single = lossy.length === 1 ? ` Yalnızca ${pct(lossy[0]!)} kayıplı: tek hedef olduğundan (o çözücünün hız sınırı olabilir) sağlayıcı yolu suçlanmadı.` : '';
  return {
    kind: 'temiz',
    text: `Dış sondalar temiz (kayıp %${num(s.probeLossPct, 1)}${rtt.length > 0 ? `, en yüksek RTT ${num(Math.max(...rtt))} ms` : ''}): sunucunun genel internet yolu sağlam.${single}`,
  };
}

/** Bir kullanıcının, verilen ölçüte uyan ("kötü") özet pencereleri. Pencere bilgisi yoksa (eski kayıt) her an sayılır. */
function badWindows(u: FreezeUser, pick: (r: FreezeReport) => boolean): [number, number][] {
  if (!u.w || u.w.length === 0) return [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]];
  return u.w.filter(pick).map((r) => [r.a - Math.max(1, r.s) * 1000, r.a]);
}

/**
 * Kötü pencereleri aynı anda çakışan en kalabalık kullanıcı kümesi ve çakışma aralığı. Kimsenin kötü penceresi
 * yoksa boş küme.
 */
export function simultaneous(users: FreezeUser[], pick: (r: FreezeReport) => boolean): { users: FreezeUser[]; from: number; to: number } {
  const wins = users.map((u) => ({ u, list: badWindows(u, pick) })).filter((x) => x.list.length > 0);
  let best: { users: FreezeUser[]; from: number; to: number } = { users: [], from: 0, to: 0 };
  // En kalabalık an, bir pencerenin başlangıcındadır
  for (const { list } of wins) {
    for (const [start] of list) {
      const t = Number.isFinite(start) ? start + 1 : 0;
      const hit = wins
        .map((x) => ({ u: x.u, win: x.list.find(([a, b]) => a <= t && t <= b) }))
        .filter((x): x is { u: FreezeUser; win: [number, number] } => x.win !== undefined);
      if (hit.length > best.users.length) {
        best = { users: hit.map((x) => x.u), from: Math.max(...hit.map((x) => x.win[0])), to: Math.min(...hit.map((x) => x.win[1])) };
      }
    }
  }
  return best;
}

/** LiveKit ölçümlerinin özeti; ölçüm yoksa null */
export function summarizeLiveKit(rows: LkRow[]): LiveKitSummary | null {
  if (rows.length === 0) return null;
  const pick = (f: (r: LkRow) => number | null): number[] => rows.map(f).filter((v): v is number => v !== null);
  const max = (f: (r: LkRow) => number | null): number | null => {
    const v = pick(f);
    return v.length === 0 ? null : Math.max(...v);
  };
  const pin = pick((r) => r.pin);
  return {
    samples: rows.length,
    nackMax: max((r) => r.nack),
    pliMax: max((r) => r.pli),
    firMax: max((r) => r.fir),
    lossInPctMax: max((r) => r.lin),
    lossOutPctMax: max((r) => r.lout),
    packetsInMin: pin.length === 0 ? null : Math.min(...pin),
    packetsInMax: pin.length === 0 ? null : Math.max(...pin),
  };
}

/** Saf sınıflandırıcı: kullanıcı kanıtları + sunucu özeti (+ LiveKit özeti) → en olası neden */
export function diagnose(users: FreezeUser[], server: ServerSummary | null, lk: LiveKitSummary | null = null, trace: TraceEvidence | null = null): Diagnosis {
  const lossyOut = (r: FreezeReport): boolean => (r.o ?? 0) >= LOSS_PCT;
  const lossyIn = (r: FreezeReport): boolean => (r.i ?? 0) >= LOSS_PCT;
  const up = users.filter((u) => (u.lossOut ?? 0) >= LOSS_PCT);
  const down = users.filter((u) => (u.lossIn ?? 0) >= LOSS_PCT);
  const streamers = users.filter((u) => u.role === 'yayıncı');
  const freezers = users.filter((u) => u.freezes > 0);
  const affected = new Set([...up, ...down, ...freezers].map((u) => u.userId));
  const upSim = simultaneous(up, lossyOut);
  const downSim = simultaneous(down, lossyIn);
  const probe = probeVerdict(server);
  const evidence: string[] = [];
  const factors: string[] = [];
  const missing: string[] = [];
  const outages = server?.outages ?? [];
  const longest = (kind: Outage['kind']): Outage | null =>
    outages.filter((o) => o.kind === kind).sort((a, b) => b.durationMs - a.durationMs)[0] ?? null;
  const total = longest('tam');
  /** Tüm dış yol kesintisi (yalnız tek protokolün kesintisi sağlayıcı kesintisi yargısını seçmez) */
  const probeOnly = outages.filter((o) => o.kind === 'sonda' && !isPartialProbeOutage(o)).sort((a, b) => b.durationMs - a.durationMs)[0] ?? null;
  /** Doğrulanmamış NIC sessizliği: tek başına hiçbir sağlayıcı yargısını seçmez */
  const nicOnly = longest('aday');

  const lossRange = (list: FreezeUser[], pick: (u: FreezeUser) => number | null): string => {
    const v = list.map(pick).filter((x): x is number => x !== null);
    return v.length === 0 ? '?' : `%${num(Math.min(...v))}–${num(Math.max(...v))}`;
  };
  const rttNote = (list: FreezeUser[]): string => {
    const r = list.map((u) => u.rttAvg).filter((x): x is number => x !== null);
    if (r.length === 0) return 'ping bilinmiyor';
    return Math.max(...r) < RTT_NORMAL_MS ? `ping normal (en çok ${num(Math.max(...r))} ms)` : `ping de yüksek (${num(Math.max(...r))} ms)`;
  };
  const freezeNote = (): string | null => {
    const n = freezers.reduce((s, u) => s + u.freezes, 0);
    return n > 0 ? `izleyicilerde toplam ${n} donma (${num(freezers.reduce((s, u) => s + u.freezeSec, 0), 1)} sn)` : null;
  };
  /** Yayıncıların (hepsinin) kodlayıcı durumu; sorun yoksa null */
  const encoderNotes = streamers
    .map((st) => {
      const s = st.screen;
      if (!s) return null;
      const lowFps = s.fpsMin !== null && s.fpsMin > 0 && s.fpsMin < LOW_FPS;
      const limited = s.limitation !== 'none' && (s.limitedRatio ?? 0) >= 0.3;
      if (!lowFps && !limited) return null;
      return {
        byNetwork: s.limitation === 'bandwidth',
        text: `yayıncı ${lowFps ? `${num(s.fpsMin)}–${num(s.fpsMax)} fps` : 'kısıtlı'}${s.limitation !== 'none' ? ` (kısıtlama: ${s.limitation})` : ''}${s.encoder ? `, ${s.encoder}` : ''}${s.bitrate ? `, ${num(s.bitrate / 1e6, 1)} Mbps` : ''}`,
      };
    })
    .filter((x): x is { byNetwork: boolean; text: string } => x !== null);
  const enc = encoderNotes.length > 0 ? encoderNotes.map((e) => e.text).join('; ') : null;
  const resource = serverResourceProblems(server);

  // ----- ortak kanıt ve eksik kanıt cümleleri -----
  const serverLine = (): string => {
    if (!server) return 'Sunucu ağ kaydı yok.';
    const parts = [
      `en yüksek giden ${server.txMbpsMax === null ? '?' : `${num(server.txMbpsMax, 1)} Mbps`}`,
      server.rxPpsMin != null && server.rxPpsMax != null ? `gelen paket ${num(server.rxPpsMin)}–${num(server.rxPpsMax)}/sn` : null,
      `NIC düşüşü ${server.nicDrops}`,
      `UDP tampon hatası ${server.udpRcvbufErr + server.udpSndbufErr}`,
      server.conntrack?.usedPct != null ? `conntrack %${num(server.conntrack.usedPct, 0)}` : null,
    ].filter(Boolean);
    return `Sunucu ağı: ${parts.join(', ')}${resource.material.length === 0 ? '; sunucuda kaynak sorunu yok' : ''}.`;
  };
  const dipLine = (): string | null => {
    const d = server?.rxDip;
    if (!d || d.pct >= 50) return null;
    return `Sunucuya gelen paket hızı ${num(d.baseline)} → ${num(d.pps)}/sn'ye düştü (olağanın %${num(d.pct)}'i).`;
  };
  const lkLines = (): string[] => {
    if (!lk) return [];
    const out: string[] = [];
    const storm = (lk.pliMax ?? 0) + (lk.firMax ?? 0) >= 2;
    if (storm || (lk.nackMax ?? 0) >= 20) {
      out.push(
        `LiveKit: ${storm ? 'anahtar kare isteği dalgası (PLI en çok ' + num(lk.pliMax, 1) + '/sn), ' : ''}NACK en çok ${num(lk.nackMax, 1)}/sn${lk.lossInPctMax != null ? `, yayıncılardan gelen akışta kayıp en çok %${num(lk.lossInPctMax, 1)}` : ''}.`,
      );
    } else if ((lk.lossInPctMax ?? 0) >= LOSS_PCT) {
      out.push(`LiveKit: yayıncılardan gelen akışta kayıp en çok %${num(lk.lossInPctMax, 1)}.`);
    }
    if (lk.packetsInMin !== null && lk.packetsInMax !== null && lk.packetsInMax >= 50 && lk.packetsInMin < lk.packetsInMax * 0.4) {
      out.push(`LiveKit'e gelen paket hızı ${num(lk.packetsInMax)} → ${num(lk.packetsInMin)}/sn'ye düştü.`);
    }
    return out;
  };
  const burstFactor = (): void => {
    const b = server?.burst;
    if (!b) return;
    const when = b.secBeforeLoss === null ? 'olay sırasında' : b.secBeforeLoss === 0 ? 'kayıpla aynı saniyede' : `kayıptan ${b.secBeforeLoss} sn önce`;
    factors.push(
      `patlama_sonrasi: ${when} giden ${num(b.txMbps, 1)} Mbps${b.txPps != null ? ` / ${num(b.txPps)} pk/sn` : ''}` +
        `${b.baseTxMbps != null ? ` (olağanı ${num(b.baseTxMbps, 1)} Mbps)` : ''}${b.rxMbps != null && b.baseRxMbps != null ? `, gelen ${num(b.baseRxMbps, 1)} → ${num(b.rxMbps, 1)} Mbps` : ''}` +
        ': patlamayla tetiklenen hız sınırı olabilir',
    );
  };
  /** İstemci olay kayıtlarından (saniyelik ölçümler) kanıt cümleleri; kayıt yoksa boş */
  const traceLines = (): string[] => {
    if (!trace) return [];
    const out: string[] = [];
    const mbps = (bps: number): string => num(bps / 1e6, 1);
    const st = trace.stun ?? trace.stunPartial;
    if (st) {
      const covered = st.users.length + st.alive.length;
      const counts = `kayıtları o saniyeleri kapsayan ${covered} kullanıcıdan ${st.users.length} tanesinde yanıtsız, ${st.alive.length} tanesinde canlı`;
      if (trace.stun) {
        out.push(
          `İstemci kayıtları: ${st.users.length} kullanıcının STUN yoklamaları aynı anda ${sec(st.maxMs)} sn yanıtsız kaldı (${counts}): istemci ↔ sunucu UDP yolu o saniyelerde bu kullanıcılar için kesikti (medyadan bağımsız kanıt).`,
        );
      } else if (st.users.length === 1) {
        out.push(`İstemci kayıtları: yalnızca bir kullanıcının STUN yoklamaları ${sec(st.maxMs)} sn yanıtsız kaldı (${counts}): o kullanıcının yolu.`);
      } else {
        out.push(`İstemci kayıtları: ${st.users.length} kullanıcının STUN yoklamaları aynı anda ${sec(st.maxMs)} sn yanıtsız kaldı ama çoğunluk değil (${counts}): herkes için kesinti değil, o kullanıcıların ortak yolu olabilir.`);
      }
    }
    const b = trace.burst;
    if (b) {
      out.push(
        `Yayıncı kaydı: yayın bit hızı ${mbps(b.baseBps)} → ${mbps(b.bps)} Mbps'e sıçradı (${b.keyFrames} anahtar kare, ${b.hugeFrames} dev kare)` +
          (b.lossAt !== null ? `; ${num(Math.max(0, (b.lossAt - b.at) / 1000), 0)} sn sonra karşı tarafın bildirdiği kayıp %${num(b.lossPct, 0)}'e yükseldi.` : '; ardından kayıp yükselmedi.'),
      );
    }
    if (trace.pliMax >= 2 || trace.nackMax >= 20) {
      out.push(`İstemci kayıtları: yayıncıya gelen anahtar kare isteği (PLI/FIR) en çok ${num(trace.pliMax, 1)}/sn, yeniden gönderme isteği (NACK) ${num(trace.nackMax, 1)}/sn.`);
    }
    if (trace.lossOutAudioPct !== null && trace.lossOutVideoPct !== null) {
      out.push(`Giden kayıp türe göre (istemci kayıtları): ses %${num(trace.lossOutAudioPct, 1)}, görüntü %${num(trace.lossOutVideoPct, 1)}.`);
    }
    if (trace.lossInAudioPct !== null && trace.lossInVideoPct !== null && trace.lossInAudioPct + trace.lossInVideoPct > 0) {
      out.push(`Gelen kayıp türe göre (istemci kayıtları): ses %${num(trace.lossInAudioPct, 1)}, görüntü %${num(trace.lossInVideoPct, 1)}.`);
    }
    if (trace.bwe) out.push(`Bant genişliği tahmini ${mbps(trace.bwe.from)} → ${mbps(trace.bwe.to)} Mbps'e çöktü (kaybın sonucudur, nedeni değil).`);
    const sr = trace.sentReceived;
    if (sr) {
      out.push(
        `Yayıncı ${sr.sent} görüntü paketi gönderdi, bir izleyici aynı saniyelerde ${sr.received} paket aldı (≈%${num(sr.pct, 0)}); karşılaştırma YAKLAŞIKTIR (saat hizası ±1 sn, SFU'nun katman seçimi ve yeniden gönderimler sayıyı değiştirir).`,
      );
    }
    if (trace.decoderFreezes.length > 0) {
      const ms = trace.decoderFreezes.reduce((n, d) => n + d.ms, 0);
      out.push(`${trace.decoderFreezes.length} izleyici taşıması temizken dondu (gelen kayıp yok, STUN canlı; toplam ${sec(ms)} sn): çözücü / işleme tarafı.`);
    }
    if (trace.lagMax && trace.lagMax.ms >= 500) out.push(`Bir istemcide JS olay döngüsü ${num(trace.lagMax.ms)} ms takıldı (o saniyelerin ölçümleri gecikmiş olabilir).`);
    return out;
  };
  const baseMissing = (providerSide: boolean): void => {
    if (!server) missing.push('Sunucu saniyelik ağ kaydı yok (ölçüm kapalıydı ya da yeni başlamıştı).');
    if (probe.kind === 'yok') missing.push('Dış sonda verisi yok.');
    if (!lk) missing.push('LiveKit ölçümleri yok (NACK/PLI/kayıp oranları bilinmiyor).');
    if (server && !server.conntrack && providerSide) missing.push('conntrack sayaçları okunamadı (bağlantı izleme tablosunun doluluğu bilinmiyor).');
    if (providerSide) missing.push('Kullanıcıların IP/servis sağlayıcı bilgisi telemetride yok: farklı ağlardan bağlandıkları doğrulanamadı.');
    if (outages.length === 0) missing.push("İstemci özetleri 10–30 sn'lik pencerelerdir: kayıpların aynı saniyede olduğu doğrulanamadı.");
  };
  const userLossLines = (): void => {
    if (up.length > 0) evidence.push(`${up.length} kullanıcıda giden kayıp ${lossRange(up, (u) => u.lossOut)}; ${rttNote(up)}`);
    if (down.length > 0) evidence.push(`${down.length} kullanıcıda gelen kayıp ${lossRange(down, (u) => u.lossIn)}`);
    const f = freezeNote();
    if (f) evidence.push(f);
  };
  const done = (cause: FreezeCause, segment: FreezeSegment, summary: string, confidence: Diagnosis['confidence']): Diagnosis => {
    // Doğrulanmamış NIC sessizliği, nedeni seçmediği durumlarda yalnızca etken olarak anılır
    if (nicOnly?.nic && cause !== 'saglayici_gelen' && cause !== 'saglayici_kesinti') {
      factors.push(
        `NIC sessizliği adayı: ${clockOf(nicOnly)} anında ${sec(nicOnly.durationMs)} sn sunucuya gelen paket ${num(nicOnly.nic.rxpMin)}/sn'ye düştü; dış sondalarla doğrulanmadı ve birden çok kullanıcının aynı andaki giden kaybıyla desteklenmedi (tek başına sağlayıcıyı göstermez)`,
      );
    }
    // İstemci olay kayıtları: varsa kanıta eklenir, yoksa (eski istemci) eksik kanıt olarak yazılır
    evidence.push(...traceLines());
    if (trace?.burst && trace.burst.lossAt !== null && !factors.some((f) => f.startsWith('patlama_sonrasi'))) {
      factors.push(`patlama_sonrasi (yayıncı kaydı): yayın bit hızı ${num(trace.burst.baseBps / 1e6, 1)} → ${num(trace.burst.bps / 1e6, 1)} Mbps sıçramasının ardından kayıp`);
    }
    if (!trace) missing.push('İstemci olay kaydı yok (eski istemci ya da kayıt ulaşmadı): STUN, kodlayıcı ve çözücünün saniyelik durumu bilinmiyor.');
    else if (trace.users.length < users.length) missing.push(`${users.length - trace.users.length} kullanıcıdan olay kaydı yok (eski istemci ya da kayıt ulaşmadı).`);
    return finish(cause, segment, summary, confidence);
  };
  const finish = (cause: FreezeCause, segment: FreezeSegment, summary: string, confidence: Diagnosis['confidence']): Diagnosis => ({
    cause,
    label: FREEZE_CAUSE_LABELS[cause],
    segment,
    summary,
    confidence,
    factors,
    evidence,
    missing,
    probe: probe.kind,
  });

  // 1) Tam kesinti: dış sondalar yanıtsız VE sunucuya paket gelmiyor (iki bağımsız işaret aynı anda)
  if (total && affected.size > 0) {
    const n = total.nic!;
    const p = total.probe;
    evidence.push(
      `Tam kesinti: ${clockOf(total)} anında ${sec(total.durationMs)} sn boyunca sunucuya paket ulaşmadı (gelen ${num(n.rxpMin)} pk/sn, taban ${num(n.baseline)})${n.txCollapsed ? '; giden paketler de durdu' : ''} ` +
        (p
          ? `ve dış sondalar da yanıtsız kaldı (${p.targets.join(', ')}${p.udp && p.tcp ? '; UDP ve TCP birlikte' : ''}).`
          : `ve aynı saniyelerde ${n.probesLost} dış sonda yanıtsız kaldı.`),
    );
    userLossLines();
    evidence.push(serverLine());
    evidence.push(...lkLines());
    if (outages.length > 1) evidence.push(`Olay süresince ${outages.length} kesinti kaydedildi.`);
    if (resource.minor.length > 0) evidence.push(...resource.minor);
    burstFactor();
    if (enc) factors.push(enc);
    baseMissing(true);
    return done(
      'saglayici_kesinti',
      'saglayici',
      `Sorun: barındırma sağlayıcısının ağı — sunucuya ${sec(total.durationMs)} sn hiç paket ulaşmadı`,
      'yüksek',
    );
  }

  // 2) Sunucu kaynağı: sunucuda trafiğe oranla önemli bir kaynak sorunu varken kayıp gören en az bir kullanıcı
  if (resource.material.length > 0 && affected.size > 0) {
    evidence.push(...resource.material, ...resource.minor);
    userLossLines();
    evidence.push(...lkLines());
    if (enc) factors.push(enc);
    baseMissing(false);
    return done(
      'sunucu_kaynak',
      resource.sfu ? 'sfu' : 'sunucu',
      `Sorun: ${resource.sfu ? 'ses sunucusu (LiveKit)' : 'sunucu makinesi'} — ${resource.material[0]}`,
      'yüksek',
    );
  }
  if (resource.minor.length > 0) evidence.push(...resource.minor);

  // 3) Yalnızca dış sondalar kesildi (NIC sessizliği görülmedi): yine sağlayıcı yolu, ama tek işaret
  if (probeOnly && affected.size > 0) {
    evidence.push(probe.text);
    userLossLines();
    const dip = dipLine();
    if (dip) evidence.push(dip);
    evidence.push(serverLine());
    evidence.push(...lkLines());
    burstFactor();
    if (enc) factors.push(enc);
    missing.push('NIC sessizliği saptanmadı: sunucuya paket gelmeye devam etmiş olabilir ya da trafik taban çizgisi dedektör için düşüktü; kesinti yalnızca giden yönde olabilir.');
    baseMissing(true);
    return done(
      'saglayici_kesinti',
      'saglayici',
      `Sorun: barındırma sağlayıcısının ağı — sunucunun dış bağlantısı ${sec(probeOnly.durationMs)} sn kesildi (dış sondalar yanıtsız)`,
      upSim.users.length >= 2 ? 'yüksek' : 'orta',
    );
  }

  // 3b) İstemci kayıtları: ≥2 kullanıcının (ve o saniyeleri kapsayan kayıtların çoğunluğunun) STUN yoklamaları
  // aynı saniyelerde yanıtsız. Medyadan bağımsızdır ama tek başına "sağlayıcı" demez: aynı evdeki/ISS'deki iki
  // kullanıcı ya da takılan ses sunucusu da böyle görünür. Sunucu tarafında bir doğrulama (NIC sessizliği adayı ya
  // da gelen paket çöküşü) varsa sağlayıcı yolu; yoksa "istemci ↔ sunucu yolu / ses sunucusu", en çok orta güven.
  if (trace?.stun && affected.size > 0) {
    const st = trace.stun;
    const serverDip = server?.rxDip != null && server.rxDip.pct < 50;
    const corroborated = nicOnly !== null || serverDip;
    if (nicOnly?.nic) {
      evidence.push(`NIC sessizliği: ${clockOf(nicOnly)} anında ${sec(nicOnly.durationMs)} sn sunucuya gelen paket ${num(nicOnly.nic.rxpMin)}/sn'ye düştü (istemcilerin STUN kaydıyla örtüşüyor).`);
    }
    userLossLines();
    evidence.push(probe.text);
    const dip = nicOnly ? null : dipLine();
    if (dip) evidence.push(dip);
    evidence.push(serverLine());
    evidence.push(...lkLines());
    burstFactor();
    if (enc) factors.push(enc);
    missing.push('Sunucu tarafında dış sonda kesintisi kaydedilmedi: kesinti yalnızca istemci → sunucu UDP yönünde olabilir; ses sunucusunun (LiveKit) o saniyelerde yanıt verip vermediği ayrıca doğrulanamadı.');
    if (!corroborated) {
      missing.push('Sunucu tarafında hiçbir doğrulama yok (sonda kesintisi, NIC sessizliği ya da gelen paket çöküşü): STUN yanıtsızlığı bu kullanıcıların ortak ağı (aynı ev / servis sağlayıcı) ya da takılan ses sunucusu yüzünden de olabilir.');
    }
    baseMissing(true);
    const who = `${st.users.length}/${st.users.length + st.alive.length} kullanıcının STUN yoklamaları aynı anda ${sec(st.maxMs)} sn yanıtsız kaldı`;
    if (!corroborated) {
      return done('sunucu_yolu', 'yol', `Sorun: istemci ↔ sunucu yolu ya da ses sunucusu — ${who} (sunucu tarafında doğrulanmadı)`, 'orta');
    }
    return done(
      'saglayici_kesinti',
      'saglayici',
      `Sorun: istemciler ↔ sunucu UDP yolu (barındırma sağlayıcısı) — ${who}`,
      st.users.length >= 3 || nicOnly !== null ? 'yüksek' : 'orta',
    );
  }

  // 4) Sunucuya gelen yol: birden çok kullanıcının kendi yükleme hatları AYNI ANDA kaybediyor (bağımsız hatlar
  // aynı anda bozulmaz); dış sondalarda kesinti yok. Doğrulanmamış NIC sessizliği (aday) bu adımı tek başına
  // seçemez: yalnızca ≥2 kullanıcının eşzamanlı giden kaybıyla birlikte kanıt sayılır.
  if (upSim.users.length >= 2) {
    const who = upSim.users;
    if (nicOnly) {
      const n = nicOnly.nic!;
      evidence.push(
        `NIC sessizliği: ${clockOf(nicOnly)} anında ${sec(nicOnly.durationMs)} sn boyunca sunucuya gelen paket ${num(n.baseline)} → ${num(n.rxpMin)}/sn'ye düştü; dış sondalar yanıt almayı sürdürdü (yalnızca gelen medya yolu).`,
      );
    }
    if (who.length >= 2) evidence.push(`${who.length} kullanıcıda aynı anda giden kayıp ${lossRange(who, (u) => u.lossOut)}; ${rttNote(who)}`);
    else if (up.length > 0) evidence.push(`${up.length} kullanıcıda giden kayıp ${lossRange(up, (u) => u.lossOut)}; ${rttNote(up)}`);
    if (down.length > 0) evidence.push(`${down.length} kullanıcıda gelen kayıp ${lossRange(down, (u) => u.lossIn)}`);
    const f = freezeNote();
    if (f) evidence.push(f);
    evidence.push(probe.text);
    const dip = nicOnly ? null : dipLine();
    if (dip) evidence.push(dip);
    evidence.push(serverLine());
    evidence.push(...lkLines());
    const routes = [...new Set(who.map((u) => u.route).filter((r): r is string => !!r))];
    if (routes.length > 1) evidence.push(`Kullanıcıların bağlantı yolları farklı (${routes.join(' / ')}).`);
    burstFactor();
    if (enc) factors.push(enc);
    if (probe.kind === 'kayıp') factors.push('sağlayıcı/VPS ağ yolu: dış sondalarda da kayıp');
    else if (probe.kind === 'temiz') factors.push("dış sondalar temiz: kayıp UDP medya akışına özgü (sağlayıcı süzgeci/hız sınırı şüphesi)");
    if (!nicOnly) missing.push('NIC sessizliği saptanmadı: paketler azalmış ama tümden kesilmemiş olabilir.');
    missing.push('Sağlayıcıdaki süzgeç/hız sınırı doğrudan gözlenemez; patlama profilli hat testiyle (Testler) yeniden üretilebilir.');
    baseMissing(true);
    const n = Math.max(who.length, up.length);
    return done(
      'saglayici_gelen',
      'saglayici_gelen',
      nicOnly
        ? `Sorun: sunucuya gelen yol (barındırma sağlayıcısı) — sunucuya gelen paketler ${sec(nicOnly.durationMs)} sn kesildi`
        : `Sorun: sunucuya gelen yol (barındırma sağlayıcısı) — ${n} kullanıcının gönderdiği paketler aynı anda kayboldu`,
      who.length >= 3 || (nicOnly !== null && who.length >= 2) || probe.kind === 'kayıp' ? 'yüksek' : 'orta',
    );
  }

  // 5) Sunucudan giden yol: yayıncılar temizken birden çok izleyici aynı anda gelen kayıp görüyor
  const streamerUp = streamers.some((st) => up.some((u) => u.userId === st.userId));
  if (downSim.users.length >= 2 && !streamerUp && up.length === 0) {
    const who = downSim.users;
    evidence.push(`${who.length} kullanıcıda aynı anda gelen kayıp ${lossRange(who, (u) => u.lossIn)}; ${rttNote(who)}; gönderen tarafta kayıp yok`);
    const f = freezeNote();
    if (f) evidence.push(f);
    evidence.push(probe.text);
    evidence.push(serverLine());
    evidence.push(...lkLines());
    burstFactor();
    if (enc) factors.push(enc);
    if (probe.kind === 'kayıp') factors.push('sağlayıcı/VPS ağ yolu: dış sondalarda da kayıp');
    missing.push('Sunucunun gönderdiği paketlerin nerede kaybolduğu sunucudan görülemez (NIC gönderdi sayıyor); aşağı yön hat testiyle (Testler) doğrulanabilir.');
    baseMissing(true);
    return done(
      'saglayici_giden',
      'saglayici_giden',
      `Sorun: sunucudan giden yol — ${who.length} izleyicide aynı anda gelen kayıp, gönderen temiz`,
      who.length >= 3 || probe.kind === 'kayıp' ? 'yüksek' : 'orta',
    );
  }

  // 6) Tek kullanıcının yükleme hattı (yayıncıysa: yayıncının hattı)
  if (up.length === 1) {
    const u = up[0]!;
    evidence.push(`Yalnızca bir kullanıcıda giden kayıp %${num(u.lossOut)}; ${rttNote([u])}`);
    if (down.length > 0) evidence.push(`${down.length} kullanıcıda gelen kayıp ${lossRange(down, (x) => x.lossIn)} (bu kullanıcının gönderdiği akışı alanlar)`);
    const f = freezeNote();
    if (f) evidence.push(f);
    evidence.push(probe.text);
    evidence.push(...lkLines());
    if (enc) factors.push(enc);
    baseMissing(false);
    if (streamers.some((st) => st.userId === u.userId)) {
      return done(
        'yayinci_yukleme',
        'yayinci',
        'Sorun: yayıncının yükleme hattı — yalnızca yayıncının gönderdiği paketler kayboluyor',
        down.length > 0 || freezers.length > 0 ? 'yüksek' : 'orta',
      );
    }
    return done('tek_kullanici', 'kullanici', 'Sorun: tek kullanıcının yükleme hattı — diğer kullanıcılar temiz', 'orta');
  }

  // 7) Birden çok kullanıcıda kayıp var ama pencereleri çakışmıyor: ortak bir neden yok
  if (up.length >= 2 || (down.length >= 2 && downSim.users.length < 2)) {
    userLossLines();
    evidence.push('Kayıp gören kullanıcıların kötü pencereleri zamanda çakışmıyor: ortak bir yol sorunu değil, ayrı ayrı hat sorunları.');
    evidence.push(probe.text);
    if (enc) factors.push(enc);
    baseMissing(false);
    return done('ayri_kullanicilar', 'kullanici', 'Sorun: kullanıcıların kendi hatları — kayıplar aynı anda değil', 'orta');
  }

  // 8) Ağda kayıp yok: kodlayıcı / kare hızı
  const networkLoss = down.length > 0;
  const limitedByNetwork = encoderNotes.some((e) => e.byNetwork);
  if (!networkLoss && enc && !limitedByNetwork) {
    evidence.push(`Kimsede paket kaybı yok; ${enc}`);
    const f = freezeNote();
    if (f) evidence.push(f);
    evidence.push(probe.text);
    evidence.push(...lkLines());
    baseMissing(false);
    return done('kodlayici', 'yayinci', 'Sorun: yayıncının kodlayıcısı — ağda kayıp yok, yayının kare hızı düşük', freezers.length > 0 ? 'yüksek' : 'orta');
  }

  // 9) Tek kullanıcıda gelen kayıp / donma (yayıncı ve diğerleri temiz): izleyicinin hattı ya da çözücüsü
  if (affected.size === 1 || (down.length === 1 && up.length === 0)) {
    const u = down[0] ?? freezers[0] ?? users[0]!;
    evidence.push(`Yalnızca bir kullanıcı etkilendi${u.lossIn !== null ? ` (gelen kayıp %${num(u.lossIn)})` : ''}; ${rttNote([u])}; yayıncı ve diğer kullanıcılar temiz`);
    const f = freezeNote();
    if (f) evidence.push(f);
    if (enc) factors.push(enc);
    baseMissing(false);
    return done(
      'tek_kullanici',
      'kullanici',
      (u.lossIn ?? 0) >= LOSS_PCT ? 'Sorun: tek izleyicinin indirme hattı — diğer kullanıcılar temiz' : 'Sorun: tek izleyicinin cihazı ya da çözücüsü — ağda kayıp yok, diğerleri temiz',
      'orta',
    );
  }

  // 10) Belirsiz
  const f = freezeNote();
  if (f) evidence.push(f);
  if (enc) evidence.push(enc);
  if (evidence.length === 0) evidence.push('Belirgin bir ağ, kaynak ya da kodlayıcı işareti yok.');
  evidence.push(probe.text);
  evidence.push(...lkLines());
  baseMissing(false);
  return done('belirsiz', 'belirsiz', 'Neden belirlenemedi — belirgin bir ağ, kaynak ya da kodlayıcı işareti yok', 'düşük');
}

// ---------- Olay toplayıcı ----------

export interface FreezeEvent extends Diagnosis {
  id: string;
  channelId: string;
  guildId: string | null;
  start: number;
  end: number;
  users: FreezeUser[];
  /** Etkilenen kullanıcı sayısı ve izleyicilerdeki toplam donma */
  affected: number;
  freezes: number;
  freezeSec: number;
  /** Yayın var mıydı */
  streaming: boolean;
  server: ServerSummary | null;
  /** Olay penceresindeki LiveKit ölçümlerinin özeti (eski kayıtlarda yok) */
  livekit?: LiveKitSummary | null;
  /** Olay penceresindeki istemci olay kayıtları (kaç kayıt, kimlerden) ve onlardan çıkan kanıt; kayıt yoksa null */
  traces?: { count: number; users: string[]; evidence: TraceEvidence } | null;
}

interface OpenEvent {
  id: string;
  channelId: string;
  guildId: string | null;
  start: number;
  end: number;
  lastRelevantAt: number;
  relevantUsers: Set<string>;
}

/** Olay bu kadar süre yeni ilgili özet gelmezse kapanır (başka kullanıcıların özetleri de gelsin) */
const QUIET_MS = 75_000;
/** Bir olay en fazla bu kadar sürer (sonra bölünür) */
const MAX_EVENT_MS = 10 * 60_000;
const RECENT_MS = 12 * 60_000;
const CHART_BEFORE_MS = 30_000;
const CHART_AFTER_MS = 10_000;
const CHART_MAX_ROWS = 300;
const EVENTS_MAX = 300;
const EVENT_FILE_MAX_LINES = 1_000;
const ROWS_FILE_MAX_LINES = 150;
/** Patlama araması için olay başlangıcından önce bakılan süre */
const BURST_CONTEXT_MS = 45_000;
/** Kesinti kaydı olay penceresinin bu kadar dışına taşabilir (özet anları yaklaşıktır) */
const OUTAGE_SLACK_MS = 3_000;

/** Bu özet bir kayıp/donma işareti taşıyor mu */
export function isRelevantEntry(e: Pick<TelemetryEntry, 'lossOut' | 'lossIn' | 'watch'>): boolean {
  const w = e.watch;
  return (e.lossOut ?? 0) >= LOSS_PCT || (e.lossIn ?? 0) >= LOSS_PCT || (w?.freezes ?? 0) >= 2 || (w?.freezeSec ?? 0) >= 1;
}

/** Özetlerden kullanıcı kanıtı (saf) */
export function buildUsers(entries: TelemetryEntry[]): FreezeUser[] {
  const byUser = new Map<string, FreezeUser>();
  for (const e of entries) {
    let u = byUser.get(e.userId);
    if (!u) {
      u = {
        userId: e.userId,
        role: 'dinleyici',
        reports: 0,
        lossOut: null,
        lossIn: null,
        rttAvg: null,
        rttMax: null,
        freezes: 0,
        freezeSec: 0,
        screen: null,
        watchFpsMin: null,
        platform: e.platform,
        route: null,
        w: [],
      };
      byUser.set(e.userId, u);
    }
    u.reports++;
    u.lossOut = maxNullable(u.lossOut, e.lossOut);
    u.lossIn = maxNullable(u.lossIn, e.lossIn);
    u.rttAvg = maxNullable(u.rttAvg, e.rttAvg);
    u.rttMax = maxNullable(u.rttMax, e.rttMax);
    if (e.candidate) u.route = e.protocol ? `${e.candidate}·${e.protocol}` : e.candidate;
    const w = e.watch;
    if (u.w!.length < REPORTS_PER_USER) {
      // Pencerenin bitişi: istemci bildirmişse sunucu saatine hizalanmış bitiş (endAt), yoksa ulaştığı an
      u.w!.push({ a: e.endAt ?? e.at, s: e.windowSec, o: e.lossOut, i: e.lossIn, f: w?.freezes ?? 0, r: e.rttAvg });
    }
    if (w) {
      u.freezes += w.freezes ?? 0;
      u.freezeSec += w.freezeSec ?? 0;
      if ((w.fps ?? 0) > 0 || (w.bitrate ?? 0) > 0) {
        if (u.role === 'dinleyici') u.role = 'izleyici';
        u.watchFpsMin = minNullable(u.watchFpsMin, (w.fps ?? 0) > 0 ? w.fps : null);
      }
    }
    const s = e.screen;
    if (s && ((s.fps ?? 0) > 0 || (s.bitrate ?? 0) > 0)) {
      u.role = 'yayıncı';
      const prev = u.screen;
      u.screen = {
        fpsMin: minNullable(prev?.fpsMin ?? null, (s.fps ?? 0) > 0 ? s.fps : null),
        fpsMax: maxNullable(prev?.fpsMax ?? null, s.fps),
        bitrate: maxNullable(prev?.bitrate ?? null, s.bitrate),
        width: s.width,
        height: s.height,
        encoder: s.encoder ?? prev?.encoder ?? null,
        hardware: s.hardware ?? prev?.hardware ?? null,
        limitation: s.limitation !== 'none' ? s.limitation : (prev?.limitation ?? 'none'),
        limitedRatio: maxNullable(prev?.limitedRatio ?? null, s.limitedRatio),
        encodeMs: maxNullable(prev?.encodeMs ?? null, s.encodeMs),
      };
    }
  }
  return [...byUser.values()];
}

function isFreezeEvent(v: unknown): v is FreezeEvent {
  const e = v as Partial<FreezeEvent> | null;
  return !!e && typeof e.id === 'string' && typeof e.channelId === 'string' && typeof e.start === 'number' && typeof e.cause === 'string';
}

/** İstemci olay kayıtlarının kaynağı (clientTrace.ts ClientTraceStore) */
export interface TraceSource {
  window(q: { from: number; to: number; channelId?: string; limit?: number }): Promise<{ traces: AlignedTrace[] }>;
}

/** LiveKit ölçüm kaynağı (infraStats.ts LiveKitMetrics) */
export interface LiveKitSource {
  window(from: number, to: number): LkRow[];
  /** Verilen ana kadar sık ölç (olay açıkken) */
  boost(until: number): void;
}

export interface FreezeOptions {
  /** <dataDir>/telemetry; null: yalnızca bellekte */
  dir: string | null;
  sampler: SecondSampler | null;
  livekit?: LiveKitSource | null;
  /** İstemci olay kayıtlarının kaynağı (clientTrace.ts); verilirse olay kapanırken kayıtlar kanıta katılır */
  traces?: TraceSource | null;
  /** Olay açılınca kanaldaki bütün istemcilerden olay kaydı ister (herkesin aynı saniyelere bakışı toplansın) */
  requestTraces?: (channelId: string, reason: string, eventId: string) => void;
  /** Olay kapanıp sınıflandığında (kalıcı kayıttan sonra) */
  onEvent?: (event: FreezeEvent) => void;
  log?: { warn(obj: object, msg: string): void };
  /** Olay dosyasının en çok satırı (aşılınca bellekteki listeyle yeniden yazılır); varsayılan 1000 */
  maxFileLines?: number;
}

/** Bir olayın saklanan saniyelik kanıtı */
export interface FreezeDetail {
  rows: SecondRow[];
  lk: LkRow[];
}

export class FreezeCorrelator {
  private readonly recent = new Map<string, TelemetryEntry[]>();
  private readonly open = new Map<string, OpenEvent>();
  private events: FreezeEvent[] = [];
  private eventFileLines = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private warned = false;
  private sweepErrors = 0;

  constructor(private readonly opts: FreezeOptions) {
    this.load();
  }

  private get eventFile(): string {
    return path.join(this.opts.dir!, 'freeze-events.jsonl');
  }

  private get rowsFile(): string {
    return path.join(this.opts.dir!, 'freeze-rows.jsonl');
  }

  private get maxFileLines(): number {
    return this.opts.maxFileLines ?? EVENT_FILE_MAX_LINES;
  }

  private load(): void {
    if (!this.opts.dir) return;
    let text: string;
    try {
      text = fs.readFileSync(this.eventFile, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter(Boolean);
    const since = Date.now() - 30 * 86_400_000;
    // Kırpma anındaki yeniden yazım ile sıradaki ekleme aynı olayı iki kez yazabilir: aynı kimlikte son satır geçerli
    const byId = new Map<string, FreezeEvent>();
    for (const line of lines) {
      try {
        const v = JSON.parse(line) as unknown;
        if (isFreezeEvent(v) && v.end >= since) {
          byId.delete(v.id);
          byId.set(v.id, v);
        }
      } catch {
        // bozuk satır atlanır
      }
    }
    this.events = [...byId.values()].slice(-EVENTS_MAX);
    this.eventFileLines = lines.length;
    if (lines.length > this.maxFileLines) {
      try {
        fs.writeFileSync(this.eventFile, this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        this.eventFileLines = this.events.length;
      } catch {
        // çalışırken ya da bir sonraki açılışta
      }
    }
  }

  start(): void {
    if (this.timer) return;
    // Süpürmedeki bir hata API sürecini düşürmemeli: yakalanır, seyrek günlüğe yazılır
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        if (this.sweepErrors++ % 60 === 0) this.opts.log?.warn({ err: String(err), count: this.sweepErrors }, 'yayın donması süpürmesi hata verdi');
      }
    }, 10_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sweep(Date.now(), true);
    await this.settled();
  }

  /**
   * Bekleyen bütün yazımlar bitince çözülür. Olay kayıtları okunurken (eşzamansız) olayın yazımı zincire SONRADAN
   * eklenir: zincir değişmeyene kadar beklenir (yoksa kapanışta açık olaylar yazılmadan çıkılırdı).
   */
  private async settled(): Promise<void> {
    let p: Promise<void>;
    do {
      p = this.writing;
      await p;
    } while (p !== this.writing);
  }

  /** Yeni telemetri özeti (TelemetryStore.ingest'ten sonra) */
  observe(e: TelemetryEntry): void {
    if (!e.channelId) return;
    const list = this.recent.get(e.channelId) ?? [];
    list.push(e);
    const from = e.at - RECENT_MS;
    while (list.length > 0 && list[0]!.at < from) list.shift();
    this.recent.set(e.channelId, list);
    if (!isRelevantEntry(e)) return;
    const windowStart = e.at - Math.max(1, e.windowSec) * 1000;
    let ev = this.open.get(e.channelId);
    if (ev && e.at - ev.start > MAX_EVENT_MS) {
      this.finalize(ev);
      ev = undefined;
    }
    if (!ev) {
      ev = {
        id: `${e.at.toString(36)}-${(this.seq++).toString(36)}`,
        channelId: e.channelId,
        guildId: e.guildId,
        start: windowStart,
        end: e.at,
        lastRelevantAt: e.at,
        relevantUsers: new Set(),
      };
      this.open.set(e.channelId, ev);
      // Olay açıldı: kanaldaki herkesten olay kaydı istenir (istek kimliği = olay kimliği; sıklık sınırı karşı tarafta)
      try {
        this.opts.requestTraces?.(e.channelId, 'yayın donması olayı', ev.id);
      } catch (err) {
        this.opts.log?.warn({ err: String(err) }, 'olay kaydı istenemedi');
      }
    }
    ev.start = Math.min(ev.start, windowStart);
    ev.end = Math.max(ev.end, e.at);
    ev.lastRelevantAt = e.at;
    ev.relevantUsers.add(e.userId);
    // Olay açıkken LiveKit ölçümleri sıklaşır (olay penceresinin NACK/PLI oranları için)
    try {
      this.opts.livekit?.boost(e.at + QUIET_MS);
    } catch {
      // ölçüm kaynağı yoksa önemli değil
    }
  }

  /** Düzenli: sessiz kalan olayları kapatır; eski özetleri atar */
  sweep(now = Date.now(), all = false): void {
    for (const ev of [...this.open.values()]) {
      if (all || now - ev.lastRelevantAt > QUIET_MS) this.finalize(ev);
    }
    for (const [channelId, list] of this.recent) {
      const from = now - RECENT_MS;
      while (list.length > 0 && list[0]!.at < from) list.shift();
      if (list.length === 0 && !this.open.has(channelId)) this.recent.delete(channelId);
    }
  }

  private finalize(ev: OpenEvent): FreezeEvent | null {
    this.open.delete(ev.channelId);
    // Pencereleri olayla çakışan tüm özetler (temiz çıkanlar dahil: yayıncı fps'i, "kimse etkilenmedi" bilgisi)
    const entries = (this.recent.get(ev.channelId) ?? []).filter((e) => e.at - Math.max(1, e.windowSec) * 1000 <= ev.end && e.at >= ev.start);
    const users = buildUsers(entries);
    const relevant = users.filter((u) => (u.lossOut ?? 0) >= LOSS_PCT || (u.lossIn ?? 0) >= LOSS_PCT || u.freezes > 0);
    const streaming = users.some((u) => u.role === 'yayıncı');
    // Tek başına sesli bir kullanıcının kaybı zaten tek kullanıcılık kalite sorunu olarak kayıtlı; burada ≥2 kullanıcı ya da yayın aranır
    if (relevant.length === 0 || (relevant.length < 2 && !streaming)) return null;
    const sampler = this.opts.sampler;
    const rows = sampler ? sampler.window(ev.start - CHART_BEFORE_MS, ev.end + CHART_AFTER_MS) : [];
    const win = sampler ? sampler.window(ev.start, ev.end) : [];
    const server =
      sampler && win.length > 0
        ? summarizeRows(win, ev.start, ev.end, undefined, {
            outages: sampler.outages.between(ev.start - OUTAGE_SLACK_MS, ev.end + OUTAGE_SLACK_MS),
            context: sampler.window(ev.start - BURST_CONTEXT_MS, ev.end),
          })
        : null;
    const lkRows = this.opts.livekit?.window(ev.start - CHART_BEFORE_MS, ev.end + CHART_AFTER_MS) ?? [];
    const livekit = summarizeLiveKit(lkRows.filter((r) => r.t >= ev.start && r.t <= ev.end + CHART_AFTER_MS));
    const d = diagnose(users, server, livekit);
    const event: FreezeEvent = {
      ...d,
      id: ev.id,
      channelId: ev.channelId,
      guildId: ev.guildId,
      start: ev.start,
      end: ev.end,
      users,
      affected: relevant.length,
      freezes: users.reduce((n, u) => n + u.freezes, 0),
      freezeSec: Number(users.reduce((n, u) => n + u.freezeSec, 0).toFixed(1)),
      streaming,
      server,
      livekit,
    };
    this.events.push(event);
    if (this.events.length > EVENTS_MAX) this.events.splice(0, this.events.length - EVENTS_MAX);
    const complete = (): void => {
      this.persist(event, rows, lkRows);
      try {
        this.opts.onEvent?.(event);
      } catch (err) {
        this.opts.log?.warn({ err: String(err) }, 'yayın donması bildirimi başarısız');
      }
    };
    const source = this.opts.traces;
    if (!source) {
      complete();
      return event;
    }
    // İstemci olay kayıtları diskten okunur (eşzamansız): olay önce kayıtsız sınıflanır ve listeye girer, kayıtlar
    // gelince yeniden sınıflanıp yerinde güncellenir, sonra kalıcı kayda yazılır
    this.writing = this.writing
      .then(async () => {
        const { traces } = await source.window({ from: ev.start - CHART_BEFORE_MS, to: ev.end + CHART_AFTER_MS, channelId: ev.channelId, limit: 60 });
        const evidence = summarizeTraces(traces, ev.start - CHART_BEFORE_MS, ev.end + CHART_AFTER_MS);
        if (evidence) Object.assign(event, diagnose(users, server, livekit, evidence), { traces: { count: traces.length, users: evidence.users, evidence } });
        else event.traces = null;
      })
      .catch((err: unknown) => this.opts.log?.warn({ err: String(err) }, 'olay kayıtları okunamadı'))
      .then(complete);
    return event;
  }

  private persist(event: FreezeEvent, rows: SecondRow[], lk: LkRow[]): void {
    if (!this.opts.dir) return;
    const dir = this.opts.dir;
    const stride = Math.max(1, Math.ceil(rows.length / CHART_MAX_ROWS));
    // Seyreltirken kesinti işaretli saniyeler atılmaz
    const sampled = stride === 1 ? rows : rows.filter((r, i) => i % stride === 0 || (r.o ?? 0) > 0);
    const lkStride = Math.max(1, Math.ceil(lk.length / CHART_MAX_ROWS));
    const lkSampled = lkStride === 1 ? lk : lk.filter((_, i) => i % lkStride === 0);
    // Olay dosyası çalışırken de kırpılır: sınır aşılınca bellekteki (en yeni) olaylarla yeniden yazılır
    this.eventFileLines++;
    const trim = this.eventFileLines > this.maxFileLines;
    const snapshot = trim ? this.events.map((e) => JSON.stringify(e)).join('\n') + '\n' : null;
    if (trim) this.eventFileLines = this.events.length;
    this.writing = this.writing
      .then(async () => {
        await fs.promises.mkdir(dir, { recursive: true });
        if (snapshot !== null) await fs.promises.writeFile(this.eventFile, snapshot);
        else await fs.promises.appendFile(this.eventFile, JSON.stringify(event) + '\n');
        await fs.promises.appendFile(this.rowsFile, JSON.stringify({ id: event.id, rows: sampled, lk: lkSampled }) + '\n');
        await this.trimRows();
      })
      .catch((err: unknown) => {
        if (!this.warned) this.opts.log?.warn({ err: String(err) }, 'yayın donması olayı kaydedilemedi');
        this.warned = true;
      });
  }

  /** Satır dosyası çok uzadıysa en yeni satırları tutar */
  private async trimRows(): Promise<void> {
    const text = await fs.promises.readFile(this.rowsFile, 'utf8').catch(() => '');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= ROWS_FILE_MAX_LINES * 2) return;
    await fs.promises.writeFile(this.rowsFile, lines.slice(-ROWS_FILE_MAX_LINES).join('\n') + '\n');
  }

  /** Bekleyen yazımlar bitince çözülür (testler) */
  flushed(): Promise<void> {
    return this.settled();
  }

  // ---------- Okuma ----------

  /** Olaylar, en yeniler önce */
  list(since: number): FreezeEvent[] {
    return this.events.filter((e) => e.end >= since).sort((a, b) => b.end - a.end);
  }

  /** Bir olayın saklanan kanıtı (dosyadan): saniyelik sunucu satırları ve LiveKit ölçümleri; yoksa boş */
  async detailOf(id: string): Promise<FreezeDetail> {
    const empty: FreezeDetail = { rows: [], lk: [] };
    if (!this.opts.dir || !/^[0-9a-z-]{1,40}$/.test(id)) return empty;
    await this.settled();
    if (!fs.existsSync(this.rowsFile)) return empty;
    const rl = readline.createInterface({ input: fs.createReadStream(this.rowsFile, 'utf8'), crlfDelay: Infinity });
    let found = empty;
    for await (const line of rl) {
      if (!line.includes(`"id":"${id}"`)) continue;
      try {
        const v = JSON.parse(line) as { id: string; rows: SecondRow[]; lk?: LkRow[] };
        if (v.id === id) found = { rows: v.rows, lk: v.lk ?? [] };
      } catch {
        continue;
      }
    }
    return found;
  }

  /** Bir olayın saniyelik satırları (dosyadan); yoksa boş */
  async rowsOf(id: string): Promise<SecondRow[]> {
    return (await this.detailOf(id)).rows;
  }
}
