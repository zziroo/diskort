import { describe, expect, it } from 'vitest';
import {
  clampPipWidth,
  clampPosition,
  cornerPosition,
  isPipCorner,
  nearestCorner,
  PIP_DEFAULT_WIDTH,
  PIP_MIN_WIDTH,
  pipSize,
  pipTarget,
  resizeWidth,
} from '../src/renderer/src/components/stage/pip.js';

const box = { w: 1200, h: 800 };
const pip = { w: 320, h: 180 };

describe('yüzen yayın penceresi', () => {
  it('köşe konumu kenar boşluğuyla hesaplanır', () => {
    expect(cornerPosition('top-left', box, pip)).toEqual({ x: 16, y: 16 });
    expect(cornerPosition('bottom-right', box, pip)).toEqual({ x: 1200 - 320 - 16, y: 800 - 180 - 16 });
    expect(cornerPosition('top-right', box, pip)).toEqual({ x: 864, y: 16 });
    // Kutu pencereden küçükse sol/üst kenara yaslanır
    expect(cornerPosition('bottom-right', { w: 200, h: 100 }, pip)).toEqual({ x: 0, y: 0 });
  });

  it('en yakın köşe pencerenin merkezine göre seçilir', () => {
    expect(nearestCorner({ x: 10, y: 10 }, box, pip)).toBe('top-left');
    expect(nearestCorner({ x: 700, y: 50 }, box, pip)).toBe('top-right');
    expect(nearestCorner({ x: 100, y: 500 }, box, pip)).toBe('bottom-left');
    expect(nearestCorner({ x: 800, y: 600 }, box, pip)).toBe('bottom-right');
    // Merkez tam ortada: sağ alt
    expect(nearestCorner({ x: 440, y: 310 }, box, pip)).toBe('bottom-right');
  });

  it('sürüklenen konum kutunun içine kırpılır', () => {
    expect(clampPosition({ x: -50, y: -20 }, box, pip)).toEqual({ x: 0, y: 0 });
    expect(clampPosition({ x: 5000, y: 5000 }, box, pip)).toEqual({ x: 880, y: 620 });
    expect(clampPosition({ x: 300, y: 200 }, box, pip)).toEqual({ x: 300, y: 200 });
  });

  it('genişlik alt ve üst sınıra kırpılır, oran 16:9', () => {
    expect(clampPipWidth(100, box)).toBe(PIP_MIN_WIDTH);
    // Üst sınır: genişliğin %85'i (1020) ile yüksekliğin %85'inin 16:9 karşılığından (1208.9) küçüğü
    expect(clampPipWidth(5000, box)).toBe(1020);
    // Basık kutuda yükseklik sınırlar
    expect(clampPipWidth(5000, { w: 1600, h: 400 })).toBe(Math.round(400 * 0.85 * (16 / 9)));
    expect(clampPipWidth(Number.NaN, box)).toBe(PIP_DEFAULT_WIDTH);
    // Çok dar kutuda alt sınır da küçülür
    expect(clampPipWidth(300, { w: 200, h: 400 })).toBe(168);
    expect(pipSize(480, box)).toEqual({ w: 480, h: 270 });
  });

  it('boyutlandırma köşeden uzağa çekilince büyütür', () => {
    // Sağ alttaki pencerenin sol kenarı sola çekilir: büyür
    expect(resizeWidth(320, -80, 0, 'bottom-right', 'x')).toBe(400);
    // Sol üstteki pencerenin sağ kenarı sola çekilir: küçülür
    expect(resizeWidth(320, -80, 0, 'top-left', 'x')).toBe(240);
    // Alt kenar 90 px aşağı: genişlik 160 artar
    expect(resizeWidth(320, 0, 90, 'top-right', 'y')).toBe(480);
    // Köşe tutamacında daha çok değiştiren eksen geçer
    expect(resizeWidth(320, -20, -90, 'bottom-right', 'xy')).toBe(480);
    expect(resizeWidth(320, -200, -9, 'bottom-right', 'xy')).toBe(520);
  });

  it('gösterilecek yayın: büyütülmüş olan, yoksa izlenenlerin süreni', () => {
    const streams = { a: {}, b: {} };
    expect(pipTarget({ focusedStream: 'b', watching: { a: true, b: true }, streams })).toBe('b');
    expect(pipTarget({ focusedStream: null, watching: { a: true, b: true }, streams })).toBe('a');
    // Yayını biten izlenen atlanır
    expect(pipTarget({ focusedStream: 'c', watching: { c: true, b: true }, streams })).toBe('b');
    expect(pipTarget({ focusedStream: null, watching: {}, streams })).toBeNull();
  });

  it('köşe adı doğrulanır', () => {
    expect(isPipCorner('top-left')).toBe(true);
    expect(isPipCorner('middle')).toBe(false);
  });
});
