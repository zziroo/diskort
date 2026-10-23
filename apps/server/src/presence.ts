import {
  ACTIVITY_ELAPSED_MAX_MS,
  ACTIVITY_ICON_KEY_PATTERN,
  ACTIVITY_MAX_COUNT,
  ACTIVITY_NAME_MAX_LENGTH,
  isSteamAppId,
  type Activity,
  type CustomStatus,
  type SelfStatus,
  type UserStatus,
} from '@diskort/shared';
import type { StatusRow, Store } from './db.js';

/** Hiç ayarlamamış hesabın durumu */
export const DEFAULT_STATUS: SelfStatus = { status: 'online', expiresAt: null, customStatus: null, customStatusExpiresAt: null };

/** Satır sonları ve görünmez denetim karakterleri tek boşluğa iner */
export const cleanText = (raw: string): string =>
  raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Kaydedilmiş satırın geçerli yorumu: süresi geçmiş değerler yok sayılır */
function toSelfStatus(row: StatusRow | undefined, now: number): SelfStatus {
  if (!row) return DEFAULT_STATUS;
  const statusLive = row.status_expires_at === null || row.status_expires_at > now;
  const customLive =
    (row.custom_text !== null || row.custom_emoji !== null) &&
    (row.custom_expires_at === null || row.custom_expires_at > now);
  return {
    status: statusLive ? row.status : 'online',
    expiresAt: statusLive && row.status !== 'online' ? row.status_expires_at : null,
    customStatus: customLive ? { text: row.custom_text, emoji: row.custom_emoji } : null,
    customStatusExpiresAt: customLive ? row.custom_expires_at : null,
  };
}

export interface StatusChange {
  status?: UserStatus;
  expiresInMs?: number | null;
  customStatus?: (CustomStatus & { expiresInMs?: number | null }) | null;
}

/**
 * Hesabın kendi seçtiği durum (kalıcı; tüm cihazlarda aynı) ve özel durumu. Başkalarına görünen durum
 * (bağlı oturumlar ve otomatik "boşta" ile birleşik hâli) gateway'de hesaplanır.
 */
export class StatusStore {
  constructor(private readonly store: Store) {}

  get(userId: string, now = Date.now()): SelfStatus {
    return toSelfStatus(this.store.getStatusRow(userId), now);
  }

  /** Değişikliği uygular; verilmeyen alanlar olduğu gibi kalır. Yeni durumu döner. */
  set(userId: string, change: StatusChange, now = Date.now()): SelfStatus {
    const current = this.get(userId, now);
    let status = current.status;
    let expiresAt = current.expiresAt;
    if (change.status !== undefined) {
      status = change.status;
      // Çevrim içi süresizdir (zaten varsayılan)
      expiresAt = status !== 'online' && change.expiresInMs ? now + change.expiresInMs : null;
    }
    let custom = current.customStatus;
    let customExpiresAt = current.customStatusExpiresAt;
    if (change.customStatus !== undefined) {
      const c = change.customStatus;
      custom = c && (c.text || c.emoji) ? { text: c.text || null, emoji: c.emoji || null } : null;
      customExpiresAt = custom && c?.expiresInMs ? now + c.expiresInMs : null;
    }
    this.store.saveStatusRow({
      user_id: userId,
      status,
      status_expires_at: expiresAt,
      custom_text: custom?.text ?? null,
      custom_emoji: custom?.emoji ?? null,
      custom_expires_at: customExpiresAt,
    });
    return this.get(userId, now);
  }

  /** Süresi dolanları varsayılana çeker; değişen hesapları döner */
  expire(now = Date.now()): string[] {
    return this.store.expireStatuses(now);
  }

  /** Rahatsız Etmeyin'deki hesaplar hariç (telefon bildirimi gidecekler) */
  withoutDnd(userIds: string[], now = Date.now()): string[] {
    const dnd = this.store.dndUserIds(userIds, now);
    return dnd.size === 0 ? userIds : userIds.filter((id) => !dnd.has(id));
  }
}

/** Aynı oyun yeniden bildirildiğinde başlangıç bu kadardan az oynadıysa eski başlangıç korunur */
export const ACTIVITY_START_TOLERANCE_MS = 60_000;

/** Aynı etkinlik mi (başlangıç ve ikon sayılmaz): tür + ad */
export const activityKey = (a: Pick<Activity, 'type' | 'name'>): string => `${a.type}\0${a.name}`;

/**
 * Görünmeyen ama "harf" ya da "simge" sayılan karakterler: sıfır genişlikliler, yön değiştirenler (bidi),
 * Hangul dolgu harfleri, boş Braille. Kaynakta görünmesinler diye hepsi \u kaçışıyla yazılır.
 */
const INVISIBLE_CHARS =
  /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufeff\uffa0]/g;
/** Adda görünen en az bir karakter (harf, rakam, noktalama ya da simge) olmalı */
const VISIBLE_CHAR = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * Etkinlik adı: özel durumdaki temizliğe ek olarak görünmeyen karakterler de atılır (görünmez ad ya da
 * yazıyı ters çeviren ad olmasın); geriye görünen bir şey kalmadıysa boş döner (geçersiz).
 */
const cleanActivityName = (raw: string): string => {
  const clean = cleanText(raw.replace(INVISIBLE_CHARS, ''));
  return VISIBLE_CHAR.test(clean) ? clean : '';
};

/** Tek bir bildirimi (güvenilmez) doğrular; geçersizse null */
function parseActivityReport(raw: unknown, iconExists: (key: string) => boolean, now: number): Activity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, name, icon, elapsedMs, steamAppId } = raw as Record<string, unknown>;
  if (type !== 'game') return null;
  if (typeof name !== 'string' || name.length > ACTIVITY_NAME_MAX_LENGTH * 4) return null;
  const clean = cleanActivityName(name);
  if (!clean || [...clean].length > ACTIVITY_NAME_MAX_LENGTH) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return null;
  const elapsed = Math.round(Math.min(ACTIVITY_ELAPSED_MAX_MS, Math.max(0, elapsedMs)));
  const known = typeof icon === 'string' && ACTIVITY_ICON_KEY_PATTERN.test(icon) && iconExists(icon);
  // Steam kimliği isteğe bağlıdır: eski istemci göndermez, geçersiz değer (rakam dışı, uzun) atılır
  return {
    type,
    name: clean,
    icon: known ? icon : null,
    startedAt: now - elapsed,
    ...(isSteamAppId(steamAppId) ? { steamAppId } : {}),
  };
}

/**
 * ACTIVITY_SET'teki listeyi (güvenilmez) doğrular; liste değilse undefined (mesaj yok sayılır). Geçersiz
 * öğeler atlanır, aynı oyun bir kez alınır, en fazla ACTIVITY_MAX_COUNT geçerli öğe alınır. Ad temizlenir,
 * süre sınırlanır, başlangıç sunucu saatiyle hesaplanır; sunucuda olmayan ikon null sayılır (istemci ikonu
 * sonradan yükleyip yeniden bildirebilir).
 */
export function parseActivityReports(
  raw: unknown,
  iconExists: (key: string) => boolean,
  now = Date.now(),
): Activity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = new Map<string, Activity>();
  for (const item of raw) {
    if (result.size >= ACTIVITY_MAX_COUNT) break;
    const activity = parseActivityReport(item, iconExists, now);
    if (activity && !result.has(activityKey(activity))) result.set(activityKey(activity), activity);
  }
  return [...result.values()];
}

/** En son başlayan ilk sırada (eşitlikte ada göre: sıra bildirim sırasından bağımsız olsun) */
const byLatest = (a: Activity, b: Activity): number =>
  b.startedAt - a.startedAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Oturumun yeni etkinlik listesi: bir oyun yeniden bildirildiyse (ör. istemci yeniden taradı ya da yeniden
 * bağlandı) ve başlangıcı pek oynamadıysa bilinen başlangıç korunur; böylece boşuna PRESENCE_UPDATE
 * yayınlanmaz ve süre sayacı zıplamaz. `known`: oturumun önceki listesi, ardından kişinin öteki
 * oturumlarınınkiler (aynı oyun için ilk eşleşen geçerlidir).
 */
export function mergeActivities(known: readonly Activity[], next: readonly Activity[]): Activity[] {
  return next
    .map((activity) => {
      const key = activityKey(activity);
      const prev = known.find(
        (k) => activityKey(k) === key && Math.abs(k.startedAt - activity.startedAt) <= ACTIVITY_START_TOLERANCE_MS,
      );
      return prev ? { ...activity, startedAt: prev.startedAt } : activity;
    })
    .sort(byLatest);
}

/**
 * Kişinin görünen etkinlikleri: oturumlarının listelerinin birleşimi, en son başlayan ilk sırada, en fazla
 * ACTIVITY_MAX_COUNT. Aynı oyun birkaç oturumdaysa tek öğe kalır: başlangıçlar birbirine yakınsa (yeniden
 * bağlanmada eski oturum henüz düşmemiş) eskisi, değilse en son başlayan; ikonu olan tercih edilir.
 */
export function combineActivities(lists: Iterable<readonly Activity[]>): Activity[] {
  const result = new Map<string, Activity>();
  for (const list of lists) {
    for (const activity of list) {
      const key = activityKey(activity);
      const other = result.get(key);
      if (!other) {
        result.set(key, activity);
        continue;
      }
      const near = Math.abs(other.startedAt - activity.startedAt) <= ACTIVITY_START_TOLERANCE_MS;
      const startedAt = near
        ? Math.min(other.startedAt, activity.startedAt)
        : Math.max(other.startedAt, activity.startedAt);
      const kept = startedAt === other.startedAt ? other : activity;
      const steamAppId = kept.steamAppId ?? other.steamAppId ?? activity.steamAppId;
      result.set(key, { ...kept, icon: kept.icon ?? other.icon ?? activity.icon, ...(steamAppId ? { steamAppId } : {}) });
    }
  }
  return [...result.values()].sort(byLatest).slice(0, ACTIVITY_MAX_COUNT);
}
