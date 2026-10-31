import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EyeOff, Maximize, Minimize, MonitorPause, Volume2, VolumeX, X } from 'lucide-react';
import { voice } from '../../features/voice/voiceClient';
import { cn } from '../../lib/utils';
import { useGuild, useSession } from '@diskort/client-core';
import { useSettings } from '../../stores/settings';
import { setVoice, useVoice } from '../../stores/voice';
import { LiveBadge } from '../sidebar/VoiceMemberRow';
import { Slider } from '../ui/Slider';
import { StreamViewers } from './StreamViewers';
import { SwapIcon } from '../ui/SwapIcon';
import { useEscapeLayer } from '../../lib/escape';
import { NO_ZOOM, panBy, wheelFactor, zoomAt, type Size, type Zoom } from './zoom';

/** Tek tık bu kadar bekler; içinde ikinci tık gelirse (çift tık: tam ekran) tek tık iptal edilir */
const CLICK_DELAY = 250;
/** Bundan fazla kayan basış tık değil sürüklemedir */
const DRAG_SLOP = 4;

interface Props {
  userId: string;
  /** Büyük (odaklanmış) görünüm mü, yoksa küçük önizleme mi */
  large?: boolean;
  /** Tek tık (çift tıkla çakışmasın diye kısa gecikmeyle çağrılır; yakınlaşmışken çağrılmaz) */
  onClick?: () => void;
  /**
   * false: ad şeridi, izleyenler ve kontrol barı çizilmez (yüzen pencere StreamPip kendi başlık ve alt
   * şeridini çizer; tam ekranda kontrol barı yine çıkar). Varsayılan true.
   */
  overlay?: boolean;
}

/** Bir kullanıcının ekran yayınını video öğesine bağlar. */
export function StreamView({ userId, large, onClick, overlay = true }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tracksVersion = useVoice((s) => s.tracksVersion);
  const hasAudio = useVoice((s) => s.streams[userId]?.hasAudio ?? false);
  const user = useGuild((s) => s.users[userId]);
  const isSelf = useSession((s) => s.user?.id === userId);
  const volume = useSettings((s) => s.streamVolumes[userId] ?? 1);
  const [fullscreen, setFullscreen] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  // Kendi yayının varsayılan olarak duraklatılır: track video öğesine hiç bağlanmaz (çözme/çizim yok)
  const paused = useVoice((s) => isSelf && !s.selfPreview);

  useEffect(() => {
    const el = videoRef.current;
    const track = paused ? undefined : voice.getScreenTrack(userId);
    if (!el || !track) {
      setHasVideo(false);
      return;
    }
    track.attach(el);
    setHasVideo(true);
    return () => {
      track.detach(el);
    };
  }, [userId, tracksVersion, paused]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  };

  // Yakınlaştırma yalnız büyük görünümde ve tam ekranda; görünüm değişince (büyük↔tam ekran dahil,
  // kutu ölçüsü değiştiği için) ve yayın değişince sıfırlanır
  const zoomable = Boolean(large) || fullscreen;
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const zoomed = zoom.s > 1;
  useEffect(() => setZoom(NO_ZOOM), [large, fullscreen, userId]);
  // Esc önce yakınlaştırmayı sıfırlar (sonra sahnenin kendi Esc davranışı)
  useEscapeLayer(() => setZoom(NO_ZOOM), zoomed);

  const measure = (): { box: Size; content: Size | null } => {
    const el = containerRef.current;
    const v = videoRef.current;
    const box = { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
    return {
      box,
      content: v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null,
    };
  };

  const onWheel = (e: React.WheelEvent): void => {
    if (!zoomable || !hasVideo || e.deltaY === 0) return;
    // Portal ile açılan izleyici listesi React ağacında içeride ama DOM'da dışarıda: onun tekerleği yayına işlemesin
    if (!containerRef.current?.contains(e.target as Node)) return;
    if ((e.target as Element).closest('[data-stage-chrome]')) return;
    // Sürüklerken ölçek değişirse pan başlangıcı eskir; sürükleme bitene kadar tekerleği yok say
    if (drag.current?.moving) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { box, content } = measure();
    setZoom((z) => zoomAt(z, z.s * wheelFactor(e.deltaY), e.clientX - rect.left, e.clientY - rect.top, box, content));
  };

  // Sürükleme: eşik aşılınca kaydırır (pan); sonrasındaki tık yutulur
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: Zoom;
    moving: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const suppressClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent): void => {
    suppressClick.current = false;
    if (e.button !== 0) return;
    if (!containerRef.current?.contains(e.target as Node)) return;
    // Kontrol barı, düğmeler ve kaydırıcılar kendi işini yapar
    if ((e.target as Element).closest('[data-stage-chrome], button, input, [role="slider"]')) return;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: zoom,
      moving: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) <= DRAG_SLOP) return;
      d.moving = true;
      suppressClick.current = true;
      if (d.start.s > 1) {
        containerRef.current?.setPointerCapture(e.pointerId);
        setDragging(true);
      }
    }
    if (d.start.s > 1) {
      const { box, content } = measure();
      setZoom(panBy(d.start, dx, dy, box, content));
    }
  };
  const endDrag = (e: React.PointerEvent): void => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  // Tek tık gecikmeli; çift tıkın ikinci tıkı onu iptal eder
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const handleClick = (e: React.MouseEvent): void => {
    clearTimeout(clickTimer.current);
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // Tam ekranda tek tık bir şey yapmaz (odak değişince öğe yeniden kurulur, tam ekran düşerdi)
    if (!onClick || e.detail > 1 || zoomed || fullscreen) return;
    clickTimer.current = setTimeout(onClick, CLICK_DELAY);
  };

  const setVolume = (v: number): void => {
    const streamVolumes = { ...useSettings.getState().streamVolumes, [userId]: v };
    useSettings.getState().set({ streamVolumes });
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'group @container relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-black',
        zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : onClick && 'cursor-pointer',
      )}
      onClick={handleClick}
      onDoubleClick={() => {
        clearTimeout(clickTimer.current);
        toggleFullscreen();
      }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Yakınlaştırma bu iç katmana uygulanır (kapsayıcının animasyonları etkilenmez) */}
      <div
        className="h-full w-full origin-top-left"
        style={
          zoomed
            ? {
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
                willChange: 'transform',
              }
            : undefined
        }
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            'h-full w-full object-contain transition-opacity duration-300',
            hasVideo ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
      {paused ? (
        <SelfPreviewPaused compact={!large} />
      ) : (
        !hasVideo && <div className="absolute animate-pulse text-sm text-text-muted">Yayın yükleniyor…</div>
      )}

      {overlay && (
        <>
          <div className="pointer-events-none absolute top-0 right-0 left-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent p-3 pr-32 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 group-data-[idle]/stage:opacity-0!">
            <LiveBadge />
            <span className="truncate text-sm font-semibold text-white">
              {isSelf ? 'Senin yayının' : user?.displayName}
            </span>
          </div>

          {/* İzleyenler her zaman görünür (yayıncı için asıl bilgi) */}
          <StreamViewers userId={userId} className="absolute top-2.5 right-2.5" />
        </>
      )}

      {/* Ses sahnesinde fare durunca gizlenir (VoiceStage: useStageChrome) */}
      <div
        data-stage-chrome
        className={cn(
          'absolute right-0 bottom-0 left-0 flex items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 group-data-[idle]/stage:opacity-0!',
          !overlay && !fullscreen && 'hidden',
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="mr-auto flex items-center gap-2">
          {zoomed && (
            <button
              type="button"
              onClick={() => setZoom(NO_ZOOM)}
              onDoubleClick={(e) => e.stopPropagation()}
              data-tooltip="Yakınlaştırmayı sıfırla"
              className="press flex h-8 items-center rounded-full bg-black/60 px-3 text-xs font-medium text-white/85 tabular-nums backdrop-blur-sm hover:text-white"
            >
              %{Math.round(zoom.s * 100)}
            </button>
          )}
          {!isSelf && hasAudio && (
            // Görüntünün üstünde okunaklı küçük hap: simge (sessize alır), kaydırıcı, yüzde; dar kutucukta yalnız simge
            <div className="flex h-8 items-center gap-2 rounded-full bg-black/60 pr-1 pl-1 text-white backdrop-blur-sm @xs:pr-3">
              <button
                className="press-icon flex h-6 w-6 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
                onClick={() => setVolume(volume > 0 ? 0 : 1)}
                data-tooltip={volume > 0 ? 'Yayın sesini kapat' : 'Yayın sesini aç'}
                aria-label="Yayın sesi"
              >
                <SwapIcon swapKey={volume > 0 ? 'on' : 'off'} motion="ico-pop">
                  {volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </SwapIcon>
              </button>
              <Slider
                className="hidden w-24 @xs:block"
                aria-label="Yayın ses seviyesi"
                aria-valuetext={`%${Math.round(volume * 100)}`}
                min={0}
                max={200}
                value={Math.round(volume * 100)}
                onValueChange={(v) => setVolume(v / 100)}
              />
              <span className="hidden w-9 text-right text-xs font-medium text-white/80 tabular-nums @xs:inline">
                %{Math.round(volume * 100)}
              </span>
            </div>
          )}
        </div>
        {isSelf && !paused && (
          <IconButton title="Önizlemeyi duraklat" onClick={() => setVoice({ selfPreview: false })}>
            <EyeOff size={18} className="ico-blink" />
          </IconButton>
        )}
        <IconButton title={fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'} onClick={toggleFullscreen}>
          <SwapIcon swapKey={fullscreen ? 'on' : 'off'} motion={fullscreen ? 'ico-shrink' : 'ico-grow'}>
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </SwapIcon>
        </IconButton>
        {!isSelf && (
          <IconButton title="İzlemeyi bırak" onClick={() => voice.stopWatching(userId)}>
            <X size={18} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/**
 * Kendi yayınına bakarken gösterilen duraklatılmış önizleme (Discord gibi): yayın sürer, yalnızca yerel
 * önizleme çizilmez. Tüm ekran paylaşılırken sonsuz ayna görüntüsünü de önler.
 */
function SelfPreviewPaused({ compact }: { compact: boolean }) {
  const show = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setVoice({ selfPreview: true });
  };
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center text-center',
        'bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-brand)_18%,transparent),transparent_70%)]',
        compact ? 'gap-1.5 p-2' : 'gap-3 p-6',
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-white/10 text-white',
          compact ? 'h-9 w-9' : 'h-14 w-14',
        )}
      >
        <MonitorPause size={compact ? 18 : 28} aria-hidden />
      </span>
      {compact ? (
        <span className="text-xs font-medium text-white/80">Önizleme duraklatıldı</span>
      ) : (
        <>
          <p className="max-w-sm text-sm leading-relaxed text-white/85">
            <span className="font-semibold text-white">Yayının halen devam ediyor!</span> Kaynaklarından tasarruf
            etmek için bu önizlemeyi duraklattık.
          </p>
          <button
            type="button"
            onClick={show}
            onDoubleClick={(e) => e.stopPropagation()}
            className="press rounded bg-control px-4 py-2 text-sm font-medium text-on-control transition-colors hover:bg-control-hover"
          >
            Önizlemeyi göster
          </button>
        </>
      )}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      data-tooltip={title}
      aria-label={title}
      onClick={onClick}
      className="press-icon flex h-8 w-8 items-center justify-center rounded bg-black/50 text-white hover:bg-black/80"
    >
      {children}
    </button>
  );
}
