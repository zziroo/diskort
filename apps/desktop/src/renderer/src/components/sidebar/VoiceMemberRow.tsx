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
import { openActivityPopover } from '../status/ActivityPopover';
import { activityCardHandlers } from './ActivityHoverCard';
import { streamCardHandlers } from './StreamPreviewCard';

/**
 * Üye satırının sağ ucundaki yuva: yayında olmayan üyede oyun ikonu (tıklayınca oyun sayfası; satırın profil
 * tıklaması ve sürüklemesi çalışmaz). Yayındaki üyede boş: yayının küçük resmi satırda durmaz, yalnız hover
 * kartında (`StreamPreviewCard`) görünür; "YAYINDA" hapı ve ses simgeleri sağa yaslı kalır.
 */
function TrailingSlot({ state, activity }: { state: VoiceState; activity: ReturnType<typeof useActivity> }) {
  if (state.streaming) return null;
  if (activity) {
    return (
      <button
        type="button"
        className="press-icon flex shrink-0 rounded"
        aria-label={`${activity.name} (oyun sayfası)`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          openActivityPopover(state.userId, activity, e.currentTarget.getBoundingClientRect());
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        // Enter/boşluk satırın profil kısayolunu tetiklemesin; öteki tuşlar (Esc katmanı) pencereye ulaşsın
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <ActivityIcon activity={activity} size={18} />
      </button>
    );
  }
  return null;
}

/**
 * Dar satırda "YAYINDA" hapının noktaya inen hâli: 10 px daire (size-2.5), dolgu yok, yazı 0 px (görsel olarak
 * yok, erişilebilir ad kalır). Eşik 170 px, satırın *içerik* genişliği (kapsayıcı sorgusu içerik kutusunu ölçer;
 * satır px-2 = 16 px dolgulu): satır ≈ kenar çubuğu − 40 px (ml-6 + dış dolgu) olduğundan en dar kenar çubuğu
 * (200 px) satırı ≈160 px, içeriği ≈144 px olur → nokta; varsayılan 240 px'te satır ≈200 px, içerik ≈184 px →
 * hap aynen kalır (ad ≈64 px). Eşik (satır ≈186 px) kenar çubuğunun ≈226 px'ine denk gelir; hapla ad 25 px'e sıkışmadan nokta devreye girer.
 */
const ROW_DOT = '@max-[170px]:size-2.5 @max-[170px]:overflow-hidden @max-[170px]:p-0 @max-[170px]:text-[0px] @max-[170px]:leading-[0]';

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
  inRow = false,
}: {
  userId: string;
  channelId: string;
  /** Kanal listesinde ipucu yerine "Şimdi Yayın Yapıyor" kartı açılır */
  tooltip?: boolean;
  /**
   * Üye satırında kullanım: satırın kapsayıcı sorgusuna (`@container`) göre dar satırda hap kırmızı noktaya iner
   * (metin görsel olarak gizlenir, ekran okuyucuya kalır). Sahne ve PiP kullanımları etkilenmez.
   */
  inRow?: boolean;
}) {
  return (
    <button
      type="button"
      data-tooltip={tooltip ? 'Yayını izle' : undefined}
      aria-label="Yayını izle"
      className={cn(
        'press shrink-0 rounded-full transition-[filter] hover:brightness-110',
        // Nokta durumunda tıklama alanı 10 px + 2×4 px dolgu = 18 px
        inRow && '@max-[170px]:p-1',
      )}
      onClick={(e) => {
        e.stopPropagation();
        void watchUserStream(userId, channelId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <LiveBadge className={cn('block', inRow && ROW_DOT)} />
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
          className={cn('anim-pill-in shrink-0', mutedByOthers ? 'text-danger' : 'text-text-muted')}
        />
      )}
      {deaf && (
        <HeadphoneOff
          size={size}
          aria-label={state.serverDeaf ? 'Sunucuda sağırlaştırıldı' : 'Sağırlaştırıldı'}
          className={cn('anim-pill-in shrink-0', state.serverDeaf && 'text-danger')}
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
        '@container group flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-text-muted transition-[color,background-color,opacity] duration-150 select-none hover:bg-bg-hover hover:text-text-normal',
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
      {state.streaming && <WatchLiveBadge userId={state.userId} channelId={state.channelId} tooltip={false} inRow />}
      <VoiceStateIcons state={state} localMuted={localMuted} />
      <TrailingSlot state={state} activity={activity} />
    </div>
  );
}
