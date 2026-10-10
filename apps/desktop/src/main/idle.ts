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
  private locked = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: (idle: boolean) => void) {}

  get current(): boolean {
    return this.idle;
  }

  start(): void {
    powerMonitor.on('lock-screen', this.lock);
    powerMonitor.on('suspend', this.lock);
    powerMonitor.on('unlock-screen', this.unlock);
    powerMonitor.on('resume', this.unlock);
    this.check();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    powerMonitor.off('lock-screen', this.lock);
    powerMonitor.off('suspend', this.lock);
    powerMonitor.off('unlock-screen', this.unlock);
    powerMonitor.off('resume', this.unlock);
  }

  private readonly lock = (): void => {
    this.locked = true;
    this.check();
  };

  private readonly unlock = (): void => {
    this.locked = false;
    this.check();
  };

  private check(): void {
    if (this.timer) clearTimeout(this.timer);
    this.update();
    this.timer = setTimeout(() => this.check(), this.idle && !this.locked ? IDLE_POLL_MS : POLL_MS);
  }

  private update(): void {
    let idle = this.locked;
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
