import { api } from './api';
import { tokenExpiresAt, useSession } from './session';

/** Dolma anı uzaksa bu aralıkla yeniden bakılır (uyku/saat değişikliği kaçmasın) */
const RECHECK_MAX_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let watchedToken: string | null = null;

/**
 * Oturum jetonunun süresi dolunca uygulamanın (ses kanalında bile) hiçbir şey olmamış gibi sürmesini önler:
 * dolma anında sunucuya sorulur (`/api/me`); jeton gerçekten geçersizse istek 401 döner ve `request` oturumu
 * kapatır (giriş ekranı, ses kanalından çıkış). Yanıt 200 ise bu cihazın saati ileridir, bir saat sonra
 * yeniden bakılır. Sunucu jetonu kullanımda yenilediğinden (SESSION_TOKEN) bu yol ancak bir ay kapalı kalan
 * uygulamada açılışta ya da ağsız geçen çok uzun sürede işler.
 */
export function watchSessionExpiry(): void {
  useSession.subscribe((s) => {
    if (s.token === watchedToken) return;
    watchedToken = s.token;
    schedule();
  });
  watchedToken = useSession.getState().token;
  schedule();
}

/** Sunucu ulaşılamazken yeniden deneme aralığı */
const RETRY_MS = 60 * 1000;

/** `delayMs` verilmezse dolma anına kadar (en çok RECHECK_MAX_MS) beklenir */
function schedule(delayMs?: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const token = watchedToken;
  if (!token) return;
  const expiresAt = tokenExpiresAt(token);
  if (expiresAt === null) return;
  const delay = delayMs ?? Math.max(1000, Math.min(expiresAt - Date.now(), RECHECK_MAX_MS));
  timer = setTimeout(() => {
    timer = null;
    if (useSession.getState().token !== token) return;
    if (expiresAt - Date.now() > 0) {
      schedule();
      return;
    }
    // 401 → request() oturumu kapatır. 200 → cihazın saati ileride, bir saat sonra yine sorulur.
    // Başka hata (ağ yok) → kısa süre sonra yeniden
    void api.me().then(
      () => schedule(RECHECK_MAX_MS),
      () => {
        if (useSession.getState().token === token) schedule(RETRY_MS);
      },
    );
  }, delay);
}
