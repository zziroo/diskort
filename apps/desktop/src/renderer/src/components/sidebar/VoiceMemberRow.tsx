import { HeadphoneOff, MicOff } from 'lucide-react';
import { Permission, type VoiceState } from '@diskort/shared';
import { voice } from '../../features/voice/voiceClient';
import { memberMenuItems } from '../../lib/memberMenu';
import { cn } from '../../lib/utils';
import {
  activeGuildContext,
  can,
  contextOfChannel,
  useActivity,
  useGuild,
  useChannelMemberColor,
  useSession,
  voiceDropTargets,
  type ProfileContext,
} from '@diskort/client-core';
import { startSidebarDrag, useSidebarDrag } from '../../lib/sidebarDrag';
import { watchUserStream } from '../../lib/watchStream';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { Avatar } from '../ui/Avatar';
import { openProfile, type ProfileAnchor } from '../members/ProfilePopover';
import { ActivityIcon } from '../status/ActivityCard';
import { activityCardHandlers } from './ActivityHoverCard';
import { streamCardHandlers } from './StreamPreviewCard';

export function LiveBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn('anim-pill-in rounded-full bg-danger px-1.5 py-px text-[10px] leading-4 font-bold text-white', className)}
    >
      YAYINDA
    </span>
  );
}

/** Tıklanabilir "YAYINDA" rozeti: yayını doğrudan izlemeye başlar (gerekirse kanala katılır) */
export function WatchLiveBadge({
  userId,
  channelId,
  tooltip = true,
}: {
  userId: string;
  channelId: string;
  /** Kanal listesinde ipucu yerine "Şimdi Yayın Yapıyor" kartı açılır */
  tooltip?: boolean;
}) {
  return (
    <button
      type="button"
      data-tooltip={tooltip ? 'Yayını izle' : undefined}
      aria-label="Yayını izle"
      className="press shrink-0 rounded-full transition-[filter] hover:brightness-110"
      onClick={(e) => {
        e.stopPropagation();
        void watchUserStream(userId, channelId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <LiveBadge className="block" />
    </button>
  );
}

/** Ses kanalındaki üyenin bağlamı: ses kanalının sunucusu (DM açıkken de) */
export function voiceMemberContext(userId: string): ProfileContext {
  const s = useGuild.getState();
  const channelId = s.voiceStates[userId]?.channelId;
  return channelId ? contextOfChannel(s, channelId) : activeGuildContext(s);
}

/** Ses kanalındaki üyenin profil kartını açar */
export function openVoiceProfile(userId: string, anchor: ProfileAnchor, side: 'right' | 'left' = 'right'): void {
  openProfile({ userId, context: voiceMemberContext(userId), anchor, side });
}

/** Üyenin bulunduğu kanalda konuşma yetkisi yok (yalnızca dinliyor) */
export function useSuppressed(state: VoiceState): boolean {
  return useGuild((s) => !can(s, state.userId, Permission.SPEAK, state.channelId));
}

/**
 * Ses durumu simgeleri: kendi susturması gri; yerel susturma, sunucuda susturma/sağırlaştırma ve kanalda
 * konuşma yetkisi olmaması kırmızı (Discord gibi).
 */
export function VoiceStateIcons({ state, localMuted, size = 15 }: { state: VoiceState; localMuted?: boolean; size?: number }) {
  const suppressed = useSuppressed(state);
  const deaf = state.selfDeaf || state.serverDeaf;
  const mutedByOthers = state.serverMute || localMuted || suppressed;
  return (
    <>
      {(state.selfMute || mutedByOthers) && !deaf && (
        <MicOff
          size={size}
          aria-label={
            state.serverMute ? 'Sunucuda susturuldu' : suppressed ? 'Bu kanalda konuşma izni yok' : 'Susturuldu'
          }
          className={cn('anim-pill-in', mutedByOthers ? 'text-danger' : 'text-text-muted')}
        />
      )}
      {deaf && (
        <HeadphoneOff
          size={size}
          aria-label={state.serverDeaf ? 'Sunucuda sağırlaştırıldı' : 'Sağırlaştırıldı'}
          className={cn('anim-pill-in', state.serverDeaf && 'text-danger')}
        />
      )}
    </>
  );
}

export function VoiceMemberRow({ state, inMyChannel }: { state: VoiceState; inMyChannel: boolean }) {
  const user = useGuild((s) => s.users[state.userId]);
  const color = useChannelMemberColor(state.userId, state.channelId);
  const speaking = useVoice((s) => inMyChannel && s.speaking[state.userId] === true);
  const intro = useVoice((s) => inMyChannel && s.introPlayingUserId === state.userId);
  const localMuted = useSettings((s) => s.localMutes[state.userId] === true);
  const selfId = useSession((s) => s.user?.id);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const isSelf = state.userId === selfId;
  // Asıl (en son başlanan) oyun: satırın sağında ikonu durur, üstünde bekleyince kartı açılır
  const activity = useActivity(state.userId);
  const playing = activity !== null;
  // Sürüklenebilir: kendin (kanal değiştirme) ya da taşıma yetkin olan, senden aşağıdaki üye
  const draggable = useGuild(
    (s) => isSelf || can(s, selfId, Permission.MOVE_MEMBERS, state.channelId),
  );
  const dragging = useSidebarDrag((s) => s.item?.kind === 'member' && s.item.userId === state.userId && !s.ending);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${user?.displayName ?? 'Üye'} profili`}
      className={cn(
        'group flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-text-muted transition-[color,background-color,opacity] duration-150 select-none hover:bg-bg-hover hover:text-text-normal',
        dragging && 'opacity-40',
      )}
      onPointerDown={
        draggable
          ? (e) =>
              startSidebarDrag(e, () => {
                const targets = voiceDropTargets(state.userId);
                if (targets.size === 0) return null;
                return { kind: 'member', userId: state.userId, fromChannelId: state.channelId, targets };
              })
          : undefined
      }
      // Sürüklemeden sonra gelen tıklama sidebarDrag'de yutulur; kart yalnızca gerçek tıklamada açılır
      onClick={(e) => openVoiceProfile(state.userId, e.currentTarget.getBoundingClientRect())}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openVoiceProfile(state.userId, e.currentTarget.getBoundingClientRect());
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const items = memberMenuItems(state.userId, voiceMemberContext(state.userId));
        if (!isSelf || items.length > 0) {
          openContextMenu({
            x: e.clientX,
            y: e.clientY,
            userId: isSelf ? undefined : state.userId,
            items,
          });
        }
      }}
      onDoubleClick={() => {
        if (inMyChannel && state.streaming && !isSelf) voice.watchStream(state.userId);
      }}
      // Yayın yapıyorsa üstünde bekleyince "Şimdi Yayın Yapıyor" kartı; yapmıyor ama oyun oynuyorsa "Oynuyor" kartı
      {...(state.streaming ? streamCardHandlers(state) : playing ? activityCardHandlers(state) : {})}
    >
      <Avatar user={user} size={24} speaking={speaking} intro={intro} />
      <span
        className={cn('flex-1 truncate text-sm transition-colors duration-200', (speaking || intro) && 'text-text-head')}
        style={color ? { color } : undefined}
      >
        {user?.displayName ?? '…'}
      </span>
      {state.streaming && <WatchLiveBadge userId={state.userId} channelId={state.channelId} tooltip={false} />}
      {activity && <ActivityIcon activity={activity} size={18} />}
      <VoiceStateIcons state={state} localMuted={localMuted} />
    </div>
  );
}
