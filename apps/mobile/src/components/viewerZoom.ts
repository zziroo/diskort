/**
 * Tam ekran görüntüleyici yakınlaştırma hesabı (saf, React Native'siz: birim testi için ayrı).
 * Dönüşüm `translate(x, y) scale(s)`, ölçek kabın ortasına göre; noktalar kabın ortasına göre verilir.
 */
export type Size = { width: number; height: number };
export type Zoom = { s: number; x: number; y: number };
export type Point = { x: number; y: number };

export const MAX_ZOOM = 4;

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** İçeriğin kaba sığdırılmış (contain) boyutu; içerik boyutu bilinmiyorsa kabın kendisi */
export function fitSize(box: Size, content: Size | null | undefined): Size {
  if (!content || content.width <= 0 || content.height <= 0) return box;
  const k = Math.min(box.width / content.width, box.height / content.height);
  return { width: content.width * k, height: content.height * k };
}

/**
 * `s` ölçekte en çok ne kadar kaydırılabilir: büyütülmüş içerik kaptan taşan kadar (taşmıyorsa 0,
 * ortada durur). İçerik kabı dolduruyorsa `(s - 1) * kap / 2`.
 */
export function panLimits(s: number, box: Size, content: Size): [number, number] {
  return [Math.max(0, (s * content.width - box.width) / 2), Math.max(0, (s * content.height - box.height) / 2)];
}

/**
 * Ölçeği `s` yapar; `start` dönüşümündeyken `focus` altında kalan içerik noktası `to` noktasına gelir
 * (iki parmakla yakınlaştırmada ilk ve şimdiki parmak ortası; çift dokunuşta ikisi de dokunulan nokta).
 */
export function zoomAround(start: Zoom, s: number, focus: Point, to: Point): Zoom {
  const k = s / start.s;
  return { s, x: to.x - (focus.x - start.x) * k, y: to.y - (focus.y - start.y) * k };
}

/** Kaydırmayı sınırlar */
export function clampPan(z: Zoom, box: Size, content: Size): Zoom {
  const [bx, by] = panLimits(z.s, box, content);
  // `+ 0`: -0 yerine 0
  return { s: z.s, x: clamp(z.x, -bx, bx) + 0, y: clamp(z.y, -by, by) + 0 };
}
