import { describe, expect, it } from 'vitest';
import {
  clampPipWidth,
  clampPosition,
  cornerPosition,
  estimateVelocity,
  isPipCorner,
  PIP_MAX_SPEED,
  nearestCorner,
  PIP_DEFAULT_WIDTH,
  PIP_MIN_WIDTH,
  pipSize,
  pipTarget,
  projectFling,
  resizeWidth,
  snapSpring,
  springAt,
  springSettled,
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

describe('yüzen pencereyi savurma ve köşeye oturma', () => {
  const at = (t: number, x: number, y = 0) => ({ t, x, y });

  it('bırakma hızı son ~100 ms örneklerinden hesaplanır', () => {
    // 500 ms önceki örnek pencerenin dışında kalır; son 100 ms'de 150 px sağa
    const v = estimateVelocity([at(0, -400), at(400, 0), at(450, 75), at(500, 150)], 505);
    expect(v.x).toBeCloseTo(1.5);
    expect(v.y).toBe(0);
  });

  it('imleç bırakmadan önce durduysa ya da tek örnek varsa hız sıfırdır', () => {
    expect(estimateVelocity([at(0, 0), at(50, 100)], 300)).toEqual({ x: 0, y: 0 });
    expect(estimateVelocity([at(0, 0)], 0)).toEqual({ x: 0, y: 0 });
    expect(estimateVelocity([], 0)).toEqual({ x: 0, y: 0 });
  });

  it('sert savuruşun hızı kırpılır', () => {
    const v = estimateVelocity([at(0, 0), at(20, 1000)], 20);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(PIP_MAX_SPEED);
  });

  it('savuruş izdüşümüyle karşı köşe seçilebilir, hızsız bırakış yerinde kalır', () => {
    const pos = { x: 300, y: 500 }; // sol yarıda, alt yarıda
    expect(nearestCorner(projectFling(pos, { x: 0, y: 0 }), box, pip)).toBe('bottom-left');
    // Sağa hızlı savuruş (1,5 px/ms) sağ alt köşeye gönderir
    expect(nearestCorner(projectFling(pos, { x: 1.5, y: 0 }), box, pip)).toBe('bottom-right');
    // Yavaş kayma (0,1 px/ms ≈ 50 px) köşeyi değiştirmez
    expect(nearestCorner(projectFling(pos, { x: 0.1, y: 0 }), box, pip)).toBe('bottom-left');
  });

  it('yay başlangıçta yerinde ve verilen hızda, sonunda hedefte durur', () => {
    const spring = snapSpring(400);
    const start = springAt(0, 0, 400, 0.8, spring);
    expect(start.value).toBeCloseTo(0);
    expect(start.velocity).toBeCloseTo(0.8);
    const end = springAt(2000, 0, 400, 0.8, spring);
    expect(springSettled(end, 400)).toBe(true);
  });

  it('yay çok az aşar (kenar boşluğundan az) ve hızsız bırakışta aşma ihmal edilebilir', () => {
    for (const [distance, v0] of [
      [900, 0],
      [900, PIP_MAX_SPEED],
      [200, 2],
    ] as const) {
      const spring = snapSpring(distance);
      let max = 0;
      for (let t = 0; t <= 1500; t += 4) max = Math.max(max, springAt(t, 0, distance, v0, spring).value);
      expect(max - distance).toBeLessThan(v0 === 0 ? distance * 0.02 : 16 + distance * 0.02);
    }
  });

  it('uzun yol daha uzun sürer ama süre sınırlıdır', () => {
    expect(snapSpring(50).response).toBeLessThan(snapSpring(800).response);
    expect(snapSpring(5000).response).toBeLessThanOrEqual(420);
  });
});
