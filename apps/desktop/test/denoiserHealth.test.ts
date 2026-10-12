import { describe, expect, it } from 'vitest';
import {
  classifySetupError,
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  DenoiserHealth,
  FAILURE_MEMORY_MS,
  ladderFor,
  OverloadDetector,
  type LoadReport,
} from '../src/renderer/src/features/voice/denoiserHealth';
import { fallbackLabel, fallbackNoticeText } from '../src/renderer/src/features/voice/noiseFallback';

/** Raporları sırayla verir; ilk düşüş kararının kaçıncı raporda (1'den) geldiğini döner, gelmezse null */
function firstFailure(d: OverloadDetector, reports: LoadReport[]): { at: number; reason: string } | null {
  for (let i = 0; i < reports.length; i++) {
    const r = d.push(reports[i]!);
    if (r) return { at: i + 1, reason: r };
  }
  return null;
}

describe('yük/boşluk denetimi (OverloadDetector)', () => {
  it('telemetrideki durum: yük 0,4 ve 300–700 ms takılmalarla gelen boşluk patlaması modeli bırakmaz', () => {
    const d = new OverloadDetector(0.75);
    let underruns = 0;
    const reports: LoadReport[] = [];
    for (let i = 0; i < 30; i++) {
      // Her ~10 sn'de bir takılma: o raporda ve sonrakinde bir sürü boşluk
      const burst = i % 5 === 0 || i % 5 === 1;
      if (burst) underruns += 12;
      reports.push({ load: 0.4, underruns, stalled: i % 5 === 0 });
    }
    // Takılmanın taşıdığı ikinci rapor stalled=false: çağıran bir önceki aralığın takılmasını da sayar
    const withCarry = reports.map((r, i) => ({ ...r, stalled: r.stalled || (i > 0 && reports[i - 1]!.stalled) }));
    expect(firstFailure(d, withCarry)).toBeNull();
  });

  it('takılma olmadan kısa bir boşluk patlaması (2 rapor) bırakmaz', () => {
    const d = new OverloadDetector(0.75);
    const reports: LoadReport[] = [0, 5, 9, 9, 9, 9, 9, 9, 9, 9].map((u) => ({ load: 0.45, underruns: u, stalled: false }));
    expect(firstFailure(d, reports)).toBeNull();
  });

  it('süren boşluklar (8 raporun 6’sı) modeli bırakır', () => {
    const d = new OverloadDetector(0.75);
    const reports: LoadReport[] = Array.from({ length: 10 }, (_, i) => ({ load: 0.45, underruns: (i + 1) * 3, stalled: false }));
    expect(firstFailure(d, reports)).toEqual({ at: 6, reason: 'underrun' });
  });

  it('5 raporluk boşluk patlaması (eski sınır) artık bırakmaz', () => {
    const d = new OverloadDetector(0.75);
    const reports: LoadReport[] = [1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5].map((u) => ({ load: 0.45, underruns: u, stalled: false }));
    expect(firstFailure(d, reports)).toBeNull();
  });

  it('süren aşırı yük modeli bırakır; tek tük aşım bırakmaz', () => {
    const spiky = new OverloadDetector(0.75);
    const spikes = Array.from({ length: 16 }, (_, i) => ({ load: i % 3 === 0 ? 0.9 : 0.3, underruns: 0, stalled: false }));
    expect(firstFailure(spiky, spikes)).toBeNull();
    const heavy = new OverloadDetector(0.75);
    // Eski sınırı (0,6) aşan ama yenisinin altındaki yük bırakılmaz
    const moderate = new OverloadDetector(0.75);
    const busy = Array.from({ length: 16 }, () => ({ load: 0.7, underruns: 0, stalled: false }));
    expect(firstFailure(moderate, busy)).toBeNull();
    const reports = Array.from({ length: 8 }, () => ({ load: 0.85, underruns: 0, stalled: false }));
    expect(firstFailure(heavy, reports)).toEqual({ at: 6, reason: 'overload' });
  });

  it('takılmayla çakışsa da pencerenin tamamında boşluk varsa bırakır', () => {
    const d = new OverloadDetector(0.75);
    const reports: LoadReport[] = Array.from({ length: 10 }, (_, i) => ({ load: 0.4, underruns: (i + 1) * 4, stalled: true }));
    expect(firstFailure(d, reports)).toEqual({ at: 8, reason: 'underrun' });
  });
});

describe('model sağlığı (bekleme süresi ve yeniden deneme)', () => {
  it('işlemci yetmeyince bekleme süresi sonunda yeniden denenebilir; tekrarlandıkça süre uzar', () => {
    let now = 1_000_000;
    const h = new DenoiserHealth(() => now);
    expect(h.available('dpdfnet')).toBe(true);
    const f1 = h.record('dpdfnet', 'underrun', 'boşluk');
    expect(f1.transient).toBe(true);
    expect(f1.retryAt).toBe(now + COOLDOWN_BASE_MS);
    expect(h.available('dpdfnet')).toBe(false);
    expect(h.nextRetryAt(['dpdfnet'])).toBe(now + COOLDOWN_BASE_MS);
    now += COOLDOWN_BASE_MS;
    expect(h.available('dpdfnet')).toBe(true);
    // Süresi dolan bekleme de yeniden deneme zamanı verir (uzun bir kurulum sürerken dolmuş olabilir)
    expect(h.nextRetryAt(['dpdfnet'])).toBe(now);
    expect(h.nextRetryAt([])).toBeNull();
    // Yeniden denendi, yine düştü: bekleme ikiye katlanır, en fazla COOLDOWN_MAX_MS
    const f2 = h.record('dpdfnet', 'overload', 'yük');
    expect(f2.retryAt! - f2.at).toBe(2 * COOLDOWN_BASE_MS);
    expect(f2.id).toBeGreaterThan(f1.id);
    for (let i = 0; i < 6; i++) {
      now += COOLDOWN_MAX_MS;
      h.record('dpdfnet', 'slow-start', 'ısınma');
    }
    const last = h.lastFailure('dpdfnet')!;
    expect(last.retryAt! - last.at).toBe(COOLDOWN_MAX_MS);
  });

  it('bekleme 1 dk’dan başlar, art arda düştükçe 2, 4, 8, en fazla 10 dk', () => {
    let now = 0;
    const h = new DenoiserHealth(() => now);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const f = h.record('dpdfnet', 'underrun', 'boşluk');
      waits.push((f.retryAt! - f.at) / 60_000);
      now = f.retryAt! + 30_000;
    }
    expect(waits).toEqual([1, 2, 4, 8, 10, 10]);
  });

  it('uzun süre sorunsuz geçince bekleme süresi baştan başlar', () => {
    let now = 0;
    const h = new DenoiserHealth(() => now);
    h.record('dpdfnet', 'underrun', 'a');
    now += COOLDOWN_BASE_MS;
    h.record('dpdfnet', 'underrun', 'b');
    now += FAILURE_MEMORY_MS + 1;
    const f = h.record('dpdfnet', 'underrun', 'c');
    expect(f.retryAt! - f.at).toBe(COOLDOWN_BASE_MS);
  });

  it('dosya/kurulum hatası bu oturumda kalıcıdır', () => {
    let now = 0;
    const h = new DenoiserHealth(() => now);
    const f = h.record('dpdfnet', 'error', 'model bozuk');
    expect(f.transient).toBe(false);
    expect(f.retryAt).toBeNull();
    now += 10 * COOLDOWN_MAX_MS;
    expect(h.available('dpdfnet')).toBe(false);
    expect(h.nextRetryAt(['dpdfnet'])).toBeNull();
    // Sonradan gelen geçici bir düşüş kalıcılığı kaldırmaz
    h.record('dpdfnet', 'underrun', 'x');
    expect(h.available('dpdfnet')).toBe(false);
  });

  it('kurulum hataları sınıflandırılır', () => {
    expect(classifySetupError('işlemci yetersiz (kare başına 9.1 ms)')).toBe('slow-start');
    expect(classifySetupError('DPDFNet-2 48 kHz zaman aşımı')).toBe('timeout');
    expect(classifySetupError('SharedArrayBuffer kullanılamıyor')).toBe('error');
  });

  it('düşüş sırası ayardan çıkar', () => {
    expect(ladderFor('dpdfnet')).toEqual(['dpdfnet']);
    // DeepFilterNet kaldırıldı: eski değer model zinciri vermez (ayar yüklenirken zaten DPDFNet'e taşınır)
    expect(ladderFor('deepfilter')).toEqual([]);
    expect(ladderFor('standard')).toEqual([]);
    expect(ladderFor('off')).toEqual([]);
  });
});

describe('düşüş metinleri', () => {
  it('ayarlardaki etiket ve bir kezlik bildirim', () => {
    const base = { from: 'dpdfnet' as const, reason: 'underrun' as const, transient: true, at: 0, retryAt: 1 };
    expect(fallbackLabel({ ...base, to: 'standard' })).toBe('DPDFNet → Standart (işlemci yoğun)');
    expect(fallbackNoticeText({ ...base, to: 'standard' })).toBe(
      'Gürültü engelleme geçici olarak standarda düşürüldü (işlemci yoğun). 1 dk sonra DPDFNet yeniden denenecek.',
    );
    expect(fallbackNoticeText({ ...base, to: 'standard', reason: 'error', transient: false, retryAt: null })).toContain(
      'bu oturumda çalıştırılamadı',
    );
  });
});
