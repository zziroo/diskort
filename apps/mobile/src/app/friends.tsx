import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, SectionList, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { FriendEntry, User } from '@diskort/shared';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  loadFriends,
  openDirectMessage,
  removeFriend,
  sendFriendRequest,
  useActivity,
  useCustomStatus,
  useFriends,
  useGuild,
} from '@diskort/client-core';
import { PresenceSubline } from '../components/ActivityCard';
import { PresenceAvatar } from '../components/Avatar';
import { BottomSheet, SheetGroup, SheetHeader, SheetItem } from '../components/BottomSheet';
import { confirmDialog } from '../components/Dialog';
import { EmptyState } from '../components/States';
import { Button, Field, Segmented } from '../components/ui';
import { feedback } from '../haptics';
import { showChat } from '../stores/nav';
import { toast } from '../stores/ui';
import { colors, createStyles, font, radius, ripple, space } from '../theme';

type Tab = 'all' | 'pending' | 'add';

const isTab = (v: unknown): v is Tab => v === 'all' || v === 'pending' || v === 'add';

/** Listedeki kişinin güncel profili (tanınan hesaplardan; yoksa listedeki kopya) */
function useEntryUser(entry: FriendEntry): User {
  return useGuild((s) => s.users[entry.userId]) ?? entry.user;
}

/**
 * Arkadaşlar: "Tümü" (arkadaşlar; dokununca konuşma açılır, uzun basınca seçenekler), "Bekleyen" (gelen
 * istekleri kabul et / reddet, gönderdiklerini geri çek) ve "Ekle" (kullanıcı adıyla istek). Direkt mesaj
 * listesinin üstündeki "Arkadaşlar" satırından ve arkadaşlık isteği bildiriminden (Bekleyen) açılır.
 */
export default function FriendsScreen() {
  const params = useLocalSearchParams<{ tab?: string; t?: string }>();
  const [tab, setTab] = useState<Tab>(isTab(params.tab) ? params.tab : 'all');
  const { friends, incoming, outgoing } = useFriends();
  const [menuFor, setMenuFor] = useState<FriendEntry | null>(null);

  // Bildirimden yeniden gelinirse istenen sekmeye geç (`t`: her yönlendirmede değişen nonce; aynı sekme
  // istense de, kullanıcı başka sekmeye geçmiş olsa da etkili olur)
  useEffect(() => {
    if (isTab(params.tab)) setTab(params.tab);
  }, [params.tab, params.t]);

  // Liste READY ve FRIENDS_UPDATE ile güncel; açılışta yine de tazelenir (kaçan olay olmasın)
  useEffect(() => {
    void loadFriends();
  }, []);

  const pendingCount = incoming.length;
  const tabs = [
    { value: 'all' as const, label: 'Tümü' },
    { value: 'pending' as const, label: pendingCount > 0 ? `Bekleyen (${pendingCount})` : 'Bekleyen' },
    { value: 'add' as const, label: 'Ekle' },
  ];

  const openDm = useCallback(async (userId: string): Promise<void> => {
    const dm = await openDirectMessage(userId);
    if (dm) showChat(dm.id);
  }, []);
  const onRowPress = useCallback((id: string) => void openDm(id), [openDm]);
  const renderFriend = useCallback(
    ({ item }: { item: FriendEntry }) => <FriendRow entry={item} onPress={onRowPress} onMenu={setMenuFor} />,
    [onRowPress],
  );

  return (
    <SafeAreaView style={styles.page} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Arkadaşlar' }} />
      <View style={styles.tabs}>
        <Segmented options={tabs} value={tab} onChange={setTab} />
      </View>
      {tab === 'all' && (
        <FlatList
          data={friends}
          keyExtractor={(e) => e.userId}
          renderItem={renderFriend}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <EmptyState
              icon="people-outline"
              tone="muted"
              title="Henüz arkadaşın yok"
              text="Kullanıcı adıyla arkadaş ekle. Arkadaşınla ortak sunucunuz olmasa da yazışabilirsin."
              action={{ title: 'Arkadaş ekle', onPress: () => setTab('add') }}
            />
          }
        />
      )}
      {tab === 'pending' && <PendingList incoming={incoming} outgoing={outgoing} />}
      {tab === 'add' && <AddFriend />}
      <FriendMenu entry={menuFor} onClose={() => setMenuFor(null)} onMessage={onRowPress} />
    </SafeAreaView>
  );
}

/** Arkadaş satırı: durum noktalı avatar, ad, özel durum / oyun / kullanıcı adı; sağda seçenekler */
const FriendRow = memo(function FriendRow({
  entry,
  onPress,
  onMenu,
}: {
  entry: FriendEntry;
  onPress: (userId: string) => void;
  onMenu: (entry: FriendEntry) => void;
}) {
  const user = useEntryUser(entry);
  const custom = useCustomStatus(entry.userId);
  const activity = useActivity(entry.userId);
  return (
    <View style={styles.rowWrap}>
      <Pressable
        onPress={() => onPress(entry.userId)}
        onLongPress={() => onMenu(entry)}
        delayLongPress={300}
        android_ripple={ripple.row}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={user.displayName}
        accessibilityHint="Mesaj göndermek için dokun, seçenekler için uzun bas"
      >
        <PresenceAvatar userId={entry.userId} user={user} size={40} surface={colors.main} />
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <PresenceSubline custom={custom} activity={activity} fallback={`@${user.username}`} textStyle={styles.sub} />
        </View>
        <Pressable
          hitSlop={8}
          onPress={() => onMenu(entry)}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={`${user.displayName} için seçenekler`}
        >
          <Ionicons name="ellipsis-vertical" size={18} color={colors.muted} />
        </Pressable>
      </Pressable>
    </View>
  );
});

/** Arkadaşa uzun basınca: mesaj gönder, arkadaşlıktan çıkar (onaylı) */
function FriendMenu({
  entry: requested,
  onClose,
  onMessage,
}: {
  entry: FriendEntry | null;
  onClose: () => void;
  onMessage: (userId: string) => void;
}) {
  // Kapanış animasyonu sürerken içerik kaybolmasın
  const last = useRef(requested);
  if (requested) last.current = requested;
  const entry = requested ?? last.current;
  const user = useGuild((s) => (entry ? s.users[entry.userId] : undefined)) ?? entry?.user;
  if (!entry || !user) return null;
  const name = user.displayName;

  const remove = async (): Promise<void> => {
    onClose();
    const ok = await confirmDialog({
      title: `${name} arkadaşlıktan çıkarılsın mı?`,
      message:
        'Ortak sunucunuz yoksa bire bir konuşmanız salt okunur olur (geçmiş kalır). Gruplar etkilenmez; ona bildirim gitmez.',
      icon: 'person-remove-outline',
      confirmLabel: 'Arkadaşlıktan çıkar',
      danger: true,
    });
    if (ok && (await removeFriend(entry.userId))) toast(`${name} arkadaşlıktan çıkarıldı.`);
  };

  return (
    <BottomSheet visible={requested !== null} onClose={onClose}>
      <SheetHeader title={name} subtitle={`@${user.username}`} leading={<PresenceAvatar userId={entry.userId} user={user} size={40} />} />
      <SheetGroup>
        <SheetItem
          icon="chatbubble-outline"
          label="Mesaj gönder"
          onPress={() => {
            onClose();
            onMessage(entry.userId);
          }}
        />
      </SheetGroup>
      <SheetGroup>
        <SheetItem icon="person-remove-outline" danger label="Arkadaşlıktan çıkar" onPress={() => void remove()} />
      </SheetGroup>
    </BottomSheet>
  );
}

type PendingSection = { key: 'in' | 'out'; title: string; data: FriendEntry[] };

/** Bekleyen istekler: gelenler (kabul et / reddet) ve gönderdiklerin (geri çek) */
function PendingList({ incoming, outgoing }: { incoming: FriendEntry[]; outgoing: FriendEntry[] }) {
  // Yanıtı beklenen satırlar: düğmeler art arda basılamasın
  const [busy, setBusy] = useState<Record<string, true>>({});
  const run = useCallback(async (userId: string, action: () => Promise<boolean>, ok?: string): Promise<void> => {
    setBusy((b) => ({ ...b, [userId]: true }));
    try {
      if (await action()) {
        if (ok) {
          feedback('tick');
          toast(ok);
        }
      }
    } finally {
      setBusy(({ [userId]: _, ...rest }) => rest);
    }
  }, []);

  const sections: PendingSection[] = [];
  if (incoming.length > 0) sections.push({ key: 'in', title: `Gelen istekler — ${incoming.length}`, data: incoming });
  if (outgoing.length > 0) sections.push({ key: 'out', title: `Gönderdiğin istekler — ${outgoing.length}`, data: outgoing });

  return (
    <SectionList
      sections={sections}
      keyExtractor={(e) => e.userId}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={styles.list}
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
      renderItem={({ item, section }) => (
        <PendingRow
          entry={item}
          incoming={section.key === 'in'}
          busy={Boolean(busy[item.userId])}
          onAccept={(id, name) => void run(id, () => acceptFriendRequest(id), `${name} ile artık arkadaşsınız.`)}
          onDecline={(id) => void run(id, () => declineFriendRequest(id))}
          onCancel={(id) => void run(id, () => cancelFriendRequest(id), 'İstek geri çekildi.')}
        />
      )}
      ListEmptyComponent={
        <EmptyState
          icon="mail-open-outline"
          tone="muted"
          title="Bekleyen istek yok"
          text="Sana gelen arkadaşlık istekleri ve gönderdiğin, henüz yanıtlanmamış istekler burada görünür."
        />
      }
    />
  );
}

function PendingRow({
  entry,
  incoming,
  busy,
  onAccept,
  onDecline,
  onCancel,
}: {
  entry: FriendEntry;
  incoming: boolean;
  busy: boolean;
  onAccept: (userId: string, name: string) => void;
  onDecline: (userId: string) => void;
  onCancel: (userId: string) => void;
}) {
  const user = useEntryUser(entry);
  return (
    <View style={styles.rowWrap}>
      <View style={styles.row}>
        <PresenceAvatar userId={entry.userId} user={user} size={40} surface={colors.main} />
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {incoming ? `@${user.username} · sana istek gönderdi` : `@${user.username} · yanıt bekleniyor`}
          </Text>
        </View>
        {incoming ? (
          <>
            <RoundButton
              icon="checkmark"
              tone="ok"
              label={`${user.displayName} isteğini kabul et`}
              disabled={busy}
              onPress={() => onAccept(entry.userId, user.displayName)}
            />
            <RoundButton
              icon="close"
              tone="danger"
              label={`${user.displayName} isteğini reddet`}
              disabled={busy}
              onPress={() => onDecline(entry.userId)}
            />
          </>
        ) : (
          <RoundButton
            icon="close"
            tone="muted"
            label={`${user.displayName} isteğini geri çek`}
            disabled={busy}
            onPress={() => onCancel(entry.userId)}
          />
        )}
      </View>
    </View>
  );
}

function RoundButton({
  icon,
  tone,
  label,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone: 'ok' | 'danger' | 'muted';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const color = tone === 'ok' ? colors.okText : tone === 'danger' ? colors.dangerText : colors.muted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      android_ripple={{ color: 'rgba(128,128,128,0.25)', borderless: true }}
      style={[styles.round, disabled && { opacity: 0.4 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Ionicons name={icon} size={20} color={color} />
    </Pressable>
  );
}

/** Kullanıcı adıyla arkadaşlık isteği; sonuç ya da hata formun altında */
function AddFriend() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (): Promise<void> => {
    const name = username.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await sendFriendRequest(name);
      if ('error' in res) {
        feedback('error');
        setResult({ ok: false, text: res.error });
        return;
      }
      feedback('tick');
      setResult({ ok: true, text: res.status === 'friends' ? 'Artık arkadaşsınız' : 'İstek gönderildi' });
      setUsername('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.add} keyboardShouldPersistTaps="handled">
      <Text style={styles.addHint}>
        Arkadaş eklemek için kullanıcı adını yaz. Kabul ederse ortak sunucunuz olmasa da yazışabilirsiniz.
      </Text>
      <Field
        label="Kullanıcı adı"
        value={username}
        onChangeText={(v) => {
          setUsername(v);
          if (result) setResult(null);
        }}
        placeholder="ör. ayse.yilmaz"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="send"
        onSubmitEditing={() => void submit()}
        error={result && !result.ok ? result.text : null}
      />
      {result?.ok && (
        <View style={styles.success}>
          <Ionicons name="checkmark-circle" size={18} color={colors.okText} />
          <Text style={styles.successText}>{result.text}</Text>
        </View>
      )}
      <View style={styles.addButton}>
        <Button title="Arkadaşlık isteği gönder" disabled={!username.trim()} busy={busy} onPress={() => void submit()} />
      </View>
    </ScrollView>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  tabs: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm },
  list: { paddingBottom: space.lg, flexGrow: 1 },
  section: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  rowWrap: { paddingHorizontal: space.sm, paddingVertical: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 58,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowText: { flex: 1 },
  name: { color: colors.head, fontSize: font.row, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: font.small - 0.5, marginTop: 1 },
  iconButton: { padding: 6 },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.rail,
  },
  add: { padding: space.lg },
  addHint: { color: colors.muted, fontSize: font.small, lineHeight: 20, marginBottom: space.md },
  success: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm },
  successText: { color: colors.okText, fontSize: font.small, fontWeight: '600' },
  addButton: { marginTop: space.lg },
}));
