import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, Eye, Monitor } from 'lucide-react';
import { create } from 'zustand';
import type { VoiceState } from '@diskort/shared';
import { fetchStreamPreview, formatStreamElapsed, useGuild, useSession } from '@diskort/client-core';
import { usePresence } from '../../lib/motion';
import { useSidebarDrag } from '../../lib/sidebarDrag';
import { cn } from '../../lib/utils';
import { watchUserStream } from '../../lib/watchStream';
import { useVoice } from '../../stores/voice';
import { StreamViewers } from '../stage/StreamViewers';
import { Avatar } from '../ui/Avatar';
import { LiveBadge } from './VoiceMemberRow';

/**
 * "Şimdi Yayın Yapıyor" kartı (Discord gibi): kanal listesinde yayın yapan üyenin üstünde biraz
 * bekleyince sağında açılır; yayının küçük önizlemesi, paylaşılan pencerenin adı ve süresi. Önizlemenin kendisi
 * düğmedir: tıklayınca yayını izler (kendi yayınında sahnede öne alır). Resim yoksa avatarlı yer tutucu görünür. İmleç satırdan karta geçerken kapanmaz; kaydırma, sürükleme ya da tıklama kapatır.
 */

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;
const GAP = 8;
const MARGIN = 8;
/** Bellekte tutulan önizleme resimleri (object URL) */
const CACHE_SIZE = 8;

interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CardTarget {
  userId: string;
  channelId: string;
  anchor: Anchor;
}

const useStreamCard = create<{ target: CardTarget | null }>(() => ({ target: null }));

let openTimer = 0;
let closeTimer = 0;

function clearTimers(): void {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
}

export function closeStreamCard(): void {
  clearTimers();
  if (useStreamCard.getState().target) useStreamCard.setState({ target: null });
}

function scheduleClose(): void {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeStreamCard, CLOSE_DELAY_MS);
}

/**
 * Yayın yapan üyenin satırına verilecek olaylar. Yalnızca fareyle (dokunmada kart açılmaz); sürükleme
 * sürerken açılmaz, satıra basınca (tıklama → profil, sürükleme başlangıcı) hemen kapanır.
 */
export function streamCardHandlers(state: Pick<VoiceState, 'userId' | 'channelId'>) {
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'mouse' || useSidebarDrag.getState().item) return;
      const el = e.currentTarget;
      clearTimers();
      const open = (): void => {
        if (!el.isConnected || useSidebarDrag.getState().item) return;
        const r = el.getBoundingClientRect();
        useStreamCard.setState({
          target: {
            userId: state.userId,
            channelId: state.channelId,
            anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          },
        });
      };
      // Başka bir yayın kartı zaten açıksa beklemeden geçer
      if (useStreamCard.getState().target) open();
      else openTimer = window.setTimeout(open, OPEN_DELAY_MS);
    },
    onPointerLeave: scheduleClose,
    onPointerDownCapture: closeStreamCard,
  };
}

// ---------- Önizleme resmi ----------

const cache = new Map<string, string>();

function remember(key: string, url: string): void {
  cache.set(key, url);
  while (cache.size > CACHE_SIZE) {
    const [oldest, old] = cache.entries().next().value as [string, string];
    cache.delete(oldest);
    URL.revokeObjectURL(old);
  }
}

/** Kart açıkken (ya da `open` true iken) önizlemeyi indirir; yenisi gelene kadar eskisi görünür */
function usePreviewImage(state: VoiceState | undefined, open: boolean): string | null {
  const at = state?.streamPreviewAt;
  const key = state && at ? `${state.userId}:${state.channelId}:${at}` : null;
  const [shown, setShown] = useState<{ userId: string; url: string } | null>(null);

  useEffect(() => {
    if (!open || !key || !state) return;
    const cached = cache.get(key);
    if (cached) {
      setShown({ userId: state.userId, url: cached });
      return;
    }
    const controller = new AbortController();
    const target = { userId: state.userId, channelId: state.channelId, streamPreviewAt: at };
    fetchStreamPreview(target, controller.signal)
      .then((blob) => {
        if (!blob || controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        remember(key, url);
        setShown({ userId: target.userId, url });
      })
      .catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  return shown && state && shown.userId === state.userId && at ? shown.url : null;
}

/**
 * Satırda sürekli duran küçük resim için: önbellekten atılıp iptal edilen bir objectURL kırık görünürse
 * (`onError`) gösterilen resmi düşürür; anahtar değişmediği için yeniden indirmek yerine yer tutucuya döner.
 */
export function useLivePreviewImage(state: VoiceState): { src: string | null; onError: () => void } {
  const url = usePreviewImage(state, true);
  const [broken, setBroken] = useState<string | null>(null);
  return { src: url && broken !== url ? url : null, onError: () => setBroken(url) };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// ---------- Kart ----------

/** App'te bir kez çizilir */
export function StreamPreviewCard() {
  const target = useStreamCard((s) => s.target);
  const { value: shown, closing } = usePresence(target, 100);
  const state = useGuild((s) => (shown ? s.voiceStates[shown.userId] : undefined));
  const user = useGuild((s) => (shown ? s.users[shown.userId] : undefined));
  const selfId = useSession((s) => s.user?.id);
  const watching = useVoice(
    (s) => Boolean(shown && s.watching[shown.userId] && s.channelId === shown.channelId && s.status !== 'idle'),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const open = Boolean(target) && !closing;
  const image = usePreviewImage(state, open);
  const now = useNow(open);

  useLayoutEffect(() => {
    if (!target || !ref.current) return;
    const { offsetWidth: width, offsetHeight: height } = ref.current;
    const { anchor } = target;
    const right = anchor.right + GAP;
    const maxX = window.innerWidth - width - MARGIN;
    const x = right <= maxX ? right : Math.max(MARGIN, Math.min(maxX, anchor.left - width - GAP));
    const y = Math.max(MARGIN, Math.min(anchor.top - 8, window.innerHeight - height - MARGIN));
    setPos({ x, y });
  }, [target]);

  // Kaydırma, sürükleme, pencereden çıkma ya da yayının bitmesi kartı kapatır
  useEffect(() => {
    if (!target) return;
    // Kartın ve kartın izleyici listesinin (ayrı katmanda) içindeki kaydırma kapatmaz
    const inside = (t: EventTarget | null): boolean =>
      Boolean(ref.current?.contains(t as Node) || (t instanceof Element && t.closest('[role="dialog"][aria-label="İzleyiciler"]')));
    const onWheel = (e: WheelEvent): void => {
      if (!inside(e.target)) closeStreamCard();
    };
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) closeStreamCard();
    };
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', closeStreamCard);
    const unsubscribe = useSidebarDrag.subscribe((s) => {
      if (s.item) closeStreamCard();
    });
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', closeStreamCard);
      unsubscribe();
    };
  }, [target]);

  useEffect(() => {
    if (target && (!state?.streaming || state.channelId !== target.channelId)) closeStreamCard();
  }, [target, state]);

  if (!shown || !state) return null;

  const isSelf = state.userId === selfId;
  // Önizlemenin üstünde beliren eylem (kendi yayınında sahnede öne alır)
  const label = isSelf ? 'Yayınına git' : watching ? 'İzlemeye dön' : 'İzle';
  const SourceIcon = state.streamSourceKind === 'screen' ? Monitor : AppWindow;
  const watch = (): void => {
    closeStreamCard();
    void watchUserStream(state.userId, state.channelId);
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Şimdi Yayın Yapıyor"
      data-tooltip-off=""
      onPointerEnter={() => window.clearTimeout(closeTimer)}
      onPointerLeave={scheduleClose}
      className={cn(
        'fixed z-50 w-[300px] rounded-lg border border-edge bg-bg-float p-3 shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
        closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
      )}
      style={pos ? { left: pos.x, top: pos.y, transformOrigin: '0 16px' } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-head">Şimdi Yayın Yapıyor</span>
        <LiveBadge />
      </div>
      {/* Önizlemenin kendisi düğme: üstüne gelince karartılır ve ortada "İzle" belirir */}
      <div className="relative">
        <button
          type="button"
          onClick={watch}
          aria-label={isSelf ? 'Yayınına git' : 'Yayını izle'}
          className="group/preview relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-black ring-1 ring-float-edge transition-[box-shadow,filter] duration-150 hover:ring-text-muted/50 hover:brightness-110"
        >
          {image ? (
            <img
              src={image}
              alt="Yayın önizlemesi"
              draggable={false}
              className="h-full w-full object-contain transition-transform duration-200 ease-out group-hover/preview:scale-[1.03] motion-reduce:transition-none"
            />
          ) : (
            // Yer tutucu: yayıncının renginde hafif bir ışıma, ortada avatarı
            <span
              className="flex h-full w-full flex-col items-center justify-center gap-2"
              style={{
                background: `radial-gradient(ellipse at center, color-mix(in srgb, ${user?.avatarColor ?? '#5865f2'} 45%, transparent), transparent 75%)`,
              }}
            >
              <span className="animate-pulse rounded-full shadow-[0_0_0_4px_rgb(255_255_255/0.12)]">
                <Avatar user={user} size={48} />
              </span>
              <span className="text-xs text-white/70">
                {state.streamPreviewAt ? 'Yükleniyor…' : 'Önizleme hazırlanıyor…'}
              </span>
            </span>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-150 group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-sm font-semibold text-white">
              <Eye size={16} aria-hidden /> {label}
            </span>
          </span>
        </button>
        <StreamViewers userId={state.userId} className="absolute top-2 right-2" />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-sm text-text-normal">
        <SourceIcon size={14} className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{state.streamSourceName ?? 'Ekran paylaşımı'}</span>
        {state.streamStartedAt !== undefined && (
          <span className="shrink-0 text-xs text-text-muted tabular-nums" aria-label="Yayın süresi">
            {formatStreamElapsed(now - state.streamStartedAt)}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
