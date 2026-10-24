/**
 * Yüzen yayın penceresinin (StreamPip) konum ve boyut hesabı (saf; test: test/streamPip.test.ts). Pencere
 * kutunun (ana içerik alanı) dört köşesinden birine yapışır; sürüklerken serbest konum kutunun içine
 * kırpılır, bırakınca en yakın köşe seçilir. Konum köşe, boyut genişlik olarak tutulur (oran hep 16:9) ki
 * pencere yeniden boyutlanınca aynı köşede kalsın ve sığmayan boyut kırpılsın.
 */

export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PipSize {
  w: number;
  h: number;
}

export interface PipPoint {
  x: number;
  y: number;
}

/** Boyutlandırma tutamacı: yalnız yatay kenar, yalnız dikey kenar ya da köşe */
export type PipHandle = 'x' | 'y' | 'xy';

export const PIP_CORNERS: readonly PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const DEFAULT_PIP_CORNER: PipCorner = 'bottom-right';
/** Köşedeki pencerenin kenarlara uzaklığı (px) */
export const PIP_MARGIN = 16;
/** Varsayılan ve en küçük genişlik (px) */
export const PIP_DEFAULT_WIDTH = 320;
export const PIP_MIN_WIDTH = 240;
/** Pencere kutunun en fazla bu kadarını kaplar (genişlikte ve yükseklikte) */
export const PIP_MAX_FRACTION = 0.85;
const RATIO = 16 / 9;

export const isPipCorner = (v: unknown): v is PipCorner => PIP_CORNERS.includes(v as PipCorner);

/**
 * Genişliği kutuya göre kırpar: en az 240 px, en fazla kutunun %85'i (yükseklik de %85'e ve kenar
 * boşluklarıyla kutuya sığar). Kutu çok darsa alt sınır da küçülür; geçersiz değer varsayılana döner.
 */
export function clampPipWidth(width: number, box: PipSize, margin = PIP_MARGIN): number {
  const w = Number.isFinite(width) ? width : PIP_DEFAULT_WIDTH;
  const max = Math.max(
    0,
    Math.min(
      box.w * PIP_MAX_FRACTION,
      box.h * PIP_MAX_FRACTION * RATIO,
      box.w - 2 * margin,
      (box.h - 2 * margin) * RATIO,
    ),
  );
  return Math.round(Math.max(Math.min(PIP_MIN_WIDTH, max), Math.min(max, w)));
}

/** İstenen genişlikten kutuya sığan 16:9 pencere ölçüsü. */
export function pipSize(width: number, box: PipSize, margin = PIP_MARGIN): PipSize {
  const w = clampPipWidth(width, box, margin);
  return { w, h: Math.round(w / RATIO) };
}

/** Köşedeki pencerenin sol üst noktası (kutu pencereden küçükse sol/üst kenara yaslanır). */
export function cornerPosition(corner: PipCorner, box: PipSize, pip: PipSize, margin = PIP_MARGIN): PipPoint {
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  return {
    x: Math.max(0, right ? box.w - pip.w - margin : margin),
    y: Math.max(0, bottom ? box.h - pip.h - margin : margin),
  };
}

/** Sürüklenen pencereyi kutunun içinde tutar (kenar boşluğu olmadan; kutu küçükse sol/üst kenara). */
export function clampPosition(pos: PipPoint, box: PipSize, pip: PipSize): PipPoint {
  return {
    x: Math.max(0, Math.min(box.w - pip.w, pos.x)),
    y: Math.max(0, Math.min(box.h - pip.h, pos.y)),
  };
}

/** Pencerenin merkezi kutunun hangi çeyreğindeyse o köşe (tam ortada sağ/alt kazanır). */
export function nearestCorner(pos: PipPoint, box: PipSize, pip: PipSize): PipCorner {
  const right = pos.x + pip.w / 2 >= box.w / 2;
  const bottom = pos.y + pip.h / 2 >= box.h / 2;
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
}

/**
 * Boyutlandırma: tutamaçlar pencerenin yapıştığı köşenin karşı kenarlarındadır (sağ alttaysa sol ve üst
 * kenar), yapışılan köşe yerinde kalır. Tutamaç dışarı (köşeden uzağa) çekilince pencere büyür. Köşe
 * tutamacında iki eksenden hangisi daha çok değiştirdiyse o geçer. Sonuç kırpılmamış genişliktir.
 */
export function resizeWidth(startWidth: number, dx: number, dy: number, corner: PipCorner, handle: PipHandle): number {
  const fromX = corner.endsWith('right') ? -dx : dx;
  const fromY = (corner.startsWith('bottom') ? -dy : dy) * RATIO;
  const delta = handle === 'x' ? fromX : handle === 'y' ? fromY : Math.abs(fromX) >= Math.abs(fromY) ? fromX : fromY;
  return startWidth + delta;
}

/** Yüzen pencerede gösterilecek yayın: büyütülmüş olan, yoksa izlenenlerin ilki (yayını süren). */
export function pipTarget(s: {
  focusedStream: string | null;
  watching: Record<string, true>;
  streams: Record<string, unknown>;
}): string | null {
  const live = (id: string): boolean => Boolean(s.watching[id] && s.streams[id]);
  if (s.focusedStream && live(s.focusedStream)) return s.focusedStream;
  return Object.keys(s.watching).find(live) ?? null;
}
