// Dosya ekleri (Android ve iOS): dosya/resim seçme, yükleme (yerel dosyayı ham gövde olarak) ve gelen dosyayı
// indirip telefondaki uygun uygulamayla açma.
import { INTRO_SOUND_MAX_BYTES, type Attachment } from '@diskort/shared';
import { attachmentUrl, formatBytes, safeDecodeURIComponent, type LocalFile, type UploadRequest, type UploadResponse } from '@diskort/client-core';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform, Share } from 'react-native';
import { Gallery } from '../modules/gallery';
import { toast } from './stores/ui';

/** Dosyayı ilerleme bildirerek gönderir (client-core'un platform yüklemesi). */
export async function uploadFromDevice(request: UploadRequest): Promise<UploadResponse> {
  if (!request.file.uri) return { status: 0, body: '' };
  const task = FileSystem.createUploadTask(
    request.url,
    request.file.uri,
    { httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: request.headers },
    ({ totalBytesSent }) => request.onProgress(totalBytesSent),
  );
  const cancel = (): void => void task.cancelAsync();
  request.signal.addEventListener('abort', cancel);
  try {
    const res = await task.uploadAsync();
    return res ? { status: res.status, body: res.body } : { status: 0, body: '' };
  } catch {
    return { status: 0, body: '' };
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}

const baseName = (uri: string): string => safeDecodeURIComponent(uri.split('/').pop() ?? '') || 'dosya';

/** Seçicinin bildirmediği boyut dosyanın kendisinden okunur. */
async function withSize(file: Omit<LocalFile, 'size'> & { size?: number | null }): Promise<LocalFile> {
  let size = file.size ?? 0;
  if (!size && file.uri) {
    const info = await FileSystem.getInfoAsync(file.uri).catch(() => null);
    if (info?.exists) size = info.size ?? 0;
  }
  return { ...file, size };
}

/** Galeriden fotoğraf/video seçer (Android'in fotoğraf seçicisi; izin gerekmez). */
export async function pickMedia(): Promise<LocalFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    // Özgün dosya olduğu gibi (GIF'ler hareketli kalır); konum bilgisini sunucu siler
    quality: 1,
  });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map((a) =>
      withSize({
        name: a.fileName ?? baseName(a.uri),
        size: a.fileSize,
        type: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
        uri: a.uri,
      }),
    ),
  );
}

/**
 * Profil fotoğrafı için galeriden tek resim seçtirir ve Android'in kırpma ekranında kare kırptırır.
 * Küçültmeyi sunucu yapar (256×256); yerel resim işleme modülü gerekmez.
 */
export async function pickAvatar(): Promise<LocalFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  });
  if (result.canceled || !result.assets[0]) return null;
  const a = result.assets[0];
  // Boyut kırpılmış dosyanın kendisinden okunur (seçicinin bildirdiği özgün resme ait olabilir)
  return withSize({ name: a.fileName ?? baseName(a.uri), type: a.mimeType ?? 'image/jpeg', uri: a.uri });
}

/**
 * Profil afişi için galeriden tek resim seçtirir ve 17:6 kırptırır. Küçültmeyi sunucu yapar (1020×360).
 */
export async function pickBanner(): Promise<LocalFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [17, 6],
    quality: 0.9,
  });
  if (result.canceled || !result.assets[0]) return null;
  const a = result.assets[0];
  return withSize({ name: a.fileName ?? baseName(a.uri), type: a.mimeType ?? 'image/jpeg', uri: a.uri });
}

/**
 * Giriş sesi için tek ses dosyası seçtirir (sistemin dosya seçicisi). Kırpmayı, ses yüksekliğini ve MP3'e
 * çevirmeyi sunucu yapar (ilk INTRO_SOUND_MAX_SECONDS saniye). Çok büyük dosyada hata fırlatır.
 */
export async function pickIntroSound(): Promise<LocalFile | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], copyToCacheDirectory: true });
  if (result.canceled || !result.assets[0]) return null;
  const a = result.assets[0];
  const file = await withSize({ name: a.name, size: a.size, type: a.mimeType ?? 'application/octet-stream', uri: a.uri });
  if (file.size > INTRO_SOUND_MAX_BYTES) {
    throw new Error(`Ses dosyası çok büyük (en fazla ${formatBytes(INTRO_SOUND_MAX_BYTES)}).`);
  }
  return file;
}

/** Herhangi bir dosya seçer (sistemin dosya seçicisi). */
export async function pickDocuments(): Promise<LocalFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map((a) => withSize({ name: a.name, size: a.size, type: a.mimeType ?? '', uri: a.uri })),
  );
}

const busy = new Set<string>();

/** Klasör/dosya adında sorun çıkaracak karakterler (bağlantı önizlemesinin kimliği adres içerir) */
const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'dosya';

/**
 * Dosyayı önbelleğe indirir (daha önce indirildiyse ve boyutu tutuyorsa tekrar indirmez); yerel adresini
 * döndürür.
 */
async function downloadToCache(attachment: Attachment): Promise<string> {
  const dir = `${FileSystem.cacheDirectory}ekler/${safeName(attachment.id)}/`;
  const target = dir + attachment.name.replace(/[/\\]/g, '_');
  const existing = await FileSystem.getInfoAsync(target);
  if (existing.exists && attachment.size > 0 && existing.size === attachment.size) return target;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  if (attachment.size > 1024 * 1024) toast('İndiriliyor…');
  const result = await FileSystem.downloadAsync(attachmentUrl(attachment), target);
  if (result.status !== 200) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error(result.status === 404 ? 'Dosya artık yok (mesaj silinmiş olabilir).' : `İndirme başarısız (${result.status}).`);
  }
  return target;
}

/** İndirme hatasını kullanıcıya anlaşılır biçimde söyler */
function downloadError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /network|timeout|unable to resolve|failed to connect/i.test(message)
    ? 'Dosya indirilemedi: internet bağlantısını kontrol et.'
    : message;
}

/** Uygulama yükleyicisini tetikleyen MIME türü (gizlenmiş tür için dosya adına da bakılır aşağıda) */
const APK_MIME = 'application/vnd.android.package-archive';

/** Bu ek bir Android APK'sı mı (bildirilen tür ya da dosya adının uzantısı) */
function isApk(attachment: Attachment): boolean {
  return attachment.contentType === APK_MIME || /\.apk$/i.test(attachment.name);
}

/** Dosyayı önbelleğe indirir ve Android'in "Birlikte aç" seçimiyle uygun uygulamada açar. */
export async function openAttachment(attachment: Attachment): Promise<void> {
  if (busy.has(attachment.id)) return;
  busy.add(attachment.id);
  try {
    const target = await downloadToCache(attachment);
    if (Platform.OS === 'ios') {
      // iOS'ta "Birlikte aç" yerine paylaşım sayfası: Dosyalar'a kaydet, önizle ya da başka uygulamada aç
      await Share.share({ url: target });
      return;
    }
    // Başka bir üyenin gönderdiği APK: uygulama kendi güncellemeleri için "bilinmeyen kaynaktan
    // yükleme" iznine sahip, VIEW niyeti bildirilen türle (application/vnd.android.package-archive)
    // açılırsa doğrudan yükleme ekranına düşer. Tür gizlenmiş olsa da (.apk uzantılı farklı bir
    // MIME) burada asıl tür yok sayılıp genel bir dosya türüyle açılır: yükleyici hiç tetiklenmez,
    // Android "bununla aç" seçtiricisini (dosya yöneticisi vb.) gösterir.
    const type = isApk(attachment) ? 'application/octet-stream' : attachment.contentType || '*/*';
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: await FileSystem.getContentUriAsync(target),
      type,
      // FLAG_GRANT_READ_URI_PERMISSION: açan uygulama dosyayı okuyabilsin
      flags: 1,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast(/No Activity found|ActivityNotFound/i.test(message) ? 'Bu dosyayı açabilecek bir uygulama yok.' : downloadError(err), 'error');
  } finally {
    busy.delete(attachment.id);
  }
}

/** Bu telefonda galeriye kaydedilebilir mi (yeni APK ve Android 10+; iOS'ta henüz yok) */
export const canSaveToGallery = (): boolean => Gallery?.isSupported() === true;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Galerideki ad: uzantısı yoksa (ör. bağlantı önizlemesinde site adı) türüne göre eklenir */
function galleryName(attachment: Attachment): string {
  const name = attachment.name.replace(/[/\\]/g, '_');
  const ext = EXTENSIONS[attachment.contentType];
  return ext && !/\.[a-z0-9]{2,5}$/i.test(name) ? `${name}.${ext}` : name;
}

/** Resimleri (ve videoları) telefonun galerisine, Pictures/Diskort klasörüne kaydeder. Kaydedildiyse true. */
export async function saveToGallery(attachments: Attachment[]): Promise<boolean> {
  if (!Gallery || attachments.length === 0) return false;
  const key = attachments.map((a) => a.id).join(',');
  if (busy.has(key)) return false;
  busy.add(key);
  try {
    for (const attachment of attachments) {
      const local = await downloadToCache(attachment);
      await Gallery.save(local, galleryName(attachment), attachment.contentType || 'image/jpeg');
    }
    toast(attachments.length === 1 ? 'Galeriye kaydedildi.' : `${attachments.length} dosya galeriye kaydedildi.`);
    return true;
  } catch (err) {
    toast(downloadError(err), 'error');
    return false;
  } finally {
    busy.delete(key);
  }
}
