import { reportClientError } from './errors';

/** Günlük bağlamını kısaltır ve içindeki erişim jetonlarını gizler. */
function describe(context: unknown): string {
  if (context === undefined) return '';
  let text: string;
  try {
    // Error/DOMException JSON'da `{}` olur; tür ve ileti açıkça yazılır
    text =
      typeof context === 'string'
        ? context
        : context instanceof Error
          ? `${context.name}: ${context.message}`
          : JSON.stringify(context);
  } catch {
    text = String(context);
  }
  return ` ${text.replace(/(access_token=|"token":")[^&"\s]+/g, '$1…').slice(0, 300)}`;
}

/**
 * LiveKit istemcisinin uyarı ve hatalarını sunucu kayıtlarına gönderir (bağlantı sorunlarının nedenini
 * görmek için). Platform, livekit-client'ın setLogExtension'ına bunu verir. `inVoice`: şu an seste mi;
 * sesten çıkıldıktan sonra kapatılmış bağlantının geç gelen uyarıları (ör. "ping timeout") hata sayılmaz.
 */
export function reportVoiceLog(
  level: number,
  warnLevel: number,
  message: string,
  context?: unknown,
  inVoice = true,
): void {
  if (level < warnLevel) return;
  if (!inVoice && AFTER_LEAVE.test(message)) return;
  reportClientError(new Error(`${message}${describe(context)}`), 'livekit');
}

/** Sesten çıkınca eski bağlantıdan gelebilen, sorun olmayan uyarılar */
const AFTER_LEAVE = /ping timeout|websocket closed|could not (send|receive)|signal.*(closed|disconnect)/i;

/**
 * "Bu hesapla başka bir cihazdan bağlanıldı" (DUPLICATE_IDENTITY) çoğu zaman gerçekten başka bir cihaz
 * değildir: LiveKit bağlantıyı baştan kurarken (tam yeniden bağlanma) sunucu eski oturumumuzu bu gerekçeyle
 * kapatır ve bu kapanış bazen yeni bağlantıya da yansır. Yeniden bağlanmanın hemen ardından gelirse
 * kullanıcıya hata göstermeden kanala sessizce yeniden girilir (sonsuz döngüye girmemek için dakikada bir).
 */
export class SpuriousDuplicateGuard {
  private lastReconnectAt = 0;
  private lastRejoinAt = 0;

  /** Reconnecting / SignalReconnecting / Reconnected olaylarında çağrılır */
  noteReconnect(): void {
    this.lastReconnectAt = Date.now();
  }

  /** Bu kopuş sessizce yeniden bağlanarak geçiştirilmeli mi */
  shouldRejoin(duplicateIdentity: boolean): boolean {
    const now = Date.now();
    if (!duplicateIdentity || now - this.lastReconnectAt > 30_000 || now - this.lastRejoinAt < 60_000) return false;
    this.lastRejoinAt = now;
    return true;
  }
}
