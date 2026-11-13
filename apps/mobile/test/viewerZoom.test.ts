// Tam ekran görüntüleyici yakınlaştırma hesabı (src/components/viewerZoom.ts): sığdırma, kaydırma sınırı,
// odak noktası sabit kalan ölçekleme.

import { describe, expect, it } from 'vitest';
import { clampPan, fitSize, panLimits, zoomAround } from '../src/components/viewerZoom';

const box = { width: 400, height: 800 };

describe('görüntüleyici yakınlaştırma', () => {
  it('içerik kaba sığdırılır; boyut bilinmiyorsa kap kullanılır', () => {
    expect(fitSize(box, { width: 2000, height: 1000 })).toEqual({ width: 400, height: 200 });
    expect(fitSize(box, { width: 100, height: 400 })).toEqual({ width: 200, height: 800 });
    expect(fitSize(box, null)).toBe(box);
    expect(fitSize(box, { width: 0, height: 0 })).toBe(box);
  });

  it('kaydırma sınırı büyütülmüş içeriğin kaptan taşan yarısı; taşmayan eksende 0', () => {
    // İçerik kabı dolduruyorsa (yayın): (s - 1) * kap / 2
    expect(panLimits(2, box, box)).toEqual([200, 400]);
    expect(panLimits(1, box, box)).toEqual([0, 0]);
    // Geniş resim 400×200: 2× iken yatayda 200 taşar, dikeyde 400 < 800 sığar
    expect(panLimits(2, box, { width: 400, height: 200 })).toEqual([200, 0]);
    expect(panLimits(4, box, { width: 400, height: 200 })).toEqual([600, 0]);
  });

  it('kaydırma sınırda kıstırılır', () => {
    const content = { width: 400, height: 200 };
    expect(clampPan({ s: 2, x: 500, y: -300 }, box, content)).toEqual({ s: 2, x: 200, y: 0 });
    expect(clampPan({ s: 2, x: -150, y: 0 }, box, content)).toEqual({ s: 2, x: -150, y: 0 });
  });

  it('odak noktası ölçeklenirken yerinde kalır', () => {
    const start = { s: 1, x: 0, y: 0 };
    const p = { x: 100, y: -50 };
    const z = zoomAround(start, 2.5, p, p);
    expect(z).toEqual({ s: 2.5, x: -150, y: 75 });
    // Odaktaki içerik noktası (başlangıçta p) yeni dönüşümde yine p'de
    expect(z.x + z.s * p.x).toBeCloseTo(p.x);
    expect(z.y + z.s * p.y).toBeCloseTo(p.y);
  });

  it('iki parmak ortası kayınca odaktaki nokta parmakları izler', () => {
    const start = { s: 2, x: 40, y: -20 };
    const focus = { x: 10, y: 10 };
    const to = { x: 30, y: 0 };
    const z = zoomAround(start, 3, focus, to);
    // Odak altındaki içerik noktası: (focus - start) / s
    const cx = (focus.x - start.x) / start.s;
    const cy = (focus.y - start.y) / start.s;
    expect(z.x + z.s * cx).toBeCloseTo(to.x);
    expect(z.y + z.s * cy).toBeCloseTo(to.y);
  });
});
