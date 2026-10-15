import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import {
  AudioWaveform,
  LayoutGrid,
  MicOff,
  MonitorCog,
  Music2,
  PhoneOff,
  Radio,
  ScreenShare,
  ScreenShareOff,
  Signal,
  Video,
} from 'lucide-react';
import type { LinkQuality } from '@diskort/client-core';
import { voice } from '../../features/voice/voiceClient';
import { cn } from '../../lib/utils';
import { Permission } from '@diskort/shared';
import { channelById, dmTitle, useCan, useGuild, useSession } from '@diskort/client-core';
import { getSettings, useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useConnectionStats } from '../../stores/connectionStats';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { SwapIcon } from '../ui/SwapIcon';
import { NoiseMenu, noiseSummary } from './AudioMenus';

const STATUS_TEXT = {
  connecting: 'Bağlanıyor…',
  reconnecting: 'Yeniden bağlanıyor…',
  connected: 'Ses Bağlantısı Kuruldu',
  idle: '',
} as const;

/** Son ölçümlerin ping ve paket kaybına göre (Discord'daki gibi yeşil/sarı/kırmızı) */
const QUALITY_COLOR: Record<LinkQuality, string> = {
  good: 'text-ok',
  fair: 'text-warn',
  poor: 'text-danger',
  unknown: 'text-ok',
};

/** Soldaki sinyal simgesinin yuvarlak kare zemini */
const QUALITY_TILE: Record<LinkQuality, string> = {
  good: 'bg-ok/15',
  fair: 'bg-warn/15',
  poor: 'bg-danger/15',
  unknown: 'bg-ok/15',
};

const QUALITY_TEXT: Record<LinkQuality, string> = {
  good: 'Bağlantı iyi',
  fair: 'Bağlantı dalgalı',
  poor: 'Bağlantı zayıf',
  unknown: 'Bağlantı bilgisi',
};

/** Giriş sesleri düğmeyle kapatılınca seviyesi; yeniden açınca bu seviyeye döner (uygulama ömrü boyunca) */
let introVolumeBeforeOff = 1;

/** Giriş seslerini kapatır (seviye 0) ya da önceki seviyesine geri açar */
function toggleIntroSounds(): void {
  const { introSoundVolume, set } = getSettings();
  if (introSoundVolume > 0) {
    introVolumeBeforeOff = introSoundVolume;
    set({ introSoundVolume: 0 });
  } else {
    set({ introSoundVolume: introVolumeBeforeOff > 0 ? introVolumeBeforeOff : 1 });
  }
}

/**
 * Discord'daki gibi ses bağlantısı kartı (yalnızca ses kanalındayken): bağlantı kalitesi, kanal / sunucu,
 * gürültü engelleme ve bağlantıyı kesme; altında kamera, ekran paylaşımı, sahne, giriş sesleri ve yayın ayarları.
 * Sağ tık (üst kısımda ya da giriş sesleri düğmesinde): giriş sesleri seviyesi.
 * Alttaki kullanıcı paneliyle birlikte tek yuvarlak kart gibi görünür (üst yarısı).
 */
export function VoiceConnectionPanel() {
  const status = useVoice((s) => s.status);
  const channelId = useVoice((s) => s.channelId);
  const ping = useVoice((s) => s.pingMs);
  const quality = useConnectionStats((s) => s.quality);
  // STUN yanıtı gelmiyorsa son ping eski bir değerdir: sağlıklıymış gibi gösterilmez
  const pingStale = useConnectionStats((s) => s.pingStale);
  const sharing = useVoice((s) => s.sharing);
  const micTesting = useVoice((s) => s.micTesting);
  const selfId = useSession((s) => s.user?.id);
  const channel = useGuild((s) => channelById(s, channelId));
  const canStream = useCan(Permission.STREAM, channelId ?? undefined);
  // Ses kanalının sunucusu (seçili sunucu başka olabilir)
  const guildName = useGuild((s) => (channel ? s.guilds[channel.guildId]?.guild.name : undefined));
  // DM araması: kanal / sunucu yerine konuşmanın adı (bire bir konuşmada karşı taraf)
  // Konuşma bu arada listeden kapatıldıysa (sunucu kanalı da değilse) yedek ad
  const dmName = useGuild((s) => {
    const dm = channelId ? s.dms[channelId] : undefined;
    if (dm) return dmTitle(dm, s.users, selfId);
    return channelId && !s.channelGuild[channelId] ? 'Sesli arama' : null;
  });
  const placeLabel = dmName ?? (channel ? `${channel.name} / ${guildName ?? ''}` : '');
  const noise = useSettings((s) => s.noise);
  const noiseStrength = useSettings((s) => s.noiseStrengthDb);
  const noiseFallback = useVoice((s) => s.noiseFallback);
  const openModal = useUi((s) => s.openModal);
  const setView = useUi((s) => s.setView);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const introOff = useSettings((s) => s.introSoundVolume <= 0);
  const [infoOpen, setInfoOpen] = useState(false);
  const [noiseOpen, setNoiseOpen] = useState(false);
  const labelRef = useRef<HTMLButtonElement>(null);
  const noiseRef = useRef<HTMLButtonElement>(null);
  const closeInfo = useCallback(() => setInfoOpen(false), []);
  const closeNoise = useCallback(() => setNoiseOpen(false), []);
  useEffect(() => {
    if (status === 'idle') {
      setInfoOpen(false);
      setNoiseOpen(false);
    }
  }, [status]);

  if (status === 'idle') return null;
  const connected = status === 'connected';
  const shownQuality: LinkQuality = connected ? quality : 'unknown';
  const color = connected ? QUALITY_COLOR[quality] : 'text-warn';
  const tile = connected ? QUALITY_TILE[quality] : 'bg-warn/15';
  const noiseLabel = `Gürültü engelleme: ${noiseSummary(noise, noiseStrength, noiseFallback)}`;
  const shareBlocked = !sharing && !canStream;
  const openIntroMenu = (e: MouseEvent): void => {
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      introVolume: true,
      items: [{ label: 'Ses Ayarları', onClick: () => openModal({ type: 'settings', section: 'notifications' }) }],
    });
  };

  return (
    <div className="anim-rise-in px-2 pt-2 pb-1.5">
      {sharing && selfId && <OwnStreamRow userId={selfId} />}
      <div className="flex items-center gap-2" onContextMenu={openIntroMenu}>
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-300',
            tile,
            color,
          )}
          aria-hidden
        >
          <Signal size={18} strokeWidth={2.5} className={cn(!connected && 'animate-pulse')} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <button
            ref={labelRef}
            type="button"
            className={cn(
              'block max-w-full truncate text-left text-sm font-semibold transition-colors duration-300 hover:underline',
              color,
            )}
            data-tooltip={infoOpen ? undefined : `${QUALITY_TEXT[shownQuality]}${ping !== null ? ` · ${pingStale ? '—' : `${ping} ms`}` : ''}`}
            aria-expanded={infoOpen}
            aria-haspopup="dialog"
            onClick={() => setInfoOpen((v) => !v)}
          >
            {STATUS_TEXT[status]}
          </button>
          <button
            type="button"
            className="block max-w-full truncate text-left text-xs text-text-muted hover:text-text-normal hover:underline"
            data-tooltip={dmName !== null ? 'Aramaya git' : 'Ses kanalına git'}
            onClick={() => setView({ kind: 'voice' })}
          >
            {placeLabel}
          </button>
        </div>
        <IconButton
          ref={noiseRef}
          label={noiseLabel}
          active={noiseOpen}
          hideTooltip={noiseOpen}
          aria-haspopup="menu"
          aria-expanded={noiseOpen}
          onClick={() => setNoiseOpen((v) => !v)}
        >
          <AudioWaveform size={20} className={cn('ico-wave', noise === 'off' && 'opacity-50')} />
        </IconButton>
        <IconButton label="Bağlantıyı Kes" danger onClick={() => void voice.leave()}>
          <PhoneOff size={20} className="ico-hangup" />
        </IconButton>
      </div>
      {micTesting && (
        <div role="status" className="mt-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-warn">
          <MicOff size={14} className="shrink-0" />
          <span className="truncate">Mikrofon testi: odada susturuldun</span>
        </div>
      )}
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        <ActionButton label="Kamera · Yakında" disabled>
          <Video size={20} />
        </ActionButton>
        <ActionButton
          label={sharing ? 'Yayını Durdur' : shareBlocked ? 'Bu kanalda ekran paylaşma iznin yok' : 'Ekranını Paylaş'}
          disabled={!connected || shareBlocked}
          active={sharing}
          onClick={() => (sharing ? void voice.stopScreenShare() : openModal({ type: 'screenPicker' }))}
        >
          <SwapIcon swapKey={sharing ? 'on' : 'off'} motion="ico-lift">
            {sharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
          </SwapIcon>
        </ActionButton>
        <ActionButton label={dmName !== null ? 'Aramayı Aç' : 'Ses Sahnesini Aç'} onClick={() => setView({ kind: 'voice' })}>
          <LayoutGrid size={20} className="ico-grow" />
        </ActionButton>
        <ActionButton
          label={introOff ? 'Giriş sesleri kapalı' : 'Giriş sesleri'}
          onClick={toggleIntroSounds}
          onContextMenu={openIntroMenu}
        >
          <SwapIcon swapKey={introOff ? 'off' : 'on'} motion="ico-lift">
            <IntroSoundIcon off={introOff} />
          </SwapIcon>
        </ActionButton>
        <ActionButton label="Yayın Ayarları" onClick={() => openModal({ type: 'settings', section: 'stream' })}>
          <MonitorCog size={20} className="ico-tilt" />
        </ActionButton>
      </div>
      <ConnectionInfoPopover open={infoOpen} anchorRef={labelRef} onClose={closeInfo} />
      <NoiseMenu open={noiseOpen} anchorRef={noiseRef} onClose={closeNoise} />
    </div>
  );
}

/**
 * Yayındayken ses bağlantısının üstündeki satır: paylaşılan kaynağın simgesi, adı ve kalitesi, sağda "Yayını
 * durdur". Satıra tıklamak kendi yayınını ses sahnesinde öne alır.
 */
function OwnStreamRow({ userId }: { userId: string }) {
  const sourceName = useGuild((s) => s.voiceStates[userId]?.streamSourceName);
  const sourceKind = useGuild((s) => s.voiceStates[userId]?.streamSourceKind);
  const quality = useVoice((s) => s.shareQuality);
  const icon = useVoice((s) => s.shareIcon);
  const setView = useUi((s) => s.setView);
  const title = sourceName ?? (sourceKind === 'window' ? 'Pencere' : 'Ekran');

  return (
    <div className="anim-rise-in mb-2 flex items-center gap-2 border-b border-float-edge pb-2">
      <button
        type="button"
        data-tooltip="Yayınına git"
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
        onClick={() => {
          voice.focusStream(userId);
          setView({ kind: 'voice' });
        }}
      >
        {/* Pencerenin uygulama simgesi; yoksa (ekran ya da simgesiz pencere) addan renkli baş harf */}
        <span
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-bold text-white"
          style={icon ? undefined : { background: sourceColor(title) }}
          aria-hidden
        >
          {icon ? (
            <img src={icon} alt="" draggable={false} className="h-7 w-7 object-contain" />
          ) : (
            title.trim().charAt(0).toLocaleUpperCase('tr-TR')
          )}
          <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-bg-card text-text-head">
            <Video size={10} strokeWidth={2.5} />
          </span>
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-semibold text-text-head group-hover:underline">{title}</span>
          {quality && (
            <span className="flex items-center gap-1 truncate text-xs font-medium text-brand">
              <Radio size={12} strokeWidth={2.5} className="shrink-0" aria-hidden />
              {quality}
            </span>
          )}
        </span>
      </button>
      <IconButton label="Yayını durdur" danger onClick={() => void voice.stopScreenShare()}>
        <ScreenShareOff size={20} />
      </IconButton>
    </div>
  );
}

/** Kaynağın adından sabit bir renk (aynı ad hep aynı renk; beyaz harf okunaklı kalsın diye koyu doygun tonlar) */
function sourceColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

function IconButton({
  ref,
  label,
  danger,
  active,
  hideTooltip,
  onClick,
  children,
  ...aria
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  danger?: boolean;
  active?: boolean;
  hideTooltip?: boolean;
  onClick: () => void;
  children: ReactNode;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      data-tooltip={hideTooltip ? undefined : label}
      aria-label={label}
      className={cn(
        'press-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
        danger
          ? 'text-text-normal hover:bg-danger hover:text-white'
          : active
            ? 'bg-bg-active text-text-head'
            : 'text-text-normal hover:bg-bg-active hover:text-text-head',
      )}
      onClick={onClick}
      {...aria}
    >
      {children}
    </button>
  );
}

/**
 * Alt sıradaki eşit genişlikte yuvarlak düğme. Devre dışıyken de ipucu gösterilsin diye `disabled` yerine
 * `aria-disabled` kullanılır (devre dışı öğeler fare olayı almaz).
 */
function ActionButton({
  label,
  disabled,
  active,
  onClick,
  onContextMenu,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-tooltip={label}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex h-8 items-center justify-center rounded-md transition-colors',
        disabled
          ? 'cursor-not-allowed bg-bg-active text-text-muted opacity-50'
          : active
            ? 'press bg-ok/20 text-ok hover:bg-ok/30'
            : 'press bg-bg-active text-text-normal hover:bg-control hover:text-text-head',
      )}
      onClick={disabled ? undefined : onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}

/**
 * Giriş sesleri simgesi; kapalıyken üstü çizili (lucide'de Music2'nin kapalı hâli yok, çizgi lucide'in "Off"
 * simgeleriyle aynı yoldan çizilir).
 */
function IntroSoundIcon({ off }: { off: boolean }) {
  return (
    <span className="relative flex h-5 w-5">
      <Music2 size={20} className={cn(off && 'opacity-60')} />
      {off && (
        <svg
          className="absolute inset-0"
          width={20}
          height={20}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden
        >
          <path d="m2 2 20 20" />
        </svg>
      )}
    </span>
  );
}
