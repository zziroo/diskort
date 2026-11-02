// Uygulama içi geri bildirim: gönderme (ekran görüntüleriyle), kendi gönderdiklerinin durumu ve
// hesap yöneticileri için liste, durum/not ve "yeni" sayısı (rozet).
import { create } from 'zustand';
import {
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  type CreateFeedbackRequest,
  type Feedback,
  type FeedbackContext,
  type FeedbackScreenshot,
  type FeedbackStatus,
  type FeedbackType,
  type GatewayServerMessage,
  type UpdateFeedbackRequest,
  type User,
} from '@diskort/shared';
import { api, ApiError, normalizeServerUrl, request } from './api';
import { env, type LocalFile } from './env';
import { recentClientErrors } from './errors';
import { gateway } from './gateway';
import { useGuild } from './guild';
import { sessionUserChanged, useSession } from './session';
import { formatBytes, sendFile } from './uploads';

export const feedbackApi = {
  create: (body: CreateFeedbackRequest) => request<Feedback>('POST', '/api/feedback', body),
  mine: () => request<Feedback[]>('GET', '/api/feedback/mine'),
  list: (filter: { status?: FeedbackStatus; type?: FeedbackType } = {}) => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.type) params.set('type', filter.type);
    const query = params.toString();
    return request<Feedback[]>('GET', `/api/feedback${query ? `?${query}` : ''}`);
  },
  stats: () => request<{ counts: Record<FeedbackStatus, number> }>('GET', '/api/feedback/stats'),
  update: (id: number, body: UpdateFeedbackRequest) => request<Feedback>('PATCH', `/api/feedback/${id}`, body),
  remove: (id: number) => request<void>('DELETE', `/api/feedback/${id}`),
};

interface FeedbackStore {
  /** Kendi gönderdiklerim (en yeni önce); yüklenmediyse null */
  mine: Feedback[] | null;
  /** Yetkili için tüm geri bildirimler (en yeni önce); yüklenmediyse null */
  all: Feedback[] | null;
  /** Yetkili için "yeni" durumundakilerin sayısı (rozet) */
  newCount: number;
  /**
   * Yetkili için gönderenlerin profilleri (tüm hesaplar). Hesap yöneticiliği sunucuya bağlı olmadığından
   * gönderen, yöneticiyle ortak bir sunucuda olmayabilir.
   */
  authors: Record<string, User>;
}

const initial = (): FeedbackStore => ({ mine: null, all: null, newCount: 0, authors: {} });

export const useFeedback = create<FeedbackStore>()(initial);

const selfId = (): string | undefined => useSession.getState().user?.id;

/** Oturumdaki kullanıcı geri bildirimleri yönetebilir mi: hesap yöneticisi (hiçbir sunucuya bağlı değil) */
export const canManageFeedback = (): boolean => useSession.getState().user?.isAdmin === true;

const countNew = (list: Feedback[]): number => list.filter((f) => f.status === 'yeni').length;

const upsert = (list: Feedback[] | null, item: Feedback): Feedback[] | null => {
  if (!list) return list;
  const i = list.findIndex((f) => f.id === item.id);
  if (i === -1) return [item, ...list].sort((a, b) => b.id - a.id);
  const next = list.slice();
  next[i] = item;
  return next;
};

export async function loadMyFeedback(): Promise<Feedback[]> {
  const mine = await feedbackApi.mine();
  useFeedback.setState({ mine });
  return mine;
}

/** Yetkili: tüm listeyi yükler (süzme istemcide yapılır; topluluk küçük) */
export async function loadAllFeedback(): Promise<Feedback[]> {
  // Hesap listesi yalnızca gönderen adları için; eski sunucuda (uç yok) ortak sunuculardaki profiller kullanılır
  const [all, users] = await Promise.all([feedbackApi.list(), api.listUsers().catch(() => null)]);
  useFeedback.setState((s) => ({
    all,
    newCount: countNew(all),
    authors: users ? Object.fromEntries(users.map((u) => [u.id, u])) : s.authors,
  }));
  return all;
}

/** Geri bildirimi gönderenin profili (bilinmiyorsa undefined) */
export const useFeedbackAuthor = (userId: string | null): User | undefined => {
  const author = useFeedback((s) => (userId ? s.authors[userId] : undefined));
  const known = useGuild((s) => (userId ? s.profiles[userId] : undefined));
  return known ?? author;
};

/** Yetkili: yalnızca rozet için "yeni" sayısı */
export async function refreshFeedbackCount(): Promise<void> {
  if (!canManageFeedback()) {
    useFeedback.setState({ newCount: 0 });
    return;
  }
  try {
    const { counts } = await feedbackApi.stats();
    useFeedback.setState({ newCount: counts.yeni ?? 0 });
  } catch {
    // eski sunucu (uç yok) ya da bağlantı sorunu: rozet gösterilmez
  }
}

/** Yetkili: durumu ya da notu değiştirir; listeler hemen güncellenir. */
export async function updateFeedback(id: number, body: UpdateFeedbackRequest): Promise<Feedback> {
  const updated = await feedbackApi.update(id, body);
  applyFeedback(updated);
  return updated;
}

export async function deleteFeedback(id: number): Promise<void> {
  await feedbackApi.remove(id);
  removeFeedback(id);
}

function applyFeedback(item: Feedback): void {
  useFeedback.setState((s) => {
    const all = upsert(s.all, item);
    return {
      all,
      mine: item.userId === selfId() ? upsert(s.mine, item) : s.mine,
      newCount: all ? countNew(all) : s.newCount,
    };
  });
}

function removeFeedback(id: number): void {
  useFeedback.setState((s) => {
    const all = s.all?.filter((f) => f.id !== id) ?? null;
    return { all, mine: s.mine?.filter((f) => f.id !== id) ?? null, newCount: all ? countNew(all) : s.newCount };
  });
}

// ---------- Gönderme ----------

export interface FeedbackDraft {
  type: FeedbackType;
  title: string;
  body: string;
  /** Kullanıcı teknik bilgileri göndermeyi kapattıysa null */
  context: FeedbackContext | null;
  screenshots: LocalFile[];
}

/**
 * Önce ekran görüntülerini yükler, sonra geri bildirimi gönderir. Başarısız olursa ApiError atar
 * (ör. saatlik sınır, geçersiz resim); gönderilen geri bildirim "Geri bildirimlerim"e eklenir.
 */
export async function submitFeedback(
  draft: FeedbackDraft,
  signal: AbortSignal = new AbortController().signal,
): Promise<Feedback> {
  if (draft.screenshots.length > FEEDBACK_MAX_SCREENSHOTS) {
    throw new ApiError(400, 'too_many', `En fazla ${FEEDBACK_MAX_SCREENSHOTS} ekran görüntüsü eklenebilir.`);
  }
  for (const file of draft.screenshots) {
    if (file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      throw new ApiError(413, 'too_large', `Resim çok büyük (en fazla ${formatBytes(FEEDBACK_SCREENSHOT_MAX_BYTES)}).`);
    }
  }
  const screenshotIds: string[] = [];
  for (const file of draft.screenshots) {
    const shot = await sendFile<FeedbackScreenshot>(
      '/api/feedback/screenshots',
      file,
      201,
      'Ekran görüntüsü yüklenemedi',
      () => undefined,
      signal,
    );
    screenshotIds.push(shot.id);
  }
  const created = await feedbackApi.create({
    type: draft.type,
    title: draft.title.trim() || null,
    body: draft.body.trim(),
    context: draft.context,
    ...(screenshotIds.length ? { screenshotIds } : {}),
  });
  useFeedback.setState((s) => ({ mine: s.mine ? upsert(s.mine, created) : [created] }));
  return created;
}

/**
 * Her platformda ortak teknik bilgiler: platform, sürüm ve bu oturumdaki son hatalar. Uygulama bunu
 * işletim sistemi, ekran ve açık görünüm bilgileriyle tamamlar.
 */
export function baseFeedbackContext(): FeedbackContext {
  const { platform, version } = env();
  return { platform, appVersion: version, recentErrors: recentClientErrors() };
}

// ---------- Ekran görüntülerini gösterme ----------

/** Ekran görüntüsünün tam adresi. Herkese açık değildir: jeton gerekir (bkz. feedbackImageHeaders). */
export const feedbackScreenshotUrl = (shot: Pick<FeedbackScreenshot, 'url'>): string =>
  normalizeServerUrl(env().serverUrl()) + shot.url;

/** Ekran görüntüsünü almak için başlıklar (mobil: <Image source={{ uri, headers }} />) */
export const feedbackImageHeaders = (): Record<string, string> => {
  const token = useSession.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Ekran görüntüsünü jetonla indirir (masaüstü: URL.createObjectURL ile gösterilir). */
export async function fetchFeedbackScreenshot(shot: Pick<FeedbackScreenshot, 'url'>, signal?: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(feedbackScreenshotUrl(shot), { headers: feedbackImageHeaders(), signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'network', 'Ekran görüntüsü alınamadı: sunucuya ulaşılamadı.');
  }
  if (!res.ok) throw new ApiError(res.status, 'error', 'Ekran görüntüsü alınamadı.');
  return res.blob();
}

// ---------- Canlı güncellemeler ----------

type FeedbackListener = (item: Feedback, previous: Feedback | undefined) => void;
const ownUpdateListeners = new Set<FeedbackListener>();

/**
 * Kendi geri bildirimimin durumu ya da notu değişti (ör. arayüz "tamamlandı" bildirimi gösterir).
 * `previous`, listede önceden yüklü olan hâlidir (yoksa undefined).
 */
export function onOwnFeedbackUpdate(listener: FeedbackListener): () => void {
  ownUpdateListeners.add(listener);
  return () => ownUpdateListeners.delete(listener);
}

gateway.on((msg: GatewayServerMessage) => {
  switch (msg.t) {
    case 'READY':
      // Rozet için sayı (yetkili değilse sıfırlanır); açık liste varsa tazelenir
      void refreshFeedbackCount();
      if (useFeedback.getState().all && canManageFeedback()) void loadAllFeedback().catch(() => undefined);
      if (useFeedback.getState().mine) void loadMyFeedback().catch(() => undefined);
      break;
    case 'FEEDBACK_CREATE':
      useFeedback.setState((s) => {
        const all = upsert(s.all, msg.d);
        return { all, newCount: all ? countNew(all) : s.newCount + (msg.d.status === 'yeni' ? 1 : 0) };
      });
      break;
    case 'FEEDBACK_UPDATE': {
      const previous = useFeedback.getState().mine?.find((f) => f.id === msg.d.id);
      const hadAll = useFeedback.getState().all !== null;
      applyFeedback(msg.d);
      if (!hadAll) void refreshFeedbackCount();
      if (msg.d.userId === selfId()) for (const l of ownUpdateListeners) l(msg.d, previous);
      break;
    }
    case 'FEEDBACK_DELETE': {
      const hadAll = useFeedback.getState().all !== null;
      removeFeedback(msg.d.id);
      if (!hadAll) void refreshFeedbackCount();
      break;
    }
    case 'USER_UPDATE':
      // Hesap yöneticiliği verilmiş ya da alınmış olabilir (oturumdaki kullanıcı bu noktada güncellenmiştir)
      if (msg.d.id === selfId()) {
        if (!msg.d.isAdmin) useFeedback.setState({ all: null, newCount: 0 });
        else void refreshFeedbackCount();
      }
      break;
    default:
      break;
  }
});

// Oturum değişince (çıkış / başka hesap) temizlenir
useSession.subscribe((s, prev) => {
  if (sessionUserChanged(s, prev)) useFeedback.setState(initial());
});
