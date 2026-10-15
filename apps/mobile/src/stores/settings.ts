import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const DEFAULT_SERVER_URL = 'https://diskort.ziroo.net';

/**
 * Gürültü engelleme: DPDFNet (telefonda çalışan yapay zekâ modeli; masaüstündekiyle aynı), WebRTC'nin
 * standart engelleyicisi ya da kapalı. DPDFNet'i desteklemeyen APK'larda (yerel modül yok) standart kullanılır.
 */
export type NoiseMode = 'dpdfnet' | 'standard' | 'off';
/** DPDFNet'in bastırma sınırı (dB); 100 = sınırsız. Masaüstündeki seçeneklerle aynı. */
export type NoiseStrengthDb = 12 | 24 | 40 | 100;

interface MobileSettings {
  serverUrl: string;
  /** Sesli sohbette hoparlör (true) ya da ahize (false); kulaklık/Bluetooth takılıysa o kullanılır */
  speaker: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Kişi başı ses seviyesi ve izlenen yayının ses seviyesi (0–2); yalnızca %100'den farklı olanlar tutulur */
  userVolumes: Record<string, number>;
  streamVolumes: Record<string, number>;
  /** Yayın sesi sessize alınan yayıncılar (seviye korunur; açınca ona dönülür) */
  streamMuted: Record<string, true>;
  /** Mikrofon işleme (WebRTC ve telefonun kendi ses işlemcisi); sesli sohbete katılırken uygulanır */
  noiseMode: NoiseMode;
  /** DPDFNet'in gücü; sesli sohbetteyken de anında uygulanır */
  noiseStrengthDb: NoiseStrengthDb;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Ses algılama: konuşmadığın anlarda mikrofon sessize alınır (arka plan sesi gitmez) */
  voiceActivity: boolean;
  /** Eşik ortam gürültüsüne göre kendiliğinden belirlenir */
  vadAuto: boolean;
  /** Elle belirlenen eşik (dBFS) */
  vadThresholdDb: number;
  /** Ses düğmelerine ve yönetim işlemlerine basınca kısa titreşim (bkz. haptics.ts) */
  haptics: boolean;
  /** Sesli sohbet sesleri: katıl/ayrıl, sustur, sağırlaştır, yayın, biri girdi/çıktı (bkz. sounds.ts) */
  sounds: boolean;
  /**
   * Giriş seslerinin seviyesi (0..1): kanala girenin kendi yüklediği kısa ses (bkz. sounds.ts playIntroSound).
   * 0 = kapalı, onun yerine genel katılma sesi çalar.
   */
  introSoundVolume: number;
  /** Uygulama açıkken bahsedilince ve direkt mesaj gelince ses (Rahatsız Etmeyin durumunda çalmaz) */
  notificationSound: boolean;
  set: (patch: Partial<Omit<MobileSettings, 'set'>>) => void;
}

export const useSettings = create<MobileSettings>()(
  persist(
    (set) => ({
      serverUrl: DEFAULT_SERVER_URL,
      speaker: true,
      selfMute: false,
      selfDeaf: false,
      userVolumes: {},
      streamVolumes: {},
      streamMuted: {},
      noiseMode: 'dpdfnet',
      noiseStrengthDb: 24,
      echoCancellation: true,
      autoGainControl: true,
      voiceActivity: true,
      vadAuto: true,
      vadThresholdDb: -50,
      haptics: true,
      sounds: true,
      introSoundVolume: 1,
      notificationSound: true,
      set: (patch) => set(patch),
    }),
    {
      name: 'diskort-settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ set: _set, ...rest }) => rest,
      // Sürüm 0 → 1: gürültü engelleme açık/kapalı yerine türü (DPDFNet/standart/kapalı). Açık olan herkes
      // DPDFNet'e geçer (destek yoksa standart çalışır).
      // Sürüm 1 → 2: ses paketleri kaldırıldı (tek ses takımı); kayıtlı soundPack ayarı silinir; ses efekti
      // seviyesi ayarı da kaldırıldı (sesler tek, sabit seviyede).
      // Sürüm 2 → 3: bağlantı önizlemesi ayarı kaldırıldı (önizlemeler hep gösterilir); kayıtlı değer silinir.
      version: 3,
      migrate: (persisted, version) => {
        let state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 1) {
          const { noiseSuppression, ...rest } = state;
          state = { ...rest, noiseMode: noiseSuppression === false ? 'off' : 'dpdfnet' };
        }
        if (version < 2) {
          const { soundPack: _soundPack, sfxVolume: _sfxVolume, ...rest } = state;
          state = rest;
        }
        if (version < 3) {
          const { linkPreviews: _linkPreviews, ...rest } = state;
          state = rest;
        }
        return state as unknown as MobileSettings;
      },
    },
  ),
);

export const getSettings = () => useSettings.getState();
