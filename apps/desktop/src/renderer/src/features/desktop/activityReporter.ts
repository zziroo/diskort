import { ensureActivityIcon, setActivities } from '@diskort/client-core';
import type { ActivityGame } from '../../../../shared/bridge';

/** İkon yüklemeleri en çok bu kadar beklenir; yetişmeyen ikon sonradan eklenir */
const ICON_WAIT_MS = 1500;

/** Her bildirimde artar: eski bir bildirimin geç biten ikon yüklemesi yenisini ezmesin */
let generation = 0;

/**
 * Ana sürecin algıladığı açık oyunları sunucuya bildirir (boş liste: oyun yok ya da "Oynadığım oyunu göster"
 * kapalı). Sunucu bilmediği ikon anahtarını ikonsuz saydığından ikonlar önce yüklenir (çoğu zaten sunucudadır,
 * sorması kısa sürer) ve liste tek seferde bildirilir: sunucu sık bildirimi sınırlar. Yükleme uzarsa liste
 * ikonsuz bildirilir, biten ikonla yeniden; yüklenemeyen (eski sunucu, ağ hatası) ikonsuz kalır.
 */
export function reportActivities(games: readonly ActivityGame[], readIcon: (key: string) => Promise<Uint8Array | null>): void {
  const run = ++generation;
  /** Sunucuda olduğu kesinleşen ikonlar */
  const ready = new Set<string>();
  const send = (): void =>
    setActivities(
      games.map((game) => ({
        type: 'game',
        name: game.name,
        icon: game.icon && ready.has(game.icon) ? game.icon : null,
        elapsedMs: Math.max(0, Date.now() - game.startedAt),
        steamAppId: game.steamAppId,
      })),
    );

  const keys = [...new Set(games.map((game) => game.icon).filter((key) => key !== null))];
  if (keys.length === 0) {
    send();
    return;
  }
  let pending = keys.length;
  let sent = false;
  for (const key of keys) {
    void ensureActivityIcon(key, () => readIcon(key)).then((ok) => {
      if (ok) ready.add(key);
      pending--;
      if (run === generation && (pending === 0 || sent)) send();
    });
  }
  setTimeout(() => {
    if (run !== generation || pending === 0) return;
    sent = true;
    send();
  }, ICON_WAIT_MS);
}
