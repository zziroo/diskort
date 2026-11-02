import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// LiveKit zamanlayıcılarının Android'de arka planda da çalışması (src/voice/backgroundTimers.ts): JS zamanlayıcısı
// duruyorken yerel olay çalıştırır, ikisi birden gelse de iş bir kez yapılır, eski APK'da hiçbir şey değişmez.

const h = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
}));

vi.mock('../modules/voice-service', () => ({
  get VoiceService() {
    return h.service;
  },
}));

const makeNative = () => ({
  setTimer: vi.fn<(id: number, delayMs: number) => void>(),
  clearTimer: vi.fn<(id: number) => void>(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  h.service = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DualTimers', () => {
  const lastToken = (native: ReturnType<typeof makeNative>): number => native.setTimer.mock.calls.at(-1)?.[0] as number;

  it('JS zamanlayıcısı durmuşken yerel olay çalıştırır, JS kurulumu iptal edilir', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn();
    timers.add(run, 300, false);
    const token = lastToken(native);
    expect(native.setTimer).toHaveBeenCalledWith(token, 300);

    timers.fire(token);
    expect(run).toHaveBeenCalledTimes(1);
    expect(native.clearTimer).toHaveBeenCalledWith(token);
    // Uygulama öne dönünce duran JS zamanlayıcısı ikinci kez çalıştırmaz
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('öndeyken JS zamanlayıcısı çalıştırır, yerel kurulum iptal edilir, geç gelen olay yok sayılır', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn();
    timers.add(run, 300, false);
    const token = lastToken(native);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    expect(native.clearTimer).toHaveBeenCalledWith(token);
    timers.fire(token);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('tekrarlayan zamanlayıcı her seferinde yeni kimlikle kurulur, durdurulunca biter', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn();
    const handle = timers.add(run, 5000, true);
    timers.fire(lastToken(native));
    timers.fire(lastToken(native));
    expect(run).toHaveBeenCalledTimes(2);
    expect(new Set(native.setTimer.mock.calls.map((c) => c[0])).size).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);

    const token = lastToken(native);
    timers.remove(handle);
    await vi.advanceTimersByTimeAsync(20_000);
    timers.fire(token);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('tekrarlayanda JS önce dolarsa kuyruktaki yerel olay sonraki turu çalıştırmaz', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn();
    timers.add(run, 5000, true);
    const first = lastToken(native);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    timers.fire(first);
    expect(run).toHaveBeenCalledTimes(1);
    // Sonraki tur bozulmadı
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('çalışırken kendini durduran tekrarlayan zamanlayıcı yeniden kurulmaz', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn(() => timers.remove(handle));
    const handle = timers.add(run, 5000, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('kaldırılan zamanlayıcı hiçbir yoldan çalışmaz', async () => {
    const { DualTimers } = await import('../src/voice/backgroundTimers');
    const native = makeNative();
    const timers = new DualTimers(native);
    const run = vi.fn();
    const handle = timers.add(run, 300, false);
    const token = lastToken(native);
    timers.remove(handle);
    expect(native.clearTimer).toHaveBeenCalledWith(token);
    timers.fire(token);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('installBackgroundTimers', () => {
  it('yerel işlev yoksa (iOS, eski APK) LiveKit zamanlayıcıları olduğu gibi kalır', async () => {
    const { CriticalTimers } = await import('livekit-client');
    const before = CriticalTimers.setTimeout;
    const addListener = vi.fn();
    h.service = { addListener };
    const { installBackgroundTimers } = await import('../src/voice/backgroundTimers');
    installBackgroundTimers();
    expect(CriticalTimers.setTimeout).toBe(before);
    expect(addListener).not.toHaveBeenCalled();
  });

  it('LiveKit zamanlayıcıları yerel olayla çalışır, bağımsız değişkenler iletilir', async () => {
    const { CriticalTimers } = await import('livekit-client');
    const saved = { ...CriticalTimers };
    const listeners: ((event: { id: number }) => void)[] = [];
    const native = makeNative();
    h.service = { ...native, addListener: vi.fn((_name: string, fn: (event: { id: number }) => void) => listeners.push(fn)) };
    const { installBackgroundTimers } = await import('../src/voice/backgroundTimers');
    installBackgroundTimers();
    try {
      const run = vi.fn();
      (CriticalTimers.setTimeout as (...args: unknown[]) => unknown)(run, 300, 'a');
      for (const fn of listeners) fn({ id: native.setTimer.mock.calls.at(-1)?.[0] as number });
      expect(run).toHaveBeenCalledWith('a');

      const tick = vi.fn();
      const interval = CriticalTimers.setInterval(tick, 5000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(2);
      CriticalTimers.clearInterval(interval);
      CriticalTimers.clearTimeout(undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(CriticalTimers, saved);
    }
  });
});
