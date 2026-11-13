import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  containRect,
  NO_ZOOM,
  panBy,
  panByRect,
  wheelFactor,
  zoomAt,
  zoomAtRect,
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

  // Resim görüntüleyici: içerik alana sığdırılmaz, yerleşimdeki dikdörtgeni verilir
  it('verilen dikdörtgen: alana sığan küçük resim yakınlaşınca ortada kalır', () => {
    const r = { x: 450, y: 200, w: 100, h: 100 };
    const z = zoomAtRect(NO_ZOOM, 4, 460, 210, box, r);
    expect(z.s).toBe(4);
    // 400x400 resim 1000x500 alanın ortasında
    expect(z.x + 4 * r.x).toBeCloseTo(300);
    expect(z.y + 4 * r.y).toBeCloseTo(50);
    // Sığdığı sürece sürüklemek yerinden oynatmaz
    expect(panByRect(z, 500, -500, box, r)).toEqual(z);
  });

  it('verilen dikdörtgen: alandan taşan resim alanın kenarına kadar kayar, imleç altı sabit kalır', () => {
    const r = { x: 100, y: 50, w: 800, h: 400 };
    const z = zoomAtRect(NO_ZOOM, 2.5, 300, 200, box, r);
    expect(z.x + z.s * 300).toBeCloseTo(300);
    expect(z.y + z.s * 200).toBeCloseTo(200);
    const far = panByRect(z, 5000, 5000, box, r);
    // Resmin sol üst köşesi alanın sol üst köşesinde
    expect(far.x + far.s * r.x).toBeCloseTo(0);
    expect(far.y + far.s * r.y).toBeCloseTo(0);
    const back = panByRect(z, -5000, -5000, box, r);
    expect(back.x + back.s * (r.x + r.w)).toBeCloseTo(box.w);
    expect(back.y + back.s * (r.y + r.h)).toBeCloseTo(box.h);
  });
});
