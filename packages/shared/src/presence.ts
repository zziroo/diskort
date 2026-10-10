// Kullanıcı durumu (çevrim içi / boşta / rahatsız etmeyin / görünmez) ve özel durum.

import type { Activity } from './activity';

/** Kullanıcının kendi seçtiği durum (hesap başına; tüm cihazlarında aynı) */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';

/**
 * Başkalarının gördüğü durum. Görünmez kullanıcı başkalarına (ve kendi durum listesine) 'offline' görünür;
 * gerçek seçimi yalnızca kendi istemcilerine USER_STATUS_UPDATE / READY.status ile gider.
 */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Özel durum: kısa metin ve/veya tek bir emoji */
export interface CustomStatus {
  text: string | null;
  emoji: string | null;
}

/** Bir kullanıcının başkalarına görünen anlık durumu */
export interface Presence {
  status: PresenceStatus;
  /** Yalnızca çevrimdışı görünmeyen kullanıcılarda */
  customStatus: CustomStatus | null;
  /** O an yaptıkları (oynadığı oyunlar), en son başlayan ilk sırada; eski sunucuda alan yok */
  activities?: Activity[];
  /**
   * Bağlı oturumlarının hepsi telefonda (Android / iOS): durum noktası telefon biçiminde çizilir. Yalnızca
   * doğruyken gönderilir; alan yoksa (masaüstünde de bağlı ya da eski sunucu) normal nokta.
   */
  mobile?: boolean;
}

/** Kullanıcının kendi durum ayarları (yalnızca kendi istemcilerine gider) */
export interface SelfStatus {
  status: UserStatus;
  /** Seçilen durumun biteceği an (ms); sonra 'online'a döner. Süresizse null */
  expiresAt: number | null;
  customStatus: CustomStatus | null;
  /** Özel durumun temizleneceği an (ms); temizlenmeyecekse null */
  customStatusExpiresAt: number | null;
}

/**
 * PATCH /api/me/status gövdesi. Verilmeyen alan değişmez. Süreler istemcinin saatinden bağımsız olsun diye
 * "şu andan itibaren" milisaniye olarak gönderilir (ör. "Bugün" = gece yarısına kalan süre).
 */
export interface UpdateStatusRequest {
  status?: UserStatus;
  /** Durumun süresi; null ya da verilmezse süresiz */
  expiresInMs?: number | null;
  /** null: özel durumu temizle */
  customStatus?: (CustomStatus & { expiresInMs?: number | null }) | null;
}

export const CUSTOM_STATUS_MAX_LENGTH = 128;
/** Durum/özel durum süresinin sınırları */
export const STATUS_DURATION_MIN_MS = 60_000;
export const STATUS_DURATION_MAX_MS = 31 * 24 * 60 * 60_000;
/** Masaüstü bu kadar süre girdi almazsa otomatik "Boşta" olur */
export const AUTO_IDLE_AFTER_MS = 10 * 60_000;

export const OFFLINE_PRESENCE: Presence = { status: 'offline', customStatus: null };

/** Durum seçeneklerinin adları */
export const STATUS_LABELS: Record<UserStatus | 'offline', string> = {
  online: 'Çevrim içi',
  idle: 'Boşta',
  dnd: 'Rahatsız Etmeyin',
  invisible: 'Görünmez',
  offline: 'Çevrimdışı',
};

/** Seçim menüsündeki açıklamalar */
export const STATUS_DESCRIPTIONS: Partial<Record<UserStatus, string>> = {
  dnd: 'Bildirim almayacaksın',
  invisible: 'Çevrimdışı görüneceksin',
};

/** Durumun süre seçenekleri (Boşta / Rahatsız Etmeyin / Görünmez); null: süresiz */
export const STATUS_DURATIONS: readonly { label: string; ms: number | null }[] = [
  { label: '15 dakika', ms: 15 * 60_000 },
  { label: '1 saat', ms: 60 * 60_000 },
  { label: '8 saat', ms: 8 * 60 * 60_000 },
  { label: '24 saat', ms: 24 * 60 * 60_000 },
  { label: '3 gün', ms: 3 * 24 * 60 * 60_000 },
  { label: 'Süresiz', ms: null },
];

/** Özel durumun "Şundan sonra temizle" seçenekleri; 'today': yerel gece yarısına kadar, null: temizleme */
export const CUSTOM_STATUS_CLEAR_OPTIONS: readonly { label: string; ms: number | 'today' | null }[] = [
  { label: 'Bugün', ms: 'today' },
  { label: '4 saat', ms: 4 * 60 * 60_000 },
  { label: '1 saat', ms: 60 * 60_000 },
  { label: '30 dakika', ms: 30 * 60_000 },
  { label: 'Temizleme', ms: null },
];

/** "Şundan sonra temizle" seçeneğinin şu andan itibaren süresi (ms) */
export function clearAfterMs(option: number | 'today' | null, now: Date = new Date()): number | null {
  if (option !== 'today') return option;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(STATUS_DURATION_MIN_MS, midnight.getTime() - now.getTime());
}

/**
 * Kendi durumunun görünen hâli: seçtiğin durum (görünmez dahil); "Çevrim içi" seçiliyken tüm cihazların
 * boştaysa otomatik "Boşta". Eski sunucuda (ayar yok) başkalarının gördüğü.
 */
export function ownDisplayStatus(self: SelfStatus | null, presence: Presence | undefined): UserStatus | 'offline' {
  if (!self) return presence && presence.status !== 'offline' ? presence.status : 'online';
  if (self.status !== 'online') return self.status;
  return presence?.status === 'idle' ? 'idle' : 'online';
}
