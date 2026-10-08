import { memo } from 'react';
import { Crown } from 'lucide-react';
import { userNameplateId, type DmChannel } from '@diskort/shared';
import { useGuild, useSession, type ProfileContext } from '@diskort/client-core';
import { memberMenuItems } from '../../lib/memberMenu';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { Nameplate, PlayScope, useHoverPlay, useKnownCosmeticSet } from '../cosmetics/Cosmetics';
import { openProfile } from '../members/ProfilePopover';
import { PresenceSubline } from '../status/ActivityCard';
import { Avatar, PresenceAvatar } from '../ui/Avatar';

/** Konuşmanın sağındaki katılımcı listesi (metin kanalındaki üye listesinin karşılığı) */
export function DmMembers({ dm }: { dm: DmChannel }) {
  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l border-divider bg-bg-side px-2 pb-4" aria-label="Konuşmadakiler">
      <h3 className="px-2 pt-6 pb-1 text-xs font-bold tracking-wide text-text-muted uppercase">
        Konuşmadakiler — {dm.participantIds.length}
      </h3>
      {dm.participantIds.map((id) => (
        <Participant key={id} userId={id} owner={dm.group && dm.ownerId === id} channelId={dm.id} />
      ))}
    </aside>
  );
}

const Participant = memo(function Participant({
  userId,
  owner,
  channelId,
}: {
  userId: string;
  owner: boolean;
  /** Konuşma: kart ve menü DM bağlamında açılır (sunucu rolü, rengi ya da yönetimi yok) */
  channelId: string;
}) {
  const user = useGuild((s) => s.users[userId]);
  const online = useGuild((s) => Boolean(s.online[userId]));
  // Ortak sunucusu kalmayan ve arkadaş olmayan (ya da seçili olmayan sunucudan tanınan) kişi
  const reachable = useGuild((s) => Boolean(s.reachable[userId]));
  const selfId = useSession((s) => s.user?.id);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const isSelf = userId === selfId;
  // İsim plakası (ortak sunucusu olmayanın dekorasyonu gibi o da gösterilmez; seti tanınmıyorsa da)
  const plate = useKnownCosmeticSet(user && (reachable || isSelf) ? userNameplateId(user) : null);
  // Plaka ve avatar dekorasyonu yalnızca satırın üstüne gelinirken (ya da klavyeyle odaklanınca) oynar
  const { playing, bind } = useHoverPlay();
  if (!user) return null;
  const context: ProfileContext = { kind: 'dm', channelId };
  const showProfile = (el: HTMLElement): void =>
    openProfile({ userId, context, anchor: el.getBoundingClientRect(), side: 'left' });

  return (
    <PlayScope playing={playing}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${user.displayName} profili`}
        {...bind}
        className={cn(
          'group flex h-[42px] cursor-pointer items-center gap-3 rounded px-2 hover:bg-bg-hover',
          plate && 'relative isolate overflow-hidden',
          // Plakalı satırda plaka solmaz, yalnızca avatar ve yazılar
          (!online || !reachable) && !plate && 'opacity-40 hover:opacity-100',
        )}
        onClick={(e) => showProfile(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          showProfile(e.currentTarget);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = memberMenuItems(userId, context);
          if (!isSelf || items.length > 0) {
            openContextMenu({ x: e.clientX, y: e.clientY, userId: isSelf ? undefined : userId, items });
          }
        }}
      >
        {plate && <Nameplate id={plate} />}
        {reachable || isSelf ? (
          <PresenceAvatar
            userId={userId}
            user={user}
            size={32}
            ringClassName="bg-bg-side"
            ringColor={plate ? '#0a0a0a' : undefined}
            decoration={user?.avatarDecoration}
            className={cn(plate && (!online || !reachable) && 'opacity-40 group-hover:opacity-100')}
          />
        ) : (
          <Avatar user={user} size={32} />
        )}
        <div
          className={cn('min-w-0 flex-1 leading-tight', plate && (!online || !reachable) && 'opacity-50 group-hover:opacity-100')}
        >
          <div className="flex items-center gap-1">
            {/* DM'de rol rengi yok: ad varsayılan renkte */}
            <span className={cn('truncate font-medium', plate ? 'nameplate-text' : 'text-text-normal')}>
              {user.displayName}
            </span>
            {owner && <Crown size={13} aria-label="Grubun sahibi" className="shrink-0 text-warn" />}
          </div>
          {reachable || isSelf ? (
            // Hesap düzeyi bilgi (sunucu bilgisi değil; ses simgesi yok): oyun simgesi; özel durum, yoksa oynadığı oyun
            <PresenceSubline userId={userId} className={cn('text-xs', plate ? 'nameplate-sub' : 'text-text-muted')} />
          ) : (
            <div className="truncate text-xs text-text-muted">Ortak sunucunuz yok, arkadaş değilsiniz</div>
          )}
        </div>
      </div>
    </PlayScope>
  );
});
