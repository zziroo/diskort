import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { LaunchMode } from './startup';

/**
 * Tepsi (macOS'ta menü çubuğu) simgesi isteğe bağlıdır. Simge gizliyken pencereye dönmenin yolu macOS'ta
 * Dock simgesidir; Windows ve Linux'ta görev çubuğudur, bu yüzden orada pencere gizlenmez, simge durumuna
 * küçültülür.
 */

export interface TrayContext {
  /** Simge şu an var mı */
  hasTray: boolean;
  isMac: boolean;
}

export type CloseAction = 'close' | 'hide' | 'minimize';

/**
 * Pencerenin kapatma düğmesine basılınca ne olacağı. Simge gizliyken Windows/Linux'ta zaten küçültülmüş
 * pencereye gelen kapatma isteği (görev çubuğunda "Pencereyi kapat") gerçekten kapatır: Ayarlar'daki Çık
 * düğmesine ulaşılamayan ekranlarda (giriş, zorunlu güncelleme) da çıkış yolu kalsın.
 */
export function closeAction(
  opts: TrayContext & { quitting: boolean; minimizeToTray: boolean; isMinimized: boolean },
): CloseAction {
  if (opts.quitting || !opts.minimizeToTray) return 'close';
  if (opts.hasTray || opts.isMac) return 'hide';
  return opts.isMinimized ? 'close' : 'minimize';
}

/** Sessiz güncellemeden sonraki açılış: simge yoksa Windows/Linux'ta gizli pencere bulunamaz, küçültülmüş açılır. */
export function launchModeFor(mode: LaunchMode, ctx: TrayContext): LaunchMode {
  if (mode === 'hidden' && !ctx.hasTray && !ctx.isMac) return 'minimized';
  return mode;
}

// ---------- Tercihin saklanması ----------
// Tercih arayüzün ayarlarındadır; ana süreç simgeyi arayüz yüklenmeden (açılışta) oluşturduğu için
// son değeri bir dosyada da tutar. Kayıt yoksa simge gösterilir.

const trayIconFile = (): string => join(app.getPath('userData'), 'tray-icon');

export function savedShowTrayIcon(): boolean {
  try {
    const file = trayIconFile();
    if (!existsSync(file)) return true;
    return readFileSync(file, 'utf8').trim() !== 'hidden';
  } catch {
    return true;
  }
}

export function saveShowTrayIcon(show: boolean): void {
  try {
    writeFileSync(trayIconFile(), show ? 'shown' : 'hidden');
  } catch {
    // önemli değil: arayüz yüklenince tercihini yine bildirir
  }
}
