import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Pencil, Plus, Smile, X } from 'lucide-react';
import { create } from 'zustand';
import {
  STATUS_DESCRIPTIONS,
  STATUS_DURATIONS,
  STATUS_LABELS,
  userEffectId,
  type UserStatus,
} from '@diskort/shared';
import {
  formatRemaining,
  setCustomStatus,
  setUserStatus,
  useCustomStatus,
  useSelfStatus,
  useSession,
  useStatus,
} from '@diskort/client-core';
import { useEscapeLayer } from '../../lib/escape';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import {
  ProfileCardTop,
  ProfileEffectLayer,
  themedCardStyle,
} from '../profile/ProfileLook';
import { StatusIcon } from '../ui/StatusIcon';
import { ActivityCards } from './ActivityCard';
import { isInsideActivityPopover } from './ActivityPopover';

const MARGIN = 8;

interface Anchor {
  left: number;
  top: number;
}

const useSelfPopout = create<{ anchor: Anchor | null }>(() => ({ anchor: null }));

/** Sol alttaki kullanıcı panelinden açılan kendi profil kartın (durum ve özel durum buradan değişir) */
export function toggleSelfProfile(anchor: Anchor): void {
  useSelfPopout.setState((s) => ({ anchor: s.anchor ? null : anchor }));
}

export function closeSelfProfile(): void {
  useSelfPopout.setState({ anchor: null });
}

const STATUS_ORDER: UserStatus[] = ['online', 'idle', 'dnd', 'invisible'];

/**
 * Discord'daki gibi kendi profil kartın: renkli şerit, durum noktalı büyük avatar, yanında özel durum
 * balonu, ad, "Profili Düzenle", durum seçimi (sağa açılan alt menü, süreli seçenekler) ve özel durum.
 */
export function SelfProfilePopout() {
  const anchor = useSelfPopout((s) => s.anchor);
  const { value: shown, closing } = usePresence(anchor, 100);
  const user = useSession((s) => s.user);
  const self = useSelfStatus();
  const status = useStatus(user?.id);
  const custom = useCustomStatus(user?.id);
  const openModal = useUi((s) => s.openModal);
  const ref = useRef<HTMLDivElement>(null);
  const [statusMenu, setStatusMenu] = useState(false);

  useEffect(() => {
    if (!anchor) return;
    setStatusMenu(false);
    const onDown = (e: MouseEvent): void => {
      // Oyun sayfası (ActivityPopover) kartın dışındadır; oradaki tıklama kartı kapatmaz
      if (!ref.current?.contains(e.target as Node) && !isInsideActivityPopover(e.target)) closeSelfProfile();
    };
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown));
    window.addEventListener('blur', closeSelfProfile);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', closeSelfProfile);
    };
  }, [anchor]);
  useEscapeLayer(closeSelfProfile, Boolean(anchor));

  if (!shown || !user) return null;

  const editCustom = (): void => {
    closeSelfProfile();
    openModal({ type: 'customStatus' });
  };
  const choose = (next: UserStatus, durationMs: number | null = null): void => {
    closeSelfProfile();
    void setUserStatus(next, durationMs);
  };
  const current = self?.status ?? 'online';
  const remaining = formatRemaining(self?.expiresAt ?? null);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Profilin"
      className={cn(
        'fixed z-50 w-[300px] rounded-lg border border-edge bg-bg-float shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
        closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
      )}
      style={{
        left: Math.max(MARGIN, shown.left),
        bottom: Math.max(MARGIN, window.innerHeight - shown.top + MARGIN),
        transformOrigin: 'bottom left',
        ...themedCardStyle(user.profileTheme),
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ProfileCardTop
        user={user}
        status={status}
        bannerClassName="rounded-t-lg"
        aside={
          <SpeechBubble onClick={editCustom}>
            {custom ? (
              <>
                {custom.emoji && <span className="mr-1">{custom.emoji}</span>}
                {custom.text}
              </>
            ) : (
              <span className="flex items-center gap-1 text-text-muted">
                <Plus size={14} className="shrink-0" />
                Şu an canının çektiği bir şey var mı?
              </span>
            )}
          </SpeechBubble>
        }
      />
      <div className="px-4 pb-3">
        {/* Oynadığın oyunlar sunucunun sana da yolladığı durumdan okunur: görünmezken yok */}
        <ActivityCards userId={user.id} className="mt-3" />
        <div className="mt-3 rounded-lg bg-bg-side p-1.5">
          <Row
            icon={<Pencil size={16} className="ico-scribble" />}
            label="Profili Düzenle"
            onClick={() => {
              closeSelfProfile();
              openModal({ type: 'settings', section: 'profile' });
            }}
          />
          <div className="mx-1.5 my-1 h-px bg-line/60" />
          <div
            className="relative"
            onMouseEnter={() => setStatusMenu(true)}
            onMouseLeave={() => setStatusMenu(false)}
          >
            <Row
              icon={<StatusIcon status={current} size={12} />}
              label={STATUS_LABELS[current]}
              sub={remaining ? `${remaining} biter` : undefined}
              chevron
              active={statusMenu}
              onClick={() => setStatusMenu((v) => !v)}
            />
            {statusMenu && (
              <Submenu>
                <Menu>
                  {STATUS_ORDER.map((option) => (
                    <StatusOption key={option} status={option} selected={option === current} onChoose={choose} />
                  ))}
                </Menu>
              </Submenu>
            )}
          </div>
          <Row
            icon={custom ? <span className="text-base leading-none">{custom.emoji ?? '💬'}</span> : <Smile size={16} className="ico-bounce" />}
            label={custom ? 'Özel durumu düzenle' : 'Özel durum ayarla'}
            sub={
              custom && self?.customStatusExpiresAt
                ? `${formatRemaining(self.customStatusExpiresAt)} temizlenir`
                : undefined
            }
            onClick={editCustom}
            trailing={
              custom ? (
                <button
                  type="button"
                  className="press-icon rounded p-0.5 text-text-muted hover:text-text-head"
                  aria-label="Özel durumu temizle"
                  data-tooltip="Özel durumu temizle"
                  onClick={(e) => {
                    e.stopPropagation();
                    void setCustomStatus(null);
                  }}
                >
                  <X size={14} className="ico-rotate" />
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
      <ProfileEffectLayer effect={userEffectId(user)} className="rounded-lg" />
    </div>
  );
}

/** Avatarın yanındaki konuşma balonu (Discord'daki gibi sol altında iki küçük daire) */
function SpeechBubble({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="group relative mt-12 min-w-0 flex-1 text-left"
      onClick={onClick}
      aria-label="Özel durum"
    >
      <span className="absolute top-1 -left-1 h-3 w-3 rounded-full bg-bg-side transition-colors group-hover:bg-bg-hover" />
      <span className="absolute top-3.5 -left-2.5 h-1.5 w-1.5 rounded-full bg-bg-side transition-colors group-hover:bg-bg-hover" />
      <span className="relative line-clamp-3 rounded-2xl bg-bg-side px-3 py-2 text-sm break-words text-text-normal transition-colors group-hover:bg-bg-hover">
        {children}
      </span>
    </button>
  );
}

function Row({
  icon,
  label,
  sub,
  chevron,
  active,
  trailing,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  chevron?: boolean;
  active?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex min-h-9 cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm text-text-normal hover:bg-bg-hover hover:text-text-head',
        active && 'bg-bg-hover text-text-head',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick();
      }}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium">{label}</span>
        {sub && <span className="block truncate text-xs text-text-muted">{sub}</span>}
      </span>
      {trailing}
      {chevron && <ChevronRight size={16} className="ico-nudge-r shrink-0 text-text-muted" />}
    </div>
  );
}

/**
 * Satırın sağına açılan alt menü; aradaki boşluk da menünün parçası (fare geçerken kapanmasın). Ekranın
 * altına sığmıyorsa yukarı kayar.
 */
function Submenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const overflow = rect.bottom - (window.innerHeight - MARGIN);
    if (overflow > 0) setShift(-Math.min(overflow, rect.top - MARGIN));
  }, []);
  return (
    <div ref={ref} className="absolute top-[-6px] left-full z-10 pl-2" style={{ transform: `translateY(${shift}px)` }}>
      {children}
    </div>
  );
}

function Menu({ children }: { children: ReactNode }) {
  return (
    <div
      role="menu"
      className="anim-pop-in w-[260px] rounded-lg border border-edge bg-bg-float p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
    >
      {children}
    </div>
  );
}

/** Durum seçeneği; Boşta / Rahatsız Etmeyin / Görünmez'in süre alt menüsü sağa açılır */
function StatusOption({
  status,
  selected,
  onChoose,
}: {
  status: UserStatus;
  selected: boolean;
  onChoose: (status: UserStatus, durationMs?: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const timed = status !== 'online';
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        role="menuitem"
        className={cn(
          'flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left text-sm text-text-normal hover:bg-brand hover:text-white',
          open && timed && 'bg-brand text-white',
        )}
        onClick={() => onChoose(status, null)}
      >
        <span className="mt-[3px] flex w-4 shrink-0 justify-center">
          <StatusIcon status={status} size={12} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className={cn('block font-medium', selected && 'font-semibold')}>{STATUS_LABELS[status]}</span>
          {STATUS_DESCRIPTIONS[status] && (
            <span className="block text-xs opacity-80">{STATUS_DESCRIPTIONS[status]}</span>
          )}
        </span>
        {timed && <ChevronRight size={16} className="ico-nudge-r mt-[1px] shrink-0 opacity-80" />}
      </button>
      {timed && open && (
        <Submenu>
          <div
            role="menu"
            className="anim-pop-in w-[160px] rounded-lg border border-edge bg-bg-float p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
          >
            {STATUS_DURATIONS.map((d) => (
              <button
                key={d.label}
                type="button"
                role="menuitem"
                className="block w-full rounded px-2 py-1.5 text-left text-sm text-text-normal hover:bg-brand hover:text-white"
                onClick={() => onChoose(status, d.ms)}
              >
                {d.ms === null ? d.label : `${d.label} boyunca`}
              </button>
            ))}
          </div>
        </Submenu>
      )}
    </div>
  );
}
