import { memo, useCallback, useMemo, useState } from 'react';
import { Animated, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import { hasPermission, Permission, type Channel, type ChannelType, type VoiceState } from '@diskort/shared';
import {
  isUnread,
  useActivity,
  membersOf,
  useCan,
  useGuild,
  useChannelMemberColor,
  useMessages,
  useSession,
} from '@diskort/client-core';
import { feedback } from '../haptics';
import { animateNextLayout, useLayoutAnimationOn, useTimingTo } from '../motion';
import { toast } from '../stores/ui';
import { colors, createStyles, font, radius, ripple, space } from '../theme';
import { useVoice } from '../voice/voice';
import { ActivityBadge } from './ActivityCard';
import { Avatar } from './Avatar';
import { CountBadge, UnreadMarker } from './Badge';
import { HeaderButton } from './HeaderButton';
import { ChannelListSkeleton } from './Skeleton';
import { SpeakingRing } from './SpeakingRing';
import { EmptyState } from './States';
import { ChannelMenu } from './ChannelMenu';
import { openGuildMenu } from './GuildMenu';
import { openServerSettings } from './serverSettings/common';
import { TypingDots } from './TypingDots';
import { VoiceStateIcon } from './VoiceStateIcon';

// Seçili sunucunun kanal listesi (metin ve ses kanalları, ses kanalındakiler). Sol panelde sunucu
// çubuğunun yanında durur (LeftPanel); çubukta sunucu değiştirilince o sunucunun kanalları görünür.

type SectionKey = 'text' | 'voice';

/** Kapatılan bölümler uygulama açık kaldıkça hatırlanır (ekran yeniden açılınca da) */
const collapsedSections = new Set<SectionKey>();

/** Kanal @everyone'dan gizlenmiş mi (kilit simgesi) */
function usePrivate(channel: Channel): boolean {
  return useGuild((s) => {
    const everyone = channel.overwrites?.find((o) => o.roleId === s.guild?.id);
    return everyone !== undefined && hasPermission(everyone.deny, Permission.VIEW_CHANNEL);
  });
}

/** Bu kanalda (kendin dışında) yazan biri var mı; seçici ilkel değer döndürür */
function useSomeoneTyping(channelId: string): boolean {
  const selfId = useSession((s) => s.user?.id);
  return useMessages((s) => {
    const typing = s.typing[channelId];
    if (!typing) return false;
    for (const userId in typing) if (userId !== selfId) return true;
    return false;
  });
}

/**
 * Sol paneldeki sunucu başlığı (Discord mobil gibi): sunucunun adı; dokununca sunucu menüsü (davet, kanal
 * oluştur, sunucu ayarları, ayrıl). Sağda üyeler düğmesi.
 */
export function GuildHeader({ onMembers }: { onMembers: () => void }) {
  const guild = useGuild((s) => s.guild);
  if (!guild) return <View style={styles.header} />;
  return (
    <View style={styles.header}>
      <Pressable
        style={styles.headerName}
        onPress={() => openGuildMenu(guild.id)}
        android_ripple={ripple.row}
        accessibilityRole="button"
        accessibilityLabel={`${guild.name}, sunucu menüsü`}
      >
        <Text style={styles.guild} numberOfLines={1}>
          {guild.name}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </Pressable>
      <HeaderButton icon="people" label="Üyeler" size={21} onPress={onMembers} />
    </View>
  );
}

/** Hiç sunucu yok (yeni hesap ya da hepsinden ayrıldı): sunucuya katıl ya da kendi sunucunu kur */
export function NoGuilds() {
  const router = useRouter();
  return (
    <View style={styles.noGuilds}>
      <EmptyState
        icon="planet-outline"
        title="Henüz bir sunucun yok"
        text="Arkadaşlarınla konuşmak için kendi sunucunu kur ya da bir davet bağlantısıyla arkadaşının sunucusuna katıl."
        action={{ title: 'Sunucuya katıl', onPress: () => router.push('/sunucu-ekle') }}
      />
      <Text style={styles.createLink} onPress={() => router.push({ pathname: '/sunucu-ekle', params: { tab: 'create' } })}>
        ya da kendi sunucunu kur
      </Text>
    </View>
  );
}

export function ChannelList({
  onOpenText,
  onOpenVoice,
  onMemberPress,
  selectedId,
}: {
  onOpenText: (id: string) => void;
  onOpenVoice: (id: string) => void;
  /** Ses kanalındaki üyeye uzun basıldı (yönetim menüsü) */
  onMemberPress: (userId: string) => void;
  /** Açık olan metin kanalı (ana ekrandaki sohbet; vurgulanır) */
  selectedId?: string;
}) {
  const status = useGuild((s) => s.status);
  const guild = useGuild((s) => s.guild);
  const channels = useGuild((s) => s.channels);
  // Kapalı bölümde de görünmesi gerekenler: okunmamış metin kanalları ve bağlı olunan ses kanalı
  const unreadKey = useGuild((s) =>
    s.channels
      .filter((c) => c.type === 'text' && isUnread(s, c.id))
      .map((c) => c.id)
      .join(','),
  );
  const voiceChannelId = useVoice((s) => s.channelId);
  const canManageChannels = useCan(Permission.MANAGE_CHANNELS);
  // Uzun basılan kanal (kanal menüsü)
  const [menuChannel, setMenuChannel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set(collapsedSections));

  const sections = useMemo(() => {
    const unread = new Set(unreadKey ? unreadKey.split(',') : []);
    const build = (key: SectionKey, title: string, type: Channel['type']) => {
      const all = channels.filter((c) => c.type === type);
      const shown = collapsed.has(key)
        ? all.filter((c) => (type === 'text' ? unread.has(c.id) || c.id === selectedId : c.id === voiceChannelId))
        : all;
      return { key, title, total: all.length, data: shown };
    };
    // Kanal oluşturabilen boş bölümü de görür (başlıktaki + ile o türde kanal açar)
    return [build('text', 'Metin Kanalları', 'text'), build('voice', 'Ses Kanalları', 'voice')].filter(
      (s) => s.total > 0 || (canManageChannels && channels.length > 0),
    );
  }, [channels, collapsed, unreadKey, voiceChannelId, selectedId, canManageChannels]);

  const createChannel = useCallback(
    (type: ChannelType) => {
      if (guild) openServerSettings(guild.id, '/sunucu-ayarlari/kanal-olustur', { type });
    },
    [guild],
  );

  const toggleSection = useCallback((key: SectionKey) => {
    animateNextLayout(200);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      collapsedSections.clear();
      next.forEach((k) => collapsedSections.add(k));
      return next;
    });
  }, []);

  const loading = channels.length === 0 && status !== 'ready';
  // Hiç sunucu yok (yeni hesap ya da hepsinden ayrıldı)
  const noGuilds = status === 'ready' && guild === null;

  return (
    <View style={styles.fill}>
      {loading ? (
        <ChannelListSkeleton />
      ) : noGuilds ? (
        <NoGuilds />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(c) => c.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          renderSectionHeader={({ section }) => (
            <SectionHeader
              title={section.title}
              sectionKey={section.key}
              collapsed={collapsed.has(section.key)}
              onToggle={toggleSection}
              onCreate={canManageChannels ? createChannel : undefined}
            />
          )}
          renderItem={({ item }) =>
            item.type === 'text' ? (
              <TextChannelRow channel={item} onOpen={onOpenText} onMenu={setMenuChannel} selected={item.id === selectedId} />
            ) : (
              <VoiceChannelRow channel={item} onOpen={onOpenVoice} onMenu={setMenuChannel} onMemberPress={onMemberPress} />
            )
          }
          ListEmptyComponent={
            <EmptyState
              icon="chatbubbles-outline"
              tone="muted"
              title="Henüz kanal yok"
              text={
                canManageChannels
                  ? 'Sunucuda henüz kanal yok. İlk kanalı sen oluştur.'
                  : 'Kanalları sunucunun yöneticileri oluşturur. Oluşturulunca burada belirir.'
              }
              action={canManageChannels ? { title: 'Kanal oluştur', onPress: () => createChannel('text') } : undefined}
            />
          }
        />
      )}
      <ChannelMenu channelId={menuChannel} onClose={() => setMenuChannel(null)} />
    </View>
  );
}

/** Bölüm başlığı: dokununca bölüm kapanır/açılır, ok döner */
function SectionHeader({
  title,
  sectionKey,
  collapsed,
  onToggle,
  onCreate,
}: {
  title: string;
  sectionKey: SectionKey;
  collapsed: boolean;
  onToggle: (key: SectionKey) => void;
  /** Kanal oluşturabilene başlığın sağında + (masaüstündeki gibi) */
  onCreate?: (type: ChannelType) => void;
}) {
  const turn = useTimingTo(collapsed ? 1 : 0, 180);
  return (
    <View style={styles.sectionRow}>
    <Pressable
      onPress={() => onToggle(sectionKey)}
      style={styles.section}
      hitSlop={{ top: 4, bottom: 4 }}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      accessibilityLabel={`${title}, ${collapsed ? 'kapalı' : 'açık'}`}
    >
      {({ pressed }) => (
        <>
          <Animated.View
            style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-90deg'] }) }] }}
          >
            <Ionicons name="chevron-down" size={12} color={pressed ? colors.text : colors.muted} />
          </Animated.View>
          <Text style={[styles.sectionText, pressed && { color: colors.text }]}>{title}</Text>
        </>
      )}
    </Pressable>
      {onCreate && (
        <HeaderButton
          icon="add"
          size={20}
          label={sectionKey === 'text' ? 'Metin kanalı oluştur' : 'Ses kanalı oluştur'}
          onPress={() => onCreate(sectionKey)}
        />
      )}
    </View>
  );
}

const TextChannelRow = memo(function TextChannelRow({
  channel,
  onOpen,
  onMenu,
  selected = false,
}: {
  channel: Channel;
  onOpen: (id: string) => void;
  /** Uzun basınca kanal menüsü */
  onMenu: (id: string) => void;
  selected?: boolean;
}) {
  const unread = useGuild((s) => isUnread(s, channel.id));
  const mentionCount = useMessages((s) => s.mentionCounts[channel.id] ?? 0);
  const typing = useSomeoneTyping(channel.id);
  const locked = usePrivate(channel);
  const tint = unread || mentionCount > 0 ? colors.head : colors.muted;
  return (
    <View style={styles.rowWrap}>
      {unread && <UnreadMarker />}
      <Pressable
        onPress={() => onOpen(channel.id)}
        onLongPress={() => {
          feedback('tick');
          onMenu(channel.id);
        }}
        delayLongPress={300}
        android_ripple={ripple.row}
        style={[styles.row, selected && styles.rowActive]}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${channel.name} kanalı${unread ? ', okunmamış mesajlar var' : ''}${mentionCount ? `, ${mentionCount} bahsetme` : ''}`}
      >
        <View style={styles.rowIcon}>
          <Feather name="hash" size={20} color={tint} style={{ opacity: unread ? 1 : 0.85 }} />
          {locked && (
            <View style={styles.lock}>
              <Ionicons name="lock-closed" size={8} color={tint} />
            </View>
          )}
        </View>
        <Text style={[styles.name, (unread || mentionCount > 0 || selected) && styles.nameUnread]} numberOfLines={1}>
          {channel.name}
        </Text>
        {typing && <TypingDots color={colors.muted} size={4.5} />}
        <CountBadge count={mentionCount} />
      </Pressable>
    </View>
  );
});

const VoiceChannelRow = memo(function VoiceChannelRow({
  channel,
  onOpen,
  onMenu,
  onMemberPress,
}: {
  channel: Channel;
  onOpen: (id: string) => void;
  /** Uzun basınca kanal menüsü */
  onMenu: (id: string) => void;
  onMemberPress: (userId: string) => void;
}) {
  const voiceStates = useGuild((s) => s.voiceStates);
  const members = useMemo(() => membersOf(voiceStates, channel.id), [voiceStates, channel.id]);
  const active = useVoice((s) => s.channelId === channel.id);
  const canConnect = useCan(Permission.CONNECT, channel.id);
  const locked = usePrivate(channel);
  // Katılan üye satırı belirir, ayrılanın yeri yumuşakça kapanır
  useLayoutAnimationOn(members.map((m) => m.userId).join(','));
  const disabled = !canConnect && !active;
  return (
    <View>
      <View style={styles.rowWrap}>
        <Pressable
          onPress={() => (disabled ? toast('Bu ses kanalına bağlanma iznin yok.', 'error') : onOpen(channel.id))}
          onLongPress={() => {
            feedback('tick');
            onMenu(channel.id);
          }}
          delayLongPress={300}
          android_ripple={ripple.row}
          style={[styles.row, active && styles.rowActive, disabled && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={`${channel.name} ses kanalı${members.length ? `, ${members.length} kişi` : ''}${active ? ', bağlısın' : ''}`}
        >
          <View style={styles.rowIcon}>
            <Ionicons
              name={disabled || locked ? 'lock-closed-outline' : 'volume-medium'}
              size={20}
              color={active ? colors.ok : members.length ? colors.text : colors.muted}
            />
          </View>
          <Text style={[styles.name, (active || members.length > 0) && { color: colors.head }]} numberOfLines={1}>
            {channel.name}
          </Text>
          {members.length > 0 && !active && <Text style={styles.count}>{members.length}</Text>}
          {active && <Text style={styles.connected}>Bağlısın</Text>}
        </Pressable>
      </View>
      {members.map((m) => (
        <VoiceMember key={m.userId} state={m} onLongPress={onMemberPress} />
      ))}
    </View>
  );
});

const VoiceMember = memo(function VoiceMember({ state, onLongPress }: { state: VoiceState; onLongPress: (userId: string) => void }) {
  const user = useGuild((s) => s.users[state.userId]);
  const color = useChannelMemberColor(state.userId, state.channelId);
  const selfId = useSession((s) => s.user?.id);
  const speaking = useVoice((s) => Boolean(s.speaking[state.userId]));
  const intro = useVoice((s) => s.introPlayingUserId === state.userId);
  const inMyChannel = useVoice((s) => s.channelId === state.channelId);
  // Asıl (en son başlanan) oyunun ikonu, masaüstündeki gibi satırın sağında
  const activity = useActivity(state.userId);
  return (
    <Pressable
      onLongPress={() => onLongPress(state.userId)}
      delayLongPress={300}
      android_ripple={ripple.row}
      style={styles.member}
      accessibilityLabel={`${user?.displayName ?? 'Üye'}${state.streaming ? ', yayında' : ''}`}
      accessibilityHint="Seçenekler için uzun bas"
    >
      <SpeakingRing speaking={inMyChannel && speaking} intro={inMyChannel && intro} size={24}>
        <Avatar user={user} size={24} />
      </SpeakingRing>
      <Text
        style={[styles.memberName, state.userId === selfId && { color: colors.head }, color ? { color } : null]}
        numberOfLines={1}
      >
        {user?.displayName ?? '…'}
      </Text>
      {state.streaming && (
        <View style={styles.live}>
          <Text style={styles.liveText}>YAYINDA</Text>
        </View>
      )}
      {activity && <ActivityBadge activity={activity} />}
      <VoiceStateIcon state={state} size={15} />
    </Pressable>
  );
});

const styles = createStyles(() => ({
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.xs,
    paddingRight: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.edge,
  },
  headerName: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  fill: { flex: 1 },
  noGuilds: { flex: 1, justifyContent: 'center', paddingHorizontal: space.sm },
  createLink: { color: colors.link, fontSize: font.body, fontWeight: '600', textAlign: 'center', marginTop: space.md },
  guild: { color: colors.head, fontSize: font.title + 1, fontWeight: '800', flexShrink: 1 },
  listContent: { paddingBottom: space.lg },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', paddingRight: space.xs },
  section: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: space.md,
    paddingRight: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionText: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowWrap: { marginHorizontal: space.sm, marginVertical: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    minHeight: 42,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowActive: { backgroundColor: colors.active },
  rowIcon: { width: 22, alignItems: 'center' },
  lock: {
    position: 'absolute',
    top: -3,
    right: -4,
    backgroundColor: colors.side,
    borderRadius: 4,
    padding: 1,
  },
  name: { color: colors.muted, fontSize: font.row + 0.5, fontWeight: '500', flex: 1 },
  nameUnread: { color: colors.head, fontWeight: '700' },
  count: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  connected: { color: colors.ok, fontSize: font.caption, fontWeight: '700' },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginLeft: 44,
    marginRight: space.sm,
    paddingHorizontal: space.sm,
    height: 34,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  memberName: { color: colors.muted, fontSize: font.body - 0.5, flex: 1 },
  live: { backgroundColor: colors.danger, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 1 },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '800' },
}));
