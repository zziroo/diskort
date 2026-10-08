import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { HotkeyConfig } from '../../../shared/bridge';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '../../../shared/themes';

export type InputMode = 'vad' | 'ptt';
/** 'dpdfnet': DPDFNet-2 48 kHz (yapay zekâ); 'standard': tarayıcının yerleşik engellemesi */
export type NoiseMode = 'dpdfnet' | 'standard' | 'off';
/**
 * Yapay zekâ gürültü engelleyicilerinin (DPDFNet) bastırma sınırı (dB): gürültü en fazla bu kadar kısılır, özgün sesin bir kısmı korunur
 * ve konuşma doğal kalır. 100 = sınırsız (sesi robotikleştirebilir).
 */
export const NOISE_STRENGTHS_DB = [12, 24, 40, 100] as const;
export type NoiseStrengthDb = (typeof NOISE_STRENGTHS_DB)[number];
export const SIDEBAR_WIDTH = { min: 200, default: 240, max: 480 } as const;
export const clampSidebarWidth = (w: number): number =>
  Number.isFinite(w) ? Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w))) : SIDEBAR_WIDTH.default;
const SCREEN_PRESET_IDS = ['720p30', '720p60', '1080p30', '1080p60'] as const;
export type ScreenPresetId = (typeof SCREEN_PRESET_IDS)[number];
const SCREEN_CODEC_IDS = ['h264', 'vp9', 'vp8', 'av1'] as const;
export type ScreenCodec = (typeof SCREEN_CODEC_IDS)[number];
export type ScreenContent = 'motion' | 'detail';
export type { ThemeId } from '../../../shared/themes';

export interface Settings {
  serverUrl: string;

  inputDeviceId: string;
  outputDeviceId: string;
  inputMode: InputMode;
  vadAuto: boolean;
  vadThresholdDb: number;
  pttReleaseMs: number;
  noise: NoiseMode;
  /** Yapay zekâ gürültü engelleme gücü (bastırma sınırı, dB) */
  noiseStrengthDb: NoiseStrengthDb;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioBitrateKbps: number;
  /** Giriş (mikrofon) ses seviyesi çarpanı (0–2); mikrofon zincirinde, eşikten önce uygulanır */
  inputVolume: number;
  /** Çıkış ses seviyesi çarpanı (0–2); herkesin sesine ve yayın seslerine uygulanır */
  outputVolume: number;

  /** Kişi başı ses seviyesi (0–2), yerel susturma ve yayın sesi seviyesi */
  userVolumes: Record<string, number>;
  localMutes: Record<string, boolean>;
  streamVolumes: Record<string, number>;

  screenPreset: ScreenPresetId;
  screenCodec: ScreenCodec;
  screenContent: ScreenContent;
  shareAudio: boolean;

  hotkeys: HotkeyConfig;
  minimizeToTray: boolean;
  openAtLogin: boolean;
  /** Arayüz sesleri: katıl/ayrıl, sustur, sağırlaştır, yayın, biri girdi/çıktı (bkz. lib/sfx.ts) */
  sounds: boolean;
  /** Bahsedilince ve direkt mesaj gelince ses (Rahatsız Etmeyin durumunda çalmaz) */
  notificationSound: boolean;
  /** Bas-konuş tuşuna basınca ve bırakınca kısa ses */
  pttSounds: boolean;
  /** Arayüz teması (bkz. apps/desktop/src/shared/themes.ts; varsayılan Siyah) */
  theme: ThemeId;
  /** Kanal/konuşma listesinin genişliği (px); sohbetle arasındaki çizgi sürüklenerek değişir */
  sidebarWidth: number;

  selfMute: boolean;
  selfDeaf: boolean;
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
}

export const DEFAULT_SERVER_URL = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? 'http://localhost:3000';

const defaults: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputMode: 'vad',
  vadAuto: true,
  vadThresholdDb: -50,
  pttReleaseMs: 150,
  noise: 'dpdfnet',
  noiseStrengthDb: 24,
  echoCancellation: true,
  autoGainControl: true,
  audioBitrateKbps: 64,
  inputVolume: 1,
  outputVolume: 1,
  userVolumes: {},
  localMutes: {},
  streamVolumes: {},
  screenPreset: '1080p60',
  screenCodec: 'h264',
  screenContent: 'motion',
  shareAudio: true,
  hotkeys: { pushToTalk: null, toggleMute: null, toggleDeafen: null },
  minimizeToTray: true,
  openAtLogin: false,
  sounds: true,
  notificationSound: true,
  pttSounds: false,
  theme: DEFAULT_THEME,
  sidebarWidth: SIDEBAR_WIDTH.default,
  selfMute: false,
  selfDeaf: false,
};

/** Giriş ve çıkış ses seviyesinin üst sınırı (%200) */
export const MAX_VOLUME = 2;
const NOISE_MODES: readonly NoiseMode[] = ['dpdfnet', 'standard', 'off'];
const AUDIO_BITRATES_KBPS = [32, 64, 96, 128] as const;

/** Giriş/çıkış ses seviyesini 0–2 (%0–200) aralığına çeker; geçersiz değer 1 olur. */
export function clampVolume(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(MAX_VOLUME, Math.max(0, n));
}

/** Kayıtlı ayarları geçerli değerlere çeker (eski sürümlerden kalan veya bozuk değerler). */
function sanitize(saved: Partial<Settings>): Partial<Settings> {
  const s = { ...saved };
  // RNNoise ve DeepFilterNet 3 kaldırıldı; eski 'rnnoise' / 'deepfilter' seçimi (ve bilinmeyen değer) DPDFNet'e taşınır.
  if (s.noise !== undefined && !NOISE_MODES.includes(s.noise)) s.noise = 'dpdfnet';
  if (s.noiseStrengthDb !== undefined && !(NOISE_STRENGTHS_DB as readonly number[]).includes(s.noiseStrengthDb)) {
    s.noiseStrengthDb = defaults.noiseStrengthDb;
  }
  if (s.audioBitrateKbps !== undefined && !(AUDIO_BITRATES_KBPS as readonly number[]).includes(s.audioBitrateKbps)) {
    const kbps = Number(s.audioBitrateKbps) || defaults.audioBitrateKbps;
    // En yakın seçenek (eşitlikte yüksek olan)
    s.audioBitrateKbps = AUDIO_BITRATES_KBPS.reduce((best, v) => (Math.abs(v - kbps) <= Math.abs(best - kbps) ? v : best));
  }
  for (const key of ['inputVolume', 'outputVolume'] as const) {
    const v = s[key];
    if (v !== undefined) s[key] = clampVolume(v);
  }
  if (s.screenPreset !== undefined && !SCREEN_PRESET_IDS.includes(s.screenPreset)) s.screenPreset = defaults.screenPreset;
  if (s.sidebarWidth !== undefined) s.sidebarWidth = clampSidebarWidth(s.sidebarWidth);
  if (s.theme !== undefined && !isThemeId(s.theme)) s.theme = defaults.theme;
  if (s.screenCodec !== undefined && !SCREEN_CODEC_IDS.includes(s.screenCodec)) s.screenCodec = defaults.screenCodec;
  return s;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...defaults,
      set: (patch) => set(patch),
    }),
    {
      name: 'diskort-settings',
      version: 12,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _set, ...rest }) => rest,
      // Sürüm 1 → 2: gürültü engelleme RNNoise → DeepFilterNet 3 (sanitize içinde)
      // Sürüm 2 → 3: DeepFilterNet sınırsız bastırıyordu (100 dB, robotik ses); herkes yeni varsayılana (Dengeli) geçer.
      // Sürüm 3 → 4: DeepFilterNet çıkan seste çatırtı yapıyordu (karesi ses iş parçacığının süresini aşabiliyor);
      // düzeltilene kadar herkes standart gürültü engellemeye geçer, isteyen yeniden seçebilir.
      // Sürüm 4 → 5: DPDFNet varsayılan oldu (kullanıcılar Krisp'e yakın buldu); kapalı olanlar hariç herkes DPDFNet'e geçer.
      // Sürüm 5 → 6: Siyah (OLED) varsayılan tema oldu; eski varsayılandaki (koyu) herkes siyaha geçer
      // (şimdiye dek yalnızca koyu ve siyah vardı), isteyen Görünüm'den geri seçebilir.
      // Sürüm 6 → 7 → 8: Otomatik yayın kalitesi denendi ve kaldırıldı; eski varsayılan (1080p30) ya da Otomatik'teki
      // herkes yeni varsayılan 1080p60'a geçer, başka bir kaliteyi bilerek seçmiş olanlar olduğu gibi kalır.
      // Sürüm 8 → 9: Yumuşak ses paketi eklendi ve varsayılan oldu (katılma sesi sert/takılır bulundu); herkes
      // Yumuşak pakete geçer, isteyen Ses → Ses efektleri → Ses paketi'nden Klasik'e dönebilir.
      // Sürüm 9 → 10: ses paketleri kaldırıldı, tek (yumuşak) ses takımı kaldı; kayıtlı soundPack ayarı silinir; ses efekti seviyesi
      // ayarı da kaldırıldı (sesler tek, sabit seviyede).
      migrate: (saved, version) => {
        const s = { ...(saved as Partial<Settings>) };
        if (version < 3) s.noiseStrengthDb = defaults.noiseStrengthDb;
        const noise = s.noise as string | undefined;
        if (version < 4 && noise === 'deepfilter') s.noise = 'standard';
        if (version < 5 && (noise === undefined || noise === 'standard' || noise === 'deepfilter')) s.noise = 'dpdfnet';
        if (version < 6 && (s.theme === undefined || s.theme === 'dark')) s.theme = 'black';
        if (version < 7 && (s.screenPreset === undefined || s.screenPreset === '1080p30')) s.screenPreset = '1080p60';
        if (version < 8 && (s.screenPreset as string | undefined) === 'auto') s.screenPreset = '1080p60';
        // Artık olmayan ayar: türde yok, kayıtta kalmasın
        if (version < 10) {
          delete (s as Record<string, unknown>).soundPack;
          delete (s as Record<string, unknown>).sfxVolume;
        }
        // 1440p60 kaldırıldı (sunucuya fazla ağır geldi); seçmiş olanlar en yüksek seçenek olan 1080p60'a geçer
        if (version < 11 && (s.screenPreset as string | undefined) === '1440p60') s.screenPreset = '1080p60';
        // Bağlantı önizlemeleri artık hep gösterilir (ayar kaldırıldı)
        if (version < 12) delete (s as Record<string, unknown>).linkPreviews;
        return s as Settings;
      },
      merge: (saved, current) => ({ ...current, ...sanitize((saved ?? {}) as Partial<Settings>) }),
    },
  ),
);

export const getSettings = (): SettingsStore => useSettings.getState();
