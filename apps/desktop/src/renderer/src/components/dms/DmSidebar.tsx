import { memo } from 'react';
import { MessagesSquare, Plus, Users, Volume2, X } from 'lucide-react';
import type { DmChannel } from '@diskort/shared';
import {
  dmTitle,
  isUnread,
  useDmList,
  useDmUnreadCount,
  useGuild,
  useIncomingFriendRequestCount,
  useSession,
} from '@diskort/client-core';
import { closeOrLeaveDm, dmMenuItems } from '../../lib/dm';
import { useMainView } from '../../lib/mainView';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { PlayOnHover } from '../cosmetics/Cosmetics';
import { formatAgo, formatFull } from '../text/format';
import { PresenceSubline } from '../status/ActivityCard';
import { DmAvatar } from './DmAvatar';

/** Direkt mesajlar bölümünün sol çubuğu: en üstte arkadaşlar, sonra konuşmalar (son etkinliğe göre). */
export function DmSidebar() {
  const dms = useDmList();
  const view = useMainView();
  const openModal = useUi((s) => s.openModal);
  const setView = useUi((s) => s.setView);

  return (
    <aside className="flex w-(--sidebar-w) shrink-0 flex-col border-r border-divider bg-bg-side">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2 shadow-sm">
        <button
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left font-semibold transition-colors',
            view.kind === 'dms' ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
          )}
          onClick={() => setView({ kind: 'dms' })}
        >
          <MessagesSquare size={18} className="ico-bounce shrink-0" />
          <span className="truncate">Direkt Mesajlar</span>
        </button>
        <button
          className="press-icon rounded p-1 text-text-muted hover:text-text-head"
          data-tooltip="Yeni Mesaj"
          aria-label="Yeni Mesaj"
          onClick={() => openModal({ type: 'newDm' })}
        >
          <Plus size={18} className="ico-rotate" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-3 pb-[calc(var(--footer-h,0px)+8px)]">
        <FriendsRow selected={view.kind === 'friends'} />
        <div className="mt-3 mb-1 px-2 text-xs font-bold tracking-wide text-text-muted uppercase">Konuşmalar</div>
        {dms.length === 0 ? (
          <p className="anim-fade-in px-2 pt-2 text-sm leading-snug text-text-muted">
            Henüz bir konuşman yok. Üye listesinde birine sağ tıklayıp <strong className="text-text-normal">Mesaj Gönder</strong>
            'i seç ya da yukarıdaki + ile başlat.
          </p>
        ) : (
          dms.map((dm) => <DmRow key={dm.id} dm={dm} selected={view.kind === 'dm' && view.channelId === dm.id} />)
        )}
      </div>

    </aside>
  );
}

/** "Arkadaşlar" satırı: arkadaşlar görünümünü açar; gelen istek sayısı kırmızı rozette */
function FriendsRow({ selected }: { selected: boolean }) {
  const incoming = useIncomingFriendRequestCount();
  const setView = useUi((s) => s.setView);
  return (
    <button
      className={cn(
        'flex h-[42px] w-full items-center gap-3 rounded px-2 text-left font-medium transition-colors duration-150',
        selected ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
      )}
      aria-label={incoming > 0 ? `Arkadaşlar, ${incoming} bekleyen istek` : 'Arkadaşlar'}
      onClick={() => setView({ kind: 'friends' })}
    >
      <span className="flex w-8 shrink-0 justify-center">
        <Users size={22} className="ico-spread" />
      </span>
      <span className="min-w-0 flex-1 truncate">Arkadaşlar</span>
      {incoming > 0 && (
        <span
          key={incoming}
          className="anim-pill-in flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white"
        >
          {incoming > 99 ? '99+' : incoming}
        </span>
      )}
    </button>
  );
}

const DmRow = memo(function DmRow({ dm, selected }: { dm: DmChannel; selected: boolean }) {
  const selfId = useSession((s) => s.user?.id);
  const title = useGuild((s) => dmTitle(dm, s.users, selfId));
  // Bire bir konuşmada karşı tarafın durumu: oynuyorsa oyun simgesi; özel durumu, yoksa oynadığı oyun
  const partnerId = dm.group ? null : (dm.participantIds.find((id) => id !== selfId) ?? null);
  const reachable = useGuild((s) => (partnerId ? Boolean(s.reachable[partnerId]) : false));
  const unread = useGuild((s) => isUnread(s, dm.id));
  const count = useDmUnreadCount(dm.id);
  // Konuşmada süren arama (kısa bir hoparlör simgesi)
  const inCall = useGuild((s) => Boolean(s.dmCalls[dm.id]));
  const setView = useUi((s) => s.setView);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const highlight = unread && !selected;

  return (
    // Avatarın dekorasyonu yalnızca satırın üstüne gelinirken (ya da klavyeyle odaklanınca) oynar
    <PlayOnHover className="group/item relative mb-0.5">
      {highlight && (
        <span className="anim-indicator-in absolute top-1/2 -left-2 h-2 w-1 origin-left -translate-y-1/2 rounded-r bg-text-head" />
      )}
      <button
        className={cn(
          'flex h-[42px] w-full items-center gap-3 rounded px-2 text-left transition-colors duration-150',
          selected
            ? 'bg-bg-active text-text-head'
            : highlight
              ? 'text-text-head hover:bg-bg-hover'
              : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
        )}
        onClick={() => setView({ kind: 'dm', channelId: dm.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu({ x: e.clientX, y: e.clientY, items: dmMenuItems(dm) });
        }}
      >
        <DmAvatar dm={dm} size={32} status ringClassName="bg-bg-side" decorated />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn('truncate', highlight ? 'font-semibold' : 'font-medium')}>{title}</span>
            {inCall && (
              <Volume2 size={14} aria-label="Arama sürüyor" className="anim-pill-in shrink-0 text-ok" />
            )}
          </span>
          {dm.group ? (
            <span className="block truncate text-xs text-text-muted">{dm.participantIds.length} üye</span>
          ) : (
            <PresenceSubline userId={reachable ? partnerId : null} className="text-xs text-text-muted" />
          )}
        </span>
        {count > 0 && !selected ? (
          <span
            key={count}
            className="anim-pill-in flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white group-hover/item:invisible"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : (
          <span
            className="shrink-0 text-[11px] text-text-faint group-hover/item:invisible"
            data-tooltip={formatFull(dm.lastActivityAt)}
          >
            {formatAgo(dm.lastActivityAt)}
          </span>
        )}
      </button>
      {/* Üstüne gelince: bire bir konuşmayı kapat, gruptan ayrıl */}
      <button
        className="press-icon invisible absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-text-muted group-hover/item:visible hover:text-text-head"
        data-tooltip={dm.group ? 'Gruptan ayrıl' : 'Konuşmayı kapat'}
        aria-label={dm.group ? 'Gruptan ayrıl' : 'Konuşmayı kapat'}
        onClick={() => void closeOrLeaveDm(dm)}
      >
        <X size={16} className="ico-rotate" />
      </button>
    </PlayOnHover>
  );
});
