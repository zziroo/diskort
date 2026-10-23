import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { create } from 'zustand';
import type { Activity } from '@diskort/shared';
import { ACTIVITY_LINK_GROUP_LABELS, activityLinks, type ActivityLinkGroup } from '@diskort/client-core';
import { bridge } from '../../lib/bridge';
import { useEscapeLayer } from '../../lib/escape';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { ActivityCard, useKnownActivities } from './ActivityCard';

/**
 * "Oyun sayfası": algılanan bir oyuna tıklayınca açılan küçük kart: oyunun adı, ikonu, ne zamandır oynandığı
 * ve dış bağlantılar (Steam/SteamDB/ProtonDB oyunun kendi sayfasına, öteki platformlar ada göre arama).
 * Bağlantılar sistem tarayıcısında açılır. Hover kartından (ActivityHoverCard) farkı: tıklamayla açılır,
 * Esc ya da dışarı tıklama kapatır, içine tıklanabilir. App'te bir kez çizilir; açan yerler
 * `openActivityPopover` çağırır. Kişinin profil kartı (ProfilePopover, SelfProfilePopout) bu kartın içindeki
 * tıklamayı dışarı tıklama saymaz (`data-activity-popover`).
 */

const WIDTH = 288;
const GAP = 8;
const MARGIN = 8;
const GROUPS: ActivityLinkGroup[] = ['store', 'info', 'watch', 'search'];

export interface ActivityAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PopoverTarget {
  userId: string;
  /** Hangi etkinlik (tür + ad; kişinin listesinden canlı okunur, biterse kart kapanır) */
  type: Activity['type'];
  name: string;
  anchor: ActivityAnchor;
  /** Tercih edilen taraf; sığmazsa öbürü */
  side: 'right' | 'left';
}

const useActivityPopover = create<{ target: PopoverTarget | null }>(() => ({ target: null }));

/** Dışarı tıklama kapatır; açan öğeye yeniden tıklamak kartı kapatıp hemen yeniden açmasın */
let lastClosed: { key: string; at: number } | null = null;
const keyOf = (t: Pick<PopoverTarget, 'userId' | 'type' | 'name'>): string => `${t.userId}\0${t.type}\0${t.name}`;

export function closeActivityPopover(): void {
  const { target } = useActivityPopover.getState();
  if (!target) return;
  lastClosed = { key: keyOf(target), at: Date.now() };
  useActivityPopover.setState({ target: null });
}

export function openActivityPopover(
  userId: string,
  activity: Pick<Activity, 'type' | 'name'>,
  anchor: ActivityAnchor,
  side: 'right' | 'left' = 'right',
): void {
  const next: PopoverTarget = { userId, type: activity.type, name: activity.name, anchor, side };
  const key = keyOf(next);
  const current = useActivityPopover.getState().target;
  if (current && keyOf(current) === key) {
    closeActivityPopover();
    return;
  }
  if (lastClosed?.key === key && Date.now() - lastClosed.at < 300) return;
  useActivityPopover.setState({ target: next });
}

/** İçindeki tıklamalar profil kartlarının "dışarı tıklama" sayılmasın */
export const isInsideActivityPopover = (node: EventTarget | null): boolean =>
  node instanceof Element && node.closest('[data-activity-popover]') !== null;

/** Dış bağlantı: Electron'da sistem tarayıcısı; düz tarayıcıda (geliştirme) yeni sekme */
function openExternal(url: string): void {
  if (bridge) void bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/** App'te bir kez çizilir */
export function ActivityPopover() {
  const target = useActivityPopover((s) => s.target);
  const { value: shown, closing } = usePresence(target, 100);
  const activities = useKnownActivities(shown?.userId);
  const activity = shown ? (activities.find((a) => a.type === shown.type && a.name === shown.name) ?? null) : null;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; origin: string } | null>(null);

  // Tercih edilen tarafa sığmıyorsa öbür tarafa; dikeyde ekranın içinde kalır
  useLayoutEffect(() => {
    if (!target || !ref.current) return;
    const { offsetWidth: width, offsetHeight: height } = ref.current;
    const { anchor } = target;
    const right = anchor.right + GAP;
    const left = anchor.left - width - GAP;
    const fitsRight = right + width <= window.innerWidth - MARGIN;
    const fitsLeft = left >= MARGIN;
    const onRight = target.side === 'right' ? fitsRight || !fitsLeft : !fitsLeft && fitsRight;
    const x = Math.max(MARGIN, Math.min(onRight ? right : left, window.innerWidth - width - MARGIN));
    const y = Math.max(MARGIN, Math.min(anchor.top, window.innerHeight - height - MARGIN));
    setPos({ x, y, origin: `${onRight ? '0' : '100%'} ${Math.max(0, anchor.top - y)}px` });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeActivityPopover();
    };
    // Açan tıklamanın kendisi kartı hemen kapatmasın
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown));
    window.addEventListener('blur', closeActivityPopover);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', closeActivityPopover);
    };
  }, [target]);
  useEscapeLayer(closeActivityPopover, Boolean(target));

  // Oyun bu arada kapandıysa (ya da kişi görünmez olduysa) kart da kapanır
  useEffect(() => {
    if (target && !activity) closeActivityPopover();
  }, [target, activity]);

  // Açılınca ilk bağlantı odaklanır (klavyeyle gezilebilsin)
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  if (!shown || !activity) return null;
  const links = activityLinks(activity);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Oyun: ${activity.name}`}
      data-activity-popover=""
      className={cn(
        'fixed z-50 rounded-lg border border-edge bg-bg-float shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
        closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
      )}
      style={pos ? { left: pos.x, top: pos.y, width: WIDTH, transformOrigin: pos.origin } : { visibility: 'hidden', left: 0, top: 0, width: WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative px-3 pt-3 pb-2">
        <ActivityCard activity={activity} />
        <button
          type="button"
          className="press-icon absolute top-2 right-2 rounded p-0.5 text-text-muted hover:text-text-head"
          aria-label="Kapat"
          onClick={closeActivityPopover}
        >
          <X size={16} className="ico-rotate" />
        </button>
      </div>
      <div className="max-h-[min(360px,calc(100vh-200px))] overflow-y-auto border-t border-line/70 px-1.5 pt-1 pb-1.5">
        {GROUPS.map((group) => {
          const items = links.filter((l) => l.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <div className="px-2 pt-1.5 pb-1 text-[11px] font-bold text-text-muted uppercase">{ACTIVITY_LINK_GROUP_LABELS[group]}</div>
              {items.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  className="flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-sm text-text-normal outline-none transition-colors duration-75 hover:bg-bg-hover hover:text-text-head focus-visible:bg-bg-hover focus-visible:text-text-head"
                  title={link.url}
                  onClick={(e) => {
                    e.preventDefault();
                    openExternal(link.url);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{link.label}</span>
                  {!link.direct && <span className="shrink-0 text-xs text-text-muted">arama</span>}
                  <ExternalLink size={14} className="shrink-0 opacity-70" aria-hidden />
                </a>
              ))}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
