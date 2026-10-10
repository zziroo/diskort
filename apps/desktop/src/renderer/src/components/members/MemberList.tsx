import { memo, useMemo } from 'react';
import { Crown } from 'lucide-react';
import { userNameplateId, type User } from '@diskort/shared';
import {
  activeGuildContext,
  guildVoiceStateOf,
  memberGroups,
  useGuild,
  useMemberColor,
  useSession,
  useOnMobile,
  useStatus,
  voiceLabel,
} from '@diskort/client-core';
import { PresenceSubline } from '../status/ActivityCard';
import { memberMenuItems } from '../../lib/memberMenu';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { Nameplate, nameplateNameColor, PlayScope, useHoverPlay, useKnownCosmeticSet } from '../cosmetics/Cosmetics';
import { Avatar } from '../ui/Avatar';
import { openProfile } from './ProfilePopover';

/** Metin kanalının sağındaki üye listesi: ayrı gösterilen rollere göre gruplar, çevrimiçi, çevrimdışı. */
export function MemberList() {
  const users = useGuild((s) => s.users);
  const roles = useGuild((s) => s.roles);
  const online = useGuild((s) => s.online);
  const guild = useGuild((s) => s.guild);
  const groups = useMemo(() => memberGroups({ users, roles, online, guild }), [users, roles, online, guild]);

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l border-divider bg-bg-side px-2 pb-4" aria-label="Üye listesi">
      {groups.map((group) => (
        <section key={group.id}>
          <h3 className="px-2 pt-6 pb-1 text-xs font-bold tracking-wide text-text-muted uppercase">
            {group.title} — {group.members.length}
          </h3>
          {group.members.map((user) => (
            <MemberRow key={user.id} user={user} offline={group.id === 'offline'} owner={user.id === guild?.ownerId} />
          ))}
        </section>
      ))}
    </aside>
  );
}

const MemberRow = memo(function MemberRow({ user, offline, owner }: { user: User; offline: boolean; owner: boolean }) {
  const color = useMemberColor(user.id);
  const selfId = useSession((s) => s.user?.id);
  // Sesteyse ses simgesinin ipucu (kanalın adıyla); seste değilse null
  const voice = useGuild((s) => {
    // DM araması sunucunun üye listesinde görünmez (konuşma sunucuya ait değil)
    const channelId = guildVoiceStateOf(s, user.id)?.channelId;
    return channelId ? voiceLabel(s.channels.find((c) => c.id === channelId)?.name) : null;
  });
  const status = useStatus(user.id);
  const mobile = useOnMobile(user.id);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const isSelf = user.id === selfId;
  // İsim plakası satırın arkasında oynar; seti tanınmıyorsa (paketi yayında değil) satır plakasızdır
  const plate = useKnownCosmeticSet(userNameplateId(user));
  // Plaka ve avatar dekorasyonu yalnızca satırın üstüne gelinirken (ya da klavyeyle odaklanınca) oynar
  const { playing, bind } = useHoverPlay();

  // Tıklayınca profil kartı listenin soluna açılır
  const showProfile = (el: HTMLElement): void => {
    // Üye listesi seçili sunucunun listesidir
    openProfile({
      userId: user.id,
      context: activeGuildContext(useGuild.getState()),
      anchor: el.getBoundingClientRect(),
      side: 'left',
    });
  };

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
          // Plakalı satırda plaka solmaz (açık temada zemine karışmasın), yalnızca avatar ve yazılar
          offline && !plate && 'opacity-40 hover:opacity-100',
        )}
        onClick={(e) => showProfile(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          showProfile(e.currentTarget);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = memberMenuItems(user.id, activeGuildContext(useGuild.getState()));
          // Başkasına sağ tıklayınca ses seviyesi de ayarlanabilir (seste olmasa da kaydedilir)
          if (!isSelf || items.length > 0) {
            openContextMenu({ x: e.clientX, y: e.clientY, userId: isSelf ? undefined : user.id, items });
          }
        }}
      >
        {plate && <Nameplate id={plate} />}
        <Avatar
          user={user}
          size={32}
          status={status}
          mobile={mobile}
          ringClassName="bg-bg-side"
          ringColor={plate ? '#0a0a0a' : undefined}
          decoration={user.avatarDecoration}
          className={cn(offline && plate && 'opacity-40 group-hover:opacity-100')}
        />
        <div
          className={cn('min-w-0 flex-1 leading-tight', offline && plate && 'opacity-50 group-hover:opacity-100')}
        >
          <div className="flex items-center gap-1">
            <span
              className={cn('truncate font-medium', plate ? 'nameplate-text' : 'text-text-normal')}
              style={color ? { color: plate ? nameplateNameColor(color) : color } : undefined}
            >
              {user.displayName}
            </span>
            {owner && <Crown size={13} aria-label="Sunucunun sahibi" className="shrink-0 text-warn" />}
          </div>
          {/* Durum simgeleri (oyun, ses) ve yazı: özel durum, yoksa oynadığı oyun, o da yoksa sesli sohbet */}
          <PresenceSubline
            userId={user.id}
            voice={voice}
            className={cn('text-xs', plate ? 'nameplate-sub' : 'text-text-muted')}
          />
        </div>
      </div>
    </PlayScope>
  );
});
