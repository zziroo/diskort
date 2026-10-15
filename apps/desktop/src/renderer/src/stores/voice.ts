import { create } from 'zustand';
import type { NoiseFallbackState, NoiseNotice } from '../features/voice/noiseFallback';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type ConnectionQualityLabel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface MicLevel {
  db: number;
  threshold: number;
  open: boolean;
}

export interface RemoteStream {
  hasAudio: boolean;
}

interface VoiceStore {
  channelId: string | null;
  status: VoiceStatus;
  /** Konuşan kullanıcılar (userId → true) */
  speaking: Record<string, true>;
  /** Giriş sesi şu an çalan kullanıcı (avatarında konuşma halkası yerine giriş sesi halkası yanar); yoksa null */
  introPlayingUserId: string | null;
  pingMs: number | null;
  quality: ConnectionQualityLabel;
  /** Bulunduğun kanalda yayın yapan kullanıcılar */
  streams: Record<string, RemoteStream>;
  /** İzlediğin yayınlar */
  watching: Record<string, true>;
  /** Yayın izlerken büyük gösterilen kullanıcı */
  focusedStream: string | null;
  /** Abone olunan track'ler değiştikçe artar (video öğelerini yeniden bağlamak için) */
  tracksVersion: number;
  sharing: boolean;
  /**
   * Kendi yayınının önizlemesi yine de gösterilsin mi. Varsayılan kapalı: kaynak tasarrufu ve tüm ekran
   * paylaşılırken sonsuz ayna görüntüsü olmasın diye önizleme duraklatılır. Her yeni yayında sıfırlanır.
   */
  selfPreview: boolean;
  shareHasAudio: boolean;
  /** Yayının başlarken seçilen kalitesi, ör. "1080p 60 FPS" */
  shareQuality: string | null;
  /** Paylaşılan pencerenin uygulama simgesi (data: URL), yoksa null */
  shareIcon: string | null;
  pttActive: boolean;
  /** Kanalda konuşma izni var mı (yetki ya da sunucuda susturma; LiveKit izninden gelir) */
  micAllowed: boolean;
  micLevel: MicLevel;
  /** Ayarlarda mikrofon testi sürüyor (görüşmedeyken odaya sessizlik gider, susturulmuş görünürsün) */
  micTesting: boolean;
  /** Görüşmede seçili gürültü engelleyici yerine başkası çalışıyor (işlemci yetmedi vb.); yoksa null */
  noiseFallback: NoiseFallbackState | null;
  /** Düşüş bildirimi (her düşüşte bir kez; kapatılınca ya da model geri gelince null) */
  noiseNotice: NoiseNotice | null;
  error: string | null;
}

export const useVoice = create<VoiceStore>()(() => ({
  channelId: null,
  status: 'idle',
  speaking: {},
  introPlayingUserId: null,
  pingMs: null,
  quality: 'unknown',
  streams: {},
  watching: {},
  focusedStream: null,
  tracksVersion: 0,
  sharing: false,
  selfPreview: false,
  shareHasAudio: false,
  shareQuality: null,
  shareIcon: null,
  pttActive: false,
  micAllowed: true,
  micLevel: { db: -100, threshold: -50, open: false },
  micTesting: false,
  noiseFallback: null,
  noiseNotice: null,
  error: null,
}));

export const setVoice = useVoice.setState;
