import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { power } = vi.hoisted(() => ({
  power: { idleSeconds: 0, emitter: null as EventEmitter | null },
}));

vi.mock('electron', () => {
  power.emitter = new EventEmitter();
  return {
    powerMonitor: {
      on: (event: string, cb: () => void) => power.emitter!.on(event, cb),
      off: (event: string, cb: () => void) => power.emitter!.off(event, cb),
      getSystemIdleTime: () => power.idleSeconds,
    },
  };
});

import { IdleMonitor } from '../src/main/idle.js';

const fire = (event: string): void => void power.emitter!.emit(event);

describe('IdleMonitor', () => {
  let monitor: IdleMonitor;
  let changes: boolean[];

  beforeEach(() => {
    power.idleSeconds = 0;
    changes = [];
    monitor = new IdleMonitor((idle) => changes.push(idle));
    monitor.start();
  });

  afterEach(() => monitor.stop());

  it('kilitliyken uykudan dönmek boşta durumunu bitirmez', () => {
    fire('lock-screen');
    fire('suspend');
    fire('resume');
    expect(monitor.current).toBe(true);
    fire('unlock-screen');
    expect(monitor.current).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('uykudayken kilit açılması boşta durumunu bitirmez', () => {
    fire('suspend');
    fire('lock-screen');
    fire('unlock-screen');
    expect(monitor.current).toBe(true);
    fire('resume');
    expect(monitor.current).toBe(false);
  });

  it('kilit olayı olmayan sistem: uyku ve dönüş yeter', () => {
    fire('suspend');
    expect(monitor.current).toBe(true);
    fire('resume');
    expect(monitor.current).toBe(false);
  });

  it('kilit ve uyku bitse de girdi yoksa boşta kalır', () => {
    fire('lock-screen');
    power.idleSeconds = 11 * 60;
    fire('unlock-screen');
    expect(monitor.current).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('durdurulunca olayları dinlemez', () => {
    monitor.stop();
    fire('lock-screen');
    expect(monitor.current).toBe(false);
  });
});
