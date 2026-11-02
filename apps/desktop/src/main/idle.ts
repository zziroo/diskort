import { powerMonitor } from 'electron';

/** Bu kadar süre klavye/fare girdisi yoksa "boşta" (Discord gibi 10 dakika) */
const IDLE_AFTER_SECONDS = 10 * 60;
/** Etkinken boşta olmaya geçişi seyrek, boştayken geri dönüşü sık yokla (fare oynayınca hemen "Çevrimiçi") */
const POLL_MS = 15_000;
const IDLE_POLL_MS = 1_000;

/**
 * Bilgisayarın boşta olup olmadığını izler: işletim sisteminin son girdiden beri geçen süresi, ekran
 * kilidi ve uyku. Değişince bildirir; arayüz bunu sunucuya iletir (otomatik "Boşta" durumu).
 */
export class IdleMonitor {
  private idle = false;
  private screenLocked = false;
  private suspended = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: (idle: boolean) => void) {}

  get current(): boolean {
    return this.idle;
  }

  start(): void {
    powerMonitor.on('lock-screen', this.onLock);
    powerMonitor.on('unlock-screen', this.onUnlock);
    powerMonitor.on('suspend', this.onSuspend);
    powerMonitor.on('resume', this.onResume);
    this.check();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    powerMonitor.off('lock-screen', this.onLock);
    powerMonitor.off('unlock-screen', this.onUnlock);
    powerMonitor.off('suspend', this.onSuspend);
    powerMonitor.off('resume', this.onResume);
  }

  /** Kilit ve uyku ayrı izlenir: kilitliyken uykudan dönmek kilidi açmış saymaz */
  private get away(): boolean {
    return this.screenLocked || this.suspended;
  }

  private readonly onLock = (): void => {
    this.screenLocked = true;
    this.check();
  };

  private readonly onUnlock = (): void => {
    this.screenLocked = false;
    this.check();
  };

  private readonly onSuspend = (): void => {
    this.suspended = true;
    this.check();
  };

  private readonly onResume = (): void => {
    this.suspended = false;
    this.check();
  };

  private check(): void {
    if (this.timer) clearTimeout(this.timer);
    this.update();
    this.timer = setTimeout(() => this.check(), this.idle && !this.away ? IDLE_POLL_MS : POLL_MS);
  }

  private update(): void {
    let idle = this.away;
    if (!idle) {
      try {
        idle = powerMonitor.getSystemIdleTime() >= IDLE_AFTER_SECONDS;
      } catch {
        idle = false; // bazı Linux masaüstlerinde ölçülemiyor: hep etkin say
      }
    }
    if (idle === this.idle) return;
    this.idle = idle;
    this.onChange(idle);
  }
}
