import { NativeModule, requireOptionalNativeModule } from 'expo';

type ScreenBroadcastEvents = {
  /** Yayın eklentisi çalışmaya başladı (uygulamadan ya da Kontrol Merkezi'nden) */
  onStarted: () => void;
  /** Yayın eklentisi durdu (kırmızı durum çubuğu, Kontrol Merkezi, ana uygulama) */
  onStopped: () => void;
};

/** iOS ekran yayını: sistem seçicisi ve yayın eklentisiyle (Broadcast Upload Extension) haberleşme. */
declare class ScreenBroadcastModule extends NativeModule<ScreenBroadcastEvents> {
  /** Sistem seçicisini açar; false: açılamadı (seçicinin düğmesi bulunamadı) */
  showPicker(): Promise<boolean>;
  /** Yayın eklentisi şu an çalışıyor mu */
  isActive(): Promise<boolean>;
  /** Çalışan yayın eklentisine durmasını söyler */
  stop(): void;
}

/** Yerel modül yalnızca iOS'ta var; Android'de ekran paylaşımı MediaProjection ile yapılır (null) */
export default requireOptionalNativeModule<ScreenBroadcastModule>('ScreenBroadcast');
