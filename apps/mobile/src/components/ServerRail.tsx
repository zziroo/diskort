import { memo, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import type { DmChannel, Guild } from '@diskort/shared';
import {
  dmTitle,
  useGuild,
  useGuildList,
  useGuildUnread,
  useGuildVoiceActivity,
  useMessages,
  useDmUnreadCount,
  useDmUnreadTotal,
  useIncomingFriendRequestCount,
  useSession,
  useUnreadDms,
  type GuildVoiceActivity,
} from '@diskort/client-core';
import { feedback } from '../haptics';
import { openChat, selectGuildInPanel, selectHome, useNav } from '../stores/nav';
import { colors, createStyles, space } from '../theme';
import { CountBadge } from './Badge';
import { DmAvatar } from './DmAvatar';
import { GuildIcon } from './GuildIcon';
import { openGuildMenu } from './GuildMenu';
import { PressableScale } from './PressableScale';

export { GuildIcon };

/** Çubuğun genişliği (sol panelde kanal sütununun solunda) */
export const RAIL_WIDTH = 72;
const ICON = 48;

/**
 * Sol paneldeki dikey sunucu çubuğu (Discord mobil gibi): en üstte direkt mesajlar (ana sayfa) düğmesi
 * okunmamış sayısıyla ve okunmamış konuşmalar, altında sunucular okunmamış işareti ve bahsetme
 * sayısıyla, sonra "+" ile sunucu kur / davetle katıl. Seçili öğenin solunda uzun beyaz çizgi,
 * okunmamışın solunda kısa nokta. Sunucuya uzun basınca sunucu menüsü. Geri bildirim düğmesi
 * masaüstündeki gibi çubuğun en altında sabittir (liste üstünde kayar).
 */
export function ServerRail() {
  const guilds = useGuildList();
  const home = useNav((s) => s.home);
  const unreadDms = useUnreadDms(3);
  const router = useRouter();
  return (
    <View style={styles.rail}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.railContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <HomeButton selected={home} />
        {unreadDms.map((dm) => (
          <UnreadDm key={dm.id} dm={dm} />
        ))}
        <View style={styles.separator} />
        {guilds.map((g) => (
          <GuildButton key={g.id} guild={g} home={home} />
        ))}
        <RailAction label="Sunucu ekle" onPress={() => router.push('/sunucu-ekle')}>
          {(pressed) => <Ionicons name="add" size={26} color={pressed ? colors.white : colors.ok} />}
        </RailAction>
      </ScrollView>
      <View style={styles.footer}>
        <RailAction label="Geri bildirim gönder" onPress={() => router.push('/feedback')}>
          {(pressed) => <FeedbackIcon color={pressed ? colors.white : colors.ok} />}
        </RailAction>
      </View>
    </View>
  );
}

/**
 * Masaüstündeki kalpli konuşma balonu (lucide MessageSquareHeart); Ionicons'ta olmadığı için balonun
 * içine küçük bir kalp oturtulur.
 */
function FeedbackIcon({ color }: { color: string }) {
  return (
    <View style={styles.feedbackIcon}>
      <Ionicons name="chatbox-outline" size={24} color={color} />
      <Ionicons name="heart" size={10} color={color} style={styles.feedbackHeart} />
    </View>
  );
}

/** Çubuğun yeşil simgeli yuvarlak düğmesi (sunucu ekle, geri bildirim); basılıyken yeşil zemin */
function RailAction({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: (pressed: boolean) => ReactNode;
}) {
  return (
    <PressableScale
      scaleTo={0.92}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.ok, borderRadius: 16 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {({ pressed }) => children(pressed)}
    </PressableScale>
  );
}

/** Ana sayfa düğmesinin altında okunmamış konuşma: dokununca açılır */
const UnreadDm = memo(function UnreadDm({ dm }: { dm: DmChannel }) {
  const count = useDmUnreadCount(dm.id);
  const selfId = useSession((s) => s.user?.id);
  const title = useGuild((s) => dmTitle(dm, s.users, selfId));
  return (
    <RailItem label={`${title}, ${count} okunmamış mesaj`} onPress={() => openChat(dm.id)}>
      <DmAvatar dm={dm} size={ICON} />
      <View style={styles.badge}>
        <CountBadge count={count} ring={colors.rail} />
      </View>
    </RailItem>
  );
});

/** Çubuktaki bir öğe: solunda seçim/okunmamış çizgisi */
function RailItem({
  children,
  label,
  selected = false,
  unread = false,
  onPress,
  onLongPress,
  hint,
}: {
  children: ReactNode;
  label: string;
  selected?: boolean;
  unread?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  hint?: string;
}) {
  return (
    <View style={styles.item}>
      {(selected || unread) && <View style={[styles.pill, selected ? styles.pillSelected : styles.pillUnread]} />}
      <PressableScale
        scaleTo={0.92}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={label}
        accessibilityHint={hint}
      >
        {children}
      </PressableScale>
    </View>
  );
}

/**
 * Direkt mesajlar (ana sayfa) düğmesi: tüm konuşmalardaki okunmamış mesaj sayısı ile yanıt bekleyen gelen
 * arkadaşlık isteklerinin toplamıyla
 */
function HomeButton({ selected }: { selected: boolean }) {
  const unread = useDmUnreadTotal();
  const requests = useIncomingFriendRequestCount();
  const label = [
    'Direkt mesajlar',
    unread > 0 ? `${unread} okunmamış` : null,
    requests > 0 ? `${requests} arkadaşlık isteği` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <RailItem
      selected={selected}
      label={label}
      onPress={() => {
        if (!selected) feedback('tick');
        selectHome();
      }}
    >
      <View style={[styles.home, { borderRadius: selected ? 16 : ICON / 2 }, selected && { backgroundColor: colors.brand }]}>
        <Ionicons name="chatbubbles" size={24} color={selected ? colors.white : colors.text} />
      </View>
      <View style={styles.badge}>
        <CountBadge count={unread + requests} ring={colors.rail} />
      </View>
    </RailItem>
  );
}

const GuildButton = memo(function GuildButton({ guild, home }: { guild: Guild; home: boolean }) {
  const selected = useGuild((s) => s.activeGuildId === guild.id) && !home;
  const unread = useGuildUnread(guild.id);
  const channelIds = useGuild(useShallow((s) => s.guilds[guild.id]?.channels.map((c) => c.id) ?? []));
  const mentions = useMessages((s) => channelIds.reduce((n, id) => n + (s.mentionCounts[id] ?? 0), 0));
  const voiceActivity = useGuildVoiceActivity(guild.id);
  return (
    <RailItem
      selected={selected}
      unread={unread}
      onPress={() => {
        if (!selected) feedback('tick');
        selectGuildInPanel(guild.id);
      }}
      onLongPress={() => {
        feedback('tick');
        openGuildMenu(guild.id);
      }}
      label={`${guild.name}${unread ? ', okunmamış mesajlar var' : ''}${mentions ? `, ${mentions} bahsetme` : ''}${
        voiceActivity === 'stream' ? ', yayın var' : voiceActivity === 'voice' ? ', seste biri var' : ''
      }`}
      hint="Sunucu menüsü için uzun bas"
    >
      <GuildIcon guild={guild} size={ICON} radius={selected ? 16 : ICON / 2} />
      {voiceActivity && <ActivityBadge activity={voiceActivity} />}
      <View style={styles.badge}>
        <CountBadge count={mentions} ring={colors.rail} />
      </View>
    </RailItem>
  );
});

/**
 * Sunucu simgesinin sağ üst köşesinde, çubuk renginde halkalı küçük koyu rozet: sunucuda yayın yapan varsa
 * ekran ikonu, yoksa seste biri varsa hoparlör. Dokunmayı
 * engellemez.
 */
function ActivityBadge({ activity }: { activity: NonNullable<GuildVoiceActivity> }) {
  const stream = activity === 'stream';
  return (
    <View
      pointerEvents="none"
      style={[styles.activity, { backgroundColor: colors.raised }]}
    >
      <Ionicons name={stream ? 'desktop-outline' : 'volume-medium'} size={11} color={colors.head} />
    </View>
  );
}

const styles = createStyles(() => ({
  rail: { width: RAIL_WIDTH, backgroundColor: colors.rail },
  scroll: { flex: 1 },
  railContent: { alignItems: 'center', gap: space.sm, paddingTop: space.sm, paddingBottom: space.md },
  footer: { alignItems: 'center', paddingTop: space.sm, paddingBottom: space.md },
  item: { width: RAIL_WIDTH, alignItems: 'center' },
  pill: {
    position: 'absolute',
    left: 0,
    width: 4,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    backgroundColor: colors.head,
  },
  pillSelected: { top: 4, bottom: 4 },
  pillUnread: { top: ICON / 2 - 4, height: 8 },
  home: { width: ICON, height: ICON, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' },
  separator: { width: 32, height: 2, borderRadius: 1, backgroundColor: colors.line },
  badge: { position: 'absolute', right: -4, bottom: -4 },
  // Sağ üst: yayın/ses rozeti. Kenarlık sabit (açılıp kapanmaz), arka plan görseli yok
  activity: {
    position: 'absolute',
    right: -4,
    top: -4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
    borderColor: colors.rail,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    width: ICON,
    height: ICON,
    borderRadius: ICON / 2,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackIcon: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  feedbackHeart: { position: 'absolute', top: 5 },
}));
