import { NativeModule, requireOptionalNativeModule } from 'expo';
import type { VoiceServiceModuleEvents } from './VoiceService.types';

/** Android ön plan servisi: sesli sohbet sürerken uygulamayı arka planda canlı tutar. */
declare class VoiceServiceModule extends NativeModule<VoiceServiceModuleEvents> {
  start(title: string, text: string, muted: boolean): void;
  update(title: string, text: string, muted: boolean): void;
  stop(): void;
  /** Arka planda da dolan zamanlayıcı (dolunca onTimer); yalnızca bu işlevi taşıyan APK'da var */
  setTimer?(id: number, delayMs: number): void;
  clearTimer?(id: number): void;
}

/**
 * Yerel modül yalnızca Android'de var. iOS'ta arka planda sesi "audio" arka plan kipi ve LiveKit'in
 * yönettiği AVAudioSession canlı tutar; ön plan servisi ve bildirim düğmeleri yoktur (bkz. docs/ios.md).
 */
const noop: Pick<VoiceServiceModule, 'start' | 'update' | 'stop' | 'addListener'> = {
  start: () => undefined,
  update: () => undefined,
  stop: () => undefined,
  addListener: () => ({ remove: () => undefined }),
};

export default (requireOptionalNativeModule<VoiceServiceModule>('VoiceService') ?? noop) as VoiceServiceModule;
