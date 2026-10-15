import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, Headphones, HeadphoneOff, Mic, MicOff, Settings, Volume2 } from 'lucide-react';
import { voice } from '../../features/voice/voiceClient';
import { cn } from '../../lib/utils';
import { STATUS_LABELS } from '@diskort/shared';
import { useCustomStatus, useFeedback, useGuild, useSession, useStatus } from '@diskort/client-core';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { CustomStatusLine } from '../status/CustomStatusLine';
import { toggleSelfProfile } from '../status/SelfProfilePopout';
import { Avatar } from '../ui/Avatar';
import { SwapIcon } from '../ui/SwapIcon';
import { MicMenu, OutputMenu } from './AudioMenus';

/**
 * Sol alttaki kullanıcı paneli (Discord'daki gibi): avatar ve durum, ad ve altında durum / "Sesli aramada";
 * sağda mikrofon ve kulaklık (yanlarındaki oklar aygıt ve ses seviyesi menülerini açar) ve ayarlar.
 * Ses kanalındayken üstündeki bağlantı kartıyla birlikte tek kart gibi görünür (alt yarısı).
 */
export function UserPanel() {
  const user = useSession((s) => s.user);
  const selfMute = useSettings((s) => s.selfMute);
  const selfDeaf = useSettings((s) => s.selfDeaf);
  const inputMode = useSettings((s) => s.inputMode);
  const speaking = useVoice((s) => (user ? s.speaking[user.id] === true : false));
  const intro = useVoice((s) => (user ? s.introPlayingUserId === user.id : false));
  const pttActive = useVoice((s) => s.pttActive);
  const voiceStatus = useVoice((s) => s.status);
  // Konuşma izni yoksa (yetki ya da sunucuda susturma) mikrofon kapalı görünür
  const micAllowed = useVoice((s) => s.micAllowed || s.status === 'idle');
  const serverMute = useGuild((s) => (user ? s.voiceStates[user.id]?.serverMute === true : false));
  const serverDeaf = useGuild((s) => (user ? s.voiceStates[user.id]?.serverDeaf === true : false));
  const openModal = useUi((s) => s.openModal);
  const status = useStatus(user?.id);
  const custom = useCustomStatus(user?.id);
  // Hesap yöneticisine yeni geri bildirim sayısı (Ayarlar > Geri bildirimler (yönetim))
  const newFeedback = useFeedback((s) => (user?.isAdmin ? s.newCount : 0));
  const [menu, setMenu] = useState<'mic' | 'output' | null>(null);
  const micChevron = useRef<HTMLButtonElement>(null);
  const outputChevron = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const inVoice = voiceStatus !== 'idle';
  const muted = selfMute || selfDeaf || !micAllowed;
  const deaf = selfDeaf || serverDeaf;

  let subtitle: ReactNode;
  if (inVoice && (serverMute || serverDeaf)) {
    subtitle = (
      <span className="flex items-center gap-1 text-danger-text">
        <MicOff size={12} strokeWidth={2.5} className="shrink-0" />
        <span className="truncate">{serverDeaf ? 'Sunucuda sağırlaştırıldın' : 'Sunucuda susturuldun'}</span>
      </span>
    );
  } else if (inVoice) {
    const text =
      voiceStatus !== 'connected'
        ? 'Bağlanıyor…'
        : inputMode === 'ptt'
          ? pttActive
            ? 'Konuşuyor (bas-konuş)'
            : 'Sesli aramada · Bas-konuş'
          : 'Sesli aramada';
    subtitle = (
      <span className="flex items-center gap-1">
        <Volume2 size={12} strokeWidth={2.5} className="shrink-0 text-ok" />
        <span className="truncate">{text}</span>
      </span>
    );
  } else {
    subtitle = custom ? <CustomStatusLine status={custom} /> : STATUS_LABELS[status];
  }

  return (
    <div
      className={cn(
        'flex h-[52px] shrink-0 items-center gap-1 px-1.5',
      )}
    >
      {/* Tıklayınca kendi profil kartın: durum ve özel durum buradan değişir */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 pl-0.5 text-left transition-colors hover:bg-bg-active"
        aria-label="Profilin ve durumun"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          toggleSelfProfile({ left: rect.left, top: rect.top });
        }}
      >
        <Avatar
          user={user ?? undefined}
          size={32}
          speaking={speaking}
          intro={intro}
          status={status}
          ringClassName="bg-bg-card"
          decoration={user?.avatarDecoration}
        />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-text-head">{user?.displayName}</div>
          <div className="truncate text-xs text-text-muted">{subtitle}</div>
        </div>
      </button>
      <SplitButton
        active={muted}
        title={!micAllowed ? voice.micBlockedReason() : muted ? 'Sesi Aç' : 'Sustur'}
        onClick={() => voice.toggleMute()}
        icon={muted ? <MicOff size={20} /> : <Mic size={20} />}
        motion="ico-nod"
        menuLabel="Mikrofon seçenekleri"
        menuOpen={menu === 'mic'}
        chevronRef={micChevron}
        onMenu={() => setMenu((m) => (m === 'mic' ? null : 'mic'))}
      />
      <SplitButton
        active={deaf}
        title={serverDeaf ? 'Sunucuda sağırlaştırıldın' : selfDeaf ? 'Sağırlaştırmayı Kaldır' : 'Sağırlaştır'}
        onClick={() => voice.toggleDeafen()}
        icon={deaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        motion="ico-wiggle"
        menuLabel="Ses çıkışı seçenekleri"
        menuOpen={menu === 'output'}
        chevronRef={outputChevron}
        onMenu={() => setMenu((m) => (m === 'output' ? null : 'output'))}
      />
      <PanelButton
        title={newFeedback > 0 ? `Kullanıcı Ayarları · ${newFeedback} yeni geri bildirim` : 'Kullanıcı Ayarları'}
        onClick={() =>
          openModal({
            type: 'settings',
            section: newFeedback > 0 ? 'feedbackAdmin' : undefined,
          })
        }
        icon={<Settings size={20} />}
        motion="ico-rotate"
        badge={newFeedback}
      />
      <MicMenu open={menu === 'mic'} anchorRef={micChevron} onClose={closeMenu} />
      <OutputMenu open={menu === 'output'} anchorRef={outputChevron} onClose={closeMenu} />
    </div>
  );
}

/**
 * Simge (sustur / sağırlaştır) + yanında menüyü açan küçük ok; kapalıyken ikisi birlikte kırmızı.
 * `motion`: üstüne gelince simgenin hareketi (styles/hover.css).
 */
function SplitButton({
  icon,
  motion,
  title,
  onClick,
  active,
  menuLabel,
  menuOpen,
  onMenu,
  chevronRef,
}: {
  icon: ReactNode;
  motion: string;
  title: string;
  onClick: () => void;
  active: boolean;
  menuLabel: string;
  menuOpen: boolean;
  onMenu: () => void;
  chevronRef: Ref<HTMLButtonElement>;
}) {
  const part = cn(
    'press-icon flex h-8 items-center justify-center transition-colors',
    active ? 'text-danger hover:bg-danger/25' : 'text-text-normal hover:bg-bg-active hover:text-text-head',
  );
  return (
    <div className={cn('flex shrink-0 items-center rounded-md transition-colors', active && 'bg-danger/15')}>
      <button
        type="button"
        data-tooltip={title}
        aria-label={title}
        aria-pressed={active}
        onClick={onClick}
        className={cn(part, 'w-8 rounded-l-md')}
      >
        <SwapIcon swapKey={title} motion={motion}>
          {icon}
        </SwapIcon>
      </button>
      <button
        ref={chevronRef}
        type="button"
        data-tooltip={menuOpen ? undefined : menuLabel}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
        className={cn(part, 'w-4 rounded-r-md', menuOpen && !active && 'bg-bg-active text-text-head')}
      >
        <ChevronDown
          size={14}
          strokeWidth={2.5}
          className={cn('ico-nudge-d', menuOpen && 'rotate-180')}
        />
      </button>
    </div>
  );
}

function PanelButton({
  icon,
  motion,
  title,
  onClick,
  active,
  badge = 0,
}: {
  icon: ReactNode;
  /** Üstüne gelince simgenin hareketi (styles/hover.css) */
  motion?: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  /** Sağ üst köşede kırmızı sayı (ör. yeni geri bildirimler) */
  badge?: number;
}) {
  return (
    <button
      data-tooltip={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'press-icon relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-bg-active',
        active ? 'text-danger' : 'text-text-normal hover:text-text-head',
      )}
    >
      {/* Simge değişince (ör. yeni geri bildirim sayısı) kısa bir dönüşle yenisine geçer */}
      <SwapIcon swapKey={title} motion={motion}>
        {icon}
      </SwapIcon>
      {badge > 0 && (
        <span
          key={badge}
          className="anim-pill-in pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-bold text-white ring-2 ring-bg-card"
          aria-hidden
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
