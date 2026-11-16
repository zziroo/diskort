import { useEffect, useRef, useState, type RefObject } from 'react';
import { EyeOff, Maximize, Minimize, MonitorPause, MonitorX, Volume2, VolumeX } from 'lucide-react';
import { voice } from '../../features/voice/voiceClient';
import { DURATION, prefersReducedMotion } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { useGuild, useSession } from '@diskort/client-core';
import { useSettings } from '../../stores/settings';
import { setVoice, useVoice } from '../../stores/voice';
import { LiveBadge } from '../sidebar/VoiceMemberRow';
import { Slider } from '../ui/Slider';
import { StreamViewers } from './StreamViewers';
import { SwapIcon } from '../ui/SwapIcon';
import { useEscapeLayer } from '../../lib/escape';
import { NO_ZOOM, panBy, wheelFactor, zoomAt, type Size, type Zoom } from './zoom';
import { StreamButton, StreamButtonDivider, StreamButtonGroup } from './StreamButton';

/** Tek tık bu kadar bekler; içinde ikinci tık gelirse (çift tık: tam ekran) tek tık iptal edilir */
const CLICK_DELAY = 250;
/** Tek tıkla tam ekrandan çıktıktan sonra bu süre içinde gelen çift tık yok sayılır (sistem çift tık süresi) */
const SLOW_DBLCLICK_MS = 600;
/** Bundan fazla kayan basış tık değil sürüklemedir */
const DRAG_SLOP = 4;
/** Tam ekranda fare bu kadar durunca şeritler ve imleç gizlenir */
const FULLSCREEN_IDLE_MS = 2500;

interface Props {
  userId: string;
  /** Büyük (odaklanmış) görünüm mü, yoksa küçük önizleme mi */
  large?: boolean;
  /**
   * Tek tık (çift tıkla çakışmasın diye kısa gecikmeyle çağrılır; yakınlaşmışken çağrılmaz). Tam ekranda
   * tek tık bunun yerine tam ekrandan çıkar ("bir seviye geri").
   */
  onClick?: () => void;
  /**
   * false: ad şeridi, izleyenler ve kontrol barı çizilmez (yüzen pencere StreamPip kendi başlık ve alt
   * şeridini çizer; tam ekranda şerit ve kontrol barı yine çıkar). Varsayılan true.
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
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void containerRef.current?.requestFullscreen().catch(() => undefined);
  };

  // Tam ekrana giriş/çıkışta görüntü sert sıçramasın: video kısa bir solma ve ölçekle yerine oturur
  const prevFullscreen = useRef(fullscreen);
  useEffect(() => {
    if (prevFullscreen.current === fullscreen) return;
    prevFullscreen.current = fullscreen;
    if (prefersReducedMotion()) return;
    videoRef.current?.animate(
      [
        { opacity: 0.4, transform: 'scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: DURATION.slow + 60, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [fullscreen]);

  // F: büyük görünümde ya da tam ekranda tam ekranı açar/kapatır (yazı yazarken değil)
  const big = Boolean(large) || fullscreen;
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'f' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      const ui = useUi.getState();
      if (ui.modal !== null || ui.contextMenu !== null) return;
      const current = document.fullscreenElement;
      // Başka bir öğe tam ekrandaysa (ör. şeritteki kutucuk) o kendi işini yapar
      if (current ? current !== containerRef.current : !large) return;
      e.preventDefault();
      toggleFullscreen();
    };
    // Yakalama evresinde: DM aramasının altındaki "yazmaya başlayınca kutuya odaklan" dinleyicisinden önce
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [big, large]);

  // Tam ekranda fare durunca şeritler ve imleç gizlenir (sahnenin kendi boşta durumu yüzen pencereden
  // açılan tam ekranı kapsamaz)
  const idle = useFullscreenIdle(containerRef, fullscreen);

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
    // İzleyici listesi açıkken dışına tıklamak yalnız listeyi kapatır (tam ekrandan çıkmaz, sahneye dönmez)
    suppressClick.current = containerRef.current?.querySelector('[aria-haspopup][aria-expanded="true"]') != null;
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
  // Tek tıkla tam ekrandan çıkılan an: yavaş bir çift tıkın (250 ms'den uzun, sistemin çift tık süresi
  // içinde) dblclick'i bundan sonra gelirse tam ekrana geri girmesin
  const clickExitAt = useRef(0);
  const handleClick = (e: React.MouseEvent): void => {
    clearTimeout(clickTimer.current);
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (e.detail > 1 || zoomed) return;
    // Portal ile açılan izleyici listesinin tıkı (React ağacında içeride, DOM'da dışarıda) sayılmaz
    if (!containerRef.current?.contains(e.target as Node)) return;
    // Tam ekranda tek tık tam ekrandan çıkar; doğrudan, odak değiştirmeden (öğe yeniden kurulmasın)
    if (fullscreen) {
      clickTimer.current = setTimeout(() => {
        if (document.fullscreenElement !== containerRef.current) return;
        clickExitAt.current = performance.now();
        void document.exitFullscreen().catch(() => undefined);
      }, CLICK_DELAY);
      return;
    }
    if (!onClick) return;
    clickTimer.current = setTimeout(onClick, CLICK_DELAY);
  };

  // Şeritlerin görünürlüğü: tam ekranda boşta kalana dek açık; değilse fare üstündeyken (sahne boşta gizler)
  const chromeVisibility = fullscreen
    ? idle
      ? 'pointer-events-none opacity-0'
      : 'opacity-100'
    : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-data-[idle]/stage:opacity-0!';
  const pill = big ? 'h-10' : 'h-8';

  const setVolume = (v: number): void => {
    const streamVolumes = { ...useSettings.getState().streamVolumes, [userId]: v };
    useSettings.getState().set({ streamVolumes });
  };

  return (
    <div
      ref={containerRef}
      data-stream-view
      className={cn(
        'group @container relative flex h-full w-full items-center justify-center overflow-hidden bg-black',
        fullscreen ? 'rounded-none' : 'rounded-lg',
        zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : (onClick || fullscreen) && 'cursor-pointer',
        idle && 'cursor-none [&_*]:cursor-none',
      )}
      onClick={handleClick}
      onDoubleClick={() => {
        clearTimeout(clickTimer.current);
        if (performance.now() - clickExitAt.current < SLOW_DBLCLICK_MS) return;
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

      {(overlay || fullscreen) && (
        <>
          <div
            className={cn(
              'pointer-events-none absolute top-0 right-0 left-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent pr-32 transition-opacity duration-300',
              fullscreen ? 'p-4' : 'p-3',
              chromeVisibility,
            )}
          >
            <LiveBadge />
            <span className={cn('truncate font-semibold text-white', fullscreen ? 'text-base' : 'text-sm')}>
              {isSelf ? 'Senin yayının' : user?.displayName}
            </span>
          </div>

          {/* İzleyenler her zaman görünür (yayıncı için asıl bilgi) */}
          <StreamViewers
            userId={userId}
            className={cn(
              'absolute',
              fullscreen ? 'top-3.5 right-4 transition-opacity duration-300' : 'top-2.5 right-2.5',
              fullscreen && idle && 'pointer-events-none opacity-0',
            )}
          />
        </>
      )}

      {/* Ses sahnesinde fare durunca gizlenir (VoiceStage: useStageChrome), tam ekranda useFullscreenIdle */}
      <div
        data-stage-chrome
        className={cn(
          'absolute right-0 bottom-0 left-0 flex items-center justify-end gap-2 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-300',
          big ? 'px-3 pt-10 pb-3' : 'p-2 pt-6',
          chromeVisibility,
          !overlay && !fullscreen && 'hidden',
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="mr-auto flex min-w-0 items-center gap-2">
          {!isSelf && hasAudio && (
            // Görüntünün üstünde okunaklı küçük hap: simge (sessize alır), kaydırıcı, yüzde; dar kutucukta yalnız simge
            <div
              className={cn(
                'flex items-center gap-2 rounded-full bg-black/55 pr-1 pl-1 text-white ring-1 ring-white/10 backdrop-blur-md @xs:pr-3',
                pill,
              )}
            >
              <button
                type="button"
                className={cn(
                  'press-icon flex items-center justify-center rounded-full text-white outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/80',
                  big ? 'h-8 w-8' : 'h-6 w-6',
                )}
                onClick={() => setVolume(volume > 0 ? 0 : 1)}
                data-tooltip={volume > 0 ? 'Yayın sesini kapat' : 'Yayın sesini aç'}
                aria-label="Yayın sesi"
              >
                <SwapIcon swapKey={volume > 0 ? 'on' : 'off'} motion="ico-pop">
                  {volume > 0 ? <Volume2 size={big ? 18 : 16} /> : <VolumeX size={big ? 18 : 16} />}
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
          {zoomed && (
            <button
              type="button"
              onClick={() => setZoom(NO_ZOOM)}
              onDoubleClick={(e) => e.stopPropagation()}
              data-tooltip="Yakınlaştırmayı sıfırla (Esc)"
              className={cn(
                'press anim-pill-in flex items-center rounded-full bg-black/55 px-3 text-xs font-medium text-white/85 tabular-nums ring-1 ring-white/10 backdrop-blur-md outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/80',
                pill,
              )}
            >
              %{Math.round(zoom.s * 100)}
            </button>
          )}
        </div>
        <StreamButtonGroup>
          {isSelf && !paused && (
            <StreamButton size={big ? 'md' : 'sm'} label="Önizlemeyi duraklat" onClick={() => setVoice({ selfPreview: false })}>
              <EyeOff size={big ? 18 : 16} className="ico-blink" />
            </StreamButton>
          )}
          <StreamButton
            size={big ? 'md' : 'sm'}
            label={fullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}
            shortcut={big ? 'F' : undefined}
            onClick={toggleFullscreen}
          >
            <SwapIcon swapKey={fullscreen ? 'on' : 'off'} motion={fullscreen ? 'ico-shrink' : 'ico-grow'}>
              {fullscreen ? <Minimize size={big ? 18 : 16} /> : <Maximize size={big ? 18 : 16} />}
            </SwapIcon>
          </StreamButton>
          {!isSelf && (
            <>
              {big && <StreamButtonDivider />}
              <StreamButton
                size={big ? 'md' : 'sm'}
                tone="danger"
                label="İzlemeyi bırak"
                // Yazı kutu yeterince genişse görünür (dar DM araması panelinde yalnız simge)
                text={big ? 'İzlemeyi bırak' : undefined}
                onClick={() => voice.stopWatching(userId)}
              >
                <MonitorX size={big ? 18 : 16} />
              </StreamButton>
            </>
          )}
        </StreamButtonGroup>
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

/** Yazı alanında (metin kutusu, Slate editörü) basılan tuş kısayol sayılmaz */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/**
 * Tam ekrandaki yayının "boşta" durumu: fare hareket edince ya da tuşa basılınca şeritler belirir, fare
 * FULLSCREEN_IDLE_MS durunca kaybolur. Fare bir kontrolün üstündeyken, kontrolde klavye odağı varken ya da
 * izleyici listesi açıkken gizlenmez.
 */
function useFullscreenIdle(ref: RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    let timer = 0;
    const held = (): boolean =>
      root.querySelector(
        '[data-stage-chrome]:hover, [data-stage-chrome] :hover, [data-stage-chrome] :focus-visible, [aria-haspopup][aria-expanded="true"]',
      ) !== null;
    const hideLater = (): void => {
      window.clearTimeout(timer);
      const check = (): void => {
        if (held()) timer = window.setTimeout(check, 500);
        else setIdle(true);
      };
      timer = window.setTimeout(check, FULLSCREEN_IDLE_MS);
    };
    const wake = (): void => {
      setIdle(false);
      hideLater();
    };
    root.addEventListener('pointermove', wake);
    root.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    hideLater();
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener('pointermove', wake);
      root.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
      setIdle(false);
    };
  }, [enabled, ref]);
  return enabled && idle;
}
