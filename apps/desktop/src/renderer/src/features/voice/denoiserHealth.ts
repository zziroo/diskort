// Yapay zekâ gürültü engelleyicilerinin sağlığı: çalışırken işlemci yetmediğinde (aşırı yük, ses boşlukları)
// model bir süre dinlendirilir, sonra görüşme ortasında da yeniden denenir. Dosya/kurulum hataları ise bu
// oturum boyunca kalıcıdır. Tarayıcıya bağımlı değildir (birim testleri bkz. test/denoiserHealth.test.ts).

/** Zincirdeki yapay zekâ gürültü engelleyicisi */
export type Denoiser = 'dpdfnet';

/**
 * Düşüş sırası: en iyiden en hafife. Seçili model çalışmazsa sıradaki denenir, hiçbiri çalışmazsa standart
 * (tarayıcının) engellemeye düşülür. Bir basamağı kaldırmak için yalnızca bu listeden çıkarmak yeterlidir.
 */
export const DENOISER_LADDER: readonly Denoiser[] = ['dpdfnet'];

/** Ayardaki gürültü engelleme türü için denenecek modeller (sırayla) */
export function ladderFor(noise: string): Denoiser[] {
  const i = DENOISER_LADDER.indexOf(noise as Denoiser);
  return i < 0 ? [] : DENOISER_LADDER.slice(i);
}

/**
 * Neden: overload (tek çekirdek yükü sınırı aştı), underrun (kareler zamanında işlenemedi, ses boşlukları),
 * slow-start (ısınmada kare süresi çok uzun), timeout (kurulum takıldı): geçici, bekleme süresinden sonra
 * yeniden denenir. error: dosya/kurulum/çökme: bu oturumda kalıcı.
 */
export type FailureReason = 'overload' | 'underrun' | 'slow-start' | 'timeout' | 'error';

export interface DenoiserFailure {
  /** Artan sıra numarası (aynı düşüş bir kez bildirilsin) */
  id: number;
  which: Denoiser;
  reason: FailureReason;
  /** Ayrıntı (ör. "yük %63"), sunucu kaydı için */
  message: string;
  transient: boolean;
  at: number;
  /** Geçiciyse yeniden deneme zamanı; kalıcıysa null */
  retryAt: number | null;
}

/**
 * İlk bekleme 1 dk: telemetride düşüşler oyunun yükleme anlarındaki kısa takılmalarda oluyor ve eski 5 dk'lık
 * bekleme DPDFNet'i gereğinden uzun kapalı tutuyordu; yeniden denemenin bedeli yalnızca kısa bir yeniden yayın
 * boşluğu. Aynı model yeniden düşerse bekleme ikiye katlanır (2, 4, 8, en fazla 10 dk): sürekli ağır bir oyunda
 * dakikada bir gidip gelme olmasın.
 */
export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_MAX_MS = 10 * 60_000;
/** Son düşüşün üzerinden bu kadar geçtiyse bekleme süresi baştan (1 dk) başlar */
export const FAILURE_MEMORY_MS = 30 * 60_000;

export function isTransient(reason: FailureReason): boolean {
  return reason !== 'error';
}

/** Kurulum hatasının nedeni (mesajlar micProcessor'daki hatalardan) */
export function classifySetupError(message: string): FailureReason {
  if (message.startsWith('işlemci yetersiz')) return 'slow-start';
  if (message.includes('zaman aşımı')) return 'timeout';
  return 'error';
}

interface Entry {
  permanent: boolean;
  until: number;
  count: number;
  last: DenoiserFailure;
}

export class DenoiserHealth {
  private readonly entries = new Map<Denoiser, Entry>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Model şu an denenebilir mi (kalıcı hatası yok, bekleme süresi dolmuş) */
  available(which: Denoiser): boolean {
    const e = this.entries.get(which);
    return !e || (!e.permanent && this.now() >= e.until);
  }

  /** Düşüşü kaydeder; geçiciyse bekleme süresini (tekrarlandıkça uzayarak) başlatır. */
  record(which: Denoiser, reason: FailureReason, message: string): DenoiserFailure {
    const now = this.now();
    const prev = this.entries.get(which);
    const transient = isTransient(reason);
    const count = prev && now - prev.last.at < FAILURE_MEMORY_MS ? prev.count + 1 : 1;
    const cooldown = Math.min(COOLDOWN_BASE_MS * 2 ** (count - 1), COOLDOWN_MAX_MS);
    const permanent = !transient || (prev?.permanent ?? false);
    const failure: DenoiserFailure = {
      id: ++this.seq,
      which,
      reason,
      message,
      transient: !permanent,
      at: now,
      retryAt: permanent ? null : now + cooldown,
    };
    this.entries.set(which, { permanent, until: permanent ? Infinity : now + cooldown, count, last: failure });
    return failure;
  }

  lastFailure(which: Denoiser): DenoiserFailure | null {
    return this.entries.get(which)?.last ?? null;
  }

  /**
   * Verilen modellerden geçici düşüşü olanların en yakın yeniden deneme zamanı. Süresi dolmuş olan da sayılır
   * (geçmişte kalan zaman: hemen denenebilir); yoksa bekleme, uzun bir kurulum sürerken dolduğunda model hiç
   * yeniden denenmezdi. Aynı zamanın bir kez denenmesini çağıran sağlar.
   */
  nextRetryAt(which: readonly Denoiser[]): number | null {
    let next: number | null = null;
    for (const w of which) {
      const e = this.entries.get(w);
      if (!e || e.permanent) continue;
      next = next === null ? e.until : Math.min(next, e.until);
    }
    return next;
  }
}

/** Bu oturumun (uygulama açık kaldıkça) model sağlığı */
export const denoiserHealth = new DenoiserHealth();

// ---------- Çalışırken yük/boşluk denetimi ----------

/** Barındırıcının 2 saniyelik raporundan gerekenler */
export interface LoadReport {
  load: number;
  /** Başından beri toplam boşluk (köprü sayacı) */
  underruns: number;
  /** Bu raporun aralığında ana iş parçacığı ya da sistem takıldı (ör. oyunun yükleme anı) */
  stalled: boolean;
}

/** Son bu kadar rapora (~16 sn) bakılır */
export const LOAD_WINDOW_REPORTS = 8;
/** Pencerede bu kadar kötü rapor (≥12 sn sorun; eskiden 5 rapor, ≥10 sn) varsa model bırakılır */
export const LOAD_BAD_REPORTS = 6;
/**
 * Takılmayla çakışan boşluklar sayılmaz (kısa takılma modelin suçu değil); ama pencerenin tamamında (eskiden
 * 8 raporun 7'si) boşluk varsa takılma olsa da bırakılır (ses sürekli kesiliyor).
 */
export const LOAD_UNDERRUN_ALWAYS_REPORTS = 8;

/**
 * Telemetri (0.8–0.9.1): düşüşlerden önceki 30 sn'de yük 0,37–0,51 (sınır o zaman 0,6), en uzun kare 5–8 ms;
 * boşluklar (8–34) 300–700 ms'lik JS/sistem takılmalarıyla birlikte geliyordu. Eski kural (art arda 3 raporda yeni
 * boşluk) tek bir oyun yükleme anında modeli bırakıyordu. Bu denetim kısa takılmaları affeder, süren sorunda
 * bırakır. 0.10.x'te de düşüşler sürünce sınırlar gevşetildi (yük 0,75, 6/8 rapor) ve köprü tamponu büyütüldü.
 */
export class OverloadDetector {
  private readonly window: { load: boolean; underrun: boolean; anyUnderrun: boolean }[] = [];
  private lastUnderruns = 0;

  constructor(private readonly maxLoad: number) {}

  /** Yeni rapor; model bırakılmalıysa nedeni, yoksa null */
  push(r: LoadReport): 'overload' | 'underrun' | null {
    const anyUnderrun = r.underruns > this.lastUnderruns;
    this.lastUnderruns = r.underruns;
    const load = r.load > this.maxLoad;
    this.window.push({ load, underrun: anyUnderrun && !r.stalled, anyUnderrun });
    if (this.window.length > LOAD_WINDOW_REPORTS) this.window.shift();
    let loads = 0;
    let underruns = 0;
    let bad = 0;
    let anyUnderruns = 0;
    for (const w of this.window) {
      if (w.load) loads++;
      if (w.underrun) underruns++;
      if (w.load || w.underrun) bad++;
      if (w.anyUnderrun) anyUnderruns++;
    }
    if (bad >= LOAD_BAD_REPORTS) return loads >= underruns ? 'overload' : 'underrun';
    if (anyUnderruns >= LOAD_UNDERRUN_ALWAYS_REPORTS) return 'underrun';
    return null;
  }
}

/** Ana iş parçacığı bu kadar süre olay işleyemediyse "takıldı" sayılır */
export const STALL_GAP_MS = 250;
