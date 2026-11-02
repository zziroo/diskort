import { CriticalTimers } from 'livekit-client';
import { VoiceService } from '../../modules/voice-service';

type Handle = ReturnType<typeof setTimeout>;

interface NativeTimers {
  setTimer(id: number, delayMs: number): void;
  clearTimer(id: number): void;
}

interface Entry {
  run: () => void;
  ms: number;
  repeat: boolean;
  js: Handle | null;
  /** Son kurulumun yerel kimliği */
  token: number;
}

/**
 * Her zamanlayıcı iki yoldan kurulur, önce gelen çalışır, öteki iptal edilir: JS zamanlayıcısı arka planda durur,
 * yerel zamanlayıcı öne dönüşte ya da eski APK'da gelmese de JS yolu aynen çalışır.
 */
export class DualTimers {
  private seq = 0;
  /** Kurulu zamanlayıcılar, yerel kimlikle. Her kurulum yeni kimlik alır: geç gelen olay sonraki turu tetiklemez. */
  private readonly armed = new Map<number, Entry>();

  constructor(private readonly native: NativeTimers) {}

  /** Dönen nesne LiveKit için zamanlayıcı kimliğidir (yalnızca remove'a geri verilir) */
  add(run: () => void, ms: number, repeat: boolean): Entry {
    const entry: Entry = { run, ms, repeat, js: null, token: 0 };
    this.arm(entry);
    return entry;
  }

  /** Yerel zamanlayıcı geldi ya da JS zamanlayıcısı doldu. Geç gelen olayın karşılığı yoksa bir şey yapmaz. */
  fire(token: number): void {
    const entry = this.armed.get(token);
    if (!entry) return;
    this.disarm(entry);
    if (entry.repeat) this.arm(entry);
    entry.run();
  }

  remove(entry: Entry): void {
    this.disarm(entry);
  }

  private arm(entry: Entry): void {
    const token = ++this.seq;
    entry.token = token;
    this.armed.set(token, entry);
    entry.js = setTimeout(() => this.fire(token), entry.ms);
    this.native.setTimer(token, entry.ms);
  }

  private disarm(entry: Entry): void {
    if (!this.armed.delete(entry.token)) return;
    if (entry.js !== null) clearTimeout(entry.js);
    entry.js = null;
    this.native.clearTimer(entry.token);
  }
}

/**
 * LiveKit'in yeniden bağlanma, ping ve bekleme zamanlayıcıları (CriticalTimers) Android'de yerel zamanlayıcıyla da
 * kurulur. React Native'in zamanlayıcıları Activity duraklayınca durur (JavaTimerManager.onHostPause): ön plan
 * servisi süreci canlı tutsa da ekran kapalıyken ağ değişince LiveKit ilk denemeyi kuramaz ve yeniden bağlanma
 * uygulama açılana kadar bekler. iOS'ta gerekmez: RCTTiming arka planda NSTimer'a geçer, "audio" kipi süreci canlı tutar.
 */
export function installBackgroundTimers(): void {
  const { setTimer, clearTimer } = VoiceService;
  if (!setTimer || !clearTimer) return;
  const timers = new DualTimers({
    setTimer: (id, delayMs) => VoiceService.setTimer?.(id, delayMs),
    clearTimer: (id) => VoiceService.clearTimer?.(id),
  });
  VoiceService.addListener('onTimer', ({ id }) => timers.fire(id));
  const start = (fn: (...args: unknown[]) => void, ms: number | undefined, repeat: boolean, args: unknown[]): Handle =>
    timers.add(() => fn(...args), ms ?? 0, repeat) as unknown as Handle;
  const stop = (handle: unknown): void => {
    if (handle) timers.remove(handle as Entry);
  };
  CriticalTimers.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    start(fn, ms, false, args)) as typeof CriticalTimers.setTimeout;
  CriticalTimers.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    start(fn, ms, true, args)) as typeof CriticalTimers.setInterval;
  CriticalTimers.clearTimeout = stop as typeof CriticalTimers.clearTimeout;
  CriticalTimers.clearInterval = stop as typeof CriticalTimers.clearInterval;
}
