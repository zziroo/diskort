import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Volume2, VolumeX, X } from 'lucide-react';
import { channelById, dmTitle, useGuild, useSession } from '@diskort/client-core';
import { voice } from '../../features/voice/voiceClient';
import { DURATION, usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { LiveBadge } from '../sidebar/VoiceMemberRow';
import { StreamView } from './StreamView';
import {
  clampPipWidth,
  clampPosition,
  cornerPosition,
  nearestCorner,
  pipSize,
  pipTarget,
  resizeWidth,
  type PipHandle,
  type PipPoint,
  type PipSize,
} from './pip';

/** Bundan fazla kayan basış tık değil taşımadır (StreamView ile aynı) */
const DRAG_SLOP = 4;
/** Bırakılan pencerenin köşeye kayma süresi */
const SNAP_MS = DURATION.slow;

type Gesture =
  | { kind: 'move'; id: number; x: number; y: number; origin: PipPoint; moving: boolean }
  | { kind: 'resize'; id: number; x: number; y: number; startWidth: number; handle: PipHandle; width: number };

/**
 * İzlenen yayının yüzen küçük penceresi (Discord'daki gibi): ses sahnesi ekranda değilken (başka kanal, DM,
 * arkadaşlar) ana içerik alanının bir köşesinde durur. Sürüklenip bırakılınca en yakın köşeye yapışır,
 * köşenin karşı kenarlarından boyutlandırılır (16:9); köşe ve genişlik ayarlarda kalır. Tıklanınca sahneye
 * dönülür. Ana içerik alanının (`relative`) içine konur.
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
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const corner = useSettings((s) => s.streamPipCorner);
  const savedWidth = useSettings((s) => s.streamPipWidth);
  // Sürüklenirken serbest konum, boyutlandırılırken anlık genişlik; bırakılınca ayarlara yazılır
  const [dragPos, setDragPos] = useState<PipPoint | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // Bırakılınca köşeye kayarken transform geçişi açık (sürüklerken ve pencere boyutlanırken kapalı)
  const [snapping, setSnapping] = useState(false);
  useEffect(() => {
    if (!snapping) return;
    const timer = window.setTimeout(() => setSnapping(false), SNAP_MS + 40);
    return () => window.clearTimeout(timer);
  }, [snapping]);

  const size = box ? pipSize(liveWidth ?? savedWidth, box) : null;
  const pos = box && size ? (dragPos ?? cornerPosition(corner, box, size)) : null;

  const gesture = useRef<Gesture | null>(null);
  // Taşımadan sonra gelen tık yutulur (sahneye dönmesin)
  const justDragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent): void => {
    justDragged.current = false;
    if (e.button !== 0 || !pos) return;
    // Düğmeler ve boyutlandırma tutamaçları kendi işini yapar
    if ((e.target as Element).closest('button, [data-pip-resize]')) return;
    gesture.current = { kind: 'move', id: e.pointerId, x: e.clientX, y: e.clientY, origin: pos, moving: false };
  };

  const startResize = (handle: PipHandle) => (e: React.PointerEvent): void => {
    // Taşıma başlamasın
    e.stopPropagation();
    if (e.button !== 0 || !size) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      kind: 'resize',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startWidth: size.w,
      handle,
      width: size.w,
    };
    setSnapping(false);
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
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.kind === 'resize') {
      g.width = clampPipWidth(resizeWidth(g.startWidth, dx, dy, corner, g.handle), box);
      setLiveWidth(g.width);
      return;
    }
    if (!g.moving) {
      if (Math.hypot(dx, dy) <= DRAG_SLOP) return;
      g.moving = true;
      justDragged.current = true;
      windowRef.current?.setPointerCapture(e.pointerId);
      setSnapping(false);
    }
    setDragPos(clampPosition({ x: g.origin.x + dx, y: g.origin.y + dy }, box, size));
  };

  /** Yarım kalan hareketi (yakalama kaybı, tuşsuz imleç) kaydetmeden kapatır; pencere köşesine döner */
  const cancelGesture = (): void => {
    gesture.current = null;
    setLiveWidth(null);
    setDragPos(null);
    setSnapping(true);
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
    if (!g.moving || !box || !size) {
      setDragPos(null);
      return;
    }
    const final = clampPosition({ x: g.origin.x + e.clientX - g.x, y: g.origin.y + e.clientY - g.y }, box, size);
    useSettings.getState().set({ streamPipCorner: nearestCorner(final, box, size) });
    setDragPos(null);
    setSnapping(true);
  };

  const returnToStage = (): void => useUi.getState().setView({ kind: 'voice' });

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

  const busy = dragPos !== null || liveWidth !== null;
  // Tutamaçlar yapışılan köşenin karşı kenarlarında (sağ alttaysa sol, üst ve sol üst köşe)
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {size && pos && (
        <div
          ref={windowRef}
          aria-label={`${streamer} yayını`}
          className={cn(
            'group/pip pointer-events-auto absolute top-0 left-0 touch-none select-none',
            dragPos && 'cursor-grabbing',
          )}
          style={{
            width: size.w,
            height: size.h,
            transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
            transition: snapping ? `transform ${SNAP_MS}ms var(--ease-out)` : undefined,
          }}
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
          <div className={cn('relative h-full w-full', closing ? 'anim-tile-out' : 'anim-tile-in')}>
            <div className="relative h-full w-full overflow-hidden rounded-lg bg-black shadow-[0_8px_24px_rgb(0_0_0/0.45)] ring-1 ring-edge-strong">
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
                  'pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pt-6 pb-2 opacity-0 transition-opacity group-focus-within/pip:opacity-100 group-hover/pip:opacity-100',
                  busy && 'opacity-0!',
                )}
              >
                <LiveBadge />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white">{streamer}</span>
                {hasAudio && (
                  <PipButton title={volume > 0 ? 'Yayın sesini kapat' : 'Yayın sesini aç'} onClick={toggleAudio}>
                    {volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
                  </PipButton>
                )}
                <PipButton title="İzlemeyi bırak" onClick={() => voice.stopWatching(userId)}>
                  <X size={16} />
                </PipButton>
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
      )}
    </div>
  );
}

function PipButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-tooltip={title}
      aria-label={title}
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="press-icon pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded bg-black/50 text-white transition-colors hover:bg-black/80"
    >
      {children}
    </button>
  );
}
