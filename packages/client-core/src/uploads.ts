import { AVATAR_MAX_BYTES, INTRO_SOUND_MAX_BYTES, INTRO_SOUND_MAX_SECONDS, type ApiErrorBody, type Attachment, type ProfileTheme, type User } from '@diskort/shared';
import { api, ApiError, clientFeatureHeaders, normalizeServerUrl } from './api';
import { env, type LocalFile, type UploadRequest, type UploadResponse } from './env';
import { useGuild } from './guild';
import { useSession } from './session';

/** Sunucudaki dosyanın tam adresi (resim gösterme ve indirme için; jeton gerekmez) */
export const attachmentUrl = (attachment: Pick<Attachment, 'url'>): string =>
  normalizeServerUrl(env().serverUrl()) + attachment.url;

/** Profil fotoğrafının tam adresi; fotoğraf yoksa (ya da sunucu bu özelliği bilmiyorsa) null. */
export const avatarUrl = (user: Pick<User, 'avatarUrl'> | null | undefined): string | null =>
  user?.avatarUrl ? normalizeServerUrl(env().serverUrl()) + user.avatarUrl : null;

/** Profil afişinin tam adresi; yoksa null. */
export const bannerUrl = (user: Pick<User, 'bannerUrl'> | null | undefined): string | null =>
  user?.bannerUrl ? normalizeServerUrl(env().serverUrl()) + user.bannerUrl : null;

/**
 * Kişisel giriş sesinin tam adresi (en fazla 5 sn MP3; jeton gerekmez, adres içerik değişince değişir);
 * yoksa (ya da sunucu bu özelliği bilmiyorsa) null.
 */
export const introSoundUrl = (user: Pick<User, 'introSoundUrl'> | null | undefined): string | null =>
  user?.introSoundUrl ? normalizeServerUrl(env().serverUrl()) + user.introSoundUrl : null;

const decimal = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

/** 834 B, 12,5 KB, 3,2 MB */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${decimal.format(bytes / 1024)} KB`;
  return `${decimal.format(bytes / 1024 / 1024)} MB`;
}

/** Yükleme kullanıcı vazgeçtiği için yarıda kesildi */
export class UploadCancelled extends Error {
  constructor() {
    super('Yükleme iptal edildi.');
  }
}

const MIME = /^[\w.+-]+\/[\w.+-]+$/;

/** Tarayıcıda (masaüstü) dosyayı ilerleme bildirerek gönderir. */
function xhrUpload(request: UploadRequest): Promise<UploadResponse> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', request.url);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => request.onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, body: '' });
    xhr.onabort = () => resolve({ status: 0, body: '' });
    request.signal.addEventListener('abort', () => xhr.abort());
    xhr.send(request.file.blob ?? null);
  });
}

/** Dosyayı ham gövde olarak gönderir; beklenen durum kodunda dönen JSON'u verir, değilse ApiError atar. */
export async function sendFile<T>(
  path: string,
  file: LocalFile,
  expectedStatus: number,
  failure: string,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<T> {
  const token = useSession.getState().token;
  const base = normalizeServerUrl(env().serverUrl());
  const res = await (env().upload ?? xhrUpload)({
    url: base + path,
    headers: {
      // Profil fotoğrafı, afiş ve giriş sesi yüklemeleri kullanıcıyı döndürür
      ...clientFeatureHeaders(),
      Authorization: `Bearer ${token ?? ''}`,
      'Content-Type': MIME.test(file.type) ? file.type : 'application/octet-stream',
    },
    file,
    onProgress,
    signal,
  });
  if (signal.aborted) throw new UploadCancelled();

  let data: unknown = null;
  try {
    data = JSON.parse(res.body);
  } catch {
    // gövde JSON değil
  }
  if (res.status === expectedStatus && data) return data as T;
  if (res.status === 0) throw new ApiError(0, 'network', `${failure}: sunucuya ulaşılamadı.`);
  if (res.status === 401 && token) useSession.getState().logout();
  const err = data as Partial<ApiErrorBody> | null;
  throw new ApiError(res.status, err?.error ?? 'error', err?.message ?? `${failure} (${res.status}).`);
}

/** Dosyayı kanala yükler; dönen ek, mesaj gönderilirken kimliğiyle verilir. */
export function uploadFile(
  channelId: string,
  file: LocalFile,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<Attachment> {
  return sendFile<Attachment>(
    `/api/channels/${channelId}/attachments?name=${encodeURIComponent(file.name)}`,
    file,
    201,
    'Dosya yüklenemedi',
    onProgress,
    signal,
  );
}

/**
 * Profil fotoğrafını yükler (sunucu kare kırpıp küçültür) ve güncellenen kullanıcıyı oturuma yazar.
 * Diğer istemciler değişikliği USER_UPDATE ile alır.
 */
export async function uploadAvatar(file: LocalFile, signal: AbortSignal = new AbortController().signal): Promise<User> {
  if (file.size > AVATAR_MAX_BYTES) {
    throw new ApiError(413, 'too_large', `Resim çok büyük (en fazla ${formatBytes(AVATAR_MAX_BYTES)}).`);
  }
  const user = await sendFile<User>('/api/me/avatar', file, 200, 'Profil fotoğrafı yüklenemedi', () => undefined, signal);
  applyOwnUser(user);
  return user;
}

/** Profil afişini yükler (sunucu 1020×360'a kırpar) ve güncellenen kullanıcıyı oturuma yazar. */
export async function uploadBanner(file: LocalFile, signal: AbortSignal = new AbortController().signal): Promise<User> {
  if (file.size > AVATAR_MAX_BYTES) {
    throw new ApiError(413, 'too_large', `Resim çok büyük (en fazla ${formatBytes(AVATAR_MAX_BYTES)}).`);
  }
  const user = await sendFile<User>('/api/me/banner', file, 200, 'Afiş yüklenemedi', () => undefined, signal);
  applyOwnUser(user);
  return user;
}

/**
 * Kişisel giriş sesini yükler ve güncellenen kullanıcıyı oturuma yazar. Sunucu sesi `start` saniyesinden
 * (varsayılan 0) başlayarak `duration` saniyeye (varsayılan ve en çok INTRO_SOUND_MAX_SECONDS) kırpar, ses yüksekliğini eşitler ve
 * MP3'e çevirir. Okunamayan dosyada ApiError 400 'unsupported', sık değişiklikte 429 'rate_limited'.
 */
export async function uploadIntroSound(
  file: LocalFile,
  opts: { start?: number; duration?: number } = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<User> {
  if (file.size > INTRO_SOUND_MAX_BYTES) {
    throw new ApiError(413, 'too_large', `Ses dosyası çok büyük (en fazla ${formatBytes(INTRO_SOUND_MAX_BYTES)}).`);
  }
  // Sunucu yalnızca düz ondalık sayı kabul eder (üslü gösterim yok); milisaniyeye yuvarlanır
  const raw = opts.start ?? 0;
  const start = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) / 1000 : 0;
  const rawDuration = opts.duration ?? INTRO_SOUND_MAX_SECONDS;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration * 1000) / 1000 : INTRO_SOUND_MAX_SECONDS;
  const user = await sendFile<User>(
    `/api/me/intro-sound?start=${start.toFixed(3)}&duration=${duration.toFixed(3)}`,
    file,
    200,
    'Giriş sesi yüklenemedi',
    () => undefined,
    signal,
  );
  applyOwnUser(user);
  return user;
}

/** Kişisel giriş sesini kaldırır (genel katılma sesine dönülür). */
export async function removeIntroSound(): Promise<User> {
  const user = await api.removeIntroSound();
  applyOwnUser(user);
  return user;
}

/** Profil afişini kaldırır. */
export async function removeBanner(): Promise<User> {
  const user = await api.removeBanner();
  applyOwnUser(user);
  return user;
}

/** Profil teması (null: kaldır); verilmezse değişmez. */
export async function updateProfileLook(patch: { profileTheme?: ProfileTheme | null }): Promise<User> {
  const user = await api.updateMe(patch);
  applyOwnUser(user);
  return user;
}

/** Profil fotoğrafını kaldırır (baş harflere dönülür). */
export async function removeAvatar(): Promise<User> {
  const user = await api.removeAvatar();
  applyOwnUser(user);
  return user;
}

/** Kendi hesabının güncel hâli oturuma ve üye listesine hemen yazılır (gateway olayını beklemeden). */
function applyOwnUser(user: User): void {
  useSession.getState().setUser(user);
  useGuild.getState().apply({ t: 'USER_UPDATE', d: user });
}
