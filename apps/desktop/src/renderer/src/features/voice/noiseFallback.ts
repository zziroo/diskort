// Seçili gürültü engelleyici çalışmadığında arayüzde gösterilen durum ve metinler.
import type { Denoiser, FailureReason } from './denoiserHealth';

/** Gerçekte çalışan: bir model ya da standart (tarayıcının) engelleme */
export type EffectiveNoise = Denoiser | 'standard';

/** Seçili model yerine başka bir engelleme çalışıyor (görüşmedeyken) */
export interface NoiseFallbackState {
  from: Denoiser;
  to: EffectiveNoise;
  reason: FailureReason;
  transient: boolean;
  at: number;
  /** Seçili modelin yeniden deneneceği zaman (kalıcı hatada null) */
  retryAt: number | null;
}

/** Başlık çubuğundaki bir kez gösterilen düşüş bildirimi */
export interface NoiseNotice {
  id: number;
  text: string;
}

export const EFFECTIVE_NOISE_LABELS: Record<EffectiveNoise, string> = {
  dpdfnet: 'DPDFNet',
  standard: 'Standart',
};

/** "DPDFNet'e", "standarda" (bildirim cümlesi için) */
const DATIVE: Record<EffectiveNoise, string> = {
  dpdfnet: 'DPDFNet’e',
  standard: 'standarda',
};

export function reasonLabel(reason: FailureReason): string {
  return reason === 'error' ? 'yüklenemedi' : reason === 'timeout' ? 'kurulamadı' : 'işlemci yoğun';
}

/** Ayarlarda ve menüde: "DPDFNet → Standart (işlemci yoğun)" */
export function fallbackLabel(f: NoiseFallbackState): string {
  return `${EFFECTIVE_NOISE_LABELS[f.from]} → ${EFFECTIVE_NOISE_LABELS[f.to]} (${reasonLabel(f.reason)})`;
}

/** Bildirim metni */
export function fallbackNoticeText(f: NoiseFallbackState): string {
  if (!f.transient) {
    return `${EFFECTIVE_NOISE_LABELS[f.from]} bu oturumda çalıştırılamadı (${reasonLabel(f.reason)}); gürültü engelleme ${DATIVE[f.to]} düşürüldü.`;
  }
  const retry = f.to === 'standard' ? `${EFFECTIVE_NOISE_LABELS[f.from]} yeniden denenecek` : 'yeniden denenecek';
  // Bekleme 1 dk'dan başlayıp 10 dk'ya kadar uzar (denoiserHealth): süre metne yazılır
  const minutes = f.retryAt === null ? null : Math.max(1, Math.round((f.retryAt - f.at) / 60_000));
  const when = minutes === null ? 'Daha sonra' : `${minutes} dk sonra`;
  return `Gürültü engelleme geçici olarak ${DATIVE[f.to]} düşürüldü (${reasonLabel(f.reason)}). ${when} ${retry}.`;
}
