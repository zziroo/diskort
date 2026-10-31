import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Play, Square } from 'lucide-react';
import { INTRO_SOUND_MAX_SECONDS } from '@diskort/shared';
import { decodeAudioFile, previewIntroClip, stopIntroSound } from '../../lib/sfx';
import { clamp, cn } from '../../lib/utils';
import { Button } from '../ui/controls';
import { Modal } from '../ui/Modal';
import { Slider } from '../ui/Slider';

export const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm';
/** Kesitin en kısa uzunluğu (sunucudaki INTRO_SOUND_MIN_SECONDS ile aynı) */
const MIN_LENGTH_S = 0.3;
/** Dalga biçimindeki çubuk sayısı */
const BARS = 96;
/** Bu süreden uzun ses çözülmez (PCM'e açılınca bellek şişer) */
const DECODE_MAX_S = 900;
/** `loadClipBuffer` 'too_long' dönünce gösterilecek metin */
export const CLIP_TOO_LONG_TEXT = 'Ses 15 dakikadan uzun; önce kısa bir parça kes.';

/** Seçilen kesit, saniye */
export interface SoundClip {
  start: number;
  duration: number;
}

/** Dosyanın süresini ucuzca (çözmeden) okur; okunamazsa null */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const objUrl = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null): void => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      URL.revokeObjectURL(objUrl);
      resolve(v);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = objUrl;
  });
}

export const localFile = (file: File) => ({ name: file.name, size: file.size, type: file.type, blob: file });

/**
 * Kesit seçmek için sesi çözer. 'too_long': çözülemeyecek kadar uzun. null: tarayıcı çözemedi ya da ses en kısa
 * uzunluktan kısa; böyle bir dosya düzenleyicisiz gider (sunucu kendi kurallarıyla kırpar/reddeder).
 */
export async function loadClipBuffer(file: File): Promise<AudioBuffer | 'too_long' | null> {
  const metaDuration = await readDuration(file);
  if (metaDuration !== null && metaDuration > DECODE_MAX_S) return 'too_long';
  try {
    const buffer = await decodeAudioFile(await file.arrayBuffer());
    return buffer.duration < MIN_LENGTH_S ? null : buffer;
  } catch {
    // Tarayıcının çözemediği biçimi sunucu (ffmpeg) okuyabilir
    return null;
  }
}

/** 0:12.3 biçiminde süre */
function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Kısa sese dönüşecek kesiti seçme penceresi: başlangıç ve uzunluk (MIN_LENGTH_S – INTRO_SOUND_MAX_SECONDS).
 * Dalga biçimine tıklamak ya da üstünde sürüklemek kesiti oraya taşır. Yalnız kesiti seçer; yükleme, kırpma ve ses
 * yüksekliği eşitleme çağıranın ve sunucunun işidir. `above`/`below` pencereye ek içerik koyar (ör. ad ve emoji).
 */
export function SoundClipEditor({
  title,
  file,
  buffer,
  uploading,
  onCancel,
  onConfirm,
  confirmLabel = 'Yükle',
  confirmDisabled = false,
  above,
  below,
}: {
  title: string;
  file: File;
  buffer: AudioBuffer;
  uploading: boolean;
  onCancel: () => void;
  onConfirm: (clip: SoundClip) => void | Promise<void>;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  above?: ReactNode;
  below?: ReactNode;
}) {
  const duration = buffer.duration;
  const maxLength = Math.min(INTRO_SOUND_MAX_SECONDS, duration);
  const minLength = Math.min(MIN_LENGTH_S, maxLength);
  const [length, setLength] = useState(maxLength);
  const [start, setStart] = useState(0);
  const maxStart = Math.max(0, Math.min(duration - length, 3600));
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const playToken = useRef(0);
  const dragging = useRef(false);
  const peaks = useMemo(() => wavePeaks(buffer, BARS), [buffer]);

  const stop = (): void => {
    if (playingRef.current) stopIntroSound();
    playingRef.current = false;
    setPlaying(false);
  };

  // Pencere kapanınca dinleme susar
  useEffect(
    () => () => {
      if (playingRef.current) stopIntroSound();
    },
    [],
  );

  const choose = (value: number): void => {
    stop();
    setStart(clamp(Math.round(value * 10) / 10, 0, maxStart));
  };

  const chooseLength = (value: number): void => {
    stop();
    const next = clamp(Math.round(value * 10) / 10, minLength, maxLength);
    setLength(next);
    // Kesit sesin sonunu aşmasın
    setStart((s) => clamp(s, 0, Math.max(0, duration - next)));
  };

  const listen = (): void => {
    if (playing) {
      stop();
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    const token = ++playToken.current;
    previewIntroClip(buffer, start, length, () => {
      if (token !== playToken.current) return; // eski kaynağın bitişi yenisini sıfırlamasın
      playingRef.current = false;
      setPlaying(false);
    });
  };

  // Dalga biçimine tıklayınca (ve sürükledikçe) kesit imlecin ortasına gelir
  const moveTo = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - rect.left) / rect.width) * duration;
    choose(at - length / 2);
  };

  const from = start / duration;
  const to = Math.min(1, (start + length) / duration);

  return (
    <Modal
      title={title}
      subtitle={`Ses ${formatTime(duration)} uzunluğunda; çalınacak kısmı seç (en fazla ${INTRO_SOUND_MAX_SECONDS} saniye).`}
      onClose={() => !uploading && onCancel()}
      className="w-[480px]"
      footer={
        <>
          <Button variant="ghost" disabled={uploading} onClick={onCancel}>
            Vazgeç
          </Button>
          <Button
            disabled={uploading || confirmDisabled}
            onClick={() => {
              stop();
              void onConfirm({ start, duration: length });
            }}
          >
            {uploading ? 'Yükleniyor…' : confirmLabel}
          </Button>
        </>
      }
    >
      {above}
      <div className="mb-2 truncate text-sm text-text-muted" title={file.name}>
        {file.name}
      </div>
      <div
        className="relative flex h-16 cursor-pointer touch-none items-center gap-px overflow-hidden rounded-md bg-bg-deep px-1"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) moveTo(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        role="presentation"
      >
        {peaks.map((p, i) => {
          const x = (i + 0.5) / peaks.length;
          const inside = x >= from && x <= to;
          return (
            <span
              key={i}
              className={cn('flex-1 rounded-full transition-colors duration-100', inside ? 'bg-brand' : 'bg-text-faint/40')}
              style={{ height: `${Math.max(6, p * 100)}%` }}
            />
          );
        })}
        {/* Seçili kesit */}
        <span
          className="pointer-events-none absolute inset-y-0 rounded-md border-2 border-brand/80 bg-brand/10"
          style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="press-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white hover:bg-brand-hover"
          aria-label={playing ? 'Durdur' : 'Dinle'}
          data-tooltip={playing ? 'Durdur' : 'Dinle'}
          onClick={listen}
        >
          {playing ? <Square size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <div className="grid flex-1 grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <span className="text-xs text-text-muted">Başlangıç</span>
          <Slider
            aria-label="Başlangıç"
            min={0}
            max={Math.round(maxStart * 10)}
            step={1}
            value={Math.round(start * 10)}
            disabled={maxStart <= 0}
            onValueChange={(v) => choose(v / 10)}
          />
          <span className="text-xs text-text-muted">Uzunluk</span>
          <Slider
            aria-label="Uzunluk"
            min={Math.round(minLength * 10)}
            max={Math.round(maxLength * 10)}
            step={1}
            value={Math.round(length * 10)}
            disabled={maxLength <= minLength}
            onValueChange={(v) => chooseLength(v / 10)}
          />
        </div>
      </div>
      <div className="mt-2 text-right text-xs text-text-muted tabular-nums">
        {formatTime(start)} – {formatTime(Math.min(duration, start + length))} ({length.toFixed(1)} sn)
      </div>
      {below}
    </Modal>
  );
}

/** Sesin ilk kanalından çubuk başına en yüksek genlik (0–1, en yüksek çubuğa göre) */
function wavePeaks(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / bars));
  // Uzun seste her örneğe bakılmaz (çubuk başına en fazla ~2000 örnek)
  const stride = Math.max(1, Math.floor(per / 2000));
  const peaks: number[] = [];
  let top = 0;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const end = Math.min(data.length, (b + 1) * per);
    for (let i = b * per; i < end; i += stride) {
      const v = Math.abs(data[i]!);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > top) top = peak;
  }
  return top > 0 ? peaks.map((p) => p / top) : peaks;
}
