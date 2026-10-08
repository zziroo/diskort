import {
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  LogLevel,
  Room,
  RoomEvent,
  setLogExtension,
  Track,
  TrackEvent,
  type AudioCaptureOptions,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
} from 'livekit-client';
import type { TelemetryVoiceSettings, VoiceJoinResponse, VoiceTraceUplinkKind } from '@diskort/shared';
import {
  api,
  ChannelSoundGate,
  describeTransport,
  errorMessage,
  gateway,
  linkQuality,
  outboundDelta,
  parseTransportStats,
  PING_STALE_MS,
  pushSample,
  reportClientError,
  reportVoiceLog,
  serverClock,
  SpuriousDuplicateGuard,
  summarizePings,
  useGuild,
  useSession,
  voiceTelemetry,
  voiceTrace,
  volumeSummary,
  type TelemetryContext,
  type TransportStats,
} from '@diskort/client-core';
import { bridge } from '../../lib/bridge';
import { playSound, prepareSounds, sharedAudioContext } from '../../lib/sfx';
import { getSettings, useSettings, type Settings } from '../../stores/settings';
import { setVoice, useVoice, type MicLevel } from '../../stores/voice';
import {
  EMPTY_CONNECTION_STATS,
  setConnectionStats,
  useConnectionStats,
  type StreamLabel,
  type VoiceServerInfo,
} from '../../stores/connectionStats';
import {
  firstAvailableDenoiser,
  MicProcessor,
  type Denoiser,
  type GateConfig,
  type MicProcessingStats,
} from './micProcessor';
import { denoiserHealth, ladderFor, type DenoiserFailure, type FailureReason } from './denoiserHealth';
import { MicSequencer } from './micSequencer';
import {
  EFFECTIVE_NOISE_LABELS,
  fallbackNoticeText,
  type EffectiveNoise,
  type NoiseFallbackState,
} from './noiseFallback';
import { prepareHardwareEncoder, releaseHardwareEncoder, type HwEncoderChoice } from './hardwareEncoder';
import { SCREEN_PRESETS, screenShareLowLayer } from './screenPresets';
import { MicTest } from './micTest';
import { RemoteSpeakingMeter } from './remoteSpeaking';
import { StreamPreviewUploader } from './streamPreviewUploader';
import type { ScreenCodec, ScreenContent, ScreenPresetId } from '../../stores/settings';

export interface ScreenShareOptions {
  /** Electron kaynak kimliği; tarayıcıda/macOS'ta sistem seçicisi kullanılır */
  sourceId?: string;
  preset: ScreenPresetId;
  codec: ScreenCodec;
  content: ScreenContent;
  audio: boolean;
  /** Seçilen pencerenin/ekranın adı ("Şimdi Yayın Yapıyor" kartında görünür) */
  sourceName?: string;
  sourceKind?: 'screen' | 'window';
  /** Pencerenin uygulama simgesi (data: URL; ses bağlantısı kartındaki yayın satırında) */
  sourceIcon?: string | null;
}

/**
 * İstatistik zamanlayıcısı saniyede bir çalışır: her tikte olay kaydının (voiceTrace) ölçümü alınır; ping
 * grafiği, kalite rengi ve 30 sn'lik özet eskisi gibi iki tikte bir (2 sn) beslenir.
 */
const TRACE_INTERVAL_MS = 1000;
const STATS_EVERY_TICKS = 2;
/** Etiket/simge rengi son bu kadar sürenin ping ve kaybına göre belirlenir */
const QUALITY_WINDOW_MS = 10_000;
const PREFETCH_TTL_MS = 60_000;
/** Yeniden bağlanma bu süreyi aşarsa "bağlantı koptu" sesi çalınır; geri gelince "geri geldi" */
const RECONNECT_SOUND_DELAY_MS = 2500;

/** LiveKit protokolündeki kaynak numaraları (ParticipantPermission.canPublishSources) */
const PROTO_SOURCE = { microphone: 2, screenShare: 3 } as const;

const RESET_ROOM_STATE = {
  micAllowed: true,
  speaking: {},
  streams: {},
  watching: {},
  focusedStream: null,
  pingMs: null,
  quality: 'unknown' as const,
  sharing: false,
  selfPreview: false,
  shareHasAudio: false,
  shareQuality: null,
  shareIcon: null,
  pttActive: false,
  noiseFallback: null,
  noiseNotice: null,
};

/** Yayının gerçek çözünürlüğü ve kare hızı (ör. "1080p 60 FPS"); tarayıcı bildirmezse seçilen kalite */
function qualityLabel(track: MediaStreamTrack, preset: { height: number; fps: number }): string {
  const s = track.getSettings();
  const height = Math.round(s.height ?? preset.height);
  const fps = Math.round(s.frameRate ?? preset.fps);
  return `${height}p ${fps} FPS`;
}

/** Paylaşılan kaynağın adı; sistem seçicisinde (macOS/tarayıcı) ad bilinmez, türü yazılır */
function sourceOf(opts: ScreenShareOptions, track: MediaStreamTrack): { name: string; kind: 'screen' | 'window' } {
  if (opts.sourceName && opts.sourceKind) return { name: opts.sourceName, kind: opts.sourceKind };
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  if (surface === 'monitor') return { name: 'Ekran', kind: 'screen' };
  return { name: surface === 'browser' ? 'Tarayıcı sekmesi' : 'Pencere', kind: 'window' };
}

/**
 * Mikrofon testi bitince odaya gönderim bu kadar gecikmeyle açılır: susturma/bas-konuş kapısı yeniden
 * uygulandıktan sonra zincirde (gürültü engelleyici gecikmesi + tamponlar) kalan test sesi odaya sızmasın.
 */
const MIC_TEST_RESUME_SEND_MS = 300;

/** Model düşünce LiveKit'in süren yeniden kurulumunun bitmesi en çok bu kadar beklenir */
const LIVEKIT_RESTART_WAIT_MS = 3000;
/** Bekleme süresi, kurulum sürerken dolduysa yeniden deneme en erken bu kadar sonra */
const REUPGRADE_MIN_DELAY_MS = 5000;
/** Kendiliğinden yeniden kurulumda mikrofon açılamadıysa bir kez daha denemeden önce */
const AUTO_REBUILD_RETRY_MS = 2000;

/** "Katıldın" sesi mikrofonun hazır olmasını en çok bu kadar bekler */
const JOIN_SOUND_MAX_WAIT_MS = 1500;

/**
 * @param dm DM araması: sunucu aramayı bitirdiyse (ör. konuşma salt okunur oldu) yalnızca "Arama sona erdi";
 * nedeni (engel) söylenmez
 */
function disconnectMessage(reason?: DisconnectReason, dm = false): string {
  if (dm) {
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) return 'Başka bir cihazdan bu aramaya bağlandın.';
    if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
      return 'Arama sona erdi.';
    }
  }
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'Başka bir cihazdan bu kanala bağlandın.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'Ses kanalından çıkarıldın.';
    case DisconnectReason.ROOM_DELETED:
      return 'Ses kanalı kapatıldı.';
    default:
      return 'Ses bağlantısı koptu.';
  }
}

/**
 * Ses motoru: LiveKit odasını, mikrofonu, ekran paylaşımını ve izlenen yayınları yönetir.
 * Arayüz yalnızca bu sınıfın metodlarını çağırır ve durumu `useVoice` store'undan okur.
 */
class VoiceClient {
  private room: Room | null = null;
  private mic: LocalAudioTrack | null = null;
  /** Mikrofonun yayınlama/yeniden yayınlama sırası ve güncel işlemcisi */
  private readonly micSeq = new MicSequencer<MicProcessor>();
  /** Seçili model düştüyse bekleme süresi dolunca (görüşme ortasında da) yeniden denenir */
  private reupgradeTimer: number | null = null;
  /** Denenmiş son yeniden deneme zamanı (her bekleme süresi bir kez denenir) */
  private attemptedRetryAt = 0;
  /** Kendiliğinden yeniden kurulum mikrofonu açamadıysa bir kezlik yeniden deneme */
  private autoRetryTimer: number | null = null;
  /** LiveKit'in yeniden kurulumunun bitmesini bekleyen dinleyiciyi kaldırır */
  private restartWait: (() => void) | null = null;
  private reupgrading = false;
  /** Bildirilen son düşüş (her düşüş bir kez bildirilir) */
  private lastNotifiedFailure = 0;
  /** Düşüşten hemen önceki ölçümler (sunucu kaydı için; o zincir yeniden kurulunca kaybolur) */
  private failureStats: { id: number; stats: MicProcessingStats | null } | null = null;
  private screen: { video: LocalVideoTrack; audio: LocalAudioTrack | null; preview: StreamPreviewUploader } | null = null;
  /** Yayında istenen donanım kodlama yolu (null: ekran kartı kodlayıcısı yok, Chromium'un varsayılanı) */
  screenHardwareEncoder: HwEncoderChoice | null = null;
  private statsTimer: number | null = null;
  /** Bir önceki istatistik ölçümü (bit hızı ve kayıp farkları için) */
  private statsPrev: { publisher: TransportStats | null; subscriber: TransportStats | null } = {
    publisher: null,
    subscriber: null,
  };
  private statsBusy = false;
  private statsTick = 0;
  /** Açık bağlantı paneli sayısı; açıkken ayrıntılı istatistikler de toplanır */
  private detailWatchers = 0;
  private pttReleaseTimer: number | null = null;
  private joinSeq = 0;
  private readonly duplicates = new SpuriousDuplicateGuard();
  /** Sunucunun bildirdiği konuşanlar; yalnızca sesi yerelde ölçülemeyenler için (bkz. remoteSpeaking.ts) */
  private serverSpeaking = new Set<string>();
  /** Uzak mikrofonların duyulan sesinden konuşma halkası */
  private readonly remoteMeter = new RemoteSpeakingMeter(sharedAudioContext, () => this.publishSpeaking());
  private selfSpeaking = false;
  /** Görüşmede mikrofon açılamadı (izin yok, aygıt yok); mikrofon testi kendi zincirini dener */
  private micFailed = false;
  /** Ayarlardaki mikrofon testi; görüşmedeyken sürdükçe odaya sessizlik gider ve susturulmuş görünürsün */
  private micTest: MicTest | null = null;
  private resumeSendTimer: number | null = null;
  private prefetched: { channelId: string; at: number; response: Promise<VoiceJoinResponse> } | null = null;
  private readonly audioSink: HTMLDivElement;
  /** Başkalarının kanal olaylarının sesleri (bağlanınca sel olmasın, art arda gelenler tek ses) */
  private readonly channelSounds = new ChannelSoundGate((name) => playSound(name));
  /** Bağlantı kısa süre içinde geri gelmezse "koptu" sesi; geri gelince "geri geldi" */
  private reconnectTimer: number | null = null;
  private lostSoundPlayed = false;

  /** Odada yayınlanan mikrofonun işlemcisi; seviye/hata/yeniden kurulum yalnızca ondan dikkate alınır */
  private get processor(): MicProcessor | null {
    return this.micSeq.current;
  }

  private set processor(p: MicProcessor | null) {
    this.micSeq.current = p;
  }

  constructor() {
    this.audioSink = document.createElement('div');
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);

    useSettings.subscribe((next, prev) => this.onSettingsChanged(next, prev));
    // İzlenen yayınlar sunucuya bildirilir (yayıncılar izleyenlerini görür); kanaldan çıkınca liste boşalır
    useVoice.subscribe((next, prev) => {
      if (next.watching !== prev.watching) gateway.setWatching(Object.keys(next.watching));
    });
    // Yönetim paneli için ses kalitesi özetleri (bkz. client-core voiceTelemetry)
    voiceTelemetry.setContext(() => this.telemetryContext());
    gateway.on((msg) => {
      if (msg.t === 'READY') this.syncVoiceState();
      // Yetkili biri seni başka ses kanalına taşıdı: o kanala geç
      if (msg.t === 'VOICE_MOVE' && useVoice.getState().channelId) void this.join(msg.d.channelId);
    });
    // Sunucuda sağırlaştırılınca kimse duyulmaz (dinleme LiveKit'te kesilmez, istemci uygular)
    useGuild.subscribe((next, prev) => {
      const selfId = useSession.getState().user?.id;
      if (!selfId) return;
      const now = next.voiceStates[selfId];
      const before = prev.voiceStates[selfId];
      if (now?.serverDeaf !== before?.serverDeaf) this.applyVolumes();
      // Yetkili biri seni sunucuda susturdu / sağırlaştırdı (ya da kaldırdı): kendi düğmendeki gibi ses
      if (now && before && useVoice.getState().status === 'connected') {
        if (now.serverDeaf !== before.serverDeaf) playSound(now.serverDeaf ? 'deafen' : 'undeafen');
        else if (now.serverMute !== before.serverMute) playSound(now.serverMute ? 'mute' : 'unmute');
      }
    });
  }

  // ---------- Bağlanma / ayrılma ----------

  /** Fare kanalın üzerine gelince jetonu önceden al; tıklamada bir ağ gidiş-dönüşü kazanılır. */
  prefetch(channelId: string): void {
    const p = this.prefetched;
    if (p && p.channelId === channelId && Date.now() - p.at < PREFETCH_TTL_MS) return;
    if (useVoice.getState().channelId === channelId) return;
    const response = api.joinVoice(channelId);
    response.catch(() => {
      if (this.prefetched?.response === response) this.prefetched = null;
    });
    this.prefetched = { channelId, at: Date.now(), response };
  }

  private takePrefetched(channelId: string): Promise<VoiceJoinResponse> {
    const p = this.prefetched;
    this.prefetched = null;
    if (p && p.channelId === channelId && Date.now() - p.at < PREFETCH_TTL_MS) return p.response;
    return api.joinVoice(channelId);
  }

  /** @param opts.silent Sessiz geri dönüş ("başka cihaz" uyarısından sonra): katılma sesi çalınmaz */
  async join(channelId: string, opts: { silent?: boolean } = {}): Promise<void> {
    const current = useVoice.getState();
    if (current.channelId === channelId && current.status !== 'idle') return;

    const seq = ++this.joinSeq;
    // Ses bağlamı ve çıkış aygıtı bağlanırken hazırlanır: "katıldın" sesi aygıt değişimine takılmasın
    prepareSounds();
    await this.teardownRoom();
    // Sökme beklenirken başka bir katılma/ayrılma başladıysa bu istek eskidir: durumu ezmesin
    if (seq !== this.joinSeq) return;
    setVoice({ ...RESET_ROOM_STATE, channelId, status: 'connecting', error: null });

    try {
      const { url, token } = await this.takePrefetched(channelId);
      if (seq !== this.joinSeq) return;

      const s = getSettings();
      const room = new Room({
        // İzlenen yayının katmanı izleme öğesinin boyutuna göre seçilir (görünmeyen yayın sunucuda durur). Piksel
        // yoğunluğu 2: öğe boyutunun iki katı istenir, böylece sahnede/tam ekranda (ızgarada da çoğunlukla) üst
        // katman gelir; alt katmana yalnızca çok küçük öğeler (kısa kenarı ~360 pikselden küçük) düşer. Varsayılan
        // yoğunluk (1) 1080p ekranda pencere içi sahnede bile 720p30 alt katmanını seçtirip 60 FPS'i yarıya indirirdi.
        adaptiveStream: { pixelDensity: 2 },
        dynacast: true,
        webAudioMix: true,
        audioOutput: { deviceId: s.outputDeviceId },
        publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false },
        disconnectOnPageLeave: true,
      });
      this.room = room;
      this.bindRoom(room);
      // Bağlanırken gelen katılımcı/yayın olayları ses çıkarmaz (süre bağlanınca kısaltılır)
      this.channelSounds.quiet(60_000);

      await room.connect(url, token, { autoSubscribe: false });
      if (seq !== this.joinSeq) {
        await room.disconnect();
        return;
      }

      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) this.onPublication(pub, p);
      }
      this.applyVolumes();
      setConnectionStats({ server: this.serverInfo(room, url) });
      setVoice({ channelId, status: 'connected', micAllowed: this.canPublish(room, PROTO_SOURCE.microphone) });
      // Bağlantı kurulunca (öncesinde değil) çalınır; kanaldakilerin girişleri ve yayınları ses seli yapmaz
      this.channelSounds.quiet();
      this.startStats();
      this.syncVoiceState();
      const micReady = this.startMic(room);
      if (!opts.silent) {
        // Mikrofon açılırken (aygıtın açılışı, gürültü engelleyicinin kurulumu) çalınan "katıldın" sesi takılıyordu
        // (geri bildirim #24); mikrofon hazır olunca, en geç JOIN_SOUND_MAX_WAIT_MS sonra çalınır.
        const waited = new Promise((resolve) => setTimeout(resolve, JOIN_SOUND_MAX_WAIT_MS));
        void Promise.race([micReady.catch(() => undefined), waited]).then(() => {
          if (seq === this.joinSeq && this.room === room) playSound('join');
        });
      }
      await micReady;
    } catch (err) {
      if (seq !== this.joinSeq) return;
      await this.teardownRoom();
      const message = errorMessage(err);
      setVoice({
        ...RESET_ROOM_STATE,
        channelId: null,
        status: 'idle',
        error: /pc connection|signal|websocket|fetch/i.test(message)
          ? 'Ses sunucusuna bağlanılamadı. Sunucu çalışıyor mu, UDP portları açık mı?'
          : message,
      });
    }
  }

  async leave(opts: { silent?: boolean } = {}): Promise<void> {
    this.joinSeq++;
    const wasActive = useVoice.getState().status !== 'idle';
    await this.teardownRoom();
    setVoice({ ...RESET_ROOM_STATE, channelId: null, status: 'idle' });
    if (wasActive && !opts.silent) playSound('leave');
  }

  clearError(): void {
    setVoice({ error: null });
  }

  private async teardownRoom(): Promise<void> {
    this.channelSounds.cancel();
    this.clearReconnectTimer();
    this.scheduleReupgrade(null);
    this.clearAutoRetry();
    this.clearRestartWait();
    this.micSeq.clearDeferred();
    this.stopStats();
    // Bekleyen olay kaydı kesiti (tetiklenmiş, süresi dolmamış) o ana kadarki ölçümlerle gönderilir
    voiceTrace.stop(Date.now());
    // Yarım kalan ses kalitesi özeti (kanal ve mikrofon bilgisi henüz duruyor)
    voiceTelemetry.reset();
    this.statsPrev = { publisher: null, subscriber: null };
    setConnectionStats(EMPTY_CONNECTION_STATS);
    if (this.pttReleaseTimer !== null) window.clearTimeout(this.pttReleaseTimer);
    this.pttReleaseTimer = null;
    const room = this.room;
    this.room = null;
    await this.stopScreenShareInternal(room, false);
    if (room) await room.disconnect(true).catch(() => undefined);
    this.mic?.stop();
    await this.processor?.destroy().catch(() => undefined);
    this.mic = null;
    this.processor = null;
    this.micFailed = false;
    this.micTest?.liveChanged();
    this.serverSpeaking.clear();
    this.remoteMeter.clear();
    this.selfSpeaking = false;
    this.audioSink.replaceChildren();
  }

  // ---------- Mikrofon ----------

  /**
   * @param denoiser Zincirde çalışacak yapay zekâ gürültü engelleyicisi. Çalışırken tarayıcının gürültü
   * engelleyicisi kapatılır (çift işlem sesi bozar); hiçbiri yüklenemezse standart engelleme devreye girer.
   * Tarayıcının otomatik kazancı da model çalışırken kapalıdır: sessizlikte gürültü tabanını yükseltip modelin
   * önüne pompalanan bir giriş verir. Model düşüp standarda geçilince yakalama yeniden açılır (bkz. openMic),
   * kullanıcının ayarı yeniden uygulanır. Mikrofon testi de bu seçenekleri kullanır.
   */
  private captureOptions(denoiser: Denoiser | null): AudioCaptureOptions {
    const s = getSettings();
    const wantsAi = ladderFor(s.noise).length > 0;
    return {
      deviceId: s.inputDeviceId,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noise === 'standard' || (wantsAi && !denoiser),
      autoGainControl: s.autoGainControl && !denoiser,
      channelCount: 1,
      sampleRate: 48000,
    };
  }

  /**
   * Ayardaki yapay zekâ gürültü engelleyicisinin dosyalarını önceden yükler. Seçili model kullanılamıyorsa
   * (yüklenemedi, işlemci yetmedi ve bekleme süresi dolmadı) sıradakine (bkz. DENOISER_LADDER), hiçbiri
   * olmazsa standart engellemeye (null) düşülür.
   */
  private wantedDenoiser(): Promise<Denoiser | null> {
    return firstAvailableDenoiser(ladderFor(getSettings().noise));
  }

  /** Gerçekte çalışan gürültü engelleme (seçili model düştüyse bir alttaki ya da standart) */
  private effectiveNoise(): EffectiveNoise | 'off' {
    const noise = getSettings().noise;
    if (!ladderFor(noise).length) return noise === 'off' ? 'off' : 'standard';
    return this.processor?.activeDenoiser ?? 'standard';
  }

  /** Ses kalitesi özetinin kanal ve mikrofon bilgisi (yalnızca ölçümler; ad, içerik yok) */
  private telemetryContext(): TelemetryContext {
    const v = useVoice.getState();
    const stats = this.processor?.stats ?? null;
    const f = v.noiseFallback;
    return {
      channelId: v.status === 'idle' ? null : v.channelId,
      mic: this.mic
        ? {
            noise: getSettings().noise,
            model: stats?.model ?? null,
            load: stats?.load ?? null,
            avgFrameMs: stats?.avgFrameMs ?? null,
            p99FrameMs: stats?.p99FrameMs ?? null,
            maxFrameMs: stats?.maxFrameMs ?? null,
            underruns: stats?.underruns ?? null,
            droppedSamples: stats?.droppedSamples ?? null,
            muted: this.micMuted(),
            effectiveNoise: this.effectiveNoise(),
            noiseFallback: f ? `${f.from} → ${f.to}: ${f.reason}` : null,
            fallback: f
              ? { from: f.from, to: f.to, reason: f.reason, transient: f.transient, at: f.at, retryAt: f.retryAt }
              : null,
          }
        : null,
      settings: this.telemetrySettings(),
    };
  }

  /** Sesi bozabilecek kayıtlı ayarlar (kişi başı seviyelerden yalnızca sayı ve en yüksek; kimlik yok) */
  private telemetrySettings(): TelemetryVoiceSettings {
    const s = getSettings();
    return {
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
      voiceActivity: s.inputMode === 'vad',
      vadAuto: s.vadAuto,
      vadThresholdDb: s.vadThresholdDb,
      noiseMode: s.noise,
      noiseStrengthDb: s.noiseStrengthDb,
      inputMode: s.inputMode,
      inputVolume: s.inputVolume,
      outputVolume: s.outputVolume,
      audioBitrateKbps: s.audioBitrateKbps,
      ...volumeSummary(s.userVolumes),
    };
  }

  /** Mikrofon işleme ölçümleri (gürültü engelleyici yükü, kare süreleri); bağlı değilse null */
  micProcessingStats(): MicProcessingStats | null {
    return this.processor?.stats ?? null;
  }

  private gateConfig(): GateConfig {
    const s = getSettings();
    return {
      // Test sürerken bas-konuş kapısı açık tutulur (odaya zaten sessizlik gider), kendini tuşsuz duyarsın
      mode: s.inputMode === 'ptt' ? (this.micTest ? 'open' : 'ptt') : 'vad',
      auto: s.vadAuto,
      threshold: s.vadThresholdDb,
      ptt: useVoice.getState().pttActive,
    };
  }

  /**
   * LiveKit bu kaynağı yayınlamaya izin veriyor mu. Sunucu izni kanaldaki yetkilere göre verir
   * (SPEAK → mikrofon, STREAM → ekran) ve sunucuda susturulunca mikrofon iznini alır.
   */
  private canPublish(room: Room, source: number): boolean {
    const p = room.localParticipant.permissions;
    if (!p) return true;
    return p.canPublish && (p.canPublishSources.length === 0 || p.canPublishSources.includes(source as never));
  }

  /** Mikrofon açılamıyorsa kullanıcıya gösterilecek neden */
  micBlockedReason(): string {
    const selfId = useSession.getState().user?.id;
    const state = selfId ? useGuild.getState().voiceStates[selfId] : undefined;
    return state?.serverMute || state?.serverDeaf
      ? 'Sunucuda susturuldun; mikrofonunu yalnızca yetkili biri açabilir.'
      : 'Bu kanalda konuşma iznin yok.';
  }

  /** İzinler değişti (rol, kanal izni, sunucuda susturma): mikrofonu ve yayını ona göre aç/kapat. */
  private async onPermissionsChanged(room: Room): Promise<void> {
    setVoice({ micAllowed: this.canPublish(room, PROTO_SOURCE.microphone) });
    // Sürmekte olan bir yayınlama/yeniden kurulum bittikten sonra, o anki izne göre
    await this.micSeq.run(async () => {
      if (room !== this.room) return;
      const micAllowed = this.canPublish(room, PROTO_SOURCE.microphone);
      if (!micAllowed && this.mic) {
        await this.detachMic(room);
        this.updateNoiseState();
      } else if (micAllowed && !this.mic && useVoice.getState().status === 'connected') {
        await this.publishMic(room);
      }
    });
    if (this.screen && !this.canPublish(room, PROTO_SOURCE.screenShare)) await this.stopScreenShare();
  }

  /** Katılınca mikrofonu yayınlar (sıradaki bir yeniden kurulum yayınladıysa ikinci kez yayınlanmaz). */
  private startMic(room: Room): Promise<void> {
    return this.micSeq.run(async () => {
      if (room !== this.room || this.mic) return;
      await this.publishMic(room);
    });
  }

  /** Yayındaki mikrofonu kaldırır; eski zincirden gelen seviye ve hatalar artık dikkate alınmaz. */
  private async detachMic(room: Room): Promise<void> {
    const old = this.mic;
    const oldProcessor = this.processor;
    this.mic = null;
    this.processor = null;
    this.micTest?.liveChanged();
    if (this.selfSpeaking) {
      this.selfSpeaking = false;
      this.publishSpeaking();
    }
    if (old) {
      await room.localParticipant.unpublishTrack(old, true).catch(() => undefined);
      old.stop();
    }
    await oldProcessor?.destroy().catch(() => undefined);
  }

  /**
   * Mikrofonu açıp işlem zincirini kurar. Sıradaki modeller denenir: kurulamayan (ör. ısınmada işlemci
   * yetmedi) kaydedilir ve bir alttaki denenir; hiçbiri olmazsa tarayıcının gürültü engellemesi açık yakalanır
   * (standart). Yakalama her denemede yeniden açılır: modelsiz ama tarayıcı engellemesi de kapalı ham ses kalmaz.
   */
  private async openMic(room: Room): Promise<{ track: LocalAudioTrack; processor: MicProcessor } | null> {
    for (;;) {
      const denoiser = await this.wantedDenoiser();
      const track = await createLocalAudioTrack(this.captureOptions(denoiser));
      track.setAudioContext(sharedAudioContext());
      const processor: MicProcessor = new MicProcessor(
        this.gateConfig(),
        denoiser,
        getSettings().noiseStrengthDb,
        // Yalnızca yayındaki (güncel) zincirden: eski ya da henüz kurulan zincirler halkayı ve göstergeyi karıştırmaz
        (level) => {
          if (this.micSeq.isCurrent(processor)) this.onMicLevel(level);
        },
        (failure, restarting) => {
          if (this.micSeq.isCurrent(processor)) this.onDenoiserFailed(failure, processor.stats, restarting);
        },
      );
      // Mikrofon testi sürüyorsa odaya daha ilk andan sessizlik gider
      processor.setSendMuted(this.micTest !== null || this.resumeSendTimer !== null);
      processor.onRebuilt = () => {
        if (this.micSeq.isCurrent(processor)) this.micTest?.liveChanged();
      };
      processor.setInputGain(getSettings().inputVolume);
      try {
        await track.setProcessor(processor);
      } catch (err) {
        track.stop();
        await processor.destroy().catch(() => undefined);
        throw err;
      }
      if (!processor.denoiserFailed) return { track, processor };
      // Model kurulamadı (düşüş kaydedildi, wantedDenoiser artık onu vermez): bir alttakiyle yeniden açılır
      track.stop();
      await processor.destroy().catch(() => undefined);
      if (room !== this.room) return null;
    }
  }

  /** Mikrofonu yayınlar. Yalnızca micSeq sırasında çağrılır (bkz. startMic, republishMic). */
  private async publishMic(room: Room): Promise<void> {
    // Konuşma izni yoksa (ya da sunucuda susturulduysa) yalnızca dinlenir; izin gelince yayınlanır
    if (!this.canPublish(room, PROTO_SOURCE.microphone)) return;
    const s = getSettings();
    this.micFailed = false;
    // Güncel ayarlarla baştan kuruluyor: yeniden bağlanınca yapılacak ertelenmiş kurulum gereksiz
    this.micSeq.clearDeferred();
    let track: LocalAudioTrack | null = null;
    try {
      const opened = await this.openMic(room);
      if (!opened) return;
      track = opened.track;
      const processor = opened.processor;
      if (this.micMuted()) await track.mute();
      if (room !== this.room) {
        track.stop();
        await processor.destroy();
        return;
      }
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
        audioPreset: { maxBitrate: s.audioBitrateKbps * 1000 },
      });
      // Yayınlanırken odadan çıkıldı ya da başka odaya geçildi: sahipsiz bir mikrofon yayını kalmasın
      if (room !== this.room) {
        await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
        track.stop();
        await processor.destroy().catch(() => undefined);
        return;
      }
      this.mic = track;
      this.processor = processor;
      // Kurulum sürerken test başladı/bittiyse güncel duruma getir
      processor.setSendMuted(this.micTest !== null || this.resumeSendTimer !== null);
      processor.updateGate(this.gateConfig());
      if (this.micMuted() !== track.isMuted) this.applyMicMute();
      this.micTest?.liveChanged();
      this.updateNoiseState();
    } catch (err) {
      track?.stop();
      this.micFailed = true;
      this.micTest?.liveChanged();
      const name = (err as Error)?.name;
      setVoice({
        error:
          name === 'NotAllowedError'
            ? 'Mikrofon izni verilmedi. Sistem ayarlarından Diskort için mikrofon erişimini aç.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'Mikrofon bulunamadı. Ayarlar > Ses ve Görüntü bölümünden bir giriş aygıtı seç.'
              : `Mikrofon açılamadı: ${errorMessage(err)}`,
      });
    }
  }

  /**
   * Gürültü engelleme vb. değişince (ya da model düşünce / yeniden denenince) mikrofonu yeni ayarlarla yeniden
   * yayınla. İstekler sıraya girer ve birleşir; bağlantı o an yoksa yeniden bağlanınca yapılır.
   */
  private republishMic(opts: { auto?: boolean; retry?: boolean } = {}): Promise<void> {
    return this.micSeq.requestRebuild(
      () => this.room !== null && useVoice.getState().status === 'connected',
      async () => {
        const room = this.room;
        if (!room) return;
        await this.detachMic(room);
        await this.publishMic(room);
        // Yayınlanamadıysa (hata, izin yok) düşüş durumu da temizlenir
        if (!this.mic) this.updateNoiseState();
        // Kendiliğinden yapılan yeniden kurulum (düşüş, yeniden deneme) çalışan mikrofonu söktü ama yenisi
        // açılamadı (ör. aygıt o an meşgul): kullanıcı mikrofonsuz kalmasın, kısa süre sonra bir kez daha denenir.
        if (!this.mic && this.micFailed && opts.auto && !opts.retry && room === this.room) {
          this.clearAutoRetry();
          this.autoRetryTimer = window.setTimeout(() => {
            this.autoRetryTimer = null;
            if (room !== this.room || this.mic) return;
            setVoice({ error: null });
            void this.republishMic({ auto: true, retry: true });
          }, AUTO_REBUILD_RETRY_MS);
        }
      },
    );
  }

  private clearAutoRetry(): void {
    if (this.autoRetryTimer !== null) window.clearTimeout(this.autoRetryTimer);
    this.autoRetryTimer = null;
  }

  private clearRestartWait(): void {
    this.restartWait?.();
    this.restartWait = null;
  }

  /**
   * Güncel zincirin modeli düştü (çalışırken ya da LiveKit zinciri yeniden kurarken): bir alt seçenekle kur.
   * LiveKit'in yeniden kurulumu (aygıt değişti, yeniden bağlanma) sürerken iz yayından kaldırılırsa LiveKit
   * yarım kalır; önce onun bitmesi (Restarted) beklenir.
   */
  private onDenoiserFailed(failure: DenoiserFailure | null, stats: MicProcessingStats | null, restarting: boolean): void {
    if (failure) this.failureStats = { id: failure.id, stats };
    const track = this.mic;
    this.clearRestartWait();
    if (!restarting || !track) {
      void this.republishMic({ auto: true });
      return;
    }
    const stop = (): void => {
      window.clearTimeout(timer);
      track.off(TrackEvent.Restarted, go);
    };
    const go = (): void => {
      stop();
      if (this.restartWait === stop) this.restartWait = null;
      void this.republishMic({ auto: true });
    };
    const timer = window.setTimeout(go, LIVEKIT_RESTART_WAIT_MS);
    track.on(TrackEvent.Restarted, go);
    // Oda kapanırsa (teardownRoom) bekleme iptal edilir
    this.restartWait = stop;
  }

  /**
   * Seçili gürültü engelleyici ile çalışanı karşılaştırır: arayüzdeki durum, her düşüşte bir kez bildirim ve
   * sunucu kaydı, bekleme süresi dolunca yeniden deneme.
   */
  private updateNoiseState(): void {
    const ladder = ladderFor(getSettings().noise);
    const processor = this.processor;
    const wanted = ladder[0];
    const active = processor?.activeDenoiser ?? null;
    if (!wanted || !processor || !this.mic || active === wanted) {
      setVoice({ noiseFallback: null, noiseNotice: null });
      this.scheduleReupgrade(null);
      return;
    }
    // Çalışandan üstteki modeller düşmüş ya da bekleme süresinde; en yeni düşüş nedeni verir
    const above = ladder.slice(0, active ? ladder.indexOf(active) : ladder.length);
    let latest: DenoiserFailure | null = null;
    for (const which of above) {
      const f = denoiserHealth.lastFailure(which);
      if (f && (!latest || f.id > latest.id)) latest = f;
    }
    const retryAt = denoiserHealth.nextRetryAt(above);
    const fallback: NoiseFallbackState = {
      from: wanted,
      to: active ?? 'standard',
      reason: latest?.reason ?? 'error',
      transient: retryAt !== null,
      at: latest?.at ?? Date.now(),
      retryAt,
    };
    setVoice({ noiseFallback: fallback });
    if (latest && latest.id > this.lastNotifiedFailure) {
      this.lastNotifiedFailure = latest.id;
      this.reportFallback(fallback, latest);
      // Yeniden deneme yine olmadıysa yeni bildirim yok (bekleme süresi uzar, durum ayarlarda görünür)
      if (!this.reupgrading) setVoice({ noiseNotice: { id: latest.id, text: fallbackNoticeText(fallback) } });
    }
    this.scheduleReupgrade(retryAt);
  }

  /** Düşüşü sunucu kayıtlarına bir kez bildirir (aynı düşüş oturumda bir kez; ayrıntılar yığın alanında). */
  private reportFallback(f: NoiseFallbackState, failure: DenoiserFailure): void {
    const name = (w: EffectiveNoise): string => EFFECTIVE_NOISE_LABELS[w];
    const err = new Error(`${name(failure.which)} bırakıldı (${failure.reason}), ${name(f.to)} kullanılıyor`);
    const stats = this.failureStats?.id === failure.id ? this.failureStats.stats : null;
    const n = (v: number | null | undefined, d = 2): string => (v == null ? '-' : v.toFixed(d));
    err.stack = [
      err.message,
      `ayrıntı: ${failure.message}`,
      failure.retryAt
        ? `geçici: ${Math.round((failure.retryAt - failure.at) / 60_000)} dk sonra yeniden denenecek`
        : 'kalıcı: bu oturumda yeniden denenmeyecek',
      stats
        ? `son ölçüm: yük ${n(stats.load)}, kare ort ${n(stats.avgFrameMs)} / p99 ${n(stats.p99FrameMs)} / en uzun ${n(stats.maxFrameMs)} ms, boşluk ${stats.underruns}, atılan ${stats.droppedSamples}, barındırıcı ${stats.host}`
        : 'son ölçüm: yok (kurulumda)',
    ].join('\n');
    reportClientError(err, failure.which === 'dpdfnet' ? 'dpdfnet' : 'denoiser');
  }

  /** Seçili model bekleme süresinden sonra (görüşme ortasında da) yeniden denenir; kısa bir yeniden yayın boşluğu olur. */
  private scheduleReupgrade(at: number | null): void {
    if (this.reupgradeTimer !== null) window.clearTimeout(this.reupgradeTimer);
    this.reupgradeTimer = null;
    // Her bekleme süresi bir kez denenir (süresi dolmuş zaman yeniden gelse de döngü olmaz); yeni düşüş yeni zaman verir
    if (at === null || at <= this.attemptedRetryAt) return;
    this.reupgradeTimer = window.setTimeout(
      () => {
        this.reupgradeTimer = null;
        this.attemptedRetryAt = at;
        void this.tryReupgrade();
      },
      // Süresi kurulum sürerken dolduysa hemen değil, en az birkaç saniye sonra
      Math.max(REUPGRADE_MIN_DELAY_MS, at - Date.now() + 1000),
    );
  }

  private async tryReupgrade(): Promise<void> {
    if (!this.mic || useVoice.getState().status === 'idle') return;
    const best = await this.wantedDenoiser();
    if (best === (this.processor?.activeDenoiser ?? null)) {
      this.updateNoiseState();
      return;
    }
    this.reupgrading = true;
    try {
      await this.republishMic({ auto: true });
    } finally {
      this.reupgrading = false;
    }
  }

  /** Başlık çubuğundaki düşüş bildirimi kapatıldı */
  dismissNoiseNotice(): void {
    setVoice({ noiseNotice: null });
  }

  /** Yalnızca geliştirme: çalışan gürültü engelleyiciyi düşürür (düşüş ve yeniden deneme denemesi için). */
  debugFailDenoiser(reason: FailureReason = 'underrun'): boolean {
    if (!import.meta.env.DEV) return false;
    return this.processor?.debugFail(reason) ?? false;
  }

  private onMicLevel(level: MicLevel): void {
    const s = getSettings();
    const speaking = level.open && !s.selfMute && !s.selfDeaf && !this.micTest && this.mic !== null;
    const prev = useVoice.getState().micLevel;
    if (Math.abs(prev.db - level.db) > 0.5 || prev.open !== level.open || prev.threshold !== level.threshold) {
      setVoice({ micLevel: level });
    }
    if (speaking !== this.selfSpeaking) {
      this.selfSpeaking = speaking;
      this.publishSpeaking();
    }
  }

  // ---------- Mute / deafen / bas-konuş ----------

  toggleMute(): void {
    const s = getSettings();
    if (!useVoice.getState().micAllowed && useVoice.getState().status !== 'idle') {
      setVoice({ error: this.micBlockedReason() });
      return;
    }
    if (s.selfDeaf) {
      s.set({ selfDeaf: false, selfMute: false });
      playSound('undeafen');
      return;
    }
    s.set({ selfMute: !s.selfMute });
    playSound(s.selfMute ? 'unmute' : 'mute');
  }

  toggleDeafen(): void {
    const s = getSettings();
    if (s.selfDeaf) {
      s.set({ selfDeaf: false });
      playSound('undeafen');
    } else {
      playSound('deafen');
      s.set({ selfDeaf: true });
    }
  }

  setPushToTalk(pressed: boolean): void {
    if (getSettings().inputMode !== 'ptt') return;
    if (this.pttReleaseTimer !== null) window.clearTimeout(this.pttReleaseTimer);
    this.pttReleaseTimer = null;
    if (pressed) {
      this.applyPtt(true);
    } else {
      this.pttReleaseTimer = window.setTimeout(() => this.applyPtt(false), getSettings().pttReleaseMs);
    }
  }

  private applyPtt(active: boolean): void {
    if (useVoice.getState().pttActive === active) return;
    setVoice({ pttActive: active });
    this.processor?.updateGate({ ptt: active });
    // Bas-konuş sesi (Ayarlar'dan açılır; varsayılan kapalı). Susturulmuşken tuş bir şey açmaz, ses de yok.
    const s = getSettings();
    if (useVoice.getState().status === 'connected' && s.inputMode === 'ptt' && !s.selfMute && !s.selfDeaf) {
      playSound(active ? 'pttOn' : 'pttOff');
    }
  }

  /**
   * LiveKit düzeyinde susturulmalı mı. Test sürerken mikrofon LiveKit'te açık kalır (kapatılırsa zincire ses
   * gelmez, kendini duyamazsın); odaya gitmeyi işlemcinin gönderim kazancı keser.
   */
  private micMuted(): boolean {
    const s = getSettings();
    return (s.selfMute || s.selfDeaf) && !this.micTest;
  }

  private applyMicMute(): void {
    if (!this.mic) return;
    if (this.micMuted()) void this.mic.mute();
    else void this.mic.unmute();
  }

  private applyVolumes(): void {
    const room = this.room;
    if (!room) return;
    const s = getSettings();
    const selfId = useSession.getState().user?.id;
    const deaf = s.selfDeaf || (selfId !== undefined && useGuild.getState().voiceStates[selfId]?.serverDeaf === true);
    // Çıkış ses seviyesi (mikrofon/kulaklık menüsü) herkesin kendi seviyesiyle çarpılır
    const master = s.outputVolume;
    for (const p of room.remoteParticipants.values()) {
      const silenced = deaf || s.localMutes[p.identity] === true;
      p.setVolume(silenced ? 0 : (s.userVolumes[p.identity] ?? 1) * master, Track.Source.Microphone);
      p.setVolume(deaf ? 0 : (s.streamVolumes[p.identity] ?? 1) * master, Track.Source.ScreenShareAudio);
    }
  }

  private syncVoiceState(): void {
    const s = getSettings();
    // Mikrofon testi sürerken diğerleri seni susturulmuş görür (kayıtlı susturma ayarın değişmez)
    const selfMute = s.selfMute || this.micTest !== null;
    gateway.send({ t: 'VOICE_STATE_SET', d: { selfMute, selfDeaf: s.selfDeaf } });
  }

  private onSettingsChanged(next: Settings, prev: Settings): void {
    if (next.selfMute !== prev.selfMute || next.selfDeaf !== prev.selfDeaf) {
      this.applyMicMute();
      this.applyVolumes();
      this.syncVoiceState();
      if (this.selfSpeaking && (next.selfMute || next.selfDeaf)) {
        this.selfSpeaking = false;
        this.publishSpeaking();
      }
    }
    if (
      next.userVolumes !== prev.userVolumes ||
      next.localMutes !== prev.localMutes ||
      next.streamVolumes !== prev.streamVolumes ||
      next.outputVolume !== prev.outputVolume
    ) {
      this.applyVolumes();
    }
    if (
      next.inputMode !== prev.inputMode ||
      next.vadAuto !== prev.vadAuto ||
      next.vadThresholdDb !== prev.vadThresholdDb
    ) {
      if (next.inputMode !== 'ptt') this.applyPtt(false);
      this.processor?.updateGate(this.gateConfig());
    }
    if (next.noiseStrengthDb !== prev.noiseStrengthDb) this.processor?.setAttenLimit(next.noiseStrengthDb);
    if (next.inputVolume !== prev.inputVolume) this.processor?.setInputGain(next.inputVolume);
    if (next.outputDeviceId !== prev.outputDeviceId) {
      void this.room?.switchActiveDevice('audiooutput', next.outputDeviceId).catch(() => undefined);
    }
    if (
      next.inputDeviceId !== prev.inputDeviceId ||
      next.noise !== prev.noise ||
      next.echoCancellation !== prev.echoCancellation ||
      // Model çalışırken otomatik kazanç zaten kapalı; değiştirmek mikrofonu boşuna yeniden kurmasın
      (next.autoGainControl !== prev.autoGainControl && !this.processor?.activeDenoiser) ||
      next.audioBitrateKbps !== prev.audioBitrateKbps
    ) {
      void this.republishMic();
    }
  }

  // ---------- Oda olayları ----------

  private bindRoom(room: Room): void {
    room
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (room === this.room) this.onPublication(pub, p, true);
      })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
          this.refreshStream(p);
        }
        if (pub.source === Track.Source.ScreenShare && room === this.room) this.channelSounds.push('userStreamStop');
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSubscribed(track, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        this.remoteMeter.remove(track.mediaStreamTrack);
        track.detach().forEach((el) => el.remove());
        this.bumpTracks();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        this.applyVolumes();
        if (room === this.room) this.channelSounds.push('userJoin');
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.serverSpeaking.delete(p.identity);
        this.remoteMeter.removeIdentity(p.identity);
        this.publishSpeaking();
        this.refreshStream(p);
        if (room === this.room) this.channelSounds.push('userLeave');
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.serverSpeaking = new Set(speakers.filter((sp) => !sp.isLocal).map((sp) => sp.identity));
        this.publishSpeaking();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, p) => {
        if (p.isLocal) setVoice({ quality });
      })
      .on(RoomEvent.Reconnecting, () => {
        this.duplicates.noteReconnect();
        if (room !== this.room) return;
        voiceTelemetry.noteReconnect();
        voiceTrace.mark(Date.now(), 'reconnecting', 'reconnect');
        setVoice({ status: 'reconnecting' });
        // Kısa kopmalar sessiz geçer; bağlantı birkaç saniyede gelmezse "koptu" sesi
        this.clearReconnectTimer();
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          if (room !== this.room || useVoice.getState().status !== 'reconnecting') return;
          this.lostSoundPlayed = true;
          playSound('disconnect');
        }, RECONNECT_SOUND_DELAY_MS);
      })
      .on(RoomEvent.SignalReconnecting, () => {
        this.duplicates.noteReconnect();
        if (room === this.room) voiceTrace.mark(Date.now(), 'signal-reconnecting', 'reconnect');
      })
      .on(RoomEvent.Reconnected, () => {
        this.duplicates.noteReconnect();
        if (room !== this.room) return;
        voiceTrace.mark(Date.now(), 'reconnected');
        setVoice({ status: 'connected' });
        // Yeniden bağlanınca LiveKit katılımcıları yeniden bildirebilir: ses seli olmasın
        this.channelSounds.quiet();
        const wasLost = this.lostSoundPlayed;
        this.clearReconnectTimer();
        if (wasLost) playSound('reconnected');
        // Bağlantı yokken istenen yeniden kurulum (model düştü, ayar değişti, yeniden deneme) şimdi yapılır
        if (this.micSeq.takeDeferred()) void this.republishMic();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!room.canPlaybackAudio) void room.startAudio().catch(() => undefined);
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p.isLocal && room === this.room) void this.onPermissionsChanged(room);
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== this.room) return; // kendi başlattığımız ayrılma
        const channelId = useVoice.getState().channelId;
        if (reason !== DisconnectReason.CLIENT_INITIATED) {
          voiceTrace.mark(Date.now(), `disconnected:${DisconnectReason[reason ?? 0] ?? reason}`, 'state');
        }
        // DUPLICATE_IDENTITY beklenen bir durum (başka cihazdan girildi): hata sayılmaz
        if (reason !== DisconnectReason.CLIENT_INITIATED && reason !== DisconnectReason.DUPLICATE_IDENTITY) {
          reportClientError(new Error(`ses bağlantısı kapandı: ${DisconnectReason[reason ?? 0] ?? reason}`), 'ses');
        }
        // Kendi yeniden bağlanmamızın ardından gelen "başka cihaz" uyarısı: sessizce kanala geri dön
        if (channelId && this.duplicates.shouldRejoin(reason === DisconnectReason.DUPLICATE_IDENTITY)) {
          void this.leave({ silent: true })
            .then(() => this.join(channelId, { silent: true }))
            .catch(() => undefined);
          return;
        }
        this.joinSeq++;
        void this.teardownRoom();
        setVoice({
          ...RESET_ROOM_STATE,
          channelId: null,
          status: 'idle',
          error: disconnectMessage(reason, Boolean(channelId && useGuild.getState().dms[channelId])),
        });
        // Kendin ayrılmadın (bağlantı koptu, çıkarıldın, başka cihazdan girildi): "koptu" sesi
        playSound(reason === DisconnectReason.CLIENT_INITIATED ? 'leave' : 'disconnect');
      });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lostSoundPlayed = false;
  }

  private onPublication(pub: RemoteTrackPublication, p: RemoteParticipant, published = false): void {
    if (pub.source === Track.Source.Microphone) {
      pub.setSubscribed(true);
      return;
    }
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      this.refreshStream(p);
      if (useVoice.getState().watching[p.identity]) pub.setSubscribed(true);
      // Kanaldaki biri yayına başladı (katılırken zaten süren yayınlar için ses yok)
      if (published && pub.source === Track.Source.ScreenShare) this.channelSounds.push('userStreamStart');
    }
  }

  private onSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (track.kind === Track.Kind.Audio) this.audioSink.appendChild(track.attach());
    // Konuşma halkası yalnızca bu odadaki mikrofonlardan ölçülür (yayın sesi konuşma sayılmaz)
    const mic = track.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone;
    if (mic && this.room?.remoteParticipants.get(p.identity) === p) {
      this.remoteMeter.add(p.identity, track.mediaStreamTrack);
    }
    this.applyVolumes();
    this.bumpTracks();
  }

  private refreshStream(p: RemoteParticipant): void {
    const video = p.getTrackPublication(Track.Source.ScreenShare);
    const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
    const id = p.identity;
    setVoice((s) => {
      const streams = { ...s.streams };
      const watching = { ...s.watching };
      let focusedStream = s.focusedStream;
      if (video) {
        streams[id] = { hasAudio: Boolean(audio) };
      } else {
        delete streams[id];
        delete watching[id];
        // Büyütülen yayın bittiyse ızgaraya dönülür
        if (focusedStream === id) focusedStream = null;
      }
      return { streams, watching, focusedStream };
    });
  }

  /**
   * Konuşma halkalarının tek çıkışı. Uzak katılımcılar: sesi yerelde ölçülüyorsa ölçüm (duyulanla eş zamanlı),
   * ölçülemiyorsa (henüz abone olunmadı, ses bağlamı çalışmıyor) sunucunun bildirimi. Küme değişmediyse store'a
   * yazılmaz.
   */
  private publishSpeaking(): void {
    const speaking: Record<string, true> = {};
    for (const id of this.room?.remoteParticipants.keys() ?? []) {
      if (this.remoteMeter.measures(id) ? this.remoteMeter.isSpeaking(id) : this.serverSpeaking.has(id)) {
        speaking[id] = true;
      }
    }
    const selfId = useSession.getState().user?.id;
    if (this.selfSpeaking && selfId) speaking[selfId] = true;
    const prev = useVoice.getState().speaking;
    const ids = Object.keys(speaking);
    if (ids.length === Object.keys(prev).length && ids.every((id) => prev[id])) return;
    setVoice({ speaking });
  }

  private bumpTracks(): void {
    setVoice((s) => ({ tracksVersion: s.tracksVersion + 1 }));
  }

  // ---------- Yayın izleme ----------

  /** `focus` false ise yayın ızgaradaki kutucuğunda oynar, büyütülmez (sahne ızgarasından izlemek) */
  watchStream(userId: string, focus = true): void {
    setVoice((s) => ({ watching: { ...s.watching, [userId]: true }, focusedStream: focus ? userId : s.focusedStream }));
    const p = this.room?.remoteParticipants.get(userId);
    p?.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(true);
    p?.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(true);
  }

  stopWatching(userId: string): void {
    const p = this.room?.remoteParticipants.get(userId);
    p?.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(false);
    p?.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(false);
    setVoice((s) => {
      const { [userId]: _removed, ...watching } = s.watching;
      // Büyütülen yayın bırakılınca başka yayına geçilmez, ızgaraya dönülür
      const focusedStream = s.focusedStream === userId ? null : s.focusedStream;
      return { watching, focusedStream };
    });
  }

  focusStream(userId: string | null): void {
    setVoice({ focusedStream: userId });
  }

  /** Yayın görüntüsü: uzak kullanıcılar için abone olunan track, kendin için yerel önizleme. */
  getScreenTrack(userId: string): RemoteVideoTrack | LocalVideoTrack | undefined {
    const selfId = useSession.getState().user?.id;
    if (userId === selfId) return this.screen?.video;
    const pub = this.room?.remoteParticipants.get(userId)?.getTrackPublication(Track.Source.ScreenShare);
    return pub?.videoTrack as RemoteVideoTrack | undefined;
  }

  // ---------- Ekran paylaşımı ----------

  /** Yayını başlatır; sistem sesi paylaşılamadıysa uyarı metni döner. */
  async startScreenShare(opts: ScreenShareOptions): Promise<string | null> {
    const room = this.room;
    if (!room || useVoice.getState().status !== 'connected') return null;
    await this.stopScreenShareInternal(room, false);

    const preset = SCREEN_PRESETS[opts.preset];
    if (bridge && opts.sourceId) await bridge.screen.select({ sourceId: opts.sourceId, audio: opts.audio });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.fps, max: preset.fps },
        },
        audio: opts.audio
          ? ({
              // Uygulamanın kendi sesini (diğer konuşmacılar) hariç tut → yankı olmaz.
              restrictOwnAudio: true,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            } as MediaTrackConstraints)
          : false,
        selfBrowserSurface: 'exclude',
        systemAudio: opts.audio ? 'include' : 'exclude',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    } catch (err) {
      if ((err as Error).name === 'NotAllowedError' || (err as Error).name === 'AbortError') return null;
      throw err;
    }
    if (room !== this.room) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }

    const videoTrack = stream.getVideoTracks()[0]!;
    videoTrack.contentHint = opts.content;
    let audioTrack = stream.getAudioTracks()[0];
    let warning: string | null = null;
    if (audioTrack) {
      const settings = audioTrack.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean };
      if (settings.restrictOwnAudio === false) {
        audioTrack.stop();
        audioTrack = undefined;
        warning = 'Sistem sesi bu sistemde yankısız paylaşılamadığı için kapatıldı.';
      }
    } else if (opts.audio && bridge?.screen.supportsAudio) {
      warning = 'Sistem sesi yakalanamadı; yayın sessiz devam ediyor.';
    }

    // Ekran kartı kodlayıcısı: SDP anlaşmasından önce ayarlanmalı (bkz. hardwareEncoder.ts)
    const hardware = await prepareHardwareEncoder(videoTrack, opts.codec, preset);
    if (room !== this.room) {
      releaseHardwareEncoder(videoTrack);
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    const video = new LocalVideoTrack(videoTrack, undefined, true);
    // Simulcast alt katmanı yalnızca ekran kartının H.264 kodlayıcısında (gerekçe aşağıda, publishTrack'te)
    const lowLayer = hardware === 'h264-high' ? screenShareLowLayer(videoTrack.getSettings(), preset) : null;
    let audio: LocalAudioTrack | null = null;
    // Yayın başlatılamazsa (ör. bağlantı koptu) yakalama açık kalmasın: yayınlanan geri alınır, izler durur
    const abandon = async (): Promise<void> => {
      for (const track of [video, audio]) {
        if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
      }
      releaseHardwareEncoder(videoTrack);
      video.stop();
      audio?.stop();
      stream.getTracks().forEach((t) => t.stop());
      audioTrack?.stop();
    };
    try {
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        videoCodec: opts.codec,
        // Donanım kodlayıcısı yayın ortasında hata verirse WebRTC başka kodeğe geçer; LiveKit sunucusu yük türü
        // değişince yayını izleyicilere iletmeyi keser. Yedek VP8 tanımlıyken sunucu izleyicileri kesintisiz ona
        // aktarır (yedek yalnızca gerektiğinde kodlanır, normalde ek yük yok).
        backupCodec: hardware ? { codec: 'vp8' } : false,
        // Simulcast yalnızca ekran kartının H.264 kodlayıcısında: telefondan ya da zayıf hattan izleyenler tek
        // 1080p60 · 12 Mbps katmanı çözemiyor/taşıyamıyor; alt katman varken LiveKit onlara (ve küçük izleme
        // öğelerine) alt katmanı gönderir, diğerleri üst katmanı almaya devam eder. Bedeli ekran kartında ikinci bir
        // kodlama oturumu (küçük ve 30 FPS, işlemciye yük yok) ve yayıncının yüklemesinde alt katman kadar fazlası.
        // Yazılım kodlayıcıda (OpenH264, VP8/VP9) kapalı: alt katman toplam kodlama süresini ~2 katına çıkarıp
        // çözünürlüğü CPU yüzünden düşürtüyor. AV1'de de kapalı: LiveKit simulcast açıkken AV1'i katman başına
        // L1T3 ile kodlatıyor; donanım kodlayıcısının istediği L1T1 tek kodlamada uygulanabiliyor (hardwareEncoder.ts).
        simulcast: lowLayer !== null,
        ...(lowLayer ? { screenShareSimulcastLayers: [lowLayer] } : {}),
        screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps, priority: 'high' },
        degradationPreference: opts.content === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
      });

      if (audioTrack) {
        audio = new LocalAudioTrack(audioTrack, undefined, true);
        await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          forceStereo: true,
          audioPreset: { maxBitrate: 128_000 },
        });
      }
    } catch (err) {
      await abandon();
      if (room !== this.room) return null;
      setVoice((s) => ({
        sharing: false,
        shareHasAudio: false,
        shareQuality: null,
        shareIcon: null,
        // Kendi yayınına odaklıysan ızgaraya dön
        focusedStream: s.focusedStream === useSession.getState().user?.id ? null : s.focusedStream,
      }));
      this.bumpTracks();
      throw err;
    }
    // Yayınlanırken odadan çıkıldı ya da başka odaya geçildi: yayın bu odaya ait değil
    if (room !== this.room) {
      await abandon();
      return null;
    }

    this.screen = { video, audio, preview: new StreamPreviewUploader(videoTrack, sourceOf(opts, videoTrack)) };
    this.screenHardwareEncoder = hardware;
    // Paylaşılan pencere kapanırsa veya sistemden durdurulursa yayını bitir.
    videoTrack.addEventListener('ended', () => void this.stopScreenShare());
    setVoice({
      sharing: true,
      selfPreview: false,
      shareHasAudio: audio !== null,
      shareQuality: qualityLabel(videoTrack, preset),
      shareIcon: opts.sourceIcon ?? null,
    });
    this.bumpTracks();
    playSound('streamStart');
    return warning;
  }

  async stopScreenShare(): Promise<void> {
    await this.stopScreenShareInternal(this.room, true);
  }

  private async stopScreenShareInternal(room: Room | null, withSound: boolean): Promise<void> {
    const screen = this.screen;
    if (!screen) return;
    this.screen = null;
    screen.preview.stop();
    this.screenHardwareEncoder = null;
    releaseHardwareEncoder(screen.video.mediaStreamTrack);
    for (const track of [screen.video, screen.audio]) {
      if (!track) continue;
      // Yakalama kendiliğinden bittiyse ('ended') livekit-client yayını zaten kaldırmıştır: ikinci kaldırma uyarı üretir
      const published = room?.localParticipant.getTrackPublications().some((pub) => pub.track === track);
      if (room && published) await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
      track.stop();
    }
    setVoice((s) => ({
      sharing: false,
      shareHasAudio: false,
      shareQuality: null,
      shareIcon: null,
      // Kendi yayınına odaklıysan ızgaraya dön
      focusedStream: s.focusedStream === useSession.getState().user?.id ? null : s.focusedStream,
    }));
    this.bumpTracks();
    if (withSound) playSound('streamStop');
  }

  // ---------- İstatistik ----------

  private startStats(): void {
    this.stopStats();
    const channelId = useVoice.getState().channelId;
    if (channelId) voiceTrace.start(channelId);
    this.statsTick = 0;
    this.statsTimer = window.setInterval(() => {
      this.statsTick++;
      void this.collectStats(this.statsTick % STATS_EVERY_TICKS === 0);
    }, TRACE_INTERVAL_MS);
    void this.collectStats();
  }

  private stopStats(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  /** Olay kaydı için giden akışların türü: MediaStreamTrack kimliği → mikrofon / ekran / yayın sesi */
  private traceKinds(): Record<string, VoiceTraceUplinkKind> {
    const kinds: Record<string, VoiceTraceUplinkKind> = {};
    const add = (track: LocalAudioTrack | LocalVideoTrack | null | undefined, kind: VoiceTraceUplinkKind): void => {
      for (const id of [track?.mediaStreamTrack?.id, track?.sender?.track?.id]) if (id) kinds[id] = kind;
    };
    add(this.mic, 'mic');
    add(this.screen?.video, 'scr');
    add(this.screen?.audio, 'sau');
    return kinds;
  }

  /**
   * Saniyede bir: bağlantının getStats() raporu alınır ve olay kaydına (voiceTrace) verilir. `full` tiklerde
   * (2 saniyede bir ve panel açılınca) ping ve giden paket kaybı da ölçülür (grafik, kalite rengi, 30 sn'lik
   * özet). Bağlantı paneli açıkken iki bağlantının ayrıntılı istatistikleri de toplanır. Tek bağlantı kipinde
   * (livekit-client varsayılanı) tik başına tek getStats çağrısı yapılır.
   */
  private async collectStats(full = true): Promise<void> {
    const room = this.room;
    if (!room || this.statsBusy) return;
    this.statsBusy = true;
    try {
      const pcs = room.engine.pcManager;
      const detail = this.detailWatchers > 0;
      const at = Date.now();
      const pubReport = await pcs?.publisher.getStats()?.catch(() => undefined);
      const publisher = full && pubReport ? parseTransportStats(pubReport, at) : null;
      // Abonelik bağlantısı varsa (çift bağlantı kipi) gelen akışlar oradadır: olay kaydı için her tikte okunur.
      // Özet ve panel için eskisi gibi yalnızca gerektiğinde ayrıştırılır (yayın bağlantısında ölçüm yoksa,
      // ör. konuşma izni yok, ping abonelik bağlantısından alınır).
      const subReport = await pcs?.subscriber?.getStats()?.catch(() => undefined);
      const needSubscriber = full && (detail || publisher?.rttMs == null || voiceTelemetry.wantsSubscriber(at));
      const subscriber = needSubscriber && subReport ? parseTransportStats(subReport, at) : null;
      if (room !== this.room) return;

      let ice: string | null = null;
      let pc: string | null = null;
      try {
        ice = pcs?.publisher.getICEConnectionState() ?? null;
        pc = pcs?.publisher.getConnectionState() ?? null;
      } catch {
        // bağlantı kapanırken okunamayabilir
      }
      voiceTrace.sample({
        at,
        reports: [pubReport, subReport].filter((r): r is RTCStatsReport => !!r),
        kinds: this.traceKinds(),
        ice,
        pc,
        lk: useVoice.getState().quality,
        lagMs: voiceTelemetry.lagPeak(),
        micUnderruns: this.processor?.stats?.underruns ?? null,
      });
      // Saat farkı (olay kayıtları ve özetler sunucu saatine çevrilir): en çok 10 dakikada bir ölçülür
      void serverClock.refresh();
      // STUN yanıtı gelmiyorsa gösterilen ping eski değerdir: arayüz "—" gösterir
      const pingStale = voiceTrace.pingStaleMs >= PING_STALE_MS;
      if (pingStale !== useConnectionStats.getState().pingStale) setConnectionStats({ pingStale });
      if (!full) return;

      const prev = this.statsPrev;
      this.statsPrev = { publisher, subscriber };
      const rttMs = publisher?.rttMs ?? subscriber?.rttMs ?? null;
      const { sent, lost } = outboundDelta(publisher, prev.publisher);
      const samples = pushSample(useConnectionStats.getState().samples, { at, rttMs, sent, lost });
      const recent = summarizePings(samples, at - QUALITY_WINDOW_MS);
      setConnectionStats({
        samples,
        quality: linkQuality(recent.lastMs, recent.lossPercent),
        detail: detail
          ? {
              at,
              publisher: publisher && describeTransport(publisher, prev.publisher),
              subscriber: subscriber && describeTransport(subscriber, prev.subscriber),
              labels: this.streamLabels(room),
            }
          : null,
      });
      if (rttMs !== null) setVoice({ pingMs: rttMs });
      voiceTelemetry.sample({
        at,
        publisher,
        prevPublisher: prev.publisher,
        subscriber,
        quality: useConnectionStats.getState().quality,
        serverQuality: useVoice.getState().quality,
      });
    } finally {
      this.statsBusy = false;
    }
  }

  /** Bağlantı paneli açıkken çağrılır; dönen işlev paneli kapatınca ayrıntılı ölçümü durdurur. */
  watchConnectionDetail(): () => void {
    this.detailWatchers++;
    void this.collectStats();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.detailWatchers = Math.max(0, this.detailWatchers - 1);
      if (this.detailWatchers === 0) setConnectionStats({ detail: null });
    };
  }

  private serverInfo(room: Room, url: string): VoiceServerInfo {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // adres çözümlenemezse olduğu gibi gösterilir
    }
    const info = room.serverInfo;
    return {
      host,
      roomName: room.name,
      region: info?.region || null,
      nodeId: info?.nodeId || null,
      version: info?.version || null,
      e2ee: room.isE2EEEnabled,
    };
  }

  /** getStats'taki track kimliklerini kullanıcı/kaynak adına çevirir */
  private streamLabels(room: Room): Record<string, StreamLabel> {
    const labels: Record<string, StreamLabel> = {};
    const add = (id: string | undefined, label: string, screen: boolean): void => {
      if (id) labels[id] = { label, screen };
    };
    const local = (track: LocalAudioTrack | LocalVideoTrack | null | undefined, label: string, screen: boolean): void => {
      if (!track) return;
      add(track.mediaStreamTrack?.id, label, screen);
      add(track.sender?.track?.id ?? undefined, label, screen);
    };
    local(this.mic, 'Mikrofonun', false);
    local(this.screen?.video, 'Ekran yayının', true);
    local(this.screen?.audio, 'Yayın sesin', true);
    const users = useGuild.getState().users;
    for (const p of room.remoteParticipants.values()) {
      const name = users[p.identity]?.displayName ?? (p.name || p.identity);
      for (const pub of p.trackPublications.values()) {
        const screen = pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio;
        const what =
          pub.source === Track.Source.Microphone
            ? 'mikrofon'
            : pub.source === Track.Source.ScreenShare
              ? 'ekran yayını'
              : pub.source === Track.Source.ScreenShareAudio
                ? 'yayın sesi'
                : pub.kind;
        add(pub.track?.mediaStreamTrack?.id, `${name} · ${what}`, screen);
      }
    }
    return labels;
  }

  // ---------- Mikrofon testi (ayarlar ekranı) ----------

  /**
   * Ayarlardaki mikrofon testi (bkz. MicTest). Görüşmedeyken canlı zincirin dinleme kolu çalınır; test
   * sürdükçe odaya sessizlik gider ve diğerleri seni susturulmuş görür. Test durunca (durdur, ayarlar kapandı,
   * kanaldan çıkıldı) önceki durum aynen geri gelir: kayıtlı susturma/sağırlaştırma ayarı hiç değişmez,
   * sunucuda susturma da testten etkilenmez. Aynı anda tek test olur; yenisi eskisini durdurur.
   */
  startMicTest(onError: (message: string | null) => void): MicTest {
    this.micTest?.stop();
    const test: MicTest = new MicTest(
      {
        wantedDenoiser: () => this.wantedDenoiser(),
        captureOptions: (denoiser) => this.captureOptions(denoiser),
        gateConfig: () => this.gateConfig(),
        liveTrack: () => this.liveMicTrack(),
        onStop: () => {
          if (this.micTest !== test) return;
          this.micTest = null;
          this.applyMicTestState();
        },
      },
      onError,
    );
    this.micTest = test;
    this.applyMicTestState();
    // Kurucu, micTest atanmadan kaynağı seçmiş olabilir; canlı zincir varsa ona geçsin
    test.liveChanged();
    return test;
  }

  /** Görüşmedeki mikrofonun dinleme kolu; mikrofon kuruluyorsa 'pending', görüşmede yayın yoksa null */
  private liveMicTrack(): MediaStreamTrack | 'pending' | null {
    const track = this.processor?.monitorTrack;
    if (track) return track;
    const v = useVoice.getState();
    // Bağlanırken ya da mikrofon yeniden yayınlanırken (aygıt/gürültü ayarı değişti) ikinci bir mikrofon açılmaz
    return v.status === 'idle' || !v.micAllowed || this.micFailed ? null : 'pending';
  }

  /** Test başladı/bitti: odaya gönderimi, LiveKit susturmasını, bas-konuş kapısını ve görünen durumu uygula. */
  private applyMicTestState(): void {
    const testing = this.micTest !== null;
    setVoice({ micTesting: testing });
    if (this.resumeSendTimer !== null) window.clearTimeout(this.resumeSendTimer);
    this.resumeSendTimer = null;
    if (testing) {
      // Önce odaya gönderim kesilir, sonra (susturulduysan) mikrofon LiveKit'te açılır: hiçbir şey sızmaz
      this.processor?.setSendMuted(true);
      this.applyMicMute();
      this.processor?.updateGate(this.gateConfig());
      if (this.selfSpeaking) {
        this.selfSpeaking = false;
        this.publishSpeaking();
      }
    } else {
      // Önce susturma ve kapı geri gelir; zincirde kalan test sesi boşalınca gönderim açılır
      this.applyMicMute();
      this.processor?.updateGate(this.gateConfig());
      this.resumeSendTimer = window.setTimeout(() => {
        this.resumeSendTimer = null;
        if (!this.micTest) this.processor?.setSendMuted(false);
      }, MIC_TEST_RESUME_SEND_MS);
    }
    if (useVoice.getState().status !== 'idle') this.syncVoiceState();
  }
}

// LiveKit'in uyarıları sunucu kayıtlarına: kullanıcılardaki bağlantı sorunlarının nedenini görmek için
setLogExtension((level, message, context) =>
  reportVoiceLog(level, LogLevel.warn, message, context, useVoice.getState().status !== 'idle'),
);

export const voice = new VoiceClient();
