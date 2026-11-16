import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Maximize, MonitorX, Volume2, VolumeX } from 'lucide-react';
import { channelById, dmTitle, useGuild, useSession } from '@diskort/client-core';
import { voice } from '../../features/voice/voiceClient';
import { DURATION, prefersReducedMotion, usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { LiveBadge } from '../sidebar/VoiceMemberRow';
import { StreamButton, StreamButtonGroup } from './StreamButton';
import { StreamView } from './StreamView';
import {
  clampPipWidth,
  clampPosition,
  cornerPosition,
  estimateVelocity,
  nearestCorner,
  PIP_VELOCITY_WINDOW_MS,
  pipSize,
  pipTarget,
  projectFling,
  resizeWidth,
  snapSpring,
  springAt,
  springSettled,
  type PipHandle,
  type PipPoint,
  type PipSample,
  type PipSize,
} from './pip';

/** Bundan fazla kayan basış tık değil taşımadır (StreamView ile aynı) */
const DRAG_SLOP = 4;

type Gesture =
  | { kind: 'move'; id: number; x: number; y: number; origin: PipPoint; moving: boolean }
  | { kind: 'resize'; id: number; x: number; y: number; startWidth: number; handle: PipHandle; width: number };

/**
 * İzlenen yayının yüzen küçük penceresi (Discord'daki gibi): ses sahnesi ekranda değilken (başka kanal, DM,
 * arkadaşlar) ana içerik alanının bir köşesinde durur. Taşınırken imleci doğrudan izler; bırakınca hızına
 * göre (savrulursa karşı köşeye) bir köşe seçilir ve oraya hafif aşmalı bir yayla oturur. Köşenin karşı
 * kenarlarından boyutlandırılır (16:9); köşe ve genişlik ayarlarda kalır. Tıklanınca sahneye dönülür. Ana
 * içerik alanının (`relative`) içine konur.
 */
export function StreamPip() {
  const inVoice = useVoice((s) => s.channelId !== null);
  const target = useVoice(pipTarget);
  // Sahne (ses görünümü ya da DM araması paneli) ekrandayken gösterilmez
  const stageShown = useUi((s) => s.stageMounts > 0);
  const { value: userId, closing } = usePresence(inVoice && !stageShown ? target : null, DURATION.base);
  if (!userId) return null;
  return <PipWindow userId={userId} closing={closing} />;
}

function PipWindow({ userId, closing }: { userId: string; closing: boolean }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<PipSize | null>(null);
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    // Alan: katmanın tamamı, ama metin kanalında ve DM'de mesaj kutusu (`data-pip-avoid`) altta kalır;
    // pencere onun üstünde durur (alt köşeler yazma alanını ve düğmelerini kapatmasın)
    let avoid: Element | null = null;
    const measure = (): void => {
      const layer = el.getBoundingClientRect();
      const rect = avoid?.getBoundingClientRect();
      // Gizli kutu (display: none) sayılmaz
      const inset = rect && rect.height > 0 ? Math.max(0, layer.bottom - rect.top) : 0;
      const next = { w: el.clientWidth, h: Math.max(0, el.clientHeight - inset) };
      setBox((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    // Görünüm değişince (kanal, DM, arkadaşlar) içerik alanının doğrudan çocuğu değişir; kutuyu yeniden bul
    const track = (): void => {
      const found = el.parentElement?.querySelector('[data-pip-avoid]') ?? null;
      if (found !== avoid) {
        if (avoid) resize.unobserve(avoid);
        avoid = found;
        if (avoid) resize.observe(avoid);
      }
      measure();
    };
    track();
    const views = new MutationObserver(track);
    if (el.parentElement) views.observe(el.parentElement, { childList: true });
    return () => {
      resize.disconnect();
      views.disconnect();
    };
  }, []);

  const corner = useSettings((s) => s.streamPipCorner);
  const savedWidth = useSettings((s) => s.streamPipWidth);
  // Boyutlandırılırken anlık genişlik; bırakılınca ayarlara yazılır
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // Taşınıyor: pencere hafifçe kalkar, şeritler gizlenir
  const [dragging, setDragging] = useState(false);

  const size = box ? pipSize(liveWidth ?? savedWidth, box) : null;
  const home = box && size ? cornerPosition(corner, box, size) : null;
  // Yay bitince güncel köşe konumu (yay sürerken alan boyutlanmış olabilir)
  const homeRef = useRef(home);
  useLayoutEffect(() => {
    homeRef.current = home;
  });

  // Konum React dışında tutulur ve doğrudan transform'a yazılır: taşırken her harekette yeniden çizim olmaz,
  // köşeye oturan yay da kare kare ilerler. `manual` iken (taşınıyor ya da yay sürüyor) köşe konumu yazılmaz.
  const shown = useRef<PipPoint | null>(null);
  const manual = useRef(false);
  const frame = useRef(0);
  const place = (p: PipPoint): void => {
    shown.current = p;
    const el = windowRef.current;
    if (el) el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  };
  const stopSpring = (): void => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    manual.current = false;
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // Köşe, genişlik ya da alan değişince (taşıma/yay yokken) pencere köşesine konur; çizimden önce
  const homeX = home?.x;
  const homeY = home?.y;
  useLayoutEffect(() => {
    if (homeX === undefined || homeY === undefined || manual.current) return;
    place({ x: homeX, y: homeY });
  }, [homeX, homeY]);

  /** Pencereyi bulunduğu yerden `target`'a yayla oturtur; başlangıç hızı bırakma hızıdır (px/ms) */
  const springTo = (target: PipPoint, velocity: PipPoint): void => {
    cancelAnimationFrame(frame.current);
    const from = shown.current ?? target;
    if (prefersReducedMotion() || !box || !size) {
      manual.current = false;
      place(homeRef.current ?? target);
      return;
    }
    const spring = snapSpring(Math.hypot(target.x - from.x, target.y - from.y));
    const area = box;
    const pip = size;
    manual.current = true;
    let start = -1;
    const step = (now: number): void => {
      if (start < 0) start = now;
      const t = now - start;
      const x = springAt(t, from.x, target.x, velocity.x, spring);
      const y = springAt(t, from.y, target.y, velocity.y, spring);
      if (springSettled(x, target.x) && springSettled(y, target.y)) {
        frame.current = 0;
        manual.current = false;
        // Bu arada alan boyutlandıysa güncel köşe konumu
        place(homeRef.current ?? target);
        return;
      }
      // Aşma kenar boşluğunu (16 px) geçmez; geçerse de pencere alanın dışına taşmaz
      place(clampPosition({ x: x.value, y: y.value }, area, pip));
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  const gesture = useRef<Gesture | null>(null);
  // Bırakma hızı için son imleç örnekleri
  const samples = useRef<PipSample[]>([]);
  // Taşımadan sonra gelen tık yutulur (sahneye dönmesin)
  const justDragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent): void => {
    justDragged.current = false;
    if (e.button !== 0 || !home) return;
    // İçteki yayın tam ekrandayken (olaylar yine buraya kabarcıklanır) pencere taşınmaz
    if (document.fullscreenElement) return;
    // Düğmeler ve boyutlandırma tutamaçları kendi işini yapar
    if ((e.target as Element).closest('button, [data-pip-resize]')) return;
    gesture.current = { kind: 'move', id: e.pointerId, x: e.clientX, y: e.clientY, origin: home, moving: false };
  };

  const startResize = (handle: PipHandle) => (e: React.PointerEvent): void => {
    // Taşıma başlamasın
    e.stopPropagation();
    if (e.button !== 0 || !size || document.fullscreenElement) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Yay yarıda kesildiyse pencere köşesine konur (köşe konumu değişmezse etki yeniden yazmaz)
    stopSpring();
    if (home) place(home);
    gesture.current = {
      kind: 'resize',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startWidth: size.w,
      handle,
      width: size.w,
    };
    setLiveWidth(size.w);
  };

  // Tutamaçtaki hareket de buraya kabarcıklanır (yakalama tutamaçta)
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || !box || !size) return;
    // Tuş pencerenin dışında bırakılmışsa (pointerup bize gelmedi) hareket burada biter; yoksa pencere
    // tuşsuz imleci izlerdi
    if (e.buttons === 0) {
      cancelGesture();
      return;
    }
    if (g.kind === 'resize') {
      g.width = clampPipWidth(resizeWidth(g.startWidth, e.clientX - g.x, e.clientY - g.y, corner, g.handle), box);
      setLiveWidth(g.width);
      return;
    }
    if (!g.moving) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= DRAG_SLOP) return;
      g.moving = true;
      justDragged.current = true;
      // Yay sürerken tutulduysa pencere ekrandaki yerinden devam eder (sıçramaz); eşik payı da yutulur
      stopSpring();
      manual.current = true;
      g.origin = shown.current ?? g.origin;
      g.x = e.clientX;
      g.y = e.clientY;
      samples.current = [];
      // Yakalama eşikte (basışta değil): basışta yakalamak içteki tık hedefini değiştirirdi
      windowRef.current?.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    place(clampPosition({ x: g.origin.x + e.clientX - g.x, y: g.origin.y + e.clientY - g.y }, box, size));
    const list = samples.current;
    list.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (list.length > 2 && e.timeStamp - list[0]!.t > PIP_VELOCITY_WINDOW_MS * 2) list.shift();
  };

  /** Yarım kalan hareketi (yakalama kaybı, tuşsuz imleç) kaydetmeden kapatır; pencere köşesine döner */
  const cancelGesture = (): void => {
    const g = gesture.current;
    gesture.current = null;
    setLiveWidth(null);
    setDragging(false);
    if (g?.kind === 'move' && g.moving && home) springTo(home, { x: 0, y: 0 });
  };

  const endGesture = (e: React.PointerEvent): void => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'resize') {
      useSettings.getState().set({ streamPipWidth: g.width });
      setLiveWidth(null);
      return;
    }
    if (!g.moving) return;
    setDragging(false);
    if (!box || !size) {
      manual.current = false;
      return;
    }
    samples.current.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    const velocity = estimateVelocity(samples.current, e.timeStamp);
    samples.current = [];
    const at = shown.current ?? cornerPosition(corner, box, size);
    // Köşe, pencerenin bu hızla kayarak varacağı yere göre seçilir (savrulursa karşı köşe)
    const next = nearestCorner(projectFling(at, velocity), box, size);
    useSettings.getState().set({ streamPipCorner: next });
    springTo(cornerPosition(next, box, size), velocity);
  };

  const returnToStage = (): void => useUi.getState().setView({ kind: 'voice' });
  const openFullscreen = (): void => {
    const el = windowRef.current?.querySelector<HTMLElement>('[data-stream-view]');
    void el?.requestFullscreen().catch(() => undefined);
  };

  const channelId = useVoice((s) => s.channelId);
  const selfId = useSession((s) => s.user?.id);
  const channelName = useGuild((s) => {
    const channel = channelById(s, channelId);
    if (channel) return channel.name;
    const dm = channelId ? s.dms[channelId] : undefined;
    return dm ? dmTitle(dm, s.users, selfId) : 'Sesli sohbet';
  });
  const streamer = useGuild((s) => s.users[userId]?.displayName ?? '');
  const hasAudio = useVoice((s) => s.streams[userId]?.hasAudio ?? false);
  const volume = useSettings((s) => s.streamVolumes[userId] ?? 1);
  const toggleAudio = (): void => {
    const streamVolumes = { ...useSettings.getState().streamVolumes, [userId]: volume > 0 ? 0 : 1 };
    useSettings.getState().set({ streamVolumes });
  };

  const busy = dragging || liveWidth !== null;
  // Tutamaçlar yapışılan köşenin karşı kenarlarında (sağ alttaysa sol, üst ve sol üst köşe)
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {size && home && (
        <div
          ref={windowRef}
          aria-label={`${streamer} yayını`}
          className={cn(
            'group/pip pointer-events-auto absolute top-0 left-0 touch-none select-none will-change-transform',
            dragging && 'cursor-grabbing [&_*]:cursor-grabbing',
          )}
          style={{ width: size.w, height: size.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onLostPointerCapture={() => gesture.current && cancelGesture()}
          onClickCapture={(e) => {
            if (!justDragged.current) return;
            justDragged.current = false;
            e.stopPropagation();
          }}
        >
          {/* Taşırken hafifçe kalkar (ölçek + daha derin gölge) */}
          <div
            className={cn(
              'h-full w-full transition-transform ease-out motion-reduce:transition-none',
              dragging && 'scale-[1.025]',
            )}
            style={{ transitionDuration: `${DURATION.base}ms` }}
          >
            <div className={cn('relative h-full w-full', closing ? 'anim-tile-out' : 'anim-tile-in')}>
              <div
                className={cn(
                  'relative h-full w-full overflow-hidden rounded-lg bg-black ring-1 ring-edge-strong transition-shadow duration-200',
                  dragging ? 'shadow-[0_18px_44px_rgb(0_0_0/0.6)]' : 'shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
                )}
              >
                <StreamView userId={userId} overlay={false} onClick={returnToStage} />

                {/* Üst şerit: ses kanalının adı, tıklanınca sahneye dönülür */}
                <div
                  className={cn(
                    'pointer-events-none absolute inset-x-0 top-0 flex items-center bg-gradient-to-b from-black/70 to-transparent px-1.5 pt-1.5 pb-5 opacity-0 transition-opacity group-focus-within/pip:opacity-100 group-hover/pip:opacity-100',
                    busy && 'opacity-0!',
                  )}
                >
                  <button
                    type="button"
                    onClick={returnToStage}
                    data-tooltip="Sahneye dön"
                    className="press pointer-events-auto flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold text-white/85 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <ArrowLeft size={14} className="shrink-0" aria-hidden />
                    <span className="truncate">{channelName}</span>
                  </button>
                </div>

                {/* Alt şerit: yayıncı ve düğmeler */}
                <div
                  className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-2 opacity-0 transition-opacity group-focus-within/pip:opacity-100 group-hover/pip:opacity-100',
                    busy && 'opacity-0!',
                  )}
                >
                  <LiveBadge />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white">{streamer}</span>
                  <StreamButtonGroup>
                    {hasAudio && (
                      <StreamButton label={volume > 0 ? 'Yayın sesini kapat' : 'Yayın sesini aç'} onClick={toggleAudio}>
                        {volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
                      </StreamButton>
                    )}
                    <StreamButton label="Tam ekran" onClick={openFullscreen}>
                      <Maximize size={16} />
                    </StreamButton>
                    <StreamButton tone="danger" label="İzlemeyi bırak" onClick={() => voice.stopWatching(userId)}>
                      <MonitorX size={16} />
                    </StreamButton>
                  </StreamButtonGroup>
                </div>
              </div>

              {/* Boyutlandırma tutamaçları (kenarın biraz dışına taşar; köşe tutamacı en üstte) */}
              <div
                data-pip-resize
                onPointerDown={startResize('x')}
                className={cn('absolute top-0 bottom-0 w-2 cursor-ew-resize', right ? '-left-1' : '-right-1')}
              />
              <div
                data-pip-resize
                onPointerDown={startResize('y')}
                className={cn('absolute right-0 left-0 h-2 cursor-ns-resize', bottom ? '-top-1' : '-bottom-1')}
              />
              <div
                data-pip-resize
                onPointerDown={startResize('xy')}
                className={cn(
                  'absolute h-4 w-4',
                  bottom ? '-top-1.5' : '-bottom-1.5',
                  right ? '-left-1.5' : '-right-1.5',
                  right === bottom ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
                )}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
