// Global kısayollar (bas-konuş, sustur, sağırlaştır). Electron'un globalShortcut API'si
// tuş bırakmayı algılayamadığı için uiohook-napi ile düşük seviyeli klavye/fare kancası kullanılır.
import type { HotkeyAction, HotkeyConfig, HotkeyEvent, Keybind } from '../shared/bridge';

type UiohookModule = typeof import('uiohook-napi');
type KeyEvent = import('uiohook-napi').UiohookKeyboardEvent;
type MouseEvent = import('uiohook-napi').UiohookMouseEvent;

const ESCAPE = 1;
const MODIFIER_CODES = new Set([29, 3613, 56, 3640, 42, 54, 3675, 3676]);
const MOUSE_LABELS: Record<number, string> = { 3: 'Orta Fare Tuşu', 4: 'Fare 4', 5: 'Fare 5' };

export class HotkeyManager {
  private hook: UiohookModule | null = null;
  private keyNames = new Map<number, string>();
  private config: HotkeyConfig = { pushToTalk: null, toggleMute: null, toggleDeafen: null };
  private pressedKeys = new Set<number>();
  private pttDown = false;
  private recording: ((bind: Keybind | null) => void) | null = null;
  private recordingModifier: KeyEvent | null = null;
  private started = false;

  constructor(private readonly emit: (event: HotkeyEvent) => void) {}

  async init(): Promise<boolean> {
    try {
      const mod = (await import('uiohook-napi')) as UiohookModule & { default?: UiohookModule };
      this.hook = mod.uIOhook ? mod : mod.default!;
      for (const [name, code] of Object.entries(this.hook.UiohookKey)) {
        if (!this.keyNames.has(code)) this.keyNames.set(code, name);
      }
      this.hook.uIOhook.on('keydown', (e) => this.onKeyDown(e));
      this.hook.uIOhook.on('keyup', (e) => this.onKeyUp(e));
      this.hook.uIOhook.on('mousedown', (e) => this.onMouse(e, true));
      this.hook.uIOhook.on('mouseup', (e) => this.onMouse(e, false));
      return true;
    } catch (err) {
      console.warn('Global kısayollar kullanılamıyor:', err);
      this.hook = null;
      return false;
    }
  }

  get available(): boolean {
    return this.hook !== null;
  }

  setConfig(config: HotkeyConfig): void {
    this.config = config;
    this.releasePtt();
    this.updateRunning();
  }

  record(): Promise<Keybind | null> {
    this.cancelRecord();
    return new Promise((resolve) => {
      this.recording = resolve;
      this.recordingModifier = null;
      this.updateRunning();
    });
  }

  cancelRecord(): void {
    this.finishRecording(null);
  }

  /** Basılı bilinen her şeyi bırakır: uyku/kilit sırasında bırakılan tuşun keyup olayı hiç gelmez. */
  releaseAll(): void {
    this.pressedKeys.clear();
    this.releasePtt();
  }

  stop(): void {
    if (this.started) this.hook?.uIOhook.stop();
    this.started = false;
  }

  /** Kanca yalnızca atanmış kısayol varken veya kayıt sırasında çalışır. */
  private updateRunning(): void {
    if (!this.hook) return;
    const { pushToTalk, toggleMute, toggleDeafen } = this.config;
    const needed = Boolean(this.recording || pushToTalk || toggleMute || toggleDeafen);
    if (needed && !this.started) {
      this.hook.uIOhook.start();
      this.started = true;
    } else if (!needed && this.started) {
      this.hook.uIOhook.stop();
      this.started = false;
    }
  }

  private finishRecording(bind: Keybind | null): void {
    const resolve = this.recording;
    this.recording = null;
    this.recordingModifier = null;
    resolve?.(bind);
    this.updateRunning();
  }

  private keyLabel(e: { keycode: number; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): string {
    const parts: string[] = [];
    const isModifier = MODIFIER_CODES.has(e.keycode);
    if (!isModifier) {
      if (e.ctrl) parts.push('Ctrl');
      if (e.alt) parts.push('Alt');
      if (e.shift) parts.push('Shift');
      if (e.meta) parts.push('Meta');
    }
    parts.push(this.keyNames.get(e.keycode) ?? `Tuş ${e.keycode}`);
    return parts.join('+');
  }

  private toKeybind(e: KeyEvent, withModifiers: boolean): Keybind {
    const mods = withModifiers
      ? { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
      : { ctrl: false, alt: false, shift: false, meta: false };
    return { kind: 'key', keycode: e.keycode, ...mods, label: this.keyLabel({ keycode: e.keycode, ...mods }) };
  }

  private onKeyDown(e: KeyEvent): void {
    const repeat = this.pressedKeys.has(e.keycode);
    this.pressedKeys.add(e.keycode);

    if (this.recording) {
      if (e.keycode === ESCAPE) return this.finishRecording(null);
      if (MODIFIER_CODES.has(e.keycode)) {
        // Tek başına değiştirici tuş (ör. Alt) de atanabilir: bırakılınca kaydedilir.
        this.recordingModifier = e;
        return;
      }
      return this.finishRecording(this.toKeybind(e, true));
    }
    if (repeat) return;

    const { pushToTalk } = this.config;
    if (pushToTalk?.kind === 'key' && pushToTalk.keycode === e.keycode) this.pressPtt();
    this.matchToggle('toggleMute', e);
    this.matchToggle('toggleDeafen', e);
  }

  private onKeyUp(e: KeyEvent): void {
    this.pressedKeys.delete(e.keycode);
    if (this.recording) {
      if (this.recordingModifier && this.recordingModifier.keycode === e.keycode) {
        this.finishRecording(this.toKeybind(this.recordingModifier, false));
      }
      return;
    }
    const { pushToTalk } = this.config;
    if (pushToTalk?.kind === 'key' && pushToTalk.keycode === e.keycode) this.releasePtt();
  }

  private onMouse(e: MouseEvent, down: boolean): void {
    const button = Number(e.button);
    if (!(button in MOUSE_LABELS)) return; // sol/sağ tık atanamaz
    if (this.recording) {
      if (down) this.finishRecording({ kind: 'mouse', button, label: MOUSE_LABELS[button]! });
      return;
    }
    const { pushToTalk, toggleMute, toggleDeafen } = this.config;
    if (pushToTalk?.kind === 'mouse' && pushToTalk.button === button) {
      if (down) this.pressPtt();
      else this.releasePtt();
    }
    if (!down) return;
    if (toggleMute?.kind === 'mouse' && toggleMute.button === button) this.emit({ action: 'toggleMute', pressed: true });
    if (toggleDeafen?.kind === 'mouse' && toggleDeafen.button === button) {
      this.emit({ action: 'toggleDeafen', pressed: true });
    }
  }

  private matchToggle(action: Exclude<HotkeyAction, 'pushToTalk'>, e: KeyEvent): void {
    const bind = this.config[action];
    if (bind?.kind !== 'key' || bind.keycode !== e.keycode) return;
    const isModifier = MODIFIER_CODES.has(e.keycode);
    if (
      !isModifier &&
      (bind.ctrl !== e.ctrlKey || bind.alt !== e.altKey || bind.shift !== e.shiftKey || bind.meta !== e.metaKey)
    ) {
      return;
    }
    this.emit({ action, pressed: true });
  }

  private pressPtt(): void {
    if (this.pttDown) return;
    this.pttDown = true;
    this.emit({ action: 'pushToTalk', pressed: true });
  }

  private releasePtt(): void {
    if (!this.pttDown) return;
    this.pttDown = false;
    this.emit({ action: 'pushToTalk', pressed: false });
  }
}
