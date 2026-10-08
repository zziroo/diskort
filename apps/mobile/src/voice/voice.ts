import { AndroidAudioTypePresets, AudioSession } from '@livekit/react-native';
import {
  api,
  ChannelSoundGate,
  errorMessage,
  gateway,
  reportClientError,
  reportVoiceLog,
  setStreamVolume,
  SpuriousDuplicateGuard,
  type StreamAudioPrefs,
  streamAudioOutput,
  toggleStreamMute,
  useGuild,
  useSession,
  voiceTelemetry,
  voiceTrace,
} from '@diskort/client-core';
import {
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type Participant,
  RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  LogLevel,
  Room,
  RoomEvent,
  setLogExtension,
  Track,
} from 'livekit-client';
import { Dimensions, PermissionsAndroid, PixelRatio, Platform } from 'react-native';
import { create } from 'zustand';
import { VoiceService } from '../../modules/voice-service';
import { soundCue, type SoundEvent } from '../haptics';
import { getSettings, useSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { MicGate, SILENT_LEVEL, type GateConfig, type MicLevel } from './micGate';
import { voiceRoomName } from './roomName';
import {
  noteVideoActivity,
  onNoiseFilterBypass,
  prepareNoiseFilter,
  releaseNoiseFilter,
  webrtcNoiseSuppression,
} from './noiseFilter';

/** Bildirimdeki (ön plan servisi) oda adı: ses kanalı ya da DM araması (konuşmanın adı) */
function roomName(channelId: string | null): string {
  return voiceRoomName(useGuild.getState(), channelId, useSession.getState().user?.id);
}

function disconnectMessage(reason: DisconnectReason | undefined, channelId: string | null): string {
  // DM araması: sunucu aramayı bitirdi (oda kapandı, konuşma salt okunur oldu…). Nedeni söylenmez (engel
  // olabilir; engellenene engellendiği söylenmez).
  if (channelId && useGuild.getState().dms[channelId]) {
    return reason === DisconnectReason.DUPLICATE_IDENTITY
      ? 'Bu hesapla başka bir cihazdan aramaya bağlanıldı.'
      : reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED
        ? 'Arama sona erdi.'
        : 'Arama bağlantısı koptu.';
  }
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'Bu hesapla başka bir cihazdan ses kanalına bağlanıldı.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'Ses kanalından çıkarıldın.';
    case DisconnectReason.ROOM_DELETED:
      return 'Ses kanalı kapatıldı.';
    default:
      return 'Ses bağlantısı koptu.';
  }
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** Telefon ekranı paylaşılırken gönderilen görüntünün kısa kenarı (piksel) */
const SCREEN_SHARE_SHORT_SIDE = 720;

export interface ScreenShareStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** Kodlayıcı (ör. donanım: c2.qti.avc.encoder, yazılım: libvpx) */
  encoder: string | null;
  /** Kaliteyi düşüren neden: cpu (işlemci yetişmiyor) / bandwidth (bağlantı) */
  limit: string | null;
  /** İzleyicilerin istediği anahtar kare sayısı (çoksa görüntü kayboluyor demektir) */
  keyframeRequests: number;
}

interface VoiceStore {
  channelId: string | null;
  status: VoiceStatus;
  /** Konuşan kullanıcılar */
  speaking: Record<string, true>;
  /** Kanalda yayın yapan kullanıcılar */
  streams: Record<string, true>;
  /** Yayınında ses de olan kullanıcılar */
  streamAudio: Record<string, true>;
  /** İzlenen yayın (tek seferde bir tane; telefonda ekran küçük) */
  watching: string | null;
  /** İzlenirken biten yayın ("Yayın sona erdi" gösterilir) */
  streamEnded: string | null;
  /** Mikrofon izni yoksa yalnızca dinlenir */
  listenOnly: boolean;
  /** Kanalda konuşma izni var mı (yetki ya da sunucuda susturma; LiveKit izninden gelir) */
  micAllowed: boolean;
  /** Telefonun ekranı paylaşılıyor */
  sharing: boolean;
  /** Abonelikler değişince artar (video bileşenlerini tazelemek için) */
  tracksVersion: number;
  /** Mikrofon seviyesi (yalnızca ayarlardaki gösterge açıkken güncellenir) */
  micLevel: MicLevel;
  /** Kendi bağlantımızın kalitesi (LiveKit'in birkaç saniyede bir bildirdiği; göstergede çubuklar) */
  quality: VoiceQuality;
}

export type VoiceQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

const IDLE: Omit<VoiceStore, 'channelId' | 'status'> = {
  speaking: {},
  streams: {},
  streamAudio: {},
  watching: null,
  streamEnded: null,
  listenOnly: false,
  micAllowed: true,
  sharing: false,
  tracksVersion: 0,
  micLevel: SILENT_LEVEL,
  quality: 'unknown',
};

export const useVoice = create<VoiceStore>()(() => ({ channelId: null, status: 'idle', ...IDLE }));

/** LiveKit protokolündeki kaynak numaraları (ParticipantPermission.canPublishSources) */
const PROTO_SOURCE = { microphone: 2, screenShare: 3 } as const;
/** Yeniden bağlanma bu süreyi aşarsa "bağlantı koptu" sesi çalınır; geri gelince "geri geldi" */
const RECONNECT_SOUND_DELAY_MS = 2500;

/** LiveKit bu kaynağı yayınlamaya izin veriyor mu (sunucu izni kanaldaki yetkilere göre verir) */
function canPublish(room: Room, source: number): boolean {
  const p = room.localParticipant.permissions;
  if (!p) return true;
  return p.canPublish && (p.canPublishSources.length === 0 || p.canPublishSources.includes(source as never));
}

/** Kendi ses durumu (sunucuda susturma/sağırlaştırma buradan okunur) */
function selfVoiceState() {
  const selfId = useSession.getState().user?.id;
  return selfId ? useGuild.getState().voiceStates[selfId] : undefined;
}

const isAudio = (pub: RemoteTrackPublication): boolean =>
  pub.source === Track.Source.Microphone ||
  (pub.kind === Track.Kind.Audio && pub.source !== Track.Source.ScreenShareAudio);

/** Ayarlardaki yayın sesi tercihleri (yalnızca ilgili alanlar) */
const streamPrefs = (s: { streamVolumes: Record<string, number>; streamMuted: Record<string, true> }): StreamAudioPrefs => ({
  streamVolumes: s.streamVolumes,
  streamMuted: s.streamMuted,
});

/** Yayın bitti ya da yayıncı ayrıldı: izleniyorsa "sona erdi" durumuna geçilir */
function streamGone(s: VoiceStore, identity: string): Partial<VoiceStore> {
  const { [identity]: _gone, ...streams } = s.streams;
  const { [identity]: _audio, ...streamAudio } = s.streamAudio;
  const ended = s.watching === identity;
  return { streams, streamAudio, watching: ended ? null : s.watching, streamEnded: ended ? identity : s.streamEnded };
}

/**
 * Mikrofon işleme seçenekleri. Android'de WebRTC eklentisi bunları ses kaynağının işleme
 * ayarlarına çevirir (googNoiseSuppression vb.). Android 10+ telefonlarda LiveKit donanım
 * (telefonun kendi) yankı engelleyicisini açar; WebRTC o zaman yazılımınkini kapatıp onu kullanır.
 * Donanım gürültü engelleyicisi ise kapalı (patches/@livekit__react-native: bazı telefonlarda sesi
 * boğuyordu); gürültüyü DPDFNet (noiseFilter.ts; o zaman WebRTC'ninki kapalı) ya da WebRTC'nin yazılım
 * engelleyicisi azaltır. Seçenekler mikrofon izi oluşturulurken, yani sesli sohbete katılırken uygulanır.
 */
function captureOptions(): AudioCaptureOptions {
  const s = getSettings();
  const options = {
    echoCancellation: s.echoCancellation,
    noiseSuppression: webrtcNoiseSuppression(),
    autoGainControl: s.autoGainControl,
    // Alçak frekans uğultusunu (fan, rüzgâr, masa titreşimi) keser; Android eklentisi bu anahtarı okur
    highpassFilter: true,
  };
  return options as AudioCaptureOptions;
}

function gateConfig(): GateConfig {
  const s = getSettings();
  return { enabled: s.voiceActivity, auto: s.vadAuto, threshold: s.vadThresholdDb };
}

async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (Number(Platform.Version) >= 31) wanted.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  // Android 13+: kalıcı "sesli sohbette" bildirimi için
  if (Number(Platform.Version) >= 33) wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Telefondaki sesli sohbet. Masaüstünden farklı olarak yankı engelleme
 * telefonun kendi donanımıyla yapılır; uygulama arka plandayken ön plan servisi bağlantıyı tutar.
 */
class MobileVoiceClient {
  private room: Room | null = null;
  /** Ses sunucusunun adresi (bağlantı panelinde gösterilir) */
  private serverUrl: string | null = null;
  private joinSeq = 0;
  private readonly duplicates = new SpuriousDuplicateGuard();
  private readonly gate = new MicGate((micLevel) => useVoice.setState({ micLevel }));
  /** Başkalarının kanal olaylarının sesleri (bağlanınca sel olmasın, art arda gelenler tek ses) */
  // Kapıdan yalnızca başkalarının olayları (userJoin, userStream…) geçer; hepsi SoundEvent
  private readonly channelSounds = new ChannelSoundGate((name) => soundCue(name as SoundEvent));
  /** Bağlantı birkaç saniyede geri gelmezse "koptu" sesi; geri gelince "geri geldi" */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lostSoundPlayed = false;
  /** Ses oturumu ve ön plan servisi açık mı (yeniden katılmada kapatılmadan korunurlar) */
  private audioSessionActive = false;
  private serviceRunning = false;

  constructor() {
    // DPDFNet yetişemedi ya da hata verdi: mikrofon WebRTC'nin standart gürültü engellemesiyle yeniden açılır
    onNoiseFilterBypass(() => {
      toast('DPDFNet gürültü engelleme durdu (telefon yetişemedi, ısındı ya da hata); standart gürültü engellemeye geçildi.');
      const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as
        | LocalAudioTrack
        | undefined;
      void track?.restartTrack(captureOptions()).catch((err: unknown) => reportClientError(err, 'dpdfnet-restart'));
    });
    // Bildirimdeki düğmeler
    VoiceService.addListener('onAction', ({ action }) => {
      if (action === 'toggleMute') {
        const wasOff = this.micMuted();
        this.toggleMute();
        const off = this.micMuted();
        if (off !== wasOff) soundCue(off ? 'mute' : 'unmute');
      } else void this.leave().then(() => soundCue('leave'));
    });
    // İzlenen yayın sunucuya bildirilir (yayıncı izleyenlerini görür); yeniden bağlanınca gateway tekrarlar
    useVoice.subscribe((next, prev) => {
      if (next.watching !== prev.watching) gateway.setWatching(next.watching ? [next.watching] : []);
      // DPDFNet: görüntü varken yetişemeyen telefon kalıcı "yavaş" kaydedilmez
      if (next.watching !== prev.watching || next.sharing !== prev.sharing) {
        noteVideoActivity(next.watching !== null || next.sharing);
      }
    });
    // Sunucuya yeniden bağlanınca ses durumunu tekrar bildir
    gateway.on((msg) => {
      if (msg.t === 'READY') this.syncVoiceState();
      // Yetkili biri seni başka ses kanalına taşıdı: o kanala geç
      // (uygulama arka plandayken de olabilir: ses oturumu ve ön plan servisi korunur)
      if (msg.t === 'VOICE_MOVE' && useVoice.getState().channelId && useVoice.getState().channelId !== msg.d.channelId) {
        this.join(msg.d.channelId, { rejoin: true }).catch((err: Error) => toast(err.message, 'error'));
      }
    });
    // Sunucuda sağırlaştırılınca kimse duyulmaz (dinleme LiveKit'te kesilmez, uygulama uygular)
    useGuild.subscribe((next, prev) => {
      const selfId = useSession.getState().user?.id;
      if (!selfId) return;
      const now = next.voiceStates[selfId];
      const before = prev.voiceStates[selfId];
      if (now?.serverDeaf !== before?.serverDeaf) void this.applyLocalState();
      // Yetkili biri seni sunucuda susturdu / sağırlaştırdı (ya da kaldırdı): kendi düğmendeki gibi ses
      if (now && before && useVoice.getState().status === 'connected') {
        if (now.serverDeaf !== before.serverDeaf) soundCue(now.serverDeaf ? 'deafen' : 'undeafen');
        else if (now.serverMute !== before.serverMute) soundCue(now.serverMute ? 'mute' : 'unmute');
      }
    });
    // Kişi/yayın ses seviyeleri ve ses algılama ayarları anında uygulanır
    useSettings.subscribe((next, prev) => {
      if (
        next.userVolumes !== prev.userVolumes ||
        next.streamVolumes !== prev.streamVolumes ||
        next.streamMuted !== prev.streamMuted
      ) {
        this.applyVolumes();
      }
      if (
        next.voiceActivity !== prev.voiceActivity ||
        next.vadAuto !== prev.vadAuto ||
        next.vadThresholdDb !== prev.vadThresholdDb
      ) {
        this.gate.setConfig(gateConfig());
      }
    });
  }

  /** Bağlantı istatistikleri için açık oda ve ses sunucusunun adresi (bkz. connectionStats.ts) */
  statsTarget(): { room: Room; url: string } | null {
    return this.room && this.serverUrl ? { room: this.room, url: this.serverUrl } : null;
  }

  /** Mikrofon açılamıyorsa kullanıcıya gösterilecek neden */
  micBlockedReason(): string {
    const state = selfVoiceState();
    return state?.serverMute || state?.serverDeaf
      ? 'Sunucuda susturuldun; mikrofonunu yalnızca yetkili biri açabilir.'
      : 'Bu kanalda konuşma iznin yok.';
  }

  /**
   * @param opts.silent Sessiz geri dönüş ("başka cihaz" uyarısından sonra): katılma sesi çalınmaz
   * @param opts.rejoin Süren sesten yeniden katılma (taşınma, "başka cihaz" sonrası geri dönüş; uygulama arka
   * planda olabilir): yalnızca oda değişir, ses oturumu ve ön plan servisi kapatılmaz. Android 12+ arka
   * planda ön plan servisini yeniden başlatmaya izin vermez.
   */
  async join(channelId: string, opts: { silent?: boolean; rejoin?: boolean } = {}): Promise<void> {
    const current = useVoice.getState();
    if (!opts.rejoin && current.channelId === channelId && current.status !== 'idle') return;
    const seq = ++this.joinSeq;
    await this.teardown({ keepSession: opts.rejoin });
    if (seq !== this.joinSeq) return;
    useVoice.setState({ ...IDLE, channelId, status: 'connecting' });

    try {
      const micGranted = await requestPermissions();
      const { url, token } = await api.joinVoice(channelId);
      if (seq !== this.joinSeq) return;
      this.serverUrl = url;

      if (!this.audioSessionActive) {
        await AudioSession.configureAudio({
          android: {
            preferredOutputList: getSettings().speaker
              ? ['bluetooth', 'headset', 'speaker']
              : ['bluetooth', 'headset', 'earpiece'],
            audioTypeOptions: AndroidAudioTypePresets.communication,
          },
          // iOS: oturumu LiveKit yönetir (registerGlobals); arka planda sürmesini "audio" arka plan kipi sağlar
          ios: { defaultOutput: getSettings().speaker ? 'speaker' : 'earpiece' },
        });
        await AudioSession.startAudioSession();
        this.audioSessionActive = true;
      }
      if (seq !== this.joinSeq) return;
      // DPDFNet (seçiliyse) mikrofon açılmadan önce yüklenir; captureOptions() sonucuna göre ayarlanır
      await prepareNoiseFilter();
      if (seq !== this.joinSeq) return;

      const room = new Room({
        // Görünmeyen yayının (uygulama arka planda, ekran kapalı, ses ekranı kapalı) görüntüsü sunucuda durur
        adaptiveStream: { pixelDensity: 'screen' },
        dynacast: true,
        publishDefaults: { dtx: true, red: true },
        audioCaptureDefaults: captureOptions(),
        // İki bağlantı (yayın + abonelik). Tek bağlantı kipinde (2.22 varsayılanı) kanala her yeni katılan
        // için yayın bağlantısı yeniden müzakere edilir; Android WebRTC bunda takılıp ("negotiation timed out",
        // "Local fingerprint does not match identity") tam yeniden bağlanıyor ve odadaki herkesin sesi kopuyordu.
        singlePeerConnection: false,
      });
      this.room = room;
      this.bind(room);
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
      useVoice.setState({
        status: 'connected',
        listenOnly: !micGranted,
        micAllowed: canPublish(room, PROTO_SOURCE.microphone),
      });
      // Katılma sesi bağlantı ve ses oturumu (görüşme kipi) kurulduktan sonra: önce çalınca kip değişirken
      // kesiliyordu
      this.channelSounds.quiet();
      if (!opts.silent) soundCue('join');
      // Konuşma izni yoksa (ya da sunucuda susturulduysa) yalnızca dinlenir; izin gelince açılır
      if (micGranted && !this.micMuted()) await room.localParticipant.setMicrophoneEnabled(true, captureOptions());
      // Mikrofon açılırken ayrılındı ya da başka kanala geçildi: bu oda artık kapatıldı
      if (seq !== this.joinSeq) return;
      this.gate.attach(room, gateConfig());

      const name = roomName(channelId);
      try {
        // Yeniden katılmada servis zaten çalışıyor: yalnızca bildirim yeni kanala güncellenir
        if (this.serviceRunning) VoiceService.update(name, this.notificationText(), this.micMuted());
        else {
          VoiceService.start(name, this.notificationText(), this.micMuted());
          this.serviceRunning = true;
        }
      } catch {
        // Servis başlatılamazsa ses yine çalışır; yalnızca arka planda kesilebilir
      }
      this.syncVoiceState();
    } catch (err) {
      if (seq !== this.joinSeq) return;
      await this.teardown();
      useVoice.setState({ ...IDLE, channelId: null, status: 'idle' });
      throw new Error(
        /pc connection|signal|websocket|fetch|could not establish/i.test(errorMessage(err))
          ? 'Ses sunucusuna bağlanılamadı. İnternet bağlantını kontrol et.'
          : errorMessage(err),
      );
    }
  }

  async leave(): Promise<void> {
    const seq = ++this.joinSeq;
    await this.teardown();
    // Bu arada yeniden katılındıysa (ör. "başka cihaz" uyarısından sonra geri dönüş) yeni bağlantının
    // durumu silinmez
    if (seq === this.joinSeq) useVoice.setState({ ...IDLE, channelId: null, status: 'idle' });
  }

  toggleMute(): void {
    const s = getSettings();
    if (!useVoice.getState().micAllowed && useVoice.getState().status !== 'idle') {
      toast(this.micBlockedReason(), 'error');
      return;
    }
    // Sağırken susturmayı kaldırmak sağırlığı da kaldırır (Discord davranışı)
    if (s.selfDeaf) s.set({ selfDeaf: false, selfMute: false });
    else s.set({ selfMute: !s.selfMute });
    void this.applyLocalState();
  }

  toggleDeafen(): void {
    const s = getSettings();
    s.set({ selfDeaf: !s.selfDeaf });
    void this.applyLocalState();
  }

  async setSpeaker(on: boolean): Promise<void> {
    getSettings().set({ speaker: on });
    if (!this.room) return;
    try {
      // iOS yalnızca "varsayılan yol" (kulaklık/Bluetooth/ahize) ve "hoparlöre zorla" ayırt eder
      if (Platform.OS === 'ios') {
        await AudioSession.selectAudioOutput(on ? 'force_speaker' : 'default');
        return;
      }
      const outputs = await AudioSession.getAudioOutputs();
      // Kulaklık/Bluetooth bağlıysa onu bozma
      if (outputs.includes('bluetooth') || outputs.includes('headset')) return;
      await AudioSession.selectAudioOutput(on ? 'speaker' : 'earpiece');
    } catch {
      // desteklenmiyorsa varsayılan çıkış kalır
    }
  }

  watch(userId: string | null): void {
    const room = this.room;
    if (!room) return;
    const previous = useVoice.getState().watching;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source !== Track.Source.ScreenShare && pub.source !== Track.Source.ScreenShareAudio) continue;
        if (p.identity === userId) pub.setSubscribed(true);
        else if (p.identity === previous) pub.setSubscribed(false);
      }
    }
    useVoice.setState({ watching: userId, streamEnded: null });
    const watched = userId ? room.remoteParticipants.get(userId) : undefined;
    if (watched) this.applyVolume(watched, true);
  }

  /** "Yayın sona erdi" bilgisini kapatır */
  dismissEndedStream(): void {
    useVoice.setState({ streamEnded: null });
  }

  /**
   * Bir kişinin sesini ya da yayın sesini (0–2) ayarlar. `persist` false iken (kaydırıcı sürüklenirken)
   * yalnızca uygulanır; bırakınca kaydedilir. %100 (varsayılan) kaydedilmez.
   */
  setVolume(userId: string, kind: 'voice' | 'stream', volume: number, persist = true): void {
    const participant = this.room?.remoteParticipants.get(userId);
    const s = getSettings();
    if (kind === 'stream') {
      if (!persist) {
        // Sürüklerken yalnızca seviye değişir; kaydedilince (bırakınca) tam durum yeniden uygulanır
        if (participant) this.setStreamTrackVolume(participant, this.deafened() || volume <= 0 ? 0 : volume);
        return;
      }
      // Ayar değişince abonelik (useSettings.subscribe) durumu yeniden uygular
      s.set(setStreamVolume(streamPrefs(s), userId, volume));
      if (participant) this.applyVolume(participant, true);
      return;
    }
    participant?.setVolume(volume, Track.Source.Microphone);
    if (!persist) return;
    const next = { ...s.userVolumes };
    if (Math.abs(volume - 1) < 0.005) delete next[userId];
    else next[userId] = Math.round(volume * 100) / 100;
    s.set({ userVolumes: next });
  }

  /**
   * İzlenen yayının sesini sessize al / aç. İstenen durum kişi başı kaydedilir ve yayın sesi izi her
   * geldiğinde (abonelik, yeniden bağlanma, yayının yeniden başlaması) yeniden uygulanır.
   */
  toggleStreamAudio(userId: string): void {
    const s = getSettings();
    s.set(toggleStreamMute(streamPrefs(s), userId));
    const participant = this.room?.remoteParticipants.get(userId);
    if (participant) this.applyVolume(participant, true);
  }

  /** Ayarlardaki mikrofon seviyesi göstergesi için ölçümü başlatır; dönen işlev durdurur */
  watchMicLevel(): () => void {
    return this.gate.watchLevel();
  }

  /**
   * Telefonun ekranını paylaşır / durdurur. Android her seferinde "ekranın kaydedilecek" onayı ister;
   * paylaşım bildirimden ya da sistemden durdurulursa durum kendiliğinden güncellenir.
   */
  async toggleScreenShare(): Promise<void> {
    const room = this.room;
    if (!room || useVoice.getState().status !== 'connected') return;
    const next = !useVoice.getState().sharing;
    this.lastShareSample = null;
    try {
      await room.localParticipant.setScreenShareEnabled(
        next,
        { audio: false },
        {
          // VP8: yazılım kodlayıcısı her telefonda var. H.264 telefonun donanım kodlayıcısına kalıyor; bazı
          // telefonlarda (ör. 0.2.2'de denenen) bu boyuttaki dikey görüntüde hiç kare üretmiyor ve yayın ölü kalıyor.
          videoCodec: 'vp8',
          simulcast: false,
          screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 24 },
          // Sıkışınca kare atlamak (donma) yerine netliği düşür
          degradationPreference: 'maintain-framerate',
        },
      );
      if (next) await this.scaleScreenShare(room);
      const sharing = next && Boolean(room.localParticipant.getTrackPublication(Track.Source.ScreenShare));
      useVoice.setState({ sharing });
      if (sharing) soundCue('shareStart');
      else if (!next) soundCue('shareStop');
    } catch (err) {
      useVoice.setState({ sharing: false });
      const message = errorMessage(err);
      // Kullanıcı Android'in onay penceresinde vazgeçtiyse hata gösterme
      if (!/permission|denied|cancel|NotAllowed/i.test(message)) toast(`Ekran paylaşılamadı: ${message}`, 'error');
    }
  }

  /**
   * Android ekranı her zaman tam çözünürlükte yakalar (ör. 1220×2656). Gönderilen görüntü kısa kenarı
   * ~720 piksel olacak şekilde küçültülür; aksi hâlde kodlayıcı yetişemez ve yayın donar.
   */
  private async scaleScreenShare(room: Room): Promise<void> {
    const sender = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack?.sender;
    if (!sender) return;
    const { width, height } = Dimensions.get('screen');
    const shortSide = Math.min(width, height) * PixelRatio.get();
    const scale = Math.max(1, shortSide / SCREEN_SHARE_SHORT_SIDE);
    try {
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      for (const encoding of params.encodings ?? []) encoding.scaleResolutionDownBy = scale;
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params);
    } catch {
      // desteklenmiyorsa tam çözünürlükte devam eder
    }
  }

  private lastShareSample: { bytes: number; at: number } | null = null;

  /** Paylaşılan ekranın gönderim bilgileri: donma gibi sorunların nedenini görmek için ses ekranında gösterilir. */
  /** Sunucuya gidiş-dönüş süresi (ms): mikrofon izinin bağlantı istatistiğinden; bilinmiyorsa null */
  async pingMs(): Promise<number | null> {
    const sender = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack?.sender;
    if (!sender) return null;
    let rtt: number | null = null;
    (await sender.getStats()).forEach((entry: Record<string, unknown>) => {
      if (entry.type === 'candidate-pair' && entry.nominated && typeof entry.currentRoundTripTime === 'number') {
        rtt = Math.round(entry.currentRoundTripTime * 1000);
      } else if (rtt === null && entry.type === 'remote-inbound-rtp' && typeof entry.roundTripTime === 'number') {
        rtt = Math.round(entry.roundTripTime * 1000);
      }
    });
    return rtt;
  }

  async screenShareStats(): Promise<ScreenShareStats | null> {
    const sender = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack?.sender;
    if (!sender) return null;
    let found: Record<string, unknown> | null = null;
    (await sender.getStats()).forEach((entry: Record<string, unknown>) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video') found = entry;
    });
    const stats = found as Record<string, unknown> | null;
    if (!stats) return null;
    const num = (key: string): number => (typeof stats[key] === 'number' ? (stats[key] as number) : 0);
    const bytes = num('bytesSent');
    const at = Date.now();
    const previous = this.lastShareSample;
    this.lastShareSample = { bytes, at };
    const reason = typeof stats.qualityLimitationReason === 'string' ? stats.qualityLimitationReason : 'none';
    return {
      width: num('frameWidth'),
      height: num('frameHeight'),
      fps: Math.round(num('framesPerSecond')),
      kbps: previous && at > previous.at ? Math.round(((bytes - previous.bytes) * 8) / (at - previous.at)) : 0,
      encoder: typeof stats.encoderImplementation === 'string' ? stats.encoderImplementation : null,
      limit: reason === 'none' ? null : reason,
      keyframeRequests: num('pliCount') + num('firCount'),
    };
  }

  getScreenPublication(userId: string): { participant: RemoteParticipant; publication: RemoteTrackPublication } | null {
    const participant = this.room?.remoteParticipants.get(userId);
    const publication = participant?.getTrackPublication(Track.Source.ScreenShare);
    return participant && publication ? { participant, publication } : null;
  }

  private micMuted(): boolean {
    const s = getSettings();
    const v = useVoice.getState();
    return s.selfMute || s.selfDeaf || v.listenOnly || !v.micAllowed;
  }

  /** Kendi ya da sunucu sağırlaştırması */
  private deafened(): boolean {
    return getSettings().selfDeaf || selfVoiceState()?.serverDeaf === true;
  }

  private notificationText(): string {
    const s = getSettings();
    if (s.selfDeaf) return 'Sağırlaştırıldın';
    if (selfVoiceState()?.serverDeaf) return 'Sunucuda sağırlaştırıldın';
    if (!useVoice.getState().micAllowed) return selfVoiceState()?.serverMute ? 'Sunucuda susturuldun' : 'Yalnızca dinliyorsun';
    if (s.selfMute) return 'Susturuldun';
    return 'Sesli sohbete bağlı';
  }

  private async applyLocalState(): Promise<void> {
    const room = this.room;
    this.syncVoiceState();
    if (!room) return;
    const deaf = this.deafened();
    // Sağırken diğerlerinin sesi hiç indirilmez (hem sessizlik hem veri tasarrufu)
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) if (isAudio(pub)) pub.setSubscribed(!deaf);
    }
    // Yayın sesi de sağırken duyulmaz
    this.applyVolumes();
    if (!useVoice.getState().listenOnly) {
      await room.localParticipant.setMicrophoneEnabled(!this.micMuted(), captureOptions()).catch(() => undefined);
    }
    const name = roomName(useVoice.getState().channelId);
    VoiceService.update(name, this.notificationText(), this.micMuted());
  }

  /** Kaydedilmiş kişi/yayın ses seviyelerini uygular (iz sonradan gelirse LiveKit aboneliğe uygular) */
  private applyVolumes(resend = false): void {
    for (const p of this.room?.remoteParticipants.values() ?? []) this.applyVolume(p, resend);
  }

  /**
   * Kişinin ses seviyesini ve yayın sesi tercihini uygular. `resend` iken yayın sesinin gönderim durumu
   * sunucuya yeniden bildirilir (abonelik ve yeniden bağlanma sonrası LiveKit ses izleri için bunu
   * kendiliğinden yapmıyor).
   */
  private applyVolume(p: RemoteParticipant, resend = false): void {
    const s = getSettings();
    p.setVolume(s.userVolumes[p.identity] ?? 1, Track.Source.Microphone);
    const out = streamAudioOutput(streamPrefs(s), p.identity, this.deafened());
    this.setStreamTrackVolume(p, out.volume);
    // Sessizken sunucu yayın sesini hiç göndermez: telefondaki iz seviyesi (yeniden abonelik,
    // yeniden bağlanma) bir yerde kaybolsa bile sessizlik bozulmaz
    for (const pub of p.trackPublications.values()) {
      if (pub.source !== Track.Source.ScreenShareAudio || !pub.isDesired) continue;
      if (pub.isEnabled !== out.enabled) pub.setEnabled(out.enabled);
      else if (resend) pub.emitTrackUpdate();
    }
  }

  /**
   * Yayın sesi izinin seviyesi. LiveKit'in katılımcı seviyesi (yeni gelen ize uygulanır) ve o an
   * bağlı olan her yayın sesi izi ayrı ayrı ayarlanır; yalnızca birine güvenilmez.
   */
  private setStreamTrackVolume(p: RemoteParticipant, volume: number): void {
    p.setVolume(volume, Track.Source.ScreenShareAudio);
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShareAudio && pub.track instanceof RemoteAudioTrack) {
        pub.track.setVolume(volume);
      }
    }
  }

  private syncVoiceState(): void {
    if (useVoice.getState().status === 'idle') return;
    const s = getSettings();
    gateway.send({ t: 'VOICE_STATE_SET', d: { selfMute: s.selfMute || useVoice.getState().listenOnly, selfDeaf: s.selfDeaf } });
  }

  private onPublication(pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (isAudio(pub)) {
      pub.setSubscribed(!this.deafened());
    } else if (pub.source === Track.Source.ScreenShare) {
      useVoice.setState((s) => ({ streams: { ...s.streams, [participant.identity]: true } }));
      if (useVoice.getState().watching === participant.identity) pub.setSubscribed(true);
    } else if (pub.source === Track.Source.ScreenShareAudio) {
      useVoice.setState((s) => ({ streamAudio: { ...s.streamAudio, [participant.identity]: true } }));
      if (useVoice.getState().watching === participant.identity) {
        pub.setSubscribed(true);
        this.applyVolume(participant, true);
      }
    }
  }

  private bind(room: Room): void {
    const bump = (): void => useVoice.setState((s) => ({ tracksVersion: s.tracksVersion + 1 }));
    room
      .on(RoomEvent.TrackPublished, (pub, p) => {
        this.onPublication(pub, p);
        // Kanaldaki biri yayına başladı (katılırken zaten süren yayınlar için ses yok)
        if (this.room === room && pub.source === Track.Source.ScreenShare) this.channelSounds.push('userStreamStart');
      })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        if (this.room === room && pub.source === Track.Source.ScreenShare) this.channelSounds.push('userStreamStop');
        if (pub.source === Track.Source.ScreenShareAudio) {
          useVoice.setState((s) => {
            const { [p.identity]: _gone, ...streamAudio } = s.streamAudio;
            return { streamAudio };
          });
        }
        if (pub.source !== Track.Source.ScreenShare) return;
        useVoice.setState((s) => streamGone(s, p.identity));
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) useVoice.setState({ sharing: false });
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
        // Kaydedilmiş ses seviyesi (kişi ya da yayın sesi)
        if (track.kind === Track.Kind.Audio) this.applyVolume(p, true);
        bump();
      })
      .on(RoomEvent.TrackUnsubscribed, bump)
      // Yayıncı yayın sesini kapatıp açtı: iz yeniden etkinleşince tercih tekrar uygulanır
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (pub.source === Track.Source.ScreenShareAudio && !p.isLocal) this.applyVolumes();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        if (this.room === room) this.channelSounds.push('userJoin');
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        useVoice.setState((s) => streamGone(s, p.identity));
        if (this.room === room) this.channelSounds.push('userLeave');
      })
      // Bağlantı kalitesi göstergesi: yalnızca kendi bağlantımız (değişince bildirilir, ucuz)
      .on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
        if (participant.isLocal && this.room === room) useVoice.setState({ quality: quality as VoiceQuality });
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        useVoice.setState({ speaking: Object.fromEntries(speakers.map((p) => [p.identity, true as const])) });
      })
      // İzinler değişti (rol, kanal izni, sunucuda susturma): mikrofonu ve yayını ona göre aç/kapat
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
        if (!participant.isLocal || this.room !== room) return;
        useVoice.setState({ micAllowed: canPublish(room, PROTO_SOURCE.microphone) });
        void this.applyLocalState();
        if (useVoice.getState().sharing && !canPublish(room, PROTO_SOURCE.screenShare)) void this.toggleScreenShare();
      })
      .on(RoomEvent.Reconnecting, () => {
        this.duplicates.noteReconnect();
        useVoice.setState({ status: 'reconnecting' });
        if (this.room !== room) return;
        voiceTelemetry.noteReconnect();
        voiceTrace.mark(Date.now(), 'reconnecting', 'reconnect');
        // Kısa kopmalar sessiz geçer; bağlantı birkaç saniyede gelmezse "koptu" sesi
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.room !== room || useVoice.getState().status !== 'reconnecting') return;
          this.lostSoundPlayed = true;
          soundCue('disconnect');
        }, RECONNECT_SOUND_DELAY_MS);
      })
      .on(RoomEvent.SignalReconnecting, () => {
        this.duplicates.noteReconnect();
        if (this.room === room) voiceTrace.mark(Date.now(), 'signal-reconnecting', 'reconnect');
      })
      .on(RoomEvent.Reconnected, () => {
        this.duplicates.noteReconnect();
        useVoice.setState({ status: 'connected' });
        if (this.room === room) {
          voiceTrace.mark(Date.now(), 'reconnected');
          // Yeniden bağlanınca LiveKit katılımcıları yeniden bildirebilir: ses seli olmasın
          this.channelSounds.quiet();
          const wasLost = this.lostSoundPlayed;
          this.clearReconnectTimer();
          if (wasLost) soundCue('reconnected');
        }
        this.syncVoiceState();
        // Yeniden bağlanınca (ör. ping zaman aşımı) izler değişmiş olabilir: seviyeler ve yayın sesi
        // tercihi yeniden uygulanır
        this.applyVolumes(true);
      })
      .on(RoomEvent.Disconnected, (reason) => {
        // Kendi başlattığımız ayrılma değilse: sunucu çıkardı, başka cihaza geçildi ya da bağlantı koptu
        if (this.room !== room || room.state !== ConnectionState.Disconnected) return;
        const channelId = useVoice.getState().channelId;
        // DM araması sunucuda bitti (oda kapandı ya da konuşma salt okunur oldu): beklenen bir durum
        const callEnded =
          Boolean(channelId && useGuild.getState().dms[channelId]) &&
          (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED);
        if (reason !== DisconnectReason.CLIENT_INITIATED) {
          voiceTrace.mark(Date.now(), `disconnected:${DisconnectReason[reason ?? 0] ?? reason}`, 'state');
        }
        // DUPLICATE_IDENTITY beklenen bir durum (başka cihazdan girildi): hata sayılmaz
        if (reason !== DisconnectReason.CLIENT_INITIATED && reason !== DisconnectReason.DUPLICATE_IDENTITY && !callEnded) {
          reportClientError(new Error(`ses bağlantısı kapandı: ${DisconnectReason[reason ?? 0] ?? reason}`), 'ses');
        }
        // Kendi yeniden bağlanmamızın ardından gelen "başka cihaz" uyarısı: sessizce kanala geri dön
        // (ses oturumu ve ön plan servisi korunur: arka planda servis yeniden başlatılamaz)
        if (channelId && this.duplicates.shouldRejoin(reason === DisconnectReason.DUPLICATE_IDENTITY)) {
          this.join(channelId, { silent: true, rejoin: true }).catch((err: Error) => toast(err.message, 'error'));
          return;
        }
        const benign =
          reason === DisconnectReason.CLIENT_INITIATED || reason === DisconnectReason.DUPLICATE_IDENTITY || callEnded;
        toast(disconnectMessage(reason, channelId), benign ? 'info' : 'error');
        // Kendimiz ayrılmadık (sunucu çıkardı, bağlantı koptu): masaüstündeki gibi "koptu" sesi
        soundCue(reason === DisconnectReason.CLIENT_INITIATED || callEnded ? 'leave' : 'disconnect');
        void this.leave();
      });
  }

  /** Süren kapatma; yenisi bunu bekler */
  private tearingDown: Promise<void> = Promise.resolve();

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lostSoundPlayed = false;
  }

  /**
   * Odayı kapatır, ses oturumunu ve ön plan servisini durdurur. Kapatmalar sırayla yapılır: önceki
   * kapatma (ör. yavaş kapanan oda) yeni katılmadan sonra bitip yeni bağlantının ses oturumunu ve ön
   * plan servisini durdurmasın; servissiz kalan ses arka planda Android tarafından kısıtlanır.
   * @param opts.keepSession Yeniden katılma: yalnızca oda kapatılır, ses oturumu ve ön plan servisi sürer
   */
  private teardown(opts: { keepSession?: boolean } = {}): Promise<void> {
    const room = this.room;
    this.room = null;
    this.channelSounds.cancel();
    this.clearReconnectTimer();
    this.gate.detach();
    const previous = this.tearingDown;
    const next = (async () => {
      await previous;
      if (room) await room.disconnect(true).catch(() => undefined);
      await releaseNoiseFilter();
      if (opts.keepSession) return;
      await AudioSession.stopAudioSession().catch(() => undefined);
      this.audioSessionActive = false;
      try {
        VoiceService.stop();
      } catch {
        // servis zaten kapalı
      }
      this.serviceRunning = false;
    })();
    this.tearingDown = next;
    return next;
  }
}

// LiveKit'in uyarıları sunucu kayıtlarına: telefondaki bağlantı sorunlarının nedenini görmek için
setLogExtension((level, message, context) =>
  reportVoiceLog(level, LogLevel.warn, message, context, useVoice.getState().status !== 'idle'),
);

export const voice = new MobileVoiceClient();

// Ayarlar dışarıdan değişirse (ör. bildirim düğmesi) ekran güncel kalsın diye dışa aç
export { useSettings };
