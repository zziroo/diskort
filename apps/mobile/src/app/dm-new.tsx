import { memo, useCallback, useMemo, useState } from 'react';
import { Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DM_GROUP_MAX_PARTICIPANTS, DM_NAME_MAX_LENGTH, type User } from '@diskort/shared';
import { addDmParticipant, createDm, dmTitle, useGuild, useSession } from '@diskort/client-core';
import { Avatar, PresenceAvatar } from '../components/Avatar';
import { EmptyState } from '../components/States';
import { Button } from '../components/ui';
import { animateNextLayout, useBump } from '../motion';
import { showChat } from '../stores/nav';
import { brandTint, colors, createStyles, font, radius, ripple, space } from '../theme';

const NOBODY: string[] = [];

/**
 * Kişi seçerek direkt mesaj başlatmak: tek kişi bire bir konuşma, birden çok kişi grup (isteğe bağlı
 * adıyla). `addTo` verilirse seçilenler o gruba eklenir.
 */
export default function NewDmScreen() {
  const { addTo } = useLocalSearchParams<{ addTo?: string }>();
  const router = useRouter();
  const selfId = useSession((s) => s.user?.id);
  const users = useGuild((s) => s.users);
  // DM yalnızca ortak sunucusu olanlarla ve arkadaşlarla
  const reachable = useGuild((s) => s.reachable);
  const online = useGuild((s) => s.online);
  const group = useGuild((s) => (addTo ? s.dms[addTo] : undefined));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const existing = group?.participantIds ?? NOBODY;
  // Seçilebilecek en fazla kişi: grubun boş yeri ya da (yeni konuşmada) kendin hariç sınır
  const capacity = group ? DM_GROUP_MAX_PARTICIPANTS - existing.length : DM_GROUP_MAX_PARTICIPANTS - 1;
  const candidates = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    return Object.values(users)
      .filter((u) => reachable[u.id] && u.id !== selfId && !existing.includes(u.id))
      .filter((u) => !q || u.username.includes(q) || u.displayName.toLocaleLowerCase('tr').includes(q))
      .sort(
        (a, b) =>
          Number(Boolean(online[b.id])) - Number(Boolean(online[a.id])) ||
          a.displayName.localeCompare(b.displayName, 'tr'),
      );
  }, [users, reachable, online, selfId, existing, query]);

  const toggle = useCallback(
    (id: string): void => {
      // Seçilenler şeridi açılıp kapanırken ve kişi eklenip çıkarken yumuşak kayma
      animateNextLayout(180);
      setSelected((current) =>
        current.includes(id) ? current.filter((x) => x !== id) : current.length < capacity ? [...current, id] : current,
      );
    },
    [capacity],
  );

  const makesGroup = !group && selected.length > 1;

  const submit = async (): Promise<void> => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      if (group) {
        for (const id of selected) if (!(await addDmParticipant(group.id, id))) return;
        router.back();
        return;
      }
      const dm = await createDm(selected, makesGroup ? name.trim() || null : null);
      // Konuşma ana ekranın sohbeti olur, seçim ekranı kapanır
      if (dm) showChat(dm.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.page} edges={['bottom']}>
      <Stack.Screen options={{ title: group ? 'Kişi ekle' : 'Yeni mesaj' }} />
      <Text style={styles.hint}>
        {group
          ? `${dmTitle(group, users, selfId)} grubuna eklenecek kişileri seç. Eklenenler geçmiş mesajları da görür.`
          : `Bir kişi seçersen bire bir konuşma, birden çok kişi seçersen grup başlar (en fazla ${DM_GROUP_MAX_PARTICIPANTS} kişi).`}
      </Text>
      {selected.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0 }}
          contentContainerStyle={styles.chips}
        >
          {selected.map((id) => (
            <Pressable
              key={id}
              onPress={() => toggle(id)}
              style={styles.chip}
              accessibilityLabel={`${users[id]?.displayName ?? 'Kişi'} seçimini kaldır`}
            >
              <Avatar user={users[id]} size={22} />
              <Text style={styles.chipText} numberOfLines={1}>
                {users[id]?.displayName ?? '…'}
              </Text>
              <Ionicons name="close" size={14} color={colors.muted} />
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Kullanıcı ara"
          placeholderTextColor={colors.faint}
          selectionColor={brandTint(0.5)}
          cursorColor={colors.head}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable hitSlop={10} onPress={() => setQuery('')} accessibilityLabel="Aramayı temizle">
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <FlatList
        data={candidates}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: space.sm, flexGrow: 1 }}
        extraData={selected}
        ListEmptyComponent={
          <EmptyState
            icon={query ? 'search' : 'people-outline'}
            tone="muted"
            title={query ? 'Eşleşen kimse yok' : 'Eklenebilecek kimse yok'}
            text={query ? 'Adı ya da kullanıcı adını denetleyip yeniden ara.' : undefined}
          />
        }
        renderItem={({ item }) => {
          const on = selected.includes(item.id);
          return (
            <CandidateRow
              user={item}
              on={on}
              disabled={!on && selected.length >= capacity}
              onToggle={toggle}
            />
          );
        }}
      />
      <View style={styles.footer}>
        {makesGroup && (
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={DM_NAME_MAX_LENGTH}
            placeholder="Grup adı (isteğe bağlı)"
            placeholderTextColor={colors.faint}
            selectionColor={brandTint(0.5)}
            cursorColor={colors.head}
            style={styles.nameInput}
          />
        )}
        <Button
          title={
            group
              ? `Ekle${selected.length ? ` (${selected.length})` : ''}`
              : makesGroup
                ? `Grup oluştur (${selected.length + 1} kişi)`
                : 'Mesaj gönder'
          }
          disabled={selected.length === 0}
          busy={busy}
          onPress={() => void submit()}
        />
      </View>
    </SafeAreaView>
  );
}

/** Seçilebilecek kişi: dokununca onay kutusu zıplayarak işaretlenir */
const CandidateRow = memo(function CandidateRow({
  user,
  on,
  disabled,
  onToggle,
}: {
  user: User;
  on: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const bump = useBump(on);
  return (
    <View style={styles.rowWrap}>
      <Pressable
        onPress={() => onToggle(user.id)}
        disabled={disabled}
        android_ripple={ripple.row}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on, disabled }}
        accessibilityLabel={user.displayName}
        style={[styles.row, on && { backgroundColor: colors.hover }, disabled && { opacity: 0.4 }]}
      >
        <PresenceAvatar userId={user.id} user={user} size={38} surface={on ? colors.hover : colors.main} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            @{user.username}
          </Text>
        </View>
        <Animated.View style={[styles.check, on && styles.checkOn, { transform: [{ scale: bump }] }]}>
          {on && <Ionicons name="checkmark" size={16} color="#fff" />}
        </Animated.View>
      </Pressable>
    </View>
  );
});

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  hint: { color: colors.muted, fontSize: font.small, paddingHorizontal: space.lg, paddingTop: 14, lineHeight: 20 },
  chips: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    paddingLeft: 4,
    paddingRight: 10,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.brandSoft,
  },
  chipText: { color: colors.head, fontSize: font.small, fontWeight: '600', flexShrink: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    margin: space.md,
    paddingHorizontal: space.md,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.rail,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.row, paddingVertical: 0 },
  rowWrap: { paddingHorizontal: space.sm, paddingVertical: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  name: { color: colors.text, fontSize: font.row, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: font.caption + 0.5 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  footer: {
    gap: 10,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.side,
  },
  nameInput: {
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.input,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 16,
  },
}));
