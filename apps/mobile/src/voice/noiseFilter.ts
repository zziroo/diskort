import { reportClientError } from '@diskort/client-core';
import { create } from 'zustand';
import { NoiseFilter, type NoiseFilterStatus } from '../../modules/noise-filter';
import { getSettings, useSettings, type NoiseMode } from '../stores/settings';
import { readThermal, type DeviceThermal } from './thermal';

/**
 * DPDFNet gürültü engelleme (modules/noise-filter): masaüstündeki modelin aynısı telefonda, WebRTC'nin ses
 * işleme hattının sonunda çalışır. DPDFNet açıkken WebRTC'nin kendi (standart) gürültü engellemesi kapatılır;
 * model yüklenemez, telefon yetişemez ya da hata olursa standart engellemeye dönülür.
 */

/** Bu APK'da DPDFNet var mı: eski APK'larda (kablosuz güncellemeyle yeni JS almış) yerel modül yoktur */
export const dpdfnetAvailable: boolean = (() => {
  try {
    return NoiseFilter?.isSupported() ?? false;
  } catch {
    return false;
  }
})();

interface NoiseFilterStore {
  /** Son katılışta DPDFNet'in durumu (DPDFNet seçili değilse null) */
  status: NoiseFilterStatus | null;
}

export const useNoiseFilter = create<NoiseFilterStore>()(() => ({ status: null }));

/** DPDFNet şu an mikrofonu işliyor mu (standart engelleme kapalı kalmalı mı) */
let running = false;

/** Sesli sohbette mi (katılıştan ayrılışa): DPDFNet yalnızca o sırada yeniden denenir */
let inCall = false;
/** Katılış/ayrılış sayacı: süren bir yeniden deneme eski oturuma aitse sonucu yok sayılır */
let session = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** DPDFNet sesli sohbet sırasında yeniden açıldı: mikrofon standart engelleme kapalı yeniden açılmalı */
let recoverListener: (() => void) | null = null;

/**
 * Yerel modülün verdiği bekleme (yetişemedi: 2–15 dk, ısındı: 5 dk) bundan uzunsa sesli sohbet sırasında
 * yeniden denenmez; süreli kayıt (12 saat) sonraki katılışlarda kendiliğinden biter.
 */
const MAX_RETRY_WAIT_MS = 30 * 60_000;

/** Ayardaki tür, bu telefonda geçerli olana çevrilir (DPDFNet yoksa standart) */
export function effectiveNoiseMode(mode: NoiseMode = getSettings().noiseMode): NoiseMode {
  return mode === 'dpdfnet' && !dpdfnetAvailable ? 'standard' : mode;
}

/** WebRTC'nin kendi gürültü engellemesi açık mı olmalı */
export function webrtcNoiseSuppression(): boolean {
  const mode = effectiveNoiseMode();
  return mode === 'standard' || (mode === 'dpdfnet' && !running);
}

/** Bu açılışta bildirilen nedenler: kaydedilmiş yavaşlık her katılışta yeniden bildirilmesin */
const reported = new Set<string>();

/**
 * Sunucuya bildirir. İleti kısa kalır (aynı nedenler gruplansın); ölçüm ayrıntıları (yürütücü, model/STFT
 * payı, çekirdek, yonga, ısı durumu) yığın alanına yazılır: saha raporundan telefonun neden yetişemediği anlaşılsın.
 */
function report(reason: string, status: NoiseFilterStatus | null = null): void {
  if (reported.has(reason)) return;
  reported.add(reason);
  const err = new Error(`DPDFNet çalışmıyor: ${reason}`);
  const s = status ?? safeStats();
  if (s) {
    const n = (v: number | null | undefined): string => (v == null ? '-' : v.toFixed(2));
    const t = deviceThermal();
    err.stack = [
      err.message,
      `yürütücü: ${s.provider ?? '-'}; başarım ipucu: ${s.hint == null ? '-' : s.hint ? 'açık' : 'yok'}`,
      `ısınma: ${n(s.warmupMs)} ms (model ${n(s.warmupModelMs)}, en uzun ${n(s.warmupMaxMs)}, ilk yarı ${n(s.warmupFirstMs)}, çekirdek ${s.warmupCore ?? '-'})`,
      `ısı durumu: ${t.thermal ?? '-'}; ısınma payı: ${n(t.thermalHeadroom)}`,
      `canlı: ort ${n(s.avgMs)} ms (model ${n(s.modelMs)}), en uzun ${n(s.maxMs)}, >10 ms: ${s.overHop}, geç: ${s.late ?? '-'}, kare: ${s.frames}`,
      `ses çekirdeği: ${s.audioCore ?? '-'}; işlemci: ${s.soc ?? '-'} · ${s.cpu ?? '-'}`,
    ].join('\n');
  }
  reportClientError(err, 'dpdfnet');
}

function safeStats(): NoiseFilterStatus | null {
  try {
    return NoiseFilter?.getStats() ?? null;
  } catch {
    return null;
  }
}

/** Yonga adı (ör. "QTI SM8850"); DPDFNet modülünden okunur, eski APK'da ya da okunamazsa null */
let soc: string | null | undefined;
export function deviceSoc(): string | null {
  if (soc === undefined) soc = safeStats()?.soc ?? null;
  return soc;
}

/** Telefonun ısı durumu (ses kalitesi özeti); eski APK'da (yerel işlev yok) alanlar null */
export function deviceThermal(): DeviceThermal {
  const module = NoiseFilter;
  return readThermal(module && typeof module.getThermal === 'function' ? () => module.getThermal!() : undefined);
}

/**
 * Yayın izleniyor ya da paylaşılıyor: görüntü de işlemciyi yorar, o sırada DPDFNet yetişemezse telefon kalıcı
 * olarak "yavaş" kaydedilmez (yalnızca o oturumda kapanır). Eski APK'da yerel işlev yoktur.
 */
export function noteVideoActivity(active: boolean): void {
  const module = NoiseFilter;
  if (!module || typeof module.setVideoActive !== 'function') return;
  try {
    module.setVideoActive(active);
  } catch {
    // yalnızca kayıt kararını etkiler
  }
}

/** DPDFNet seçili ama çalışmıyorsa nedeni (ses kalitesi özeti); çalışıyorsa ya da seçili değilse null */
export function noiseFallbackReason(status: NoiseFilterStatus | null): string | null {
  if (effectiveNoiseMode() !== 'dpdfnet') return null;
  return status && !status.active ? (status.reason ?? null) : null;
}

/**
 * Sesli sohbete katılırken, mikrofon açılmadan önce: DPDFNet seçiliyse modeli yükler ve WebRTC'ye takar,
 * değilse kapatır. Sonuç webrtcNoiseSuppression() ile mikrofonun ayarlarına yansır.
 */
export async function prepareNoiseFilter(): Promise<void> {
  running = false;
  session++;
  inCall = true;
  clearRetry();
  if (!NoiseFilter) return;
  const s = getSettings();
  const want = effectiveNoiseMode(s.noiseMode) === 'dpdfnet';
  try {
    const status = await NoiseFilter.configure(want, s.noiseStrengthDb);
    running = want && status.active;
    useNoiseFilter.setState({ status: want ? status : null });
    if (want && !status.active) {
      if (status.reason) report(status.reason, status);
      scheduleRetry(status.retryInMs);
    }
  } catch (err) {
    reportClientError(err, 'dpdfnet');
    useNoiseFilter.setState({ status: null });
  }
}

/**
 * Ayrılış başlarken (oda kapanmadan önce, eşzamanlı): bekleyen yeniden deneme durur ve süren bir denemenin sonucu
 * yok sayılır; böylece oda kapanırken configure(true) ya da mikrofonun yeniden açılması çalışmaz. Model
 * releaseNoiseFilter ile bellekten atılır.
 */
export function suspendNoiseFilterRetry(): void {
  inCall = false;
  session++;
  clearRetry();
}

/** Sesli sohbetten ayrılınca: model bellekten atılır */
export async function releaseNoiseFilter(): Promise<void> {
  running = false;
  session++;
  inCall = false;
  clearRetry();
  useNoiseFilter.setState({ status: null });
  await NoiseFilter?.configure(false, 100).catch(() => undefined);
}

/** Anlık ölçümler (sesli sohbet ekranındaki satır) */
export function noiseFilterStats(): NoiseFilterStatus | null {
  const last = useNoiseFilter.getState().status;
  if (!running && !last) return null;
  try {
    const now = NoiseFilter?.getStats() ?? null;
    // Yüklenemediyse neden yalnızca katılıştaki sonuçta vardır
    return now && !now.active && !now.reason ? { ...now, reason: last?.reason ?? null } : now;
  } catch {
    return null;
  }
}

/**
 * DPDFNet sesli sohbet sırasında kendini devre dışı bıraktığında (telefon yetişemedi, çok ısındı ya da hata)
 * çağrılır; yerel modül motoru o sırada kapatır. Çağrıldığında webrtcNoiseSuppression() artık true döner;
 * mikrofon standart engellemeyle yeniden açılmalı.
 */
export function onNoiseFilterBypass(listener: (reason: string) => void): void {
  NoiseFilter?.addListener('onBypass', ({ reason, retryInMs }) => {
    if (!running) return;
    running = false;
    const status = useNoiseFilter.getState().status;
    if (status) useNoiseFilter.setState({ status: { ...status, active: false, reason, retryInMs } });
    report(reason);
    listener(reason);
    scheduleRetry(retryInMs);
  });
}

/**
 * DPDFNet sesli sohbet sırasında yeniden açıldığında (bekleme süresi doldu, telefon yetişti) çağrılır; çağrıldığında
 * webrtcNoiseSuppression() artık false döner: mikrofon standart engelleme kapalı yeniden açılmalı.
 */
export function onNoiseFilterRecover(listener: () => void): void {
  recoverListener = listener;
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Bekleme süresi dolunca (sesli sohbetteyse) DPDFNet yeniden denenir; eski APK'larda süre gelmez: denenmez */
function scheduleRetry(retryInMs: number | null | undefined): void {
  clearRetry();
  if (!inCall || retryInMs == null || !(retryInMs >= 0) || retryInMs > MAX_RETRY_WAIT_MS) return;
  const mine = session;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryNoiseFilter(mine);
  }, Math.max(retryInMs, 1000));
}

async function retryNoiseFilter(mine: number): Promise<void> {
  if (!NoiseFilter || !inCall || mine !== session || running) return;
  const s = getSettings();
  if (effectiveNoiseMode(s.noiseMode) !== 'dpdfnet') return;
  let status: NoiseFilterStatus;
  try {
    status = await NoiseFilter.configure(true, s.noiseStrengthDb);
  } catch (err) {
    reportClientError(err, 'dpdfnet');
    return;
  }
  // Bu arada ayrılındı ya da yeniden katılındı: ayrılışın/yeni katılışın kendi kurulumu geçerli (yerel modülde
  // çağrılar sırayla işlenir, sonra gelen kapatma ya da kurulum bunu ezer)
  if (mine !== session || !inCall) return;
  useNoiseFilter.setState({ status });
  if (status.active) {
    running = true;
    recoverListener?.();
  } else {
    if (status.reason) report(status.reason, status);
    scheduleRetry(status.retryInMs);
  }
}

// Güç ayarı sesli sohbetteyken de anında uygulanır
useSettings.subscribe((next, prev) => {
  if (next.noiseStrengthDb !== prev.noiseStrengthDb) {
    try {
      NoiseFilter?.setAttenLimit(next.noiseStrengthDb);
    } catch {
      // model yüklü değilse bir sonraki katılışta uygulanır
    }
  }
});
