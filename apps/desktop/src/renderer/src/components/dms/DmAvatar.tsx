import { Users } from 'lucide-react';
import type { DmChannel } from '@diskort/shared';
import { dmPartner, useGuild, useOnMobile, useSession, useStatus } from '@diskort/client-core';
import { cn } from '../../lib/utils';
import { Avatar } from '../ui/Avatar';

/** Grup renkleri: kimlikten türetilir, konuşma her yerde aynı renkte görünür */
const GROUP_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];

function groupColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]!;
}

/** Konuşmanın resmi: bire bir konuşmada karşı tarafın profil fotoğrafı (çevrimiçi noktasıyla), grupta simge */
export function DmAvatar({
  dm,
  size = 32,
  status = false,
  ringClassName,
  decorated = false,
  className,
}: {
  dm: DmChannel;
  size?: number;
  /** Bire bir konuşmada çevrimiçi noktası gösterilsin */
  status?: boolean;
  ringClassName?: string;
  /** Bire bir konuşmada karşı tarafın avatar dekorasyonu da çizilsin (konuşma listesi) */
  decorated?: boolean;
  className?: string;
}) {
  const selfId = useSession((s) => s.user?.id);
  const partner = useGuild((s) => dmPartner(dm, s.users, selfId));
  const shown = useStatus(partner?.id);
  const mobile = useOnMobile(partner?.id);
  const reachable = useGuild((s) => (partner ? Boolean(s.reachable[partner.id]) : false));
  if (!dm.group) {
    return (
      <Avatar
        user={partner}
        size={size}
        status={status && partner && reachable ? shown : undefined}
        mobile={mobile}
        ringClassName={ringClassName}
        decoration={decorated ? partner?.avatarDecoration : undefined}
        className={className}
      />
    );
  }
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-full text-white', className)}
      style={{ width: size, height: size, background: groupColor(dm.id) }}
    >
      <Users size={Math.round(size * 0.55)} />
    </div>
  );
}
