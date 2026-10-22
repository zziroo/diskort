/**
 * Yayın yakınlaştırma hesabı (saf): görüntüyü saran katmana `translate(x, y) scale(s)` uygulanır
 * (transform-origin sol üst). Kenarlar video içeriğine göre sınırlanır: yakınlaşınca letterbox
 * boşluğu ekrana girmez, içerik alandan küçük kaldığı eksende ortalanır.
 */
export interface Zoom {
  s: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };

/** object-contain ile alana yerleşen içeriğin dikdörtgeni; içerik boyutu bilinmiyorsa tüm alan. */
export function containRect(box: Size, content: Size | null): { x: number; y: number; w: number; h: number } {
  if (!content || content.w <= 0 || content.h <= 0 || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, ...box };
  const k = Math.min(box.w / content.w, box.h / content.h);
  const w = content.w * k;
  const h = content.h * k;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

function clampAxis(t: number, s: number, size: number, start: number, len: number): number {
  const scaled = s * len;
  // İçerik alandan küçükse ortada durur
  if (scaled <= size) return (size - scaled) / 2 - s * start;
  // `+ 0`: -0 yerine 0
  return Math.min(-s * start, Math.max(size - s * (start + len), t)) + 0;
}

/** Kaydırmayı sınırlar: içerik alanı doldurduğu eksende kenardan boşluk çıkmaz. */
export function clampZoom(z: Zoom, box: Size, content: Size | null): Zoom {
  if (z.s <= ZOOM_MIN) return NO_ZOOM;
  const r = containRect(box, content);
  return {
    s: z.s,
    x: clampAxis(z.x, z.s, box.w, r.x, r.w),
    y: clampAxis(z.y, z.s, box.h, r.y, r.h),
  };
}

/** İmlecin altındaki nokta (alan koordinatında px, py) sabit kalacak şekilde ölçeği `next` yapar. */
export function zoomAt(z: Zoom, next: number, px: number, py: number, box: Size, content: Size | null): Zoom {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  // Bire çok yakınsa tam sıfırlanır (kayan nokta artığı kalmasın)
  if (s < 1.01) return NO_ZOOM;
  const k = s / z.s;
  return clampZoom({ s, x: px - (px - z.x) * k, y: py - (py - z.y) * k }, box, content);
}

/** Tekerlek adımını ölçek çarpanına çevirir (fare ve dokunmatik yüzey için sürekli). */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.002);
}

/** Kaydırma (pan): başlangıçtaki dönüşüme sürükleme farkını ekleyip sınırlar. */
export function panBy(start: Zoom, dx: number, dy: number, box: Size, content: Size | null): Zoom {
  return clampZoom({ s: start.s, x: start.x + dx, y: start.y + dy }, box, content);
}
