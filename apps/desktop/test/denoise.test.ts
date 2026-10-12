import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web/wasm';
import {
  ALGORITHMIC_DELAY_SAMPLES,
  BINS,
  DpdfnetDenoiser,
  HOP,
  RealFft,
  StftFramer,
  WIN,
  initialState,
  readOnnxMetadata,
} from '../src/renderer/src/features/voice/dpdfnet/dsp.js';
import {
  BUFFER_SAMPLES,
  CAP,
  IN_READ,
  IN_WRITE,
  OUT_WRITE,
  UNDERRUNS,
  createRing,
  ringViews,
} from '../src/renderer/src/features/voice/denoise/ring';

const voiceDir = path.join(__dirname, '..', 'src', 'renderer', 'src', 'features', 'voice');

describe('DPDFNet DSP', () => {
  it('karışık tabanlı FFT (960) doğrudan DFT ile aynı', () => {
    const x = Float32Array.from({ length: WIN }, (_, i) => Math.sin(i * 0.37) + ((i * 7919) % 13) / 13 - 0.5);
    const fft = new RealFft(WIN);
    const re = new Float64Array(BINS);
    const im = new Float64Array(BINS);
    fft.forward(x, re, im);
    for (const k of [0, 1, 17, 240, 479, 480]) {
      let sr = 0;
      let si = 0;
      for (let j = 0; j < WIN; j++) {
        sr += x[j]! * Math.cos((2 * Math.PI * j * k) / WIN);
        si -= x[j]! * Math.sin((2 * Math.PI * j * k) / WIN);
      }
      expect(re[k]).toBeCloseTo(sr, 8);
      expect(im[k]).toBeCloseTo(si, 8);
    }
    const y = new Float32Array(WIN);
    fft.inverse(re, im, y);
    for (let i = 0; i < WIN; i++) expect(y[i]).toBeCloseTo(x[i]!, 5);
  });

  it('STFT → ISTFT tam geri çatım (1 kare gecikmeyle)', () => {
    const framer = new StftFramer();
    const n = HOP * 20;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 0.5 + Math.cos(i * 0.9) * 0.1);
    const y = new Float32Array(n);
    const spec = new Float32Array(BINS * 2);
    const out = new Float32Array(HOP);
    for (let i = 0; i < n; i += HOP) {
      framer.analyze(x.subarray(i, i + HOP), spec);
      framer.synthesize(spec, out);
      y.set(out, i);
    }
    for (let i = HOP; i < n; i++) expect(y[i]).toBeCloseTo(x[i - HOP]!, 5);
  });

  describe('model', () => {
    let session: ort.InferenceSession;
    let meta: Record<string, string>;
    beforeAll(async () => {
      ort.env.wasm.numThreads = 1;
      const bytes = readFileSync(path.join(voiceDir, 'dpdfnet', 'dpdfnet2_48khz_hr.onnx'));
      meta = readOnnxMetadata(bytes);
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }, 60_000);

    it('ONNX metaverisinden başlangıç durumu', () => {
      expect(Number(meta.state_size)).toBe(56436);
      const state = initialState(meta);
      expect(state.length).toBe(56436);
      expect(state.some((v) => v !== 0)).toBe(true);
    });

    it('gürültüyü bastırır, konuşma benzeri tonu korur, gecikme 50 ms', async () => {
      const den = new DpdfnetDenoiser(ort, session, meta, 100);
      const sr = 48000;
      const n = HOP * 300; // 3 sn
      let seed = 7;
      const noise = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296 - 0.5;
      };
      // Önce 1,5 sn yalnız beyaz gürültü, sonra gürültü + harmonik "sesli harf"
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let v = 0.05 * noise();
        if (i >= n / 2) for (let h = 1; h <= 8; h++) v += (0.12 / h) * Math.sin(2 * Math.PI * 140 * h * t);
        x[i] = v;
      }
      const y = new Float32Array(n);
      const out = new Float32Array(HOP);
      for (let i = 0; i < n; i += HOP) {
        await den.processHop(x.subarray(i, i + HOP), out);
        y.set(out, i);
      }
      const rms = (a: Float32Array, s: number, e: number) => {
        let acc = 0;
        for (let i = s; i < e; i++) acc += a[i]! * a[i]!;
        return Math.sqrt(acc / (e - s));
      };
      expect(y.every(Number.isFinite)).toBe(true);
      const noiseIn = rms(x, sr * 0.5, sr * 1.4);
      const noiseOut = rms(y, sr * 0.5, sr * 1.4);
      expect(20 * Math.log10(noiseOut / noiseIn)).toBeLessThan(-20);
      const d = ALGORITHMIC_DELAY_SAMPLES;
      const toneOut = rms(y, n / 2 + d + sr * 0.3, n);
      const toneIn = rms(x, n / 2 + sr * 0.3, n - d);
      expect(toneOut / toneIn).toBeGreaterThan(0.5);
    }, 60_000);
  });
});

// ---------- Köprü (AudioWorklet) ⇄ işçi halka tamponu ----------

type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
type ProcessorCtor = new (options: { processorOptions: unknown }) => Processor;

const registry: Record<string, ProcessorCtor> = {};
const messages: unknown[] = [];

async function loadWorklets(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (m: unknown) => messages.push(m), onmessage: null };
  };
  g.registerProcessor = (name: string, c: ProcessorCtor) => (registry[name] = c);
  await import('../src/renderer/src/features/voice/denoise/bridge-worklet.js');
  await import('../src/renderer/src/features/voice/denoise/compute.worklet');
}

async function loadBridge(): Promise<ProcessorCtor> {
  await loadWorklets();
  const ctor = registry['diskort-denoise-bridge'];
  if (!ctor) throw new Error('köprü kaydolmadı');
  return ctor;
}

describe('gürültü engelleyici köprüsü', () => {
  let Bridge: ProcessorCtor;
  beforeAll(async () => {
    Bridge = await loadBridge();
  });

  /** Kimlik "işçi": giriş halkasındaki tam kareleri çıkış halkasına kopyalar. */
  function identityWorker(sab: SharedArrayBuffer) {
    const { ctrl, input, output } = ringViews(sab);
    let inR = 0;
    let outW = 0;
    return () => {
      while (((Atomics.load(ctrl, IN_WRITE) - inR) | 0) >= HOP) {
        for (let i = 0; i < HOP; i++) output[(outW + i) & (CAP - 1)] = input[(inR + i) & (CAP - 1)]!;
        inR = (inR + HOP) | 0;
        outW = (outW + HOP) | 0;
        Atomics.store(ctrl, IN_READ, inR);
        Atomics.store(ctrl, OUT_WRITE, outW);
      }
    };
  }

  it('işçi zamanında yetişirse sesi sabit gecikmeyle, boşluksuz geçirir', () => {
    const sab = createRing();
    const node = new Bridge({ processorOptions: { sab, extraSamples: HOP, maxExtraSamples: 3 * HOP } });
    const work = identityWorker(sab);
    const blocks = 400;
    const x = Float32Array.from({ length: blocks * 128 }, (_, i) => Math.sin(i * 0.01) + 1.5);
    const y = new Float32Array(x.length);
    const out = new Float32Array(128);
    for (let b = 0; b < blocks; b++) {
      node.process([[x.subarray(b * 128, b * 128 + 128)]], [[out]]);
      y.set(out, b * 128);
      work(); // işçi, blok bittikten hemen sonra
    }
    const { ctrl } = ringViews(sab);
    expect(Atomics.load(ctrl, UNDERRUNS)).toBe(0);
    const delay = y.findIndex((v) => v !== 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(Atomics.load(ctrl, BUFFER_SAMPLES) + 128);
    for (let i = delay; i < y.length; i++) expect(y[i]).toBeCloseTo(x[i - delay]!, 6);
  });

  it('köprü ⇄ hesap worklet’i (DPDFNet) uçtan uca: boşluksuz, temizlenmiş ses', async () => {
    const Compute = registry['diskort-denoise-compute']!;
    const sab = createRing();
    const ortWasm = new Uint8Array(readFileSync(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'))).buffer;
    const model = new Uint8Array(readFileSync(path.join(voiceDir, 'dpdfnet', 'dpdfnet2_48khz_hr.onnx'))).buffer;
    messages.length = 0;
    const compute = new Compute({
      processorOptions: { sab, kind: 'dpdfnet', attenLimDb: 100, ortWasm, model },
    });
    for (let i = 0; i < 200 && !messages.some((m) => (m as { type: string }).type === 'ready'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(messages).toContainEqual(expect.objectContaining({ type: 'ready' }));
    const bridge = new Bridge({ processorOptions: { sab, extraSamples: 2 * HOP, maxExtraSamples: 4 * HOP } });
    const out = new Float32Array(128);
    let seed = 3;
    const y: number[] = [];
    const blocks = 1500; // 4 sn
    for (let b = 0; b < blocks; b++) {
      const block = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        block[i] = 0.05 * (seed / 4294967296 - 0.5);
      }
      bridge.process([[block]], [[out]]);
      compute.process([[]], [[new Float32Array(128)]]);
      // DPDFNet (onnxruntime) kareyi Promise ile bitirir: sıradaki ses bloğundan önce tamamlanmasına izin ver
      await new Promise((r) => setImmediate(r));
      if (b > blocks / 2) y.push(...out);
    }
    const { ctrl } = ringViews(sab);
    // Model gerçekten kare işledi: 1500 blok × 128 örnek ≈ 400 kare (baştaki ısınma payı hariç)
    expect(Atomics.load(ctrl, OUT_WRITE)).toBeGreaterThan(390 * HOP);
    expect(Atomics.load(ctrl, UNDERRUNS)).toBe(0);
    const rms = Math.sqrt(y.reduce((a, v) => a + v * v, 0) / y.length);
    // Beyaz gürültü (−35 dBFS civarı) sınırsız bastırmayla belirgin şekilde kısılır
    expect(20 * Math.log10(rms)).toBeLessThan(-50);
  }, 60_000);

  it('üretim ayarı (3 kare pay, en fazla 4): 20 ms takılmayı boşluksuz yutar, pay 4 karede durur', () => {
    // micProcessor.ts BRIDGE_EXTRA_SAMPLES / BRIDGE_MAX_EXTRA_SAMPLES ile aynı
    const sab = createRing();
    const node = new Bridge({ processorOptions: { sab, extraSamples: 3 * HOP, maxExtraSamples: 4 * HOP } });
    const work = identityWorker(sab);
    const { ctrl } = ringViews(sab);
    const out = new Float32Array(128);
    const input = new Float32Array(128).fill(0.5);
    for (let b = 0; b < 600; b++) {
      node.process([[input]], [[out]]);
      // 300. bloktan sonra işçi ~18,7 ms (7 blok) boyunca hiç çalışmaz: 30 ms'lik pay yutar
      if (b < 300 || b > 306) work();
    }
    expect(Atomics.load(ctrl, UNDERRUNS)).toBe(0);
    expect(Atomics.load(ctrl, BUFFER_SAMPLES)).toBe(HOP - 32 + 3 * HOP);
    // Art arda uzun takılmalar (~53 ms): boşluk sayılır, pay büyür ama 4 kareyi aşmaz
    for (let b = 0; b < 3000; b++) {
      node.process([[input]], [[out]]);
      if (b % 500 >= 20) work();
    }
    expect(Atomics.load(ctrl, UNDERRUNS)).toBeGreaterThan(0);
    expect(Atomics.load(ctrl, BUFFER_SAMPLES)).toBeGreaterThan(HOP - 32 + 3 * HOP);
    expect(Atomics.load(ctrl, BUFFER_SAMPLES)).toBeLessThanOrEqual(HOP - 32 + 4 * HOP);
  });

  it('işçi 1 kareden uzun takılırsa boşluğu sayar ve payı büyütür', () => {
    const sab = createRing();
    const node = new Bridge({ processorOptions: { sab, extraSamples: HOP, maxExtraSamples: 3 * HOP } });
    const work = identityWorker(sab);
    const out = new Float32Array(128);
    const input = new Float32Array(128).fill(0.5);
    for (let b = 0; b < 600; b++) {
      node.process([[input]], [[out]]);
      // 300. bloktan sonra işçi ~21 ms (8 blok) boyunca hiç çalışmaz
      if (b < 300 || b > 308) work();
    }
    const { ctrl } = ringViews(sab);
    expect(Atomics.load(ctrl, UNDERRUNS)).toBeGreaterThan(0);
    expect(Atomics.load(ctrl, BUFFER_SAMPLES)).toBeGreaterThan(HOP - 32 + HOP);
  });
});
