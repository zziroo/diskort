import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { DM_GROUP_MAX_PARTICIPANTS, type DmChannel } from '@diskort/shared';
import {
  ackChannel,
  closeDm,
  dmPartner,
  dmTitle,
  isUnread,
  useActivity,
  useCustomStatus,
  useDmCall,
  useDmList,
  useDmUnreadCount,
  useGuild,
  useIncomingFriendRequestCount,
  useMessages,
  useSession,
} from '@diskort/client-core';
import { PresenceSubline } from './ActivityCard';
import { CountBadge, UnreadMarker } from './Badge';
import { BottomSheet, SheetGroup, SheetHeader, SheetItem } from './BottomSheet';
import { confirmDialog } from './Dialog';
import { DmAvatar } from './DmAvatar';
import { ListSkeleton } from './Skeleton';
import { EmptyState } from './States';
import { TypingDots } from './TypingDots';
import { useLayoutAnimationOn } from '../motion';
import { toast } from '../stores/ui';
import { brandTint, colors, createStyles, font, radius, ripple, space } from '../theme';

const dayMonth = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
/** Satır yüksekliği sabit: liste kaydırırken ölçmeden konumları bilir (getItemLayout) */
const ROW_HEIGHT = 64;

/** Listedeki kısa "son etkinlik": "şimdi", "5 dk", "3 sa", "Dün", "4 g", "12 Eyl" */
function formatAgo(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return 'şimdi';
  if (minutes < 60) return `${minutes} dk`;
  const start = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(ts)) / 86_400_000);
  if (days === 0) return `${Math.floor(minutes / 60)} sa`;
  if (days === 1) return 'Dün';
  if (days < 7) return `${days} g`;
  return dayMonth.format(ts);
}

/**
 * Direkt mesaj listesi: konuşmalar son etkinliğe göre, arama kutusuyla; dokununca açılır, uzun basınca
 * seçenekler. Sol panelde (ana sayfa seçiliyken) ve "Direkt Mesajlar" ekranında kullanılır.
 */
export function DmList({ onOpen, selectedId }: { onOpen: (dm: DmChannel) => void; selectedId?: string | null }) {
  const router = useRouter();
  const dms = useDmList();
  const status = useGuild((s) => s.status);
  const users = useGuild((s) => s.users);
  const selfId = useSession((s) => s.user?.id);
  const [menuFor, setMenuFor] = useState<DmChannel | null>(null);
  const [query, setQuery] = useState('');
  // Yeni konuşma belirir, kapanan yumuşakça çıkar, yeri değişen kayar
  useLayoutAnimationOn(dms.map((d) => d.id).join(','));

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!q) return dms;
    return dms.filter((d) => {
      if (dmTitle(d, users, selfId).toLocaleLowerCase('tr').includes(q)) return true;
      return d.participantIds.some((id) => id !== selfId && users[id]?.username.includes(q));
    });
  }, [dms, query, users, selfId]);

  const renderItem = useCallback(
    ({ item }: { item: DmChannel }) => (
      <DmRow dm={item} onPress={onOpen} onLongPress={setMenuFor} selected={item.id === selectedId} />
    ),
    [onOpen, selectedId],
  );

  const loading = dms.length === 0 && status !== 'ready';

  return (
    <View style={styles.page}>
      <FriendsRow onPress={() => router.navigate('/friends')} />
      {dms.length > 0 && (
        <View style={styles.search}>
          <Ionicons name="search" size={17} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Konuşma ara"
            placeholderTextColor={colors.faint}
            selectionColor={brandTint(0.5)}
            cursorColor={colors.head}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchInput}
          />
          {query ? (
            <Pressable hitSlop={10} onPress={() => setQuery('')} accessibilityLabel="Aramayı temizle">
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      )}
      {loading ? (
        <ListSkeleton rows={7} avatar={44} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(d) => d.id}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: space.lg, flexGrow: 1 }}
          ListEmptyComponent={
            query ? (
              <EmptyState icon="search" tone="muted" title="Eşleşen konuşma yok" text={`"${query.trim()}" adında bir konuşma bulunamadı.`} />
            ) : (
              <EmptyState
                icon="chatbubbles"
                title="Henüz bir konuşman yok"
                text="Bir kişiyle ya da küçük bir grupla ayrı yazış. Mesajları yalnızca konuşmadakiler görür; sunucu yöneticileri de okuyamaz."
                action={{ title: 'Yeni mesaj', onPress: () => router.push('/dm-new') }}
              />
            )
          }
        />
      )}
      <DmMenu dm={menuFor} onClose={() => setMenuFor(null)} />
    </View>
  );
}

/** Listenin üstündeki "Arkadaşlar" satırı: arkadaşlar ekranını açar; yanıt bekleyen gelen istek sayısıyla */
function FriendsRow({ onPress }: { onPress: () => void }) {
  const incoming = useIncomingFriendRequestCount();
  return (
    <View style={styles.friendsWrap}>
      <Pressable
        onPress={onPress}
        android_ripple={ripple.row}
        style={styles.friends}
        accessibilityRole="button"
        accessibilityLabel={incoming > 0 ? `Arkadaşlar, ${incoming} bekleyen istek` : 'Arkadaşlar'}
      >
        <Ionicons name="people" size={22} color={colors.muted} />
        <Text style={[styles.friendsText, incoming > 0 && { color: colors.head }]} numberOfLines={1}>
          Arkadaşlar
        </Text>
        <CountBadge count={incoming} />
      </Pressable>
    </View>
  );
}

/** Bu konuşmada (kendin dışında) yazan biri var mı */
function useSomeoneTyping(channelId: string, selfId: string | undefined): boolean {
  return useMessages((s) => {
    const typing = s.typing[channelId];
    if (!typing) return false;
    for (const userId in typing) if (userId !== selfId) return true;
    return false;
  });
}

const DmRow = memo(function DmRow({
  dm,
  onPress,
  onLongPress,
  selected,
}: {
  dm: DmChannel;
  onPress: (dm: DmChannel) => void;
  onLongPress: (dm: DmChannel) => void;
  /** Ana ekranda açık olan konuşma (vurgulanır) */
  selected: boolean;
}) {
  const selfId = useSession((s) => s.user?.id);
  const title = useGuild((s) => dmTitle(dm, s.users, selfId));
  const partnerName = useGuild((s) => (dm.group ? undefined : dmPartner(dm, s.users, selfId)?.username));
  // Bire bir konuşmada karşı tarafın özel durumu ve oynadığı oyun (ortak sunucunuz varsa görünür)
  const partnerId = useGuild((s) => (dm.group ? undefined : dmPartner(dm, s.users, selfId)?.id));
  const custom = useCustomStatus(partnerId);
  const activity = useActivity(partnerId);
  const unread = useGuild((s) => isUnread(s, dm.id));
  const count = useDmUnreadCount(dm.id);
  const typing = useSomeoneTyping(dm.id, selfId);
  // Konuşmada arama sürüyor: zamanın yerinde küçük yeşil telefon
  const calling = useDmCall(dm.id) !== undefined;
  return (
    <View style={styles.rowWrap}>
      {unread && <UnreadMarker left={0} />}
      <Pressable
        onPress={() => onPress(dm)}
        onLongPress={() => onLongPress(dm)}
        delayLongPress={300}
        android_ripple={ripple.row}
        style={[styles.row, selected && styles.rowSelected]}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${title}${calling ? ', arama sürüyor' : ''}${count ? `, ${count} okunmamış mesaj` : ''}`}
        accessibilityHint="Seçenekler için uzun bas"
      >
        <DmAvatar dm={dm} size={44} status decorated />
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, (unread || selected) && styles.nameUnread]} numberOfLines={1}>
            {title}
          </Text>
          {typing ? (
            <View style={styles.typingRow}>
              <TypingDots color={colors.brandText} size={4} />
              <Text style={[styles.sub, { color: colors.brandText }]}>yazıyor…</Text>
            </View>
          ) : dm.group ? (
            <Text style={styles.sub} numberOfLines={1}>
              {dm.participantIds.length} üye
            </Text>
          ) : (
            // Oynuyorsa oyun simgesi; özel durum, yoksa oynadığı oyun, o da yoksa kullanıcı adı (ses bilgisi yok)
            <PresenceSubline
              custom={custom}
              activity={activity}
              fallback={partnerName ? `@${partnerName}` : undefined}
              textStyle={styles.sub}
            />
          )}
        </View>
        <View style={styles.meta}>
          {calling ? (
            <Ionicons name="call" size={14} color={colors.okText} />
          ) : (
            <Text style={[styles.time, count > 0 && { color: colors.head }]}>{formatAgo(dm.lastActivityAt)}</Text>
          )}
          <CountBadge count={count} />
        </View>
      </Pressable>
    </View>
  );
});

/** Uzun basınca: okundu say; grupta ad değiştir, kişi ekle, ayrıl; bire bir konuşmada kapat */
function DmMenu({ dm: requested, onClose }: { dm: DmChannel | null; onClose: () => void }) {
  const router = useRouter();
  // Kapanış animasyonu sürerken içerik kaybolmasın
  const last = useRef(requested);
  if (requested) last.current = requested;
  const dm = requested ?? last.current;
  const selfId = useSession((s) => s.user?.id);
  const title = useGuild((s) => (dm ? dmTitle(dm, s.users, selfId) : ''));
  const unread = useGuild((s) => (dm ? isUnread(s, dm.id) : false));
  if (!dm) return null;
  const close = (): void => onClose();

  return (
    <BottomSheet visible={requested !== null} onClose={close}>
      <SheetHeader
        title={title}
        subtitle={dm.group ? `Grup · ${dm.participantIds.length} üye` : 'Direkt mesaj'}
        leading={<DmAvatar dm={dm} size={40} />}
      />
      <SheetGroup>
        {unread && (
          <SheetItem
            key="read"
            icon="checkmark-done"
            label="Okundu say"
            onPress={() => {
              ackChannel(dm.id);
              close();
            }}
          />
        )}
        {dm.group && (
          <SheetItem
            key="rename"
            icon="create-outline"
            label="Grubun adını değiştir"
            onPress={() => {
              close();
              router.push({ pathname: '/dm-rename', params: { id: dm.id } });
            }}
          />
        )}
        {dm.group && dm.participantIds.length < DM_GROUP_MAX_PARTICIPANTS && (
          <SheetItem
            key="add"
            icon="person-add-outline"
            label="Kişi ekle"
            onPress={() => {
              close();
              router.push({ pathname: '/dm-new', params: { addTo: dm.id } });
            }}
          />
        )}
        {!dm.group && (
          <SheetItem
            key="close"
            icon="close-circle-outline"
            label="Konuşmayı kapat"
            hint="Listeden kalkar; yeni mesaj gelince geri döner"
            onPress={() => {
              close();
              void closeDm(dm.id).then((ok) => ok && toast('Konuşma listeden kaldırıldı; yeni mesaj gelince döner.'));
            }}
          />
        )}
      </SheetGroup>
      {dm.group && (
        <SheetGroup>
          <SheetItem
            icon="exit-outline"
            danger
            label="Gruptan ayrıl"
            onPress={() => {
              close();
              void confirmDialog({
                title: `"${title}" grubundan ayrılınsın mı?`,
                message: 'Yeniden eklenmezsen bu grubun mesajlarını göremezsin.',
                icon: 'exit-outline',
                confirmLabel: 'Gruptan ayrıl',
                danger: true,
              }).then((ok) => {
                if (ok) void closeDm(dm.id);
              });
            }}
          />
        </SheetGroup>
      )}
    </BottomSheet>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.md,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.rail,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  friendsWrap: { paddingHorizontal: space.sm, paddingTop: space.sm },
  friends: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  friendsText: { flex: 1, color: colors.muted, fontSize: font.row + 0.5, fontWeight: '600' },
  rowWrap: { height: ROW_HEIGHT, paddingVertical: 1, paddingHorizontal: space.sm },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowSelected: { backgroundColor: colors.active },
  name: { color: colors.muted, fontSize: font.row + 0.5, fontWeight: '600' },
  nameUnread: { color: colors.head, fontWeight: '800' },
  sub: { color: colors.muted, fontSize: font.small - 0.5, marginTop: 1 },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  meta: { alignItems: 'flex-end', gap: 5, minWidth: 36 },
  time: { color: colors.faint, fontSize: font.caption - 0.5, fontWeight: '600' },
}));
