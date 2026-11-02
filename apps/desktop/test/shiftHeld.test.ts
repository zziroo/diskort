import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installShiftHeld } from '../src/renderer/src/lib/shiftHeld';

describe('Shift göstergesi (shiftHeld)', () => {
  let attrs: Set<string>;
  let win: EventTarget;
  const fire = (type: string, shiftKey: boolean): void => {
    win.dispatchEvent(Object.assign(new Event(type), { shiftKey }));
  };
  const held = (): boolean => attrs.has('data-shift-held');

  beforeEach(() => {
    attrs = new Set();
    win = new EventTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {
      documentElement: {
        toggleAttribute: (name: string, on: boolean) => (on ? attrs.add(name) : attrs.delete(name)),
        removeAttribute: (name: string) => attrs.delete(name),
      },
    });
    installShiftHeld();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Shift basılınca köke yazılır, bırakılınca kalkar', () => {
    fire('keydown', true);
    expect(held()).toBe(true);
    fire('keyup', false);
    expect(held()).toBe(false);
  });

  it('Shift basılıyken pencereden çıkılırsa kalkar', () => {
    fire('keydown', true);
    win.dispatchEvent(new Event('blur'));
    expect(held()).toBe(false);
  });

  it('pencere dışında değişen Shift fare hareketiyle düzelir', () => {
    fire('mousemove', true);
    expect(held()).toBe(true);
    fire('mousemove', false);
    expect(held()).toBe(false);
  });
});
