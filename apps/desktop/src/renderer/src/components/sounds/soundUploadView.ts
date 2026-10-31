import { SOUNDBOARD_NAME_MAX } from '@diskort/shared';
import { ApiError, errorMessage } from '@diskort/client-core';

/** Sunucu ses paneline yüklemenin kullanıcıya gösterilen hata metinleri; gerisi ApiError iletisi */
const UPLOAD_ERRORS: Record<string, string> = {
  sound_limit: 'Sunucuda en çok 64 ses olabilir.',
  too_large: "Dosya 8 MB'tan büyük olamaz.",
  unsupported: 'Bu ses dosyası okunamadı.',
  rate_limited: 'Çok sık ses yüklüyorsun, biraz bekle.',
  no_space: 'Sunucuda yer kalmadı.',
  unavailable: 'Ses işleme şu an kapalı.',
};

export const SOUND_TOO_LARGE_TEXT = UPLOAD_ERRORS.too_large!;

export function soundUploadError(err: unknown): string {
  return (err instanceof ApiError ? UPLOAD_ERRORS[err.code] : undefined) ?? errorMessage(err);
}

/** Dosya adından varsayılan ses adı: uzantısız, en çok SOUNDBOARD_NAME_MAX karakter (emoji ortadan bölünmez) */
export function defaultSoundName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '').trim();
  return base
    .slice(0, SOUNDBOARD_NAME_MAX)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
}
