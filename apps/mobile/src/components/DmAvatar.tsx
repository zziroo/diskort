import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { DmChannel } from '@diskort/shared';
import { dmPartner, useGuild, useOnMobile, useSession, useStatus } from '@diskort/client-core';
import { Avatar } from './Avatar';

/** Grup renkleri: kimlikten türetilir, konuşma her yerde aynı renkte görünür (masaüstüyle aynı) */
const GROUP_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];

function groupColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]!;
}

/** Konuşmanın resmi: bire bir konuşmada karşı tarafın profil fotoğrafı (çevrimiçi noktasıyla), grupta simge */
export function DmAvatar({
  dm,
  size = 40,
  status = false,
  surfaceColor,
  decorated = false,
}: {
  dm: DmChannel;
  size?: number;
  status?: boolean;
  /** Çevrimiçi noktasının halkası: avatarın durduğu yüzeyin rengi */
  surfaceColor?: string;
  /** Bire bir konuşmada karşı tarafın avatar dekorasyonu da çizilsin (konuşma listesi) */
  decorated?: boolean;
}) {
  const selfId = useSession((s) => s.user?.id);
  const partner = useGuild((s) => dmPartner(dm, s.users, selfId));
  const reachable = useGuild((s) => (partner ? Boolean(s.reachable[partner.id]) : false));
  const shown = useStatus(partner?.id);
  const mobile = useOnMobile(partner?.id);
  if (!dm.group) {
    return (
      <Avatar
        user={partner}
        size={size}
        status={status && partner && reachable ? shown : undefined}
        mobile={mobile}
        surface={surfaceColor}
        decoration={decorated ? partner?.avatarDecoration : undefined}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: groupColor(dm.id),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="people" size={Math.round(size * 0.5)} color="#fff" />
    </View>
  );
}
