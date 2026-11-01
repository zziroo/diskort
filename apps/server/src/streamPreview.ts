import sharp from 'sharp';
import { STREAM_SOURCE_NAME_MAX_LENGTH } from '@diskort/shared';
import { UploadError } from './attachments.js';
import { inspectImage } from './fileInfo.js';
import type { VoiceStateStore } from './voiceState.js';

/** Saklanan önizlemenin en büyük genişliği/yüksekliği (piksel) */
const PREVIEW_MAX_WIDTH = 480;
const PREVIEW_MAX_HEIGHT = 480;
/** Çözülecek en büyük resim (sıkıştırma bombalarına karşı) */
const MAX_INPUT_PIXELS = 4096 * 4096;

sharp.cache(false);
// Süreç geneli: hiçbir yükleme yolu SVG beklemez; içerikten tür tanıyan sharp'ın librsvg'ye inmesi kapalı
sharp.block({ operation: ['VipsForeignLoadSvg'] });

interface Preview {
  channelId: string;
  data: Buffer;
  at: number;
}

/**
 * Yayın önizlemeleri (Discord'daki "Şimdi Yayın Yapıyor" kartındaki küçük resim). Yayıncının istemcisi
 * birkaç saniyede bir kendi ekran paylaşımından bir kare yükler; sunucu onu yeniden kodlayıp YALNIZCA
 * bellekte, kişi başına bir tane tutar. Yayın bitince, kanal değişince ya da sesten çıkınca silinir;
 * diske yazılmaz. Önizlemeyi yalnızca o ses kanalını görebilenler indirebilir (bkz. routes/voice.ts).
 */
export class StreamPreviewStore {
  private readonly previews = new Map<string, Preview>();

  constructor(private readonly voice: VoiceStateStore) {
    voice.on('update', (state) => {
      const preview = this.previews.get(state.userId);
      if (preview && (!state.streaming || preview.channelId !== state.channelId)) this.previews.delete(state.userId);
    });
    voice.on('delete', ({ userId }) => this.previews.delete(userId));
  }

  get size(): number {
    return this.previews.size;
  }

  /** Kullanıcının şu anki yayınına ait önizleme */
  get(userId: string, channelId: string): Preview | null {
    const preview = this.previews.get(userId);
    const state = this.voice.get(userId);
    if (!preview || !state?.streaming || state.channelId !== channelId || preview.channelId !== channelId) return null;
    return preview;
  }

  /**
   * Yüklenen kareyi küçültüp WebP olarak yeniden kodlar ve saklar; kişi yayında değilse (ya da kodlama
   * sırasında yayını bittiyse) null. Geçersiz resimde UploadError.
   */
  async put(userId: string, input: Buffer, now = Date.now()): Promise<number | null> {
    const before = this.voice.get(userId);
    if (!before?.streaming) return null;
    // İstemcinin başlığına değil içeriğe bakılır: yalnızca rotanın kabul ettiği türler çözücüye gider
    const image = inspectImage(input);
    if (!image || image.type === 'image/gif') throw new UploadError(400, 'invalid_image', 'Önizleme resmi okunamadı.');
    let data: Buffer;
    try {
      data = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
        .resize({ width: PREVIEW_MAX_WIDTH, height: PREVIEW_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();
    } catch {
      throw new UploadError(400, 'invalid_image', 'Önizleme resmi okunamadı.');
    }
    const after = this.voice.get(userId);
    if (!after?.streaming || after.channelId !== before.channelId) return null;
    // Aynı milisaniyede gelen iki yükleme de istemcide önbelleği tazelesin
    const prev = this.previews.get(userId);
    const at = prev && prev.at >= now ? prev.at + 1 : now;
    this.previews.set(userId, { channelId: after.channelId, data, at });
    this.voice.setStreamPreview(userId, at);
    return at;
  }

  delete(userId: string): void {
    if (!this.previews.delete(userId)) return;
    this.voice.setStreamPreview(userId, null);
  }
}

/**
 * Kaynak adını güvenli hâle getirir: denetim ve yön değiştirme karakterleri çıkar, boşluklar sadeleşir,
 * en çok 64 karakter. Boş kalırsa null.
 */
export function sanitizeSourceName(name: string): string | null {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length <= STREAM_SOURCE_NAME_MAX_LENGTH
    ? clean
    : `${chars.slice(0, STREAM_SOURCE_NAME_MAX_LENGTH - 1).join('').trimEnd()}…`;
}
