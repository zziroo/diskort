import { beforeAll, describe, expect, it } from 'vitest';

// Ses kapısı worklet'i (gate-worklet.js): yazılımsal otomatik kazanç, sınırlayıcı ve konuşma seviyesi ölçümü.
// AudioWorklet küreselleri (AudioWorkletProcessor, registerProcessor, sampleRate, currentTime) taklit edilir.

const SR = 48000;
const BLOCK = 128;
const CEILING = Math.pow(10, -3 / 20);

type Msg = { db?: number; threshold?: number; open?: boolean; type?: string; pre?: number[]; post?: number[] };
type Gate = {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  port: { onmessage: (e: { data: unknown }) => void };
  agcDb: number;
};
type GateCtor = new () => Gate;

const g = globalThis as Record<string, unknown>;
let Gate: GateCtor;
let messages: Msg[] = [];

beforeAll(async () => {
  g.sampleRate = SR;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (m: Msg) => messages.push(m), onmessage: null };
  };
  g.registerProcessor = (name: string, c: GateCtor) => {
    if (name === 'diskort-gate') Gate = c;
  };
  await import('../src/renderer/src/features/voice/gate-worklet.js');
});

function create(config: Record<string, unknown>): Gate {
  g.currentTime = 0;
  messages = [];
  const node = new Gate();
  node.port.onmessage({ data: config });
  return node;
}

/** RMS'i `db` dBFS olan 1500 Hz sinüs bloğu (blok tam 4 periyot: blok RMS'i tam olarak `db`) */
function tone(db: number, block: number): Float32Array {
  const a = Math.SQRT2 * Math.pow(10, db / 20);
  return Float32Array.from({ length: BLOCK }, (_, i) => a * Math.sin((2 * Math.PI * 1500 * (block * BLOCK + i)) / SR));
}

const rmsDb = (x: Float32Array): number => {
  let s = 0;
  for (const v of x) s += v * v;
  return 10 * Math.log10(s / x.length + 1e-20);
};

/** Konuşma benzeri: ~300 ms ses, ~200 ms -80 dBFS sessizlik */
const bursts = (db: number) => (b: number) => (b % 188 < 113 ? tone(db, b) : tone(-80, b));

/** `seconds` boyunca işler; her bloğun çıkışını geri çağırır */
function run(node: Gate, seconds: number, input: (b: number) => Float32Array, onOut?: (y: Float32Array, x: Float32Array) => void): void {
  const blocks = Math.round((seconds * SR) / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const x = input(b);
    const y = new Float32Array(BLOCK);
    node.process([[x]], [[y]]);
    onOut?.(y, x);
    g.currentTime = (g.currentTime as number) + BLOCK / SR;
  }
}

describe('ses kapısı: yazılımsal otomatik kazanç', () => {
  it('sessizlikte kazanç donuk kalır (gürültü yükseltilmez)', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 5, (b) => tone(-75, b));
    expect(node.agcDb).toBe(0);
    // Kapı açık (bas-konuş/açık kip) olsa da gürültü tabanının hemen üstündeki ses konuşma sayılmaz
    const open = create({ mode: 'open', auto: true, agc: true });
    run(open, 5, (b) => tone(-75, b));
    expect(Math.abs(open.agcDb)).toBeLessThan(0.01);
  });

  it('kapı hep açıkken -75 dBFS kalıntı kazancı artırmaz; -35 dBFS konuşma yine hedefe gelir', () => {
    // Gürültü tabanı çok düşükken (DPDFNet sonrası ~-90) kalıntı, taban+12 eşiğini aşar ama mutlak alt sınırın altındadır
    const open = create({ mode: 'open', auto: true, agc: true });
    run(open, 3, (b) => tone(-95, b));
    run(open, 10, (b) => tone(-75, b));
    expect(open.agcDb).toBeLessThanOrEqual(0.01);
    run(open, 25, (b) => tone(-35, b));
    expect(open.agcDb).toBeGreaterThan(14.5);
    expect(open.agcDb).toBeLessThanOrEqual(15.01);
  });

  it('-35 dBFS konuşma yavaşça -20 dBFS hedefine yaklaşır', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 2, bursts(-35));
    // Yükseltme yavaş: 2 sn'nin ~1,2 sn'si konuşma → en çok ~3,6 dB
    expect(node.agcDb).toBeGreaterThan(2);
    expect(node.agcDb).toBeLessThan(4);
    run(node, 20, bursts(-35));
    expect(node.agcDb).toBeGreaterThan(14.5);
    expect(node.agcDb).toBeLessThanOrEqual(15.01);
    let out = -100;
    run(node, 0.2, bursts(-35), (y) => (out = rmsDb(y)));
    expect(out).toBeGreaterThan(-21);
    expect(out).toBeLessThan(-19.5);
  });

  it('kazanç en çok +18 dB', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 25, bursts(-50));
    expect(node.agcDb).toBeGreaterThan(17.9);
    expect(node.agcDb).toBeLessThanOrEqual(18);
  });

  it('yüksek seste kısma hızlıdır, alt sınır -6 dB', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 20, bursts(-35));
    expect(node.agcDb).toBeGreaterThan(14);
    // ~1,5 sn bağırma (~0,9 sn'si ses): +15 dB'den 0'ın altına iner
    run(node, 1.5, bursts(-8));
    expect(node.agcDb).toBeLessThan(0);
    run(node, 3, bursts(-8));
    expect(node.agcDb).toBeGreaterThanOrEqual(-6);
    expect(node.agcDb).toBeLessThan(-5);
  });

  it('sınırlayıcı kazanç sonrası sinyalde: tavan (-3 dBFS) aşılmaz', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 25, bursts(-50));
    expect(node.agcDb).toBeGreaterThan(17);
    let peak = 0;
    run(node, 0.5, (b) => tone(-4, b), (y) => {
      for (const v of y) peak = Math.max(peak, Math.abs(v));
    });
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
  });

  it('kapı kararı ve seviye göstergesi kazanç öncesi seviyeyle', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 20, bursts(-35));
    expect(node.agcDb).toBeGreaterThan(14);
    messages = [];
    run(node, 0.3, (b) => tone(-35, b));
    const levels = messages.filter((m) => m.type === undefined);
    expect(levels.length).toBeGreaterThan(0);
    for (const m of levels) expect(m.db).toBeCloseTo(-35, 0);
  });

  it('agc kapalıyken kazanç uygulanmaz', () => {
    const node = create({ mode: 'vad', auto: true, agc: false });
    let out = 0;
    let inp = 0;
    run(node, 10, bursts(-35), (y, x) => {
      out = rmsDb(y);
      inp = rmsDb(x);
    });
    expect(node.agcDb).toBe(0);
    expect(out).toBeCloseTo(inp, 1);
  });

  it('konuşma seviyesi dağılımı (kazanç öncesi/sonrası) ~1 sn’de bir gönderilir', () => {
    const node = create({ mode: 'vad', auto: true, agc: true });
    run(node, 20, bursts(-35));
    messages = [];
    run(node, 2.1, bursts(-35));
    const speech = messages.filter((m) => m.type === 'speech');
    expect(speech.length).toBeGreaterThanOrEqual(2);
    const peakBin = (a: number[]) => -100 + (a.indexOf(Math.max(...a)) + 0.5) * 0.5;
    const last = speech[speech.length - 1]!;
    expect(last.pre).toHaveLength(200);
    expect(peakBin(last.pre!)).toBeCloseTo(-35, 0);
    expect(Math.abs(peakBin(last.post!) - -20)).toBeLessThan(1.5);
  });
});
