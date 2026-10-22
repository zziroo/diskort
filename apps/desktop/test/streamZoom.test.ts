import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  containRect,
  NO_ZOOM,
  panBy,
  wheelFactor,
  zoomAt,
} from '../src/renderer/src/components/stage/zoom.js';

const box = { w: 1000, h: 500 };

describe('yayın yakınlaştırma', () => {
  it('içerik dikdörtgeni object-contain gibi ortalanır', () => {
    const r = containRect(box, { w: 1920, h: 1080 });
    expect(r.x).toBeCloseTo(55.56, 1);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(888.89, 1);
    expect(r.h).toBe(500);
    expect(containRect(box, null)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });

  it('imlecin altındaki nokta sabit kalır', () => {
    const z = zoomAt(NO_ZOOM, 2, 300, 200, box, null);
    expect(z.s).toBe(2);
    // Ekran noktası p = t + s * içerik noktası; içerik noktası (300, 200) yine 300, 200'de
    expect(z.x + z.s * 300).toBeCloseTo(300);
    expect(z.y + z.s * 200).toBeCloseTo(200);
    const z2 = zoomAt(z, 3, 600, 100, box, null);
    const cx = (600 - z.x) / z.s;
    expect(z2.x + z2.s * cx).toBeCloseTo(600);
  });

  it('ölçek 1–4 arasında kalır, bire inince tam sıfırlanır', () => {
    expect(zoomAt(NO_ZOOM, 10, 0, 0, box, null).s).toBe(4);
    expect(zoomAt({ s: 2, x: -100, y: -50 }, 0.5, 0, 0, box, null)).toEqual(NO_ZOOM);
    expect(zoomAt({ s: 2, x: -100, y: -50 }, 1.005, 0, 0, box, null)).toEqual(NO_ZOOM);
  });

  it('kaydırma kenarlarda durur (dışarı boşluk çıkmaz)', () => {
    const z = { s: 2, x: 0, y: 0 };
    expect(panBy(z, 500, 500, box, null)).toEqual({ s: 2, x: 0, y: 0 });
    expect(panBy(z, -5000, -5000, box, null)).toEqual({
      s: 2,
      x: -1000,
      y: -500,
    });
  });

  it('letterbox: içerik alanı doldurmayan eksende ortada kalır, dolduranda içerik kenarına göre sınırlanır', () => {
    // 4:3 içerik 1000x500 alanda: 666.7 genişlik, x = 166.7
    const content = { w: 800, h: 600 };
    const r = containRect(box, content);
    const z = clampZoom({ s: 1.2, x: 0, y: 0 }, box, content);
    // Yatayda 1.2 * 666.7 = 800 < 1000: ortalanır
    expect(z.x + 1.2 * r.x + (1.2 * r.w) / 2).toBeCloseTo(500);
    // Dikeyde y 0 ile -100 arasında
    expect(z.y).toBe(0);
    const far = clampZoom({ s: 3, x: 1000, y: 0 }, box, content);
    // Sol kenar içeriğin sol kenarında: x + s * r.x = 0
    expect(far.x + 3 * r.x).toBeCloseTo(0);
  });

  it('tekerlek yukarı yakınlaştırır, aşağı uzaklaştırır', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });
});
