/**
 * Konuşma seviyesi dağılımı (ses kalitesi özeti için): konuşma sırasındaki blok/ölçüm RMS seviyeleri (dBFS)
 * 0,5 dB'lik kutularda toplanır; özet gönderilirken medyan ve 90. yüzdelik alınıp sıfırlanır. Masaüstünün ses
 * kapısı worklet'i (gate-worklet.js) aynı kutuları kendisi doldurup sayılar halinde gönderir (addCounts).
 */
export const SPEECH_BINS = 200;
export const SPEECH_BIN_DB = 0.5;
export const SPEECH_MIN_DB = -100;
/** Varsayılan alt sınır; çağıran kaynağın ölçüm hızına göre `minCount` verir (masaüstü ~375 blok/sn, mobil ~11/sn) */
const DEFAULT_MIN_COUNT = 20;

export interface SpeechLevelSummary {
  /** Medyan ve 90. yüzdelik (dBFS) */
  median: number;
  p90: number;
  count: number;
}

export class SpeechLevelHistogram {
  private bins = new Float64Array(SPEECH_BINS);
  private count = 0;

  add(db: number): void {
    if (!Number.isFinite(db)) return;
    const i = Math.floor((db - SPEECH_MIN_DB) / SPEECH_BIN_DB);
    this.bins[Math.min(SPEECH_BINS - 1, Math.max(0, i))]! += 1;
    this.count++;
  }

  /** Aynı kutu düzenindeki sayıları ekler (uzunluğu farklıysa yok sayılır) */
  addCounts(counts: ArrayLike<number>): void {
    if (counts.length !== SPEECH_BINS) return;
    for (let i = 0; i < SPEECH_BINS; i++) {
      const c = counts[i]!;
      if (c > 0 && Number.isFinite(c)) {
        this.bins[i]! += c;
        this.count += c;
      }
    }
  }

  /** Yüzdelik (0–1) kutunun ortasında; ölçüm yetersizse null */
  percentile(q: number, minCount = DEFAULT_MIN_COUNT): number | null {
    if (this.count < minCount) return null;
    const want = q * this.count;
    let acc = 0;
    for (let i = 0; i < SPEECH_BINS; i++) {
      acc += this.bins[i]!;
      if (acc >= want && acc > 0) return SPEECH_MIN_DB + (i + 0.5) * SPEECH_BIN_DB;
    }
    return SPEECH_MIN_DB + (SPEECH_BINS - 0.5) * SPEECH_BIN_DB;
  }

  /** Özeti verir ve sıfırlar (`minCount`'tan az ölçüm varsa null, yine sıfırlanır; ör. tek öksürük bildirilmez) */
  take(minCount = DEFAULT_MIN_COUNT): SpeechLevelSummary | null {
    const median = this.percentile(0.5, minCount);
    const p90 = this.percentile(0.9, minCount);
    const count = this.count;
    this.reset();
    return median === null || p90 === null ? null : { median, p90, count };
  }

  reset(): void {
    this.bins.fill(0);
    this.count = 0;
  }
}
