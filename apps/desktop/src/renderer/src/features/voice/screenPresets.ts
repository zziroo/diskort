import { VideoPreset } from 'livekit-client';
import type { ScreenCodec, ScreenPresetId } from '../../stores/settings';

export interface ScreenPreset {
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Üst sınır bit hızı (bps); bant yetmezse WebRTC tıkanıklık denetimi bunun altında kalır */
  bitrate: number;
}

// Akıcılık ve bit hızı öncelikli sabit kaliteler; yayın boyunca hiçbir ayar değişmez (bant yetmezse WebRTC kendi
// içinde düşürür). 1080p60 · 12 Mbps kare başına eski 1080p30 · 6 Mbps kadar veri demek (kullanıcılar onu iyi buldu);
// 720p60 · 6 Mbps ve 720p30 · 3 Mbps aynı kare başı veriyle (720p'de ~100 kbit/kare). 720p30 zayıf yükleme hattı içindir.
// Sunucu çıkışı ≈ bit hızı × izleyici (aylık ~5 TB kota): 1080p60 izleyici başına saatte en çok ~5,4 GB. 1440p60
// (18 Mbps) sunucuya fazla ağır geldiği için kaldırıldı; en yüksek seçenek 1080p60.
// Ekran kartı kodlayıcısında ayrıca bir alt katman (simulcast) yayımlanır, bkz. screenShareLowLayer; yazılım
// kodlayıcıda tek katman olduğundan izleyicinin indirme hızı bunu taşımalı, taşımazsa LiveKit o izleyicide yayını
// duraklatır.
export const SCREEN_PRESETS: Record<ScreenPresetId, ScreenPreset> = {
  '720p30': { label: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  '720p60': { label: '720p · 60 FPS', width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
  '1080p30': { label: '1080p · 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  '1080p60': { label: '1080p · 60 FPS (önerilen)', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
};

/**
 * Simulcast alt katmanı: telefondan ya da zayıf hattan izleyenler ve küçük izleme öğeleri bunu alır (LiveKit
 * izleyicinin öğe boyutuna ve bant genişliğine göre seçer). Yakalanan görüntünün kısa kenarına göre seçilir
 * (pencere paylaşımında kare ön ayardan küçük olabilir): 900 piksel ve üstüyse 720p30 · 2,5 Mbps, değilse 360p30 ·
 * 1 Mbps (üst katmana çok yakın bir alt katman boşa kodlanmasın); 480 pikselden küçük kare için alt katman yok (null). Öncelik (priority) alt katmanda: Chromium göndericinin önceliğini
 * yalnızca ilk kodlamadan (en düşük katman) okur, LiveKit de üst katmanın önceliğini oraya yazmıyor.
 */
export function screenShareLowLayer(captured: { width?: number; height?: number }, preset: ScreenPreset): VideoPreset | null {
  const short = Math.min(captured.width ?? preset.width, captured.height ?? preset.height);
  if (short >= 900) return new VideoPreset(1280, 720, 2_500_000, Math.min(30, preset.fps), 'high');
  if (short >= 480) return new VideoPreset(640, 360, 1_000_000, Math.min(30, preset.fps), 'high');
  return null;
}

// Donanım kodlaması (ekran kartı): H.264 hemen her kartta; AV1 yeni kartlarda (NVIDIA RTX 40+, AMD RX 7000+,
// Intel Arc). VP8/VP9 NVIDIA ve AMD'de her zaman işlemcide kodlanır. Bkz. hardwareEncoder.ts.
export const SCREEN_CODECS: Record<ScreenCodec, string> = {
  h264: 'H.264 (önerilen; ekran kartı varsa onunla kodlanır)',
  vp9: 'VP9 (işlemciyle kodlanır, daha fazla CPU)',
  vp8: 'VP8 (işlemciyle kodlanır, en uyumlu)',
  av1: 'AV1 (deneysel; yeni ekran kartlarında donanımla, izleyiciye daha ağır)',
};
