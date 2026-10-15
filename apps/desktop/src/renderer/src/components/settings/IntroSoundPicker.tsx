import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Music2, Play, Square } from 'lucide-react';
import { INTRO_SOUND_MAX_BYTES, INTRO_SOUND_MAX_SECONDS, type User } from '@diskort/shared';
import { errorMessage, formatBytes, introSoundUrl, removeIntroSound, uploadIntroSound } from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { PresenceProvider, usePresence } from '../../lib/motion';
import { decodeAudioFile, playIntroSound, previewIntroClip, stopIntroSound } from '../../lib/sfx';
import { clamp, cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import { Button, SectionTitle } from '../ui/controls';
import { Modal } from '../ui/Modal';
import { Slider } from '../ui/Slider';

const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm';
/** Bu süreden kısa (yuvarlama payıyla) ses kırpılmadan yüklenir */
const DIRECT_MAX_S = INTRO_SOUND_MAX_SECONDS + 0.05;
/** Dalga biçimindeki çubuk sayısı */
const BARS = 96;
/** Bu süreden uzun ses çözülmez (PCM'e açılınca bellek şişer) */
const DECODE_MAX_S = 900;

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

const localFile = (file: File) => ({ name: file.name, size: file.size, type: file.type, blob: file });

/** 0:12.3 biçiminde süre */
function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Giriş sesi: kullanıcının yüklediği kısa ses (en fazla INTRO_SOUND_MAX_SECONDS); ses kanalına girince
 * kanaldakiler (kendisi dahil) genel katılma sesi yerine bunu duyar. Uzun dosyada başlangıç noktası seçilir,
 * kırpma, ses yüksekliği eşitleme ve MP3'e çevirme sunucuda yapılır.
 */
export function IntroSoundPicker({ user }: { user: User }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'decode' | 'upload' | 'remove' | null>(null);
  const [editing, setEditing] = useState<{ file: File; buffer: AudioBuffer } | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const playToken = useRef(0);
  const editor = usePresence(editing);
  const url = introSoundUrl(user);

  const setPlayingBoth = (v: boolean): void => {
    playingRef.current = v;
    setPlaying(v);
  };

  // Sayfadan çıkınca kendi dinlemesi susar (kanaldaki başka bir giriş sesine dokunulmaz)
  useEffect(
    () => () => {
      if (playingRef.current) stopIntroSound();
    },
    [],
  );

  const upload = async (file: File, start = 0): Promise<boolean> => {
    setBusy('upload');
    try {
      await uploadIntroSound(localFile(file), { start });
      toast('Giriş sesi güncellendi.', 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const picked = async (file: File): Promise<void> => {
    if (file.size > INTRO_SOUND_MAX_BYTES) {
      toast(`Ses dosyası çok büyük (en fazla ${formatBytes(INTRO_SOUND_MAX_BYTES)}).`, 'error');
      return;
    }
    setBusy('decode');
    const metaDuration = await readDuration(file);
    if (metaDuration !== null && metaDuration > DECODE_MAX_S) {
      setBusy(null);
      toast('Ses 15 dakikadan uzun; önce kısa bir parça kes.', 'error');
      return;
    }
    let buffer: AudioBuffer | null = null;
    try {
      buffer = await decodeAudioFile(await file.arrayBuffer());
    } catch {
      // Tarayıcının çözemediği biçimi sunucu (ffmpeg) okuyabilir: baştan kırpılarak yüklenir
      buffer = null;
    }
    setBusy(null);
    if (!buffer || buffer.duration <= DIRECT_MAX_S) {
      await upload(file);
      return;
    }
    setEditing({ file, buffer });
  };

  const listen = (): void => {
    if (!url) return;
    if (playing) {
      stopIntroSound();
      setPlayingBoth(false);
      return;
    }
    setPlayingBoth(true);
    const token = ++playToken.current;
    void playIntroSound(url, {
      preview: true,
      onEnd: () => {
        if (token === playToken.current) setPlayingBoth(false); // eski kaynağın bitişi yenisini sıfırlamasın
      },
    }).then((ok) => {
      if (ok || !playingRef.current) return; // çaldı ya da bu arada durduruldu
      setPlayingBoth(false);
      toast('Giriş sesi çalınamadı.', 'error');
    });
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Giriş sesi kaldırılsın mı?',
      message: 'Kanala girince yeniden genel katılma sesi çalar.',
      confirmLabel: 'Kaldır',
      danger: true,
    });
    if (!ok) return;
    if (playingRef.current) stopIntroSound();
    setPlayingBoth(false);
    setBusy('remove');
    try {
      await removeIntroSound();
      toast('Giriş sesi kaldırıldı.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pick = (): void => input.current?.click();

  return (
    <div>
      <SectionTitle>Giriş Sesi</SectionTitle>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
            url ? 'bg-brand/15 text-brand' : 'bg-bg-active text-text-muted',
          )}
          aria-hidden
        >
          <Music2 size={20} />
        </span>
        <span className="min-w-[120px] flex-1 text-sm text-text-normal">
          {url ? 'Kişisel giriş sesin var' : 'Genel katılma sesi çalıyor'}
        </span>
        <div className="flex flex-wrap gap-2">
          {url && (
            <Button type="button" variant="secondary" onClick={listen} disabled={busy !== null}>
              <span className="inline-flex items-center gap-1.5">
                {playing ? <Square size={14} /> : <Play size={14} />}
                {playing ? 'Durdur' : 'Dinle'}
              </span>
            </Button>
          )}
          <Button type="button" onClick={pick} disabled={busy !== null}>
            {busy === 'decode' || busy === 'upload' ? 'Yükleniyor…' : url ? 'Değiştir' : 'Giriş Sesi Yükle'}
          </Button>
          {url && (
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void remove()}>
              Kaldır
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        MP3, WAV, OGG, M4A… En fazla {INTRO_SOUND_MAX_SECONDS} saniye; uzunsa başlangıcı seçersin. Kanala girince herkes
        duyar.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // aynı dosya yeniden seçilebilsin
          if (file) void picked(file);
        }}
      />
      <PresenceProvider value={editor.closing}>
        {editor.value && (
          <IntroSoundEditor
            file={editor.value.file}
            buffer={editor.value.buffer}
            uploading={busy === 'upload'}
            onCancel={() => setEditing(null)}
            onUpload={async (start) => {
              if (await upload(editor.value!.file, start)) setEditing(null);
            }}
          />
        )}
      </PresenceProvider>
    </div>
  );
}

/** Uzun seste giriş sesi olacak INTRO_SOUND_MAX_SECONDS saniyelik kesitin başlangıcını seçme penceresi */
function IntroSoundEditor({
  file,
  buffer,
  uploading,
  onCancel,
  onUpload,
}: {
  file: File;
  buffer: AudioBuffer;
  uploading: boolean;
  onCancel: () => void;
  onUpload: (start: number) => Promise<void>;
}) {
  const duration = buffer.duration;
  const maxStart = Math.max(0, Math.min(duration - INTRO_SOUND_MAX_SECONDS, 3600));
  const [start, setStart] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const playToken = useRef(0);
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

  const listen = (): void => {
    if (playing) {
      stop();
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    const token = ++playToken.current;
    previewIntroClip(buffer, start, () => {
      if (token !== playToken.current) return; // eski kaynağın bitişi yenisini sıfırlamasın
      playingRef.current = false;
      setPlaying(false);
    });
  };

  // Dalga biçimine tıklayınca kesit tıklanan yerin ortasına gelir
  const onWavePointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - rect.left) / rect.width) * duration;
    choose(at - INTRO_SOUND_MAX_SECONDS / 2);
  };

  const from = start / duration;
  const to = Math.min(1, (start + INTRO_SOUND_MAX_SECONDS) / duration);

  return createPortal(
    // Ayarlar penceresinin üstünde açılsın
    <div className="relative z-[60]">
      <Modal
        title="Giriş sesini seç"
        subtitle={`Ses ${formatTime(duration)} uzunluğunda; çalınacak ${INTRO_SOUND_MAX_SECONDS} saniyeyi seç.`}
        onClose={() => !uploading && onCancel()}
        className="w-[480px]"
        footer={
          <>
            <Button variant="ghost" disabled={uploading} onClick={onCancel}>
              Vazgeç
            </Button>
            <Button
              disabled={uploading}
              onClick={() => {
                stop();
                void onUpload(start);
              }}
            >
              {uploading ? 'Yükleniyor…' : 'Yükle'}
            </Button>
          </>
        }
      >
        <div className="mb-2 truncate text-sm text-text-muted" title={file.name}>
          {file.name}
        </div>
        <div
          className="relative flex h-16 cursor-pointer items-center gap-px overflow-hidden rounded-md bg-bg-deep px-1"
          onPointerDown={onWavePointer}
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
          <Slider
            className="flex-1"
            aria-label="Başlangıç"
            min={0}
            max={Math.round(maxStart * 10)}
            step={1}
            value={Math.round(start * 10)}
            onValueChange={(v) => choose(v / 10)}
          />
          <span className="shrink-0 text-xs text-text-muted tabular-nums">
            {formatTime(start)} – {formatTime(Math.min(duration, start + INTRO_SOUND_MAX_SECONDS))}
          </span>
        </div>
      </Modal>
    </div>,
    document.body,
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
