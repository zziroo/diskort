import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HotkeyEvent, Keybind } from '../src/shared/bridge.js';

const { hook } = vi.hoisted(() => ({ hook: { emitter: null as EventEmitter | null } }));

vi.mock('uiohook-napi', () => {
  const emitter = new EventEmitter();
  hook.emitter = emitter;
  return { UiohookKey: {}, uIOhook: Object.assign(emitter, { start: () => undefined, stop: () => undefined }) };
});

import { HotkeyManager } from '../src/main/hotkeys.js';

const KEY = 57;
const keyBind: Keybind = { kind: 'key', keycode: KEY, ctrl: false, alt: false, shift: false, meta: false, label: 'Space' };
const mouseBind: Keybind = { kind: 'mouse', button: 4, label: 'Fare 4' };
const keyEvent = { keycode: KEY, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe('HotkeyManager.releaseAll', () => {
  let events: HotkeyEvent[];
  let manager: HotkeyManager;

  beforeEach(async () => {
    hook.emitter?.removeAllListeners();
    events = [];
    manager = new HotkeyManager((event) => events.push(event));
    await manager.init();
  });

  const set = (pushToTalk: Keybind): void => manager.setConfig({ pushToTalk, toggleMute: null, toggleDeafen: null });

  it('basılı bas-konuşu bir kez bırakır', () => {
    set(keyBind);
    hook.emitter!.emit('keydown', keyEvent);
    manager.releaseAll();
    manager.releaseAll();
    expect(events).toEqual([
      { action: 'pushToTalk', pressed: true },
      { action: 'pushToTalk', pressed: false },
    ]);
  });

  it('fare tuşuyla basılı bas-konuşu da bırakır', () => {
    set(mouseBind);
    hook.emitter!.emit('mousedown', { button: 4 });
    manager.releaseAll();
    expect(events.at(-1)).toEqual({ action: 'pushToTalk', pressed: false });
  });

  it('sonraki basış tekrar sayılmaz', () => {
    set(keyBind);
    hook.emitter!.emit('keydown', keyEvent);
    manager.releaseAll();
    hook.emitter!.emit('keydown', keyEvent);
    expect(events.at(-1)).toEqual({ action: 'pushToTalk', pressed: true });
  });

  it('basılı değilken bir şey göndermez', () => {
    set(keyBind);
    manager.releaseAll();
    expect(events).toEqual([]);
  });
});
