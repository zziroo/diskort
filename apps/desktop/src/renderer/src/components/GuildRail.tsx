import type { ReactNode } from 'react';
import { MessageSquareHeart, MessagesSquare, Plus, ScreenShare, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { DmChannel, Guild } from '@diskort/shared';
import {
  dmTitle,
  useDmUnreadCount,
  useDmUnreadTotal,
  useGuild,
  useGuildList,
  useGuildUnread,
  useGuildVoiceActivity,
  useIncomingFriendRequestCount,
  useMessages,
  useSession,
  useUnreadDms,
  type GuildVoiceActivity,
} from '@diskort/client-core';
import { isDmSection, openDmSection, openGuildSection, useMainView } from '../lib/mainView';
import { cn } from '../lib/utils';
import { useUi } from '../stores/ui';
import { DmAvatar } from './dms/DmAvatar';
import { GuildIcon } from './ui/GuildIcon';

/**
 * Sol dikey çubuk (Discord gibi): en üstte direkt mesajlar (okunmamış ve gelen arkadaşlık isteği sayısıyla, altında okunmamış
 * konuşmalar), sonra üye olunan sunucular, en altta sunucu ekleme ve geri bildirim.
 */
export function GuildRail() {
  const guilds = useGuildList();
  const openModal = useUi((s) => s.openModal);
  const view = useMainView();
  const inDms = isDmSection(view);
  const dmUnread = useDmUnreadTotal();
  // Ana sayfa rozeti: okunmamış DM'ler ve yanıt bekleyen arkadaşlık istekleri birlikte
  const friendRequests = useIncomingFriendRequestCount();
  const unreadDms = useUnreadDms(3);
  // Konuşmalardan birinde arama sürüyor
  const dmCall = useGuild((s) => Object.keys(s.dmCalls).length > 0);

  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-divider bg-bg-rail pt-3 pb-[calc(var(--footer-h,0px)+12px)] [scrollbar-width:none]">
      <RailItem
        selected={inDms}
        unread={false}
        label="Direkt Mesajlar"
        badge={dmUnread + friendRequests}
        badgeText={[
          dmUnread > 0 ? `${dmUnread} okunmamış mesaj` : null,
          friendRequests > 0 ? `${friendRequests} arkadaşlık isteği` : null,
        ]
          .filter(Boolean)
          .join(', ')}
        activity={dmCall ? 'voice' : null}
        onClick={openDmSection}
      >
        <div
          className={cn(
            'flex h-12 w-12 items-center justify-center transition-[border-radius,background-color,color] duration-200 ease-out',
            inDms
              ? 'rounded-2xl bg-brand text-white'
              : 'rounded-3xl bg-bg-raised text-text-normal group-hover/rail:rounded-2xl group-hover/rail:bg-brand group-hover/rail:text-white',
          )}
        >
          <MessagesSquare size={24} className="ico-bounce" />
        </div>
      </RailItem>

      {unreadDms.map((dm) => (
        <UnreadDm key={dm.id} dm={dm} />
      ))}

      <div className="h-0.5 w-8 shrink-0 rounded bg-bg-hover" />

      {guilds.map((guild) => (
        <GuildItem key={guild.id} guild={guild} inDms={inDms} />
      ))}

      <RailAction label="Sunucu ekle" onClick={() => openModal({ type: 'addGuild' })}>
        <Plus size={24} className="ico-rotate" />
      </RailAction>

      {/* Geri bildirim: en altta */}
      <RailAction label="Geri bildirim gönder" className="mt-auto" onClick={() => openModal({ type: 'feedback' })}>
        <MessageSquareHeart size={22} className="ico-beat" />
      </RailAction>
    </nav>
  );
}

/**
 * Çubuğun altındaki yeşil simgeli düğme (sunucu ekle, geri bildirim). Basınca küçülme düğmede, köşe
 * yuvarlaklığı ve renk geçişi içteki kutuda (.press düğmenin kendi geçişini ezdiğinden ayrı öğelerde).
 */
function RailAction({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={cn('press group/act shrink-0 rounded-2xl', className)}
      data-tooltip={label}
      data-tooltip-side="right"
      aria-label={label}
      onClick={onClick}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-3xl bg-bg-raised text-ok transition-[border-radius,background-color,color] duration-200 ease-out group-hover/act:rounded-2xl group-hover/act:bg-ok group-hover/act:text-white">
        {children}
      </span>
    </button>
  );
}

/** Sunucu: simgesi, seçiliyse uzun işaret, okunmamış mesajı varsa kısa işaret, bahsetme sayısı, seste/yayında biri varsa sağ üst rozet */
function GuildItem({ guild, inDms }: { guild: Guild; inDms: boolean }) {
  const selected = useGuild((s) => !inDms && s.activeGuildId === guild.id);
  const unread = useGuildUnread(guild.id);
  // Sunucunun kanallarındaki okunmamış bahsetmeler
  const channelIds = useGuild(useShallow((s) => s.guilds[guild.id]?.channels.map((c) => c.id) ?? []));
  const mentions = useMessages((s) => channelIds.reduce((n, id) => n + (s.mentionCounts[id] ?? 0), 0));
  const voiceActivity = useGuildVoiceActivity(guild.id);
  return (
    <RailItem
      selected={selected}
      unread={unread}
      label={guild.name}
      badge={mentions}
      activity={voiceActivity}
      onClick={() => openGuildSection(guild.id)}
    >
      <GuildIcon
        guild={guild}
        size={48}
        className={cn(
          'transition-[border-radius] duration-200 ease-out',
          selected ? 'rounded-2xl' : 'rounded-3xl group-hover/rail:rounded-2xl',
        )}
      />
    </RailItem>
  );
}

/** Okunmamış mesajı olan konuşma: profil fotoğrafı ve okunmamış sayısı */
function UnreadDm({ dm }: { dm: DmChannel }) {
  const selfId = useSession((s) => s.user?.id);
  const title = useGuild((s) => dmTitle(dm, s.users, selfId));
  const count = useDmUnreadCount(dm.id);
  const inCall = useGuild((s) => Boolean(s.dmCalls[dm.id]));
  return (
    <div className="anim-pop-in">
      <RailItem
        selected={false}
        unread
        label={title}
        badge={count}
        activity={inCall ? 'voice' : null}
        onClick={() => useUi.getState().setView({ kind: 'dm', channelId: dm.id })}
      >
        <DmAvatar dm={dm} size={48} />
      </RailItem>
    </div>
  );
}

/**
 * Çubuktaki öğe: seçiliyse soldaki uzun işaret, okunmamışsa kısa işaret, sağ altta kırmızı sayı, sağ üstte
 * sunucuda yayın (ekran ikonu) ya da seste biri (hoparlör) olduğunu gösteren koyu rozet
 */
function RailItem({
  selected,
  unread,
  label,
  badge = 0,
  badgeText,
  activity = null,
  onClick,
  children,
}: {
  selected: boolean;
  unread: boolean;
  label: string;
  badge?: number;
  /** Rozetin ekran okuyucu metni (verilmezse "N okunmamış mesaj") */
  badgeText?: string;
  activity?: GuildVoiceActivity;
  onClick: () => void;
  children: ReactNode;
}) {
  const activityText = activity === 'stream' ? 'yayın var' : activity === 'voice' ? 'seste biri var' : null;
  const ariaLabel = [label, badge > 0 ? (badgeText ?? `${badge} okunmamış mesaj`) : null, activityText].filter(Boolean).join(', ');
  return (
    <div className="group/rail relative flex shrink-0 items-center">
      <span
        className={cn(
          'absolute -left-3 w-1 origin-left rounded-r bg-text-head transition-[height,opacity] duration-200 ease-out',
          selected ? 'h-10 opacity-100' : unread ? 'h-2 opacity-100 group-hover/rail:h-5' : 'h-5 opacity-0 group-hover/rail:opacity-100',
        )}
      />
      <button
        className="press relative rounded-2xl"
        data-tooltip={activityText ? `${label} (${activityText})` : label}
        data-tooltip-side="right"
        aria-label={ariaLabel}
        aria-current={selected ? 'page' : undefined}
        onClick={onClick}
      >
        {children}
        {activity && (
          <span
            key={activity}
            aria-hidden
            className="anim-pill-in absolute -top-1 -right-1 flex h-[22px] w-[22px] items-center justify-center rounded-full border-[3px] border-bg-rail bg-bg-raised-hover text-text-head"
          >
            {activity === 'stream' ? <ScreenShare size={11} strokeWidth={2.5} /> : <Volume2 size={11} strokeWidth={2.5} />}
          </span>
        )}
        {badge > 0 && (
          <span
            key={badge}
            className="anim-pill-in absolute -right-1 -bottom-1 flex h-[22px] min-w-[22px] items-center justify-center rounded-full border-[3px] border-bg-rail bg-danger px-1 text-[11px] font-bold text-white"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    </div>
  );
}
