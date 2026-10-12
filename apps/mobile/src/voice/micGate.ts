import { AppState } from 'react-native';
import { type LocalAudioTrack, type Room, Track } from 'livekit-client';
import { SpeechLevelHistogram, type SpeechLevelSummary } from '@diskort/client-core';

export interface GateConfig {
  /** Ses algılama açık mı (kapalıyken mikrofon hep açıktır, yalnızca seviye ölçülebilir) */
  enabled: boolean;
  /** Eşik ortam gürültüsüne göre kendiliğinden belirlenir */
  auto: boolean;
  /** Elle belirlenen eşik (dBFS) */
  threshold: number;
}

export interface MicLevel {
  /** Son ölçülen seviye (dBFS; -100 = sessiz) */
  db: number;
  /** Kullanılan eşik (otomatikse o anki değeri) */
  threshold: number;
  /** Ses iletiliyor mu */
  open: boolean;
}

export const SILENT_LEVEL: MicLevel = { db: -100, threshold: -50, open: false };

/** Kapı kapalıyken konuşmanın başını kaçırmamak için sık, açıkken daha seyrek ölçülür */
const POLL_CLOSED_MS = 50;
const POLL_OPEN_MS = 90;
/** Ses eşiğin altına indikten sonra kapının açık kaldığı süre (kelime aralarında kesilmesin) */
const RELEASE_MS = 350;
/** Açıkken eşiğin bu kadar altına inene kadar konuşma sürüyor sayılır (titremeyi önler) */
const HYSTERESIS_DB = 4;
/** Bu süre ölçüm alınamazsa kapı açılır: ölçemediğimiz sesi asla kesmeyiz */
const STALE_MS = 400;
/** Konuşma seviyesi bildirmek için en az ölçüm: ~90 ms yoklamada ~11 ölçüm ≈ 1 sn konuşma */
const SPEECH_MIN_COUNT = 11;
/** Kapı kapalıyken ölçüm bu kadar süre tam sessizlik (dijital sıfır) gösterirse ölçüm kör sayılır */
const BLIND_MS = 3000;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Telefonda ses algılama (voice activity gate), masaüstündeki "ses aktivitesi"nin karşılığı.
 *
 * Mikrofonun işlenmiş (gürültü engelleme ve kazanç kontrolünden geçmiş) seviyesi WebRTC
 * istatistiklerinden (media-source: totalAudioEnergy / totalSamplesDuration) okunur; eşiğin
 * altındayken iz `enabled = false` yapılır. Bu yalnızca kodlayıcıya giden sesi sessizliğe çevirir:
 * yeniden anlaşma (renegotiation) olmaz, LiveKit'in "susturuldu" durumu değişmez ve ölçüm sürer.
 *
 * - Susturma/sağırlaştırma/sunucuda susturma LiveKit'in `isMuted` durumuyla yapılır; kapı susturulmuş
 *   ize hiç dokunmaz.
 * - React Native'de JS zamanlayıcıları uygulama arka plandayken (ekran kapalı) durur. Kapı o sırada
 *   kapalı kalıp sesi kesmesin diye arka plana geçerken açılır ve ölçüm durur; öne gelince sürer.
 */
export class MicGate {
  private room: Room | null = null;
  private config: GateConfig = { enabled: false, auto: true, threshold: -50 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private foreground = AppState.currentState !== 'background';
  /** Seviyeyi izleyen ekran sayısı (ayarlardaki gösterge) */
  private watchers = 0;
  /** Ölçüm kör (kapalı izde sessizlik görüyor): bu oturumda kapı devre dışı */
  private blind = false;
  /** Kapı kapalıyken ses ölçüldü: ölçüm susturmadan etkilenmiyor */
  private verified = false;

  private lastSample: { energy: number; duration: number } | null = null;
  private noiseFloor = -60;
  private lastAboveAt = 0;
  private lastMeasuredAt = 0;
  private lastTickAt = 0;
  private silentSince = 0;
  private open = true;
  private lastReported: MicLevel = SILENT_LEVEL;
  /**
   * Konuşma seviyesi dağılımı (ses kalitesi telemetrisi): eşik üstü ölçümler. Ölçüm WebRTC işlemesinden (AGC,
   * gürültü engelleme) sonraki, kodlayıcıya giden sestir. Yalnızca ölçüm sürerken (ses algılama açık ya da
   * gösterge açık) dolar.
   */
  private speech = new SpeechLevelHistogram();

  constructor(private readonly onLevel: (level: MicLevel) => void) {
    AppState.addEventListener('change', (state) => {
      this.foreground = state === 'active';
      this.update();
    });
  }

  attach(room: Room, config: GateConfig): void {
    this.room = room;
    this.config = config;
    this.blind = false;
    this.verified = false;
    this.silentSince = 0;
    this.noiseFloor = -60;
    this.lastSample = null;
    this.update();
  }

  detach(): void {
    this.release();
    this.room = null;
    this.update();
  }

  setConfig(config: GateConfig): void {
    this.config = config;
    this.update();
  }

  /** Ayarlardaki seviye göstergesi açıkken ölçüm (ses algılama kapalı olsa da) sürer */
  watchLevel(): () => void {
    this.watchers++;
    // Gösterge yeniden açılınca ilk ölçüm hemen yansısın
    this.lastReported = { db: Number.NaN, threshold: Number.NaN, open: false };
    this.update();
    return () => {
      this.watchers = Math.max(0, this.watchers - 1);
      this.update();
    };
  }

  private get gating(): boolean {
    return this.config.enabled && !this.blind;
  }

  /** Ölçüm gerekiyor mu; gerekmiyorsa kapı açık bırakılır */
  private update(): void {
    const wanted = this.room !== null && this.foreground && (this.gating || this.watchers > 0);
    if (!this.gating || !this.foreground || !this.room) this.release();
    if (wanted && !this.running) {
      this.running = true;
      this.lastSample = null;
      this.lastTickAt = Date.now();
      this.lastMeasuredAt = Date.now();
      this.schedule(0);
    } else if (!wanted && this.running) {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.report(SILENT_LEVEL);
    }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.running) this.schedule(this.open ? POLL_OPEN_MS : POLL_CLOSED_MS);
      });
    }, ms);
  }

  private micTrack(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as
      | LocalAudioTrack
      | undefined;
  }

  /** Kapıyı açar (ses iletilir); susturulmuş ize dokunulmaz */
  private release(): void {
    this.open = true;
    const track = this.micTrack();
    if (track && !track.isMuted && !track.mediaStreamTrack.enabled) track.mediaStreamTrack.enabled = true;
  }

  private setOpen(track: LocalAudioTrack, open: boolean): void {
    this.open = open;
    // Susturma LiveKit'e aittir: susturulmuş iz açılmaz (isMuted ile enabled birlikte değişir)
    if (track.isMuted) return;
    if (track.mediaStreamTrack.enabled !== open) track.mediaStreamTrack.enabled = open;
  }

  private async tick(): Promise<void> {
    const track = this.micTrack();
    const sender = track?.sender;
    const now = Date.now();
    const dt = Math.min(1, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    if (!track || !sender || track.isMuted) {
      this.lastSample = null;
      this.open = true;
      this.report(SILENT_LEVEL);
      return;
    }

    let db: number | null = null;
    try {
      let source: Record<string, unknown> | null = null;
      (await sender.getStats()).forEach((entry: Record<string, unknown>) => {
        if (entry.type === 'media-source' && entry.kind === 'audio') source = entry;
      });
      db = this.levelFrom(source);
    } catch {
      db = null;
    }
    // Ölçüm beklenirken iz değişmiş ya da susturulmuş olabilir
    if (!this.running || track !== this.micTrack() || track.isMuted) return;

    if (db === null) {
      if (now - this.lastMeasuredAt > STALE_MS) this.setOpen(track, true);
      return;
    }
    this.lastMeasuredAt = now;

    // Uyarlanabilir gürültü tabanı: sessizliğe hızla iner, gürültüye yavaşça yükselir
    const tau = db < this.noiseFloor ? 0.25 : 6;
    this.noiseFloor += (db - this.noiseFloor) * (1 - Math.exp(-dt / tau));
    const threshold = this.config.auto ? clamp(this.noiseFloor + 10, -60, -28) : this.config.threshold;

    if (db >= (this.open ? threshold - HYSTERESIS_DB : threshold)) this.lastAboveAt = now;
    let open = !this.gating || now - this.lastAboveAt < RELEASE_MS;

    // Güvenlik: kapı kapalıyken ölçüm hiç ses görmüyorsa (dijital sıfır) ölçüm susturulmuş sesi
    // okuyor olabilir; o zaman konuşma hiç algılanamaz. Kapalıyken bir kez bile ses görüldüyse ölçüm
    // güvenilirdir; görülmeden BLIND_MS geçerse bu oturumda ses algılama kapatılır (ses kesilmez).
    if (!this.open && db > -99) this.verified = true;
    if (!this.verified && !this.open && db <= -99) {
      if (!this.silentSince) this.silentSince = now;
      else if (now - this.silentSince > BLIND_MS) {
        this.blind = true;
        open = true;
      }
    } else {
      this.silentSince = 0;
    }

    this.setOpen(track, open);
    if (db >= threshold) this.speech.add(db);
    this.report({ db, threshold, open });
  }

  /** Son alımdan beri konuşma seviyesi (medyan, 90. yüzdelik; yetersizse null) ve sıfırlama */
  takeSpeechLevel(): SpeechLevelSummary | null {
    return this.speech.take(SPEECH_MIN_COUNT);
  }

  /** İstatistikten dBFS seviye: iki ölçüm arasındaki enerji (ortalama kare), yoksa anlık seviye */
  private levelFrom(source: Record<string, unknown> | null): number | null {
    if (!source) return null;
    const energy = source.totalAudioEnergy;
    const duration = source.totalSamplesDuration;
    if (typeof energy === 'number' && typeof duration === 'number') {
      const previous = this.lastSample;
      this.lastSample = { energy, duration };
      if (previous && duration > previous.duration) {
        const meanSquare = (energy - previous.energy) / (duration - previous.duration);
        return meanSquare > 1e-10 ? Math.max(-100, 10 * Math.log10(meanSquare)) : -100;
      }
    }
    const level = source.audioLevel;
    if (typeof level === 'number') return level > 1e-5 ? Math.max(-100, 20 * Math.log10(level)) : -100;
    return null;
  }

  private report(level: MicLevel): void {
    if (this.watchers === 0) return;
    const last = this.lastReported;
    if (Math.abs(last.db - level.db) < 1 && last.open === level.open && Math.abs(last.threshold - level.threshold) < 0.5) {
      return;
    }
    this.lastReported = level;
    this.onLevel(level);
  }
}
