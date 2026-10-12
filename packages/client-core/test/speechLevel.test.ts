import { describe, expect, it } from 'vitest';
import { SpeechLevelHistogram } from '../src/speechLevel';

describe('konuşma seviyesi dağılımı', () => {
  it('medyan ve 90. yüzdelik (0,5 dB kutu ortası), alınca sıfırlanır', () => {
    const h = new SpeechLevelHistogram();
    for (let i = 0; i < 100; i++) h.add(-40 + i * 0.2); // -40 .. -20,2
    const s = h.take();
    expect(s).not.toBeNull();
    expect(s!.count).toBe(100);
    expect(Math.abs(s!.median - -30.2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(s!.p90 - -22.2)).toBeLessThanOrEqual(0.5);
    expect(h.take()).toBeNull();
  });

  it('az ölçümle null; sınır dışı değerler uç kutulara', () => {
    const h = new SpeechLevelHistogram();
    for (let i = 0; i < 5; i++) h.add(-30);
    expect(h.take()).toBeNull();
    for (let i = 0; i < 30; i++) h.add(5);
    expect(h.take()!.median).toBe(-0.25);
    for (let i = 0; i < 30; i++) h.add(-150);
    expect(h.take()!.median).toBe(-99.75);
  });

  it('minCount alt sınırı çağırana göre ayarlanır', () => {
    const h = new SpeechLevelHistogram();
    for (let i = 0; i < 100; i++) h.add(-30);
    expect(h.take(375)).toBeNull();
    for (let i = 0; i < 100; i++) h.add(-30);
    expect(h.take(100)).not.toBeNull();
  });

  it('worklet kutu sayıları eklenir; uzunluğu farklıysa yok sayılır', () => {
    const h = new SpeechLevelHistogram();
    const counts = new Array<number>(200).fill(0);
    counts[130] = 50; // -35 .. -34,5
    h.addCounts(counts);
    h.addCounts([1, 2, 3]);
    expect(h.take()).toEqual({ median: -34.75, p90: -34.75, count: 50 });
  });
});
