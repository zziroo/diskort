import {
  ACTIVITY_ICON_KEY_PATTERN,
  activityIconPath,
  isKnownActivity,
  clearAfterMs,
  ownDisplayStatus,
  type Activity,
  type CustomStatus,
  type SelfStatus,
  type UpdateStatusRequest,
  type UserStatus,
} from '@diskort/shared';
import { normalizeServerUrl, request } from './api';
import { env } from './env';
import { useGuild, type GuildStore } from './guild';
import { useSession } from './session';

/** Durum noktasının gösterimi: kendi durumunda 'invisible' da olabilir */
export type DisplayStatus = UserStatus | 'offline';

/** Kişinin gösterilecek durumu; kendin için seçtiğin görünmezlik de görünür */
export function displayStatusOf(
  s: Pick<GuildStore, 'presences' | 'selfStatus'>,
  userId: string | null | undefined,
  selfId: string | null | undefined,
): DisplayStatus {
  if (!userId) return 'offline';
  if (userId === selfId) return ownDisplayStatus(s.selfStatus, s.presences[userId]);
  return s.presences[userId]?.status ?? 'offline';
}

/** Kişinin durumu (değer döner: seçici kararlıdır) */
export function useStatus(userId: string | null | undefined): DisplayStatus {
  const selfId = useSession((s) => s.user?.id);
  return useGuild((s) => displayStatusOf(s, userId, selfId));
}

/**
 * Kişi yalnızca telefondan bağlı mı (durum noktası telefon biçiminde çizilir). Çevrimdışı görünen (görünmez
 * dahil) kişide ve eski sunucuda hep false.
 */
export function onMobileOf(s: Pick<GuildStore, 'presences'>, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const p = s.presences[userId];
  return p !== undefined && p.status !== 'offline' && p.mobile === true;
}

/** Kişi yalnızca telefondan bağlı mı (değer döner: seçici kararlıdır) */
export function useOnMobile(userId: string | null | undefined): boolean {
  return useGuild((s) => onMobileOf(s, userId));
}

/** Kişinin özel durumu; kendininki görünmezken de gösterilir */
export function useCustomStatus(userId: string | null | undefined): CustomStatus | null {
  const selfId = useSession((s) => s.user?.id);
  return useGuild((s) => {
    if (!userId) return null;
    if (userId === selfId && s.selfStatus) return s.selfStatus.customStatus;
    return s.presences[userId]?.customStatus ?? null;
  });
}

const NO_ACTIVITIES: readonly Activity[] = [];

/** Kişinin asıl etkinliği (en son başladığı oyun); tanınmayan türler gösterilmez */
export function useActivity(userId: string | null | undefined): Activity | null {
  return useGuild((s) => (userId ? s.presences[userId]?.activities?.find(isKnownActivity) : null) ?? null);
}

/**
 * Kişinin tüm etkinlikleri, en son başlayan ilk sırada (profilde alt alta kartlar). Seçici kararlı kalsın
 * diye liste süzülmeden döner: gösterirken `isKnownActivity` ile süz.
 */
export function useActivities(userId: string | null | undefined): readonly Activity[] {
  return useGuild((s) => (userId ? s.presences[userId]?.activities : undefined) ?? NO_ACTIVITIES);
}

/** Etkinlik ikonunun adresi; ikon yoksa (ya da anahtar geçersizse) null */
export const activityIconUrl = (activity: Pick<Activity, 'icon'> | null | undefined): string | null =>
  activity?.icon && ACTIVITY_ICON_KEY_PATTERN.test(activity.icon)
    ? normalizeServerUrl(env().serverUrl()) + activityIconPath(activity.icon)
    : null;

/** Kendi durum ayarların (eski sunucuda null) */
export function useSelfStatus(): SelfStatus | null {
  return useGuild((s) => s.selfStatus);
}

async function update(body: UpdateStatusRequest): Promise<boolean> {
  try {
    const status = await request<SelfStatus>('PATCH', '/api/me/status', body);
    useGuild.getState().apply({ t: 'USER_STATUS_UPDATE', d: status });
    return true;
  } catch (err) {
    env().notifyError(err instanceof Error ? err.message : 'Durum değiştirilemedi.');
    return false;
  }
}

/** Durumu değiştirir; `durationMs` null ya da verilmezse süresiz */
export function setUserStatus(status: UserStatus, durationMs: number | null = null): Promise<boolean> {
  return update({ status, expiresInMs: status === 'online' ? null : durationMs });
}

/**
 * Özel durumu ayarlar (null: temizler). `clearAfter`: ms, 'today' (yerel gece yarısı) ya da null (temizleme).
 */
export function setCustomStatus(
  custom: { text?: string | null; emoji?: string | null } | null,
  clearAfter: number | 'today' | null = null,
): Promise<boolean> {
  const text = custom?.text?.trim() || null;
  const emoji = custom?.emoji || null;
  if (!text && !emoji) return update({ customStatus: null });
  return update({ customStatus: { text, emoji, expiresInMs: clearAfterMs(clearAfter) } });
}

/** Süre dolumunu okunur yazar: "15 dakika sonra", "3 saat sonra", "2 gün sonra" */
export function formatRemaining(expiresAt: number | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  if (minutes < 60) return `${minutes} dakika sonra`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} saat sonra`;
  return `${Math.round(hours / 24)} gün sonra`;
}
