import {
  TELEMETRY_INTERVAL_MS,
  TELEMETRY_MIN_GAP_MS,
  type TelemetryAudioIn,
  type TelemetryJsLag,
  type TelemetryLimitation,
  type TelemetryMic,
  type TelemetryQuality,
  type TelemetryDevice,
  type TelemetryScreen,
  type TelemetryView,
  type TelemetryVoiceSettings,
  type TelemetryWatch,
  type VoiceTelemetryReport,
} from '@diskort/shared';
import { normalizeServerUrl } from './api';
import {
  isHardwareCodec,
  jitterBufferMs,
  mainInboundVideo,
  perFrameMs,
  type RtpStream,
  type TransportStats,
  type VideoCounters,
} from './connectionStats';
import { env } from './env';
import { serverClock } from './serverClock';
import { useSession } from './session';

/**
 * Ses kalitesi ölçümü (yönetim paneli): platformun 2 saniyede bir aldığı bağlantı istatistiklerinden
 * (connectionStats) ~30 saniyelik özetler çıkarır ve sunucuya gönderir; kalite "kötü"ye düşünce özet hemen
 * gider (en fazla 10 sn'de bir). Yalnızca zaten ölçülen değerler toplanır, ek getStats çağrısı yok (gelen
 * akışlar için abonelik bağlantısı 10 sn'de bir okunur). Hatalar sessizce yutulur: görüşmeyi asla etkilemez.
 *
 * livekit-client 2.x varsayılan olarak tek bağlantı kullanır (singlePeerConnection): abonelik bağlantısı
 * yoktur, gelen akışlar da yayın bağlantısının raporundadır. O durumda gelen akışlar yayın bağlantısından okunur.
 */

/** Abonelik bağlantısının (gelen akışlar) okunma aralığı */
export const TELEMETRY_SUBSCRIBER_EVERY_MS = 10_000;
/** Çıkarken son yarım özet ancak bu kadar ölçüm varsa gönderilir */
const MIN_FINAL_SAMPLES = 3;
/** Ölçümler arasında en fazla sayılan süre (uyku/donma sonrası uzun aralık "kötü" süresini şişirmesin) */
const MAX_STEP_MS = 10_000;

/** Platformun her özet için verdiği anlık bilgiler */
export interface TelemetryContext {
  channelId: string | null;
  mic: TelemetryMic | null;
  /** İzlenen yayının görünümü (tam ekran / küçük); bildirmeyen platformda yok */
  view?: TelemetryView | null;
  device?: TelemetryDevice | null;
  /** Sesi bozabilecek kayıtlı ses ayarları */
  settings?: TelemetryVoiceSettings | null;
}

export interface TelemetrySample {
  at: number;
  /** Yayın bağlantısının şimdiki ve bir önceki ölçümü */
  publisher: TransportStats | null;
  prevPublisher: TransportStats | null;
  /** Bu ölçümde okunduysa abonelik bağlantısı (tek bağlantı kipinde hep null) */
  subscriber: TransportStats | null;
  /** Son saniyelerin kalitesi (linkQuality) */
  quality: TelemetryQuality;
  /** LiveKit'in bildirdiği bağlantı kalitesi (excellent, good, poor, lost, unknown) */
  serverQuality?: string | null;
}

const SERVER_QUALITY_RANK: Record<string, number> = { excellent: 1, good: 2, poor: 3, lost: 4 };

class Mean {
  sum = 0;
  n = 0;
  max: number | null = null;
  add(v: number | null | undefined): void {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    this.sum += v;
    this.n++;
    if (this.max === null || v > this.max) this.max = v;
  }
  get avg(): number | null {
    return this.n ? this.sum / this.n : null;
  }
}

/** İki ölçüm arasında harcanan süre (sn) ve kare sayısı toplamları: ortalama ms/kare */
class FrameTime {
  sec = 0;
  frames = 0;
  add(time: number | null, prevTime: number | null, frames: number | null, prevFrames: number | null): void {
    if (time === null || prevTime === null || frames === null || prevFrames === null) return;
    const dFrames = frames - prevFrames;
    const dTime = time - prevTime;
    if (dFrames <= 0 || dTime < 0) return;
    this.sec += dTime;
    this.frames += dFrames;
  }
  get ms(): number | null {
    return this.frames > 0 ? (this.sec / this.frames) * 1000 : null;
  }
}

const round = (v: number | null, digits = 0): number | null => {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const pct = (part: number, total: number): number | null => (total > 0 ? Math.min(100, (part / total) * 100) : null);

/** Giden görüntü akışları arasından ekran yayını: en büyük kare */
function screenStream(stats: TransportStats | null): RtpStream | null {
  let best: RtpStream | null = null;
  for (const s of stats?.streams ?? []) {
    if (s.direction !== 'out' || s.kind !== 'video') continue;
    const area = (s.frameWidth ?? 0) * (s.frameHeight ?? 0);
    if (!best || area > (best.frameWidth ?? 0) * (best.frameHeight ?? 0)) best = s;
  }
  return best;
}

function limitationOf(reason: string | null): TelemetryLimitation {
  if (reason === 'cpu' || reason === 'bandwidth' || reason === 'none') return reason;
  return reason ? 'other' : 'none';
}

// ---------- Gelen sesler ve izlenen yayın ----------

/** İki okuma arasında gelen sesler: abone olunan tüm ses akışlarının toplamı */
export interface InboundAudioDelta {
  /** Bu aralıkta paket gelen ses akışı sayısı */
  active: number;
  /** Beklenen (alınan + kaybolan) ve kaybolan paket */
  packets: number;
  lost: number;
  bytes: number;
  /** Çalınan örnek ve bunlardan gizlenen (sessizlik sırasındakiler hariç) */
  samples: number;
  concealed: number;
  /** Gizleme olayı; hiçbir akış bildirmiyorsa null */
  events: number | null;
  /** Titreşim tamponunda bekleme (sn) ve tampondan çıkan örnek */
  bufferDelay: number;
  bufferEmitted: number;
  /** Paket gelen akışların titreşimi (ms) */
  jitters: number[];
}

/**
 * Gelen seslerin iki okuma arasındaki değişimi. Paket gelmeyen (susturulmuş) ve önceki okumada olmayan
 * akışlar sayılmaz (susturulmuşun titreşimi eskidir); sayaç geriye giderse fark 0.
 */
export function inboundAudioDelta(curr: TransportStats, prev: TransportStats | null): InboundAudioDelta {
  const out: InboundAudioDelta = {
    active: 0,
    packets: 0,
    lost: 0,
    bytes: 0,
    samples: 0,
    concealed: 0,
    events: null,
    bufferDelay: 0,
    bufferEmitted: 0,
    jitters: [],
  };
  const prevStreams = new Map(prev?.streams.map((x) => [x.id, x]));
  const diff = (a: number | null | undefined, b: number | null | undefined): number | null =>
    a === null || a === undefined || b === null || b === undefined ? null : Math.max(0, a - b);
  for (const st of curr.streams) {
    if (st.direction !== 'in' || st.kind !== 'audio') continue;
    const p = prevStreams.get(st.id);
    if (!p) continue;
    const received = Math.max(0, st.packets - p.packets);
    const lost = diff(st.packetsLost, p.packetsLost) ?? 0;
    if (received + lost === 0) continue;
    out.active++;
    out.packets += received + lost;
    out.lost += lost;
    out.bytes += Math.max(0, st.bytes - p.bytes);
    if (st.jitterMs !== null) out.jitters.push(st.jitterMs);
    const samples = diff(st.totalSamplesReceived, p.totalSamplesReceived);
    const concealed = diff(st.concealedSamples, p.concealedSamples);
    // Sessizlikte (DTX) sentezlenen örnekler duyulmaz: kesilme sayılmaz. Tarayıcı hiç bildirmiyorsa 0;
    // yalnızca bir okumada varsa bu akış için hesaplanamaz (fazla sayılmasın)
    const silentCurr = st.audio?.silentConcealedSamples ?? null;
    const silentPrev = p.audio?.silentConcealedSamples ?? null;
    const silent = silentCurr === null && silentPrev === null ? 0 : diff(silentCurr, silentPrev);
    if (samples !== null && samples > 0 && concealed !== null && silent !== null) {
      out.samples += samples;
      out.concealed += Math.max(0, concealed - silent);
    }
    const events = diff(st.audio?.concealmentEvents, p.audio?.concealmentEvents);
    if (events !== null) out.events = (out.events ?? 0) + events;
    const delay = diff(st.audio?.jitterBufferDelay, p.audio?.jitterBufferDelay);
    const emitted = diff(st.audio?.jitterBufferEmittedCount, p.audio?.jitterBufferEmittedCount);
    if (delay !== null && emitted !== null && emitted > 0) {
      out.bufferDelay += delay;
      out.bufferEmitted += emitted;
    }
  }
  return out;
}

/**
 * İzlenen yayın: bu aralıkta veri gelen en büyük görüntü. Duraklatılmış (görünmeyen/izlenmeyen, bayt
 * artmayan) akışlar sayılmaz; önceki okumada olmayan akış kare hızı varsa sayılır.
 */
export function watchedVideo(curr: TransportStats, prev: TransportStats | null): RtpStream | null {
  const prevStreams = new Map(prev?.streams.map((x) => [x.id, x]));
  return mainInboundVideo(
    curr.streams.filter((s) => {
      if (s.direction !== 'in' || s.kind !== 'video') return false;
      const p = prevStreams.get(s.id);
      return p ? s.bytes > p.bytes : (s.framesPerSecond ?? 0) > 0;
    }),
  );
}

// ---------- JS iş parçacığı takılması ----------

/** Zamanlayıcı aralığı; takılma = beklenenden geç gelen tik */
export const LAG_TICK_MS = 500;
/** Bu kadar ve üstü gecikme "takılma" sayılır */
export const LAG_STALL_MS = 200;
/** Bellekte tutulan en fazla ölçüm (30 sn'lik aralıkta ~60) */
const LAG_MAX_SAMPLES = 600;

/** Gecikmelerin en yükseği, 95. yüzdeliği ve takılma sayısı; ölçüm yoksa null */
export function summarizeLag(lags: readonly number[], stallMs = LAG_STALL_MS): TelemetryJsLag | null {
  if (lags.length === 0) return null;
  const sorted = [...lags].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  return {
    maxMs: Math.round(sorted[sorted.length - 1]!),
    p95Ms: Math.round(p95),
    stalls: lags.filter((v) => v >= stallMs).length,
  };
}

const monotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * JS olay döngüsü gecikmesi: yarım saniyede bir tik; tikin beklenenden ne kadar geç geldiği ölçülür.
 * Uzun bir iş (çizim, JSON, GC) iş parçacığını tutarsa sonraki tik o kadar gecikir.
 */
export class LoopLagMeter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private lags: number[] = [];
  /** Son takePeak()'ten beri en yüksek gecikme (olay kaydının saniyelik ölçümü; take()'ten bağımsız) */
  private peak: number | null = null;

  constructor(
    private readonly now: () => number = monotonicNow,
    private readonly tickMs = LAG_TICK_MS,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.last = this.now();
    this.lags = [];
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Node'da (testler) süreci açık tutmasın
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.lags = [];
    this.peak = null;
  }

  /**
   * Zamanlayıcıdan; testlerde elle. 10 sn'den uzun gecikme takılma değil uyku/arka plandır (React
   * Native arka planda zamanlayıcıları durdurur): kaydedilmez, ölçüm oradan yeniden başlar.
   */
  tick(at = this.now()): void {
    const lag = Math.max(0, at - this.last - this.tickMs);
    this.last = at;
    if (lag > MAX_STEP_MS) return;
    if (this.peak === null || lag > this.peak) this.peak = lag;
    this.lags.push(lag);
    if (this.lags.length > LAG_MAX_SAMPLES) this.lags.shift();
  }

  /** Uygulama öne gelince: arka planda geçen süre sonraki tikte takılma sayılmasın */
  rebase(): void {
    this.last = this.now();
  }

  /** Son takePeak()'ten beri en yüksek gecikme (ms; tik gelmediyse null). Özetin ölçümlerine dokunmaz. */
  takePeak(): number | null {
    const peak = this.peak;
    this.peak = null;
    return peak;
  }

  /** Son okumadan beri ölçülenlerin özeti; ölçümler sıfırlanır */
  take(): TelemetryJsLag | null {
    const summary = summarizeLag(this.lags);
    this.lags = [];
    return summary;
  }
}

/** Kişi başı ses seviyeleri: %100'den (1) farklı olanların sayısı ve en yükseği (kimlik yok) */
export function volumeSummary(volumes: Record<string, number> | null | undefined): {
  userVolumesChanged: number;
  userVolumeMax: number | null;
} {
  let changed = 0;
  let max: number | null = null;
  for (const v of Object.values(volumes ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v - 1) < 0.005) continue;
    changed++;
    if (max === null || v > max) max = v;
  }
  return { userVolumesChanged: changed, userVolumeMax: max === null ? null : Math.round(max * 100) / 100 };
}

/** Bir özet aralığında biriken değerler */
class Window {
  start = 0;
  lastAt = 0;
  samples = 0;
  poorMs = 0;
  quality: TelemetryQuality = 'unknown';
  serverQuality: string | null = null;
  rtt = new Mean();
  jitterOut = new Mean();
  jitterIn = new Mean();
  available = new Mean();
  sentPackets = 0;
  lostPackets = 0;
  // Giden kayıp, ses ve görüntü ayrı (yalnızca karşı tarafın rapor verdiği akışlar)
  sentAudio = 0;
  lostAudio = 0;
  sentVideo = 0;
  lostVideo = 0;
  outBits = 0;
  outMs = 0;
  inBits = 0;
  inMs = 0;
  inPackets = 0;
  inLost = 0;
  concealed = 0;
  audioSamples = 0;
  // Gelen sesler (yalnızca ses akışları)
  audioActive = 0;
  audioPackets = 0;
  audioLost = 0;
  audioBits = 0;
  audioMs = 0;
  concealEvents: number | null = null;
  audioBufferDelay = 0;
  audioBufferEmitted = 0;
  candidate: string | null = null;
  protocol: string | null = null;
  reconnects = 0;
  // Ekran yayını
  screenBits = 0;
  screenMs = 0;
  screenFps = new Mean();
  screenLast: RtpStream | null = null;
  limited = 0;
  limitSamples = 0;
  limitCounts: Record<TelemetryLimitation, number> = { none: 0, cpu: 0, bandwidth: 0, other: 0 };
  encode = new FrameTime();
  // İzlenen (gelen) yayın
  watchLast: RtpStream | null = null;
  watchBits = 0;
  watchMs = 0;
  watchFps = new Mean();
  decode = new FrameTime();
  /** ~10 sn'lik ölçümlerin kare başına çözme süreleri (en yükseği için) */
  decodeSteps = new Mean();
  jitterBuffer = new FrameTime();
  dropped: number | null = null;
  freezes: number | null = null;
  freezeSec: number | null = null;
}

/** Sayaç farkı (null: iki ölçümde de yoksa); sayaç sıfırlandıysa (yeni akış) 0 */
const addDelta = (acc: number | null, curr: number | null | undefined, prev: number | null | undefined): number | null =>
  curr === null || curr === undefined || prev === null || prev === undefined ? acc : (acc ?? 0) + Math.max(0, curr - prev);

function addCounters(w: Window, v: VideoCounters, p: VideoCounters): void {
  w.decode.add(v.totalTime, p.totalTime, v.frames, p.frames);
  w.decodeSteps.add(perFrameMs(v, p));
  w.jitterBuffer.add(v.jitterBufferDelay, p.jitterBufferDelay, v.jitterBufferEmittedCount, p.jitterBufferEmittedCount);
  w.dropped = addDelta(w.dropped, v.framesDropped, p.framesDropped);
  w.freezes = addDelta(w.freezes, v.freezeCount, p.freezeCount);
  w.freezeSec = addDelta(w.freezeSec, v.totalFreezesDuration, p.totalFreezesDuration);
}

export class VoiceTelemetry {
  private win = new Window();
  private lastSub: TransportStats | null = null;
  private lastSubAt = 0;
  private lastSentAt = 0;
  private prevQuality: TelemetryQuality = 'unknown';
  /** Sunucu desteklemiyor (404) ya da sınırladı (429): bu ana kadar gönderilmez */
  private pausedUntil = 0;
  private context: () => TelemetryContext = () => ({ channelId: null, mic: null });

  constructor(private readonly lag: LoopLagMeter = new LoopLagMeter()) {}

  /** Platform bir kez verir: kanal ve mikrofon bilgisi özet anında okunur */
  setContext(fn: () => TelemetryContext): void {
    this.context = fn;
  }

  /** Bu ölçümde abonelik bağlantısı (gelen akışlar) da okunmalı mı */
  wantsSubscriber(at: number): boolean {
    return at - this.lastSubAt >= TELEMETRY_SUBSCRIBER_EVERY_MS;
  }

  /** Sese bağlanırken ve ayrılırken: yarım kalan özet gönderilir (yeterli ölçüm varsa), sayaçlar sıfırlanır */
  reset(): void {
    try {
      if (this.win.samples >= MIN_FINAL_SAMPLES) this.flush(this.win.lastAt);
    } catch {
      // ölçüm görüşmeyi etkilemez
    }
    this.lag.stop();
    this.win = new Window();
    this.lastSub = null;
    this.lastSubAt = 0;
    this.prevQuality = 'unknown';
  }

  /** JS olay döngüsünün son okumadan beri en yüksek gecikmesi (olay kaydı için; özetin ölçümlerine dokunmaz) */
  lagPeak(): number | null {
    return this.lag.takePeak();
  }

  /** Uygulama öne geldi (telefon): arka planda duran zamanlayıcı takılma sayılmaz */
  rebaseLag(): void {
    this.lag.rebase();
  }

  /** LiveKit yeniden bağlanıyor (Reconnecting) */
  noteReconnect(): void {
    this.win.reconnects++;
  }

  /** Platformun 2 saniyelik ölçümü */
  sample(s: TelemetrySample): void {
    try {
      this.add(s);
    } catch {
      // ölçüm görüşmeyi etkilemez
    }
  }

  private add(s: TelemetrySample): void {
    // Sesliyken JS takılması ölçülür (ayrılınca reset durdurur)
    this.lag.start();
    // Uzun boşluk (uyku, donma): önceki aralık kendi sonunda kapanır, yenisi baştan başlar
    if (this.win.lastAt && s.at - this.win.lastAt > MAX_STEP_MS) {
      if (this.win.samples >= MIN_FINAL_SAMPLES) this.flush(this.win.lastAt);
      // Gönderilmeyen aralığın takılmaları sonraki özete kalmasın
      else this.lag.take();
      this.win = new Window();
    }
    const w = this.win;
    if (w.samples === 0) w.start = s.at - (w.lastAt ? Math.min(MAX_STEP_MS, s.at - w.lastAt) : 2_000);
    const step = w.lastAt ? Math.min(MAX_STEP_MS, Math.max(0, s.at - w.lastAt)) : 2_000;
    w.lastAt = s.at;
    w.samples++;
    if (s.quality === 'poor') w.poorMs += step;
    w.quality = s.quality;
    if (s.serverQuality && (SERVER_QUALITY_RANK[s.serverQuality] ?? 0) > (SERVER_QUALITY_RANK[w.serverQuality ?? ''] ?? 0)) {
      w.serverQuality = s.serverQuality;
    }

    const pub = s.publisher;
    const prev = s.prevPublisher;
    w.rtt.add(pub?.rttMs ?? s.subscriber?.rttMs ?? this.lastSub?.rttMs ?? null);
    if (pub) {
      w.available.add(pub.availableOutgoingBitrate);
      const route = pub.local;
      if (route) {
        w.candidate = route.candidateType;
        w.protocol = (route.candidateType === 'relay' ? route.relayProtocol : null) ?? route.protocol;
      }
      for (const st of pub.streams) if (st.direction === 'out' && st.kind === 'audio') w.jitterOut.add(st.jitterMs);
    }
    if (pub && prev) {
      const dt = pub.at - prev.at;
      if (dt > 0 && pub.bytesSent >= prev.bytesSent) {
        w.outBits += (pub.bytesSent - prev.bytesSent) * 8;
        w.outMs += dt;
      }
      const prevStreams = new Map(prev.streams.map((x) => [x.id, x]));
      for (const st of pub.streams) {
        const p = prevStreams.get(st.id);
        if (st.direction !== 'out' || !p) continue;
        const dSent = Math.max(0, st.packets - p.packets);
        w.sentPackets += dSent;
        if (st.packetsLost !== null && p.packetsLost !== null) {
          const dLost = Math.max(0, st.packetsLost - p.packetsLost);
          w.lostPackets += dLost;
          if (st.kind === 'video') {
            w.sentVideo += dSent;
            w.lostVideo += dLost;
          } else {
            w.sentAudio += dSent;
            w.lostAudio += dLost;
          }
        }
      }
      // Ekran yayını: kare, kare hızı, kodlayıcı ve kısıtlama nedeni
      const screen = screenStream(pub);
      if (screen) {
        const p = prevStreams.get(screen.id);
        if (p && dt > 0 && screen.bytes >= p.bytes) {
          w.screenBits += (screen.bytes - p.bytes) * 8;
          w.screenMs += dt;
        }
        if (p?.video && screen.video) {
          w.encode.add(screen.video.totalTime, p.video.totalTime, screen.video.frames, p.video.frames);
        }
        w.screenFps.add(screen.framesPerSecond);
        w.screenLast = screen;
        const reason = limitationOf(screen.qualityLimitationReason);
        w.limitCounts[reason]++;
        w.limitSamples++;
        if (reason !== 'none') w.limited++;
      }
    }

    // Gelen akışlar: abonelik bağlantısından; tek bağlantı kipinde (abonelik bağlantısı yok) yayın
    // bağlantısındaki gelen akışlardan, aynı aralıkla
    const sub =
      s.subscriber ??
      (pub && this.wantsSubscriber(s.at) && pub.streams.some((x) => x.direction === 'in') ? pub : null);
    if (sub) this.addSubscriber(sub);

    // Özet zamanı geldi ya da kalite "kötü"ye düştü
    const due = s.at - w.start >= TELEMETRY_INTERVAL_MS;
    const dropped = s.quality === 'poor' && this.prevQuality !== 'poor' && s.at - this.lastSentAt >= TELEMETRY_MIN_GAP_MS;
    this.prevQuality = s.quality;
    if (due || (dropped && w.samples >= 2)) {
      this.flush(s.at);
      this.win = new Window();
      this.win.lastAt = s.at;
    }
  }

  /** Gelen akışlar: iki okuma arasındaki kayıp, gizlenen ses ve bit hızı */
  private addSubscriber(sub: TransportStats): void {
    const w = this.win;
    const prev = this.lastSub;
    this.lastSub = sub;
    this.lastSubAt = sub.at;
    // Gelen sesler: titreşim, kayıp, gizlenen örnekler, bit hızı
    const audio = inboundAudioDelta(sub, prev);
    for (const j of audio.jitters) w.jitterIn.add(j);
    w.audioActive = Math.max(w.audioActive, audio.active);
    w.audioPackets += audio.packets;
    w.audioLost += audio.lost;
    w.audioSamples += audio.samples;
    w.concealed += audio.concealed;
    if (audio.events !== null) w.concealEvents = (w.concealEvents ?? 0) + audio.events;
    w.audioBufferDelay += audio.bufferDelay;
    w.audioBufferEmitted += audio.bufferEmitted;
    if (prev && sub.at > prev.at) {
      w.audioBits += audio.bytes * 8;
      w.audioMs += sub.at - prev.at;
    }
    // İzlenen yayın: çözücü, çözme süresi, atılan kare, donma
    const watched = watchedVideo(sub, prev);
    if (watched) {
      w.watchLast = watched;
      w.watchFps.add(watched.framesPerSecond);
    }
    if (!prev) return;
    const pw = watched ? prev.streams.find((x) => x.id === watched.id) : undefined;
    if (watched && pw) {
      const dt = sub.at - prev.at;
      if (dt > 0 && watched.bytes >= pw.bytes) {
        w.watchBits += (watched.bytes - pw.bytes) * 8;
        w.watchMs += dt;
      }
      if (watched.video && pw.video) addCounters(w, watched.video, pw.video);
    }
    const dt = sub.at - prev.at;
    if (dt > 0 && sub.bytesReceived >= prev.bytesReceived) {
      w.inBits += (sub.bytesReceived - prev.bytesReceived) * 8;
      w.inMs += dt;
    }
    const prevStreams = new Map(prev.streams.map((x) => [x.id, x]));
    for (const st of sub.streams) {
      const p = prevStreams.get(st.id);
      if (st.direction !== 'in' || !p) continue;
      const received = Math.max(0, st.packets - p.packets);
      const lost = st.packetsLost !== null && p.packetsLost !== null ? Math.max(0, st.packetsLost - p.packetsLost) : 0;
      w.inPackets += received + lost;
      w.inLost += lost;
    }
  }

  private flush(at: number): void {
    const w = this.win;
    // Takılma ölçümleri her aralıkta okunur (gönderilmese de): sonraki özete kalmasın
    const jsLag = this.lag.take();
    // context() konuşma seviyesi histogramını da alıp sıfırlar: örnek yoksa bile çağrılır ki sayımlar sonraki özete taşınmasın
    const ctx = this.context();
    if (w.samples === 0) return;
    if (!ctx.channelId) return;
    const { platform, version } = env();
    const last = w.screenLast;
    const screen: TelemetryScreen | null = last
      ? {
          width: last.frameWidth,
          height: last.frameHeight,
          fps: round(w.screenFps.avg, 1),
          bitrate: w.screenMs > 0 ? Math.round(w.screenBits / (w.screenMs / 1000)) : null,
          encoder: last.implementation,
          codec: last.codec,
          limitation: (Object.entries(w.limitCounts) as [TelemetryLimitation, number][])
            .filter(([k]) => k !== 'none')
            .sort((a, b) => b[1] - a[1])
            .find(([, n]) => n > 0)?.[0] ?? 'none',
          limitedRatio: w.limitSamples ? round(w.limited / w.limitSamples, 2) : null,
          encodeMs: round(w.encode.ms, 2),
          hardware: isHardwareCodec(last.implementation, last.video?.powerEfficient ?? null),
        }
      : null;
    const seen = w.watchLast;
    const watch: TelemetryWatch | null = seen
      ? {
          codec: seen.codec,
          decoder: seen.implementation,
          hardware: isHardwareCodec(seen.implementation, seen.video?.powerEfficient ?? null),
          powerEfficient: seen.video?.powerEfficient ?? null,
          width: seen.frameWidth,
          height: seen.frameHeight,
          fps: round(w.watchFps.avg, 1),
          // Aralıkta fark alınamadıysa (ilk okuma) baştan beri ortalama
          decodeMs: round(w.decode.ms ?? perFrameMs(seen.video, null), 2),
          decodeMsMax: round(w.decodeSteps.max, 2),
          bitrate: w.watchMs > 0 ? Math.round(w.watchBits / (w.watchMs / 1000)) : null,
          framesDropped: w.dropped,
          freezes: w.freezes,
          freezeSec: round(w.freezeSec, 1),
          jitterBufferMs: round(w.jitterBuffer.ms ?? jitterBufferMs(seen.video, null), 1),
          view: ctx.view ?? null,
        }
      : null;
    // Gelen ses yoksa (kanalda yalnız, herkes susturulmuş) null
    const audioIn: TelemetryAudioIn | null =
      w.audioActive > 0 || w.jitterIn.n > 0
        ? {
            streams: w.audioActive,
            jitterMaxMs: round(w.jitterIn.max, 1),
            lossPct: round(pct(w.audioLost, w.audioPackets), 2),
            concealEvents: w.concealEvents,
            jitterBufferMs: w.audioBufferEmitted > 0 ? round((w.audioBufferDelay / w.audioBufferEmitted) * 1000, 1) : null,
            bitrate: w.audioMs > 0 ? Math.round(w.audioBits / (w.audioMs / 1000)) : null,
          }
        : null;
    const report: VoiceTelemetryReport = {
      v: 1,
      platform,
      version,
      channelId: ctx.channelId,
      windowSec: Math.max(1, Math.round((at - w.start) / 1000)),
      samples: w.samples,
      quality: w.quality,
      poorSec: Math.round(w.poorMs / 1000),
      serverQuality: w.serverQuality,
      rttMs: { avg: round(w.rtt.avg), max: round(w.rtt.max) },
      jitterInMs: round(w.jitterIn.avg, 1),
      jitterOutMs: round(w.jitterOut.avg, 1),
      lossOutPct: round(pct(w.lostPackets, w.sentPackets), 2),
      lossInPct: round(pct(w.inLost, w.inPackets), 2),
      concealedPct: round(pct(w.concealed, w.audioSamples), 2),
      bitrateOut: w.outMs > 0 ? Math.round(w.outBits / (w.outMs / 1000)) : null,
      bitrateIn: w.inMs > 0 ? Math.round(w.inBits / (w.inMs / 1000)) : null,
      availableOut: round(w.available.avg),
      candidate: w.candidate,
      protocol: w.protocol,
      reconnects: w.reconnects,
      mic: ctx.mic,
      screen,
      watch,
      device: ctx.device ?? null,
      audioIn,
      jsLag,
      settings: ctx.settings ?? null,
      lossOutAudioPct: round(pct(w.lostAudio, w.sentAudio), 2),
      lossOutVideoPct: round(pct(w.lostVideo, w.sentVideo), 2),
      endAt: at,
    };
    this.lastSentAt = at;
    this.send(report);
  }

  private send(report: VoiceTelemetryReport): void {
    const now = Date.now();
    const token = useSession.getState().token;
    if (!token || now < this.pausedUntil) return;
    // Gönderim anı ve tahmini saat farkı (platform sesliyken ölçtürür, bkz. serverClock): sunucu, geç ulaşan
    // özeti aralığın gerçek bitişine yerleştirir
    report.sentAt = now;
    report.offsetMs = serverClock.offsetMs;
    void fetch(`${normalizeServerUrl(env().serverUrl())}/api/telemetry/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(report),
    })
      .then((res) => {
        // Eski sunucu: bu oturumda bir daha denenmez; sınır aşıldı: bir dakika ara
        if (res.status === 404) this.pausedUntil = Number.POSITIVE_INFINITY;
        else if (res.status === 429) this.pausedUntil = Date.now() + 60_000;
      })
      .catch(() => undefined);
  }
}

/** Uygulamadaki tek ölçüm toplayıcı (ses motoru besler) */
export const voiceTelemetry = new VoiceTelemetry();
