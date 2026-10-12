import { NativeModule, requireOptionalNativeModule } from 'expo';

/** DPDFNet'in anlık durumu ve son 2 saniyenin ölçümleri */
export interface NoiseFilterStatus {
  /** Model yüklü, WebRTC'ye takılı ve devre dışı kalmadı */
  active: boolean;
  /** Son 1 saniyede kare işlendi (mikrofon açık, 48 kHz) */
  processing: boolean;
  /** Çalışmıyorsa nedeni (ör. "yavaş: kare başına 7,1 ms") */
  reason: string | null;
  /** WebRTC'nin ses işleme hızı (Hz); model yalnızca 48000'de çalışır */
  sampleRate: number;
  /** Isınmada ölçülen kare başına süre (ms) */
  warmupMs: number;
  // "?" alanlar eski APK'larda yoktur (kablosuz güncellemeyle yeni JS almış olanlar)
  /** Isınmada kare süresinin modele (ONNX Runtime) düşen kısmı; kalanı STFT/ISTFT */
  warmupModelMs?: number | null;
  /** Isınmanın ilk yarısında kare süresi (ikinci yarıdan çok yüksekse işlemci frekansı yükseliyordu) */
  warmupFirstMs?: number | null;
  /** Isınmanın ikinci yarısındaki en uzun kare (ms) */
  warmupMaxMs?: number | null;
  /** Isınmanın bittiği çekirdek, ör. "7 (2600 MHz)" */
  warmupCore?: string | null;
  /** Modeli çalıştıran ONNX Runtime yürütücüsü: "CPU" ya da "XNNPACK" */
  provider?: string | null;
  /** Android'in başarım ipucu (ADPF) açıldı mı (Android 12+; üretici desteklemiyorsa false) */
  hint?: boolean | null;
  avgMs: number | null;
  /** Ortalamanın modele düşen kısmı (ms) */
  modelMs?: number | null;
  maxMs: number | null;
  /** Modelin iş parçacığının modelle geçirdiği zaman oranı (0–1) */
  load: number | null;
  frames: number;
  /** Son pencerede 10 ms'yi aşan kareler (30 ms tamponla sesi bozmaz) */
  overHop: number;
  /** Son pencerede tampon payını da aşıp gürültü engellemesiz geçen kareler; eski APK'larda yoktur */
  late?: number;
  /** Çalışmıyorsa yeniden denemeye kalan süre (ms; null: denenmeyecek ya da bilinmiyor); eski APK'larda yoktur */
  retryInMs?: number | null;
  /** Modelin iş parçacığının son çalıştığı çekirdek, ör. "2 (1800 MHz)" */
  audioCore?: string | null;
  /** Çekirdek kümeleri, ör. "6×2000 + 2×2600 MHz" */
  cpu?: string | null;
  /** Yonga (Android 12+: üretici ve model; öncesi Build.HARDWARE) */
  soc?: string | null;
}

/** Telefonun ısı durumu (Android PowerManager) */
export interface ThermalInfo {
  /** THERMAL_STATUS_*: 0 yok, 1 hafif, 2 orta, 3 ciddi, 4 kritik, 5 acil, 6 kapanıyor; Android 10 öncesinde -1 */
  status: number;
  /** Isınma payı (1,0 = "ciddi" eşiği); Android 11 öncesinde ya da ölçülemezse null */
  headroom: number | null;
}

export type NoiseFilterEvents = {
  /** retryInMs: yeniden denemeye kalan süre (ms; null ya da eski APK'da yok: denenmez) */
  onBypass: (params: { reason: string; retryInMs?: number | null }) => void;
};

declare class NoiseFilterModule extends NativeModule<NoiseFilterEvents> {
  isSupported(): boolean;
  configure(enabled: boolean, attenLimitDb: number): Promise<NoiseFilterStatus>;
  setAttenLimit(db: number): void;
  getStats(): NoiseFilterStatus;
  /** Eski APK'larda yoktur (çağırmadan önce varlığı denetlenmeli) */
  getThermal?: () => ThermalInfo;
  /** Yayın izleniyor ya da paylaşılıyor (o sırada yavaşlık kalıcı kaydedilmez); eski APK'larda yoktur */
  setVideoActive?: (active: boolean) => void;
}

/** Eski APK'larda (kablosuz güncellemeyle yeni JS almış) yerel modül yoktur: null */
export default requireOptionalNativeModule<NoiseFilterModule>('DiskortNoiseFilter');
