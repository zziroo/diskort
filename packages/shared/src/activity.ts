// Etkinlik: kişinin o an yaptığı şey (şimdilik yalnızca oynadığı oyun). Kalıcı değildir; bildiren
// oturum kapanınca ya da kişi görünmez olunca kaybolur. Aynı anda birden çok etkinlik olabilir (iki oyun
// açık): liste en son başlayandan eskiye sıralıdır, ilki "asıl" etkinliktir (satırlarda o görünür).

/** Etkinlik türü; ileride 'listening' (müzik) gibi türler eklenebilir: bilinmeyen tür gösterilmez */
export type ActivityType = 'game';

/** Başkalarının gördüğü etkinlik */
export interface Activity {
  type: ActivityType;
  /** Oyunun adı */
  name: string;
  /** İkon anahtarı (bkz. ACTIVITY_ICON_KEY_PATTERN); ikon yoksa null */
  icon: string | null;
  /** Başladığı an (ms, sunucu saati) */
  startedAt: number;
  /**
   * Steam uygulama kimliği (yalnızca rakam, en çok STEAM_APP_ID_MAX_LENGTH hane): oyun Steam kütüphane
   * kaydından tanındıysa; Epic, Battle.net ve elle eklenen oyunlarda ya da eski istemciden gelen bildirimde
   * yok/null. Oyun sayfasındaki mağaza bağlantıları bununla kurulur.
   */
  steamAppId?: string | null;
}

/**
 * ACTIVITY_SET gövdesindeki tek etkinlik. Başlangıç istemcinin saatinden bağımsız olsun diye "şu ana dek geçen süre"
 * olarak gönderilir; sunucu `startedAt`'i kendi saatiyle hesaplar.
 */
export interface ActivityReport {
  type: ActivityType;
  name: string;
  icon: string | null;
  elapsedMs: number;
  /** Bkz. Activity.steamAppId; eski istemci göndermez */
  steamAppId?: string | null;
}

export const ACTIVITY_NAME_MAX_LENGTH = 64;
/** Steam uygulama kimliği: yalnızca rakam, en çok bu kadar hane */
export const STEAM_APP_ID_MAX_LENGTH = 10;
export const STEAM_APP_ID_PATTERN = /^[0-9]{1,10}$/;
/** Geçerli Steam uygulama kimliği mi (sunucu ve istemci aynı kuralı kullanır) */
export const isSteamAppId = (value: unknown): value is string => typeof value === 'string' && STEAM_APP_ID_PATTERN.test(value);
/** Bildirilebilecek en uzun geçmiş süre (saat hatası ya da kötü niyetli değerlere karşı) */
export const ACTIVITY_ELAPSED_MAX_MS = 7 * 24 * 60 * 60_000;

/** İkon: PNG, kare, en fazla bu kenar ve bu boyut. Anahtarı dosyanın SHA-256'sı (küçük harf onaltılık) */
export const ACTIVITY_ICON_MAX_SIZE_PX = 128;
export const ACTIVITY_ICON_MAX_BYTES = 64 * 1024;
export const ACTIVITY_ICON_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** İkonun yolu: PUT ile yüklenir (gövde PNG), GET ile okunur */
export const activityIconPath = (key: string): string => `/api/activity-icons/${key}`;

/** Etkinlik türünün başlığı (kartta: "Oynuyor") */
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  game: 'Oynuyor',
};

/** Bir kişinin aynı anda taşıyabileceği en fazla etkinlik (birden çok oyun açıksa) */
export const ACTIVITY_MAX_COUNT = 4;

/** İstemcinin gösterebildiği türden mi (ileride eklenecek türleri eski istemci göstermez) */
export const isKnownActivity = (a: Activity): boolean => Object.hasOwn(ACTIVITY_TYPE_LABELS, a.type);

export const sameActivity = (a: Activity | null | undefined, b: Activity | null | undefined): boolean =>
  (a ?? null) === (b ?? null) ||
  (!!a &&
    !!b &&
    a.type === b.type &&
    a.name === b.name &&
    a.icon === b.icon &&
    a.startedAt === b.startedAt &&
    (a.steamAppId ?? null) === (b.steamAppId ?? null));

export const sameActivities = (a: readonly Activity[] | undefined, b: readonly Activity[] | undefined): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((item, i) => sameActivity(item, y[i]));
};
