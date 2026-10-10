import { memo, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { guildVoiceStateOf, memberColorOf, useActiveGuildContext, useGuild, useOnMobile, useSession, useStatus, type MemberUser } from '@diskort/client-core';
import { colors, createStyles, font, radius, ripple, space } from '../../theme';
import { Avatar } from '../Avatar';
import { MemberSheet } from '../MemberSheet';
import { Card } from '../ui';
import { Intro, RoleDot } from './common';

/** Üyeler: arama, roller; dokununca üye menüsü (roller, sesli sohbet, atma, yasaklama — yetkiye göre) */
export function MembersSection() {
  const users = useGuild((s) => s.users);
  const online = useGuild((s) => s.online);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const context = useActiveGuildContext();

  const all = useMemo(() => Object.values(users).filter((u) => !u.removed), [users]);
  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    return all
      .filter((u) => !q || u.username.includes(q) || u.displayName.toLocaleLowerCase('tr').includes(q))
      .sort(
        (a, b) =>
          Number(Boolean(online[b.id])) - Number(Boolean(online[a.id])) || a.displayName.localeCompare(b.displayName, 'tr'),
      );
  }, [all, online, query]);
  const onlineCount = all.filter((u) => online[u.id]).length;

  return (
    <View>
      <Intro>
        {all.length} üye · {onlineCount} çevrimiçi. Bir üyeye dokunarak rollerini, sesli sohbetini ve üyeliğini
        yönetebilirsin. Yalnızca en üst rolü seninkinden aşağıda olanları yönetebilirsin.
      </Intro>
      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Üye ara"
          placeholderTextColor={colors.faint}
          selectionColor={colors.brand}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Aramayı temizle">
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <Card>
        {list.length === 0 && <Text style={styles.empty}>Eşleşen üye yok.</Text>}
        {list.map((u, i) => (
          <MemberRow key={u.id} user={u} first={i === 0} onPress={setSelected} />
        ))}
      </Card>
      <MemberSheet userId={selected} context={context} onClose={() => setSelected(null)} />
    </View>
  );
}

const MemberRow = memo(function MemberRow({
  user,
  first,
  onPress,
}: {
  user: MemberUser;
  first: boolean;
  onPress: (userId: string) => void;
}) {
  const selfId = useSession((s) => s.user?.id);
  const color = useGuild((s) => memberColorOf(s, user.id));
  const roles = useGuild((s) => s.roles);
  const ownerId = useGuild((s) => s.guild?.ownerId);
  const status = useStatus(user.id);
  const mobile = useOnMobile(user.id);
  const voiceChannel = useGuild((s) => {
    const state = guildVoiceStateOf(s, user.id);
    return state ? s.channels.find((c) => c.id === state.channelId)?.name : undefined;
  });
  const held = user.roles
    .map((id) => roles[id])
    .filter((r) => r !== undefined)
    .sort((a, b) => b.position - a.position);

  return (
    <View>
      {!first && <View style={styles.divider} />}
      <Pressable
        onPress={() => onPress(user.id)}
        android_ripple={ripple.row}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={`${user.displayName}, üyeyi yönet`}
      >
        <Avatar user={user} size={40} status={status} mobile={mobile} surface={colors.side} />
        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, color ? { color } : null]} numberOfLines={1}>
              {user.displayName}
            </Text>
            {user.id === ownerId && (
              <MaterialCommunityIcons name="crown-outline" size={14} color={colors.warn} accessibilityLabel="Sunucunun sahibi" />
            )}
            {user.id === selfId && <Text style={styles.you}>(sen)</Text>}
          </View>
          <Text style={styles.sub} numberOfLines={1}>
            @{user.username}
            {voiceChannel ? ` · 🔊 ${voiceChannel}` : ''}
          </Text>
          {held.length > 0 && (
            <View style={styles.roles}>
              {held.map((r) => (
                <View key={r.id} style={styles.role}>
                  <RoleDot color={r.color} size={8} />
                  <Text style={styles.roleText} numberOfLines={1}>
                    {r.name}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
        <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
});

const styles = createStyles(() => ({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.input,
    marginBottom: space.md,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  empty: { color: colors.muted, fontSize: font.small, padding: space.lg },
  divider: { height: 0.5, backgroundColor: colors.line, marginLeft: 68 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm + 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.head, fontSize: font.row, fontWeight: '600', flexShrink: 1 },
  you: { color: colors.muted, fontSize: font.caption },
  sub: { color: colors.muted, fontSize: font.caption + 0.5, marginTop: 1 },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 },
  role: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.main,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 160,
  },
  roleText: { color: colors.text, fontSize: 11.5, fontWeight: '600', flexShrink: 1 },
}));
