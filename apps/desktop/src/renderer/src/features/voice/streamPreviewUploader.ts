import type { StreamSourceKind } from '@diskort/shared';
import { ApiError, reportStreamSource, uploadStreamPreview } from '@diskort/client-core';

/** İlk kare: yayın sunucuya ulaşsın ve görüntü otursun diye kısa bir bekleme */
const FIRST_DELAY_MS = 2_500;
/** Sonraki kareler */
const INTERVAL_MS = 25_000;
/** Yayın webhook'u henüz gelmediyse (409) yeniden deneme */
const RETRY_DELAY_MS = 4_000;
const MAX_RETRIES = 4;
const WIDTH = 480;
const GRAB_TIMEOUT_MS = 3_000;

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}
declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('zaman aşımı')), ms);
    promise.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Yerel ekran paylaşımından bir kare alır, ~480 px genişliğe küçültüp JPEG yapar (≈20–40 KB). */
async function grabFrame(track: MediaStreamTrack): Promise<Blob | null> {
  if (track.readyState !== 'live') return null;
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup = (): void => undefined;
  if (typeof ImageCapture !== 'undefined') {
    const bitmap = await withTimeout(new ImageCapture(track).grabFrame(), GRAB_TIMEOUT_MS);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    cleanup = () => bitmap.close();
  } else {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    await withTimeout(video.play(), GRAB_TIMEOUT_MS);
    source = video;
    width = video.videoWidth;
    height = video.videoHeight;
    cleanup = () => {
      video.pause();
      video.srcObject = null;
    };
  }
  try {
    if (!width || !height) return null;
    const scale = Math.min(1, WIDTH / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
  } finally {
    cleanup();
  }
}

/**
 * Yayıncı tarafı: yayın sürdükçe önizleme karelerini sunucuya yükler ve paylaşılan kaynağın adını
 * bildirir. Hatalar sessizce yutulur (önizleme yalnızca süs; yayını etkilememeli). Sunucu önizlemeyi
 * yalnızca bellekte tutar ve yayın bitince siler.
 */
export class StreamPreviewUploader {
  private timer = 0;
  private stopped = false;
  private busy = false;
  private retries = 0;

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly source: { name: string; kind: StreamSourceKind } | null,
  ) {
    this.reportSource();
    this.schedule(FIRST_DELAY_MS);
  }

  /** Kaynağın adını bildirir; sunucu onu katılımcı çıkınca siler, tam yeniden bağlanmadan sonra yeniden çağrılır. */
  reportSource(): void {
    if (this.source && !this.stopped) void reportStreamSource(this.source.name, this.source.kind).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    window.clearTimeout(this.timer);
    if (!this.stopped) this.timer = window.setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    if (this.track.readyState !== 'live') return;
    this.busy = true;
    let next = INTERVAL_MS;
    try {
      const blob = await grabFrame(this.track);
      if (blob && !this.stopped) await uploadStreamPreview(blob);
      this.retries = 0;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : -1;
      // Eski sunucu önizlemeyi tanımıyor: bu yayında bir daha denenmez
      if (status === 404) this.stop();
      else if (status === 409 && this.retries < MAX_RETRIES) {
        this.retries++;
        next = RETRY_DELAY_MS;
      } else if (status === 429) next = INTERVAL_MS * 2;
    } finally {
      this.busy = false;
    }
    this.schedule(next);
  }
}
