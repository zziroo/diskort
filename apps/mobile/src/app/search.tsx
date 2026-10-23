import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View, type ListRenderItem } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import type { SearchResult, SearchScope, SearchSnippet } from '@diskort/shared';
import {
  clearSearchResults,
  dmTitle,
  jumpToSearchResult,
  loadMoreSearch,
  replaceLastWord,
  runSearch,
  SEARCH_OPTIONS,
  searchScopeKey,
  searchSuggestions,
  useGuild,
  useChannelMemberColor,
  useSearch,
  useSession,
} from '@diskort/client-core';
import { Avatar } from '../components/Avatar';
import { HeaderButton } from '../components/HeaderButton';
import { messageStamp } from '../components/MessageRow';
import { ListSkeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/States';
import { showChat } from '../stores/nav';
import { brandTint, colors, createStyles, font, radius, ripple, space, text as textStyles, tint } from '../theme';

/**
 * Mesaj araması (Discord mobil gibi): üstte arama kutusu, altında işleç çipleri (Kimden, Kanal, İçerir,
 * Önce, Sonra, Tarih). Yazarken from:/in:/has: için öneriler; sonuçlar kanala göre gruplu, vurgulu. Sonuca
 * dokununca sohbete dönülür ve mesaja atlanır. Kapsam: `guildId` (sunucu) ya da `dmId` (konuşma).
 */
export default function SearchScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ guildId?: string; dmId?: string; channelId?: string }>();
  const scope = useMemo<SearchScope>(
    () =>
      params.dmId
        ? { dmId: params.dmId }
        : params.channelId
          ? { guildId: params.guildId ?? '', channelId: params.channelId }
          : { guildId: params.guildId ?? '' },
    [params.dmId, params.guildId, params.channelId],
  );
  const dm = 'dmId' in scope;
  // Tek kanalda aranıyorsa (kanal panelinden) "Kanal" işleci gösterilmez
  const inChannel = !dm && Boolean(scope.channelId);
  const key = searchScopeKey(scope);
  const current = useSearch((s) => (searchScopeKey(s.scope) === key ? s.query : ''));
  const status = useSearch((s) => (searchScopeKey(s.scope) === key ? s.status : 'idle'));
  const [text, setText] = useState(current);
  const input = useRef<TextInput>(null);
  const users = useGuild((s) => s.users);
  const channels = useGuild((s) => s.channels);
  const suggestions = useMemo(() => searchSuggestions(text, { users, channels }, dm), [text, users, channels, dm]);
  const selfId = useSession((s) => s.user?.id);
  const scopeName = useGuild((s) => {
    if ('dmId' in scope) {
      const conv = s.dms[scope.dmId];
      return conv ? dmTitle(conv, s.users, selfId) : '';
    }
    if (scope.channelId) {
      const channel = s.channels.find((c) => c.id === scope.channelId);
      if (channel) return `#${channel.name}`;
    }
    return s.guilds[scope.guildId]?.guild.name ?? '';
  });

  const submit = (): void => {
    if (text.trim()) void runSearch(scope, text);
    else clearSearchResults();
  };

  const addOperator = (op: string): void => {
    setText((t) => (t === '' || /\s$/.test(t) ? `${t}${op}` : `${t} ${op}`));
    input.current?.focus();
  };

  const open = useCallback((r: SearchResult) => {
    showChat(r.channel.id);
    void jumpToSearchResult(r);
  }, []);

  return (
    <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <HeaderButton icon="arrow-back" label="Geri" size={24} color={colors.text} onPress={() => router.back()} />
        <View style={styles.inputBox}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            autoFocus={status === 'idle'}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            placeholder={scopeName ? `${scopeName} içinde ara` : 'Ara'}
            placeholderTextColor={colors.muted}
            style={styles.input}
            accessibilityLabel="Mesajlarda ara"
          />
          {text ? (
            <Pressable
              hitSlop={10}
              accessibilityLabel="Aramayı temizle"
              onPress={() => {
                setText('');
                clearSearchResults();
                input.current?.focus();
              }}
            >
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.chips}
        >
          {SEARCH_OPTIONS.filter((o) => (!dm || o.dm) && !(inChannel && o.op === 'in:')).map((o) => (
            <Pressable
              key={o.op}
              onPress={() => addOperator(o.op)}
              android_ripple={ripple.strong}
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={`${o.label} süzgeci ekle`}
            >
              <Text style={styles.chipText}>{o.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {suggestions.length > 0 ? (
        <FlatList
          data={suggestions}
          keyExtractor={(s) => s.key}
          keyboardShouldPersistTaps="always"
          renderItem={({ item }) => (
            <Pressable
              style={styles.suggestion}
              android_ripple={ripple.row}
              onPress={() => {
                setText(replaceLastWord(text, item.insert));
                input.current?.focus();
              }}
            >
              {item.user ? <Avatar user={item.user} size={28} /> : <Feather name="hash" size={18} color={colors.muted} />}
              <Text style={styles.suggestionText} numberOfLines={1}>
                {item.label}
              </Text>
              {item.detail ? (
                <Text style={styles.suggestionDetail} numberOfLines={1}>
                  {item.detail}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      ) : status === 'idle' ? (
        <ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={{ paddingBottom: space.lg }}>
          <Text style={[textStyles.section, styles.sectionTitle]}>Arama seçenekleri</Text>
          {SEARCH_OPTIONS.filter((o) => (!dm || o.dm) && !(inChannel && o.op === 'in:')).map((o) => (
            <Pressable key={o.op} style={styles.option} android_ripple={ripple.row} onPress={() => addOperator(o.op)}>
              <Text style={styles.optionOp}>{o.op}</Text>
              <Text style={styles.optionHint} numberOfLines={1}>
                {o.hint}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Results onOpen={open} />
      )}
    </SafeAreaView>
  );
}

function Results({ onOpen }: { onOpen: (r: SearchResult) => void }) {
  const status = useSearch((s) => s.status);
  const results = useSearch((s) => s.results);
  const total = useSearch((s) => s.total);
  const capped = useSearch((s) => s.totalCapped);
  const more = useSearch((s) => s.nextCursor !== null);
  const loadingMore = useSearch((s) => s.loadingMore);
  const error = useSearch((s) => s.error);
  const query = useSearch((s) => s.query);

  const renderItem: ListRenderItem<SearchResult> = useCallback(
    ({ item, index }) => (
      <ResultRow result={item} showChannel={results[index - 1]?.channel.id !== item.channel.id} onOpen={onOpen} />
    ),
    [results, onOpen],
  );

  if (status === 'loading') return <ListSkeleton rows={6} avatar={36} />;
  if (status === 'error') return <ErrorState text={error ?? 'Arama yapılamadı.'} onRetry={() => void rerun()} />;
  if (results.length === 0) {
    return <EmptyState icon="search" tone="muted" title="Sonuç bulunamadı" text="Başka sözcükler dene ya da süzgeçleri kaldır." />;
  }
  return (
    <FlatList
      data={results}
      keyExtractor={(r) => r.message.id}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onEndReached={() => void loadMoreSearch()}
      onEndReachedThreshold={0.6}
      ListHeaderComponent={
        <Text style={[textStyles.section, styles.sectionTitle]} accessibilityLabel={`${query} için ${total} sonuç`}>
          {total}
          {capped ? '+' : ''} sonuç
        </Text>
      }
      ListFooterComponent={
        loadingMore ? (
          <ListSkeleton rows={2} avatar={36} />
        ) : !more && error ? (
          <Text style={styles.footerError}>{error}</Text>
        ) : null
      }
      contentContainerStyle={{ paddingBottom: space.lg }}
    />
  );
}

/** Hata sonrası aynı aramayı yeniden yapar */
function rerun(): Promise<void> {
  const s = useSearch.getState();
  return s.scope ? runSearch(s.scope, s.query) : Promise.resolve();
}

const ResultRow = memo(function ResultRow({
  result,
  showChannel,
  onOpen,
}: {
  result: SearchResult;
  showChannel: boolean;
  onOpen: (r: SearchResult) => void;
}) {
  const { message } = result;
  const member = useGuild((s) => (message.authorId ? s.users[message.authorId] : undefined));
  const fallback = useSearch((s) => (message.authorId ? s.users[message.authorId] : undefined));
  const user = member ?? fallback;
  const color = useChannelMemberColor(message.authorId, message.channelId);
  const selfId = useSession((s) => s.user?.id);
  const dmName = useGuild((s) => {
    const conv = s.dms[result.channel.id];
    return conv ? dmTitle(conv, s.users, selfId) : '';
  });
  const files = message.attachments.length;
  return (
    <View>
      {showChannel ? (
        <View style={styles.channelLabel}>
          {result.channel.guildId ? <Feather name="hash" size={14} color={colors.muted} /> : null}
          <Text style={styles.channelLabelText} numberOfLines={1}>
            {result.channel.guildId ? result.channel.name : dmName}
          </Text>
        </View>
      ) : null}
      <Pressable
        style={styles.card}
        android_ripple={ripple.row}
        onPress={() => onOpen(result)}
        accessibilityRole="button"
        accessibilityHint="Mesaja git"
      >
        <Avatar user={user} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.cardHead}>
            <Text style={[styles.author, color ? { color } : null, !user && styles.deleted]} numberOfLines={1}>
              {user?.displayName ?? 'Silinmiş Kullanıcı'}
            </Text>
            <Text style={styles.stamp}>{messageStamp(message.createdAt)}</Text>
          </View>
          {result.snippet.text ? <Highlighted snippet={result.snippet} /> : null}
          {files > 0 ? (
            <View style={styles.files}>
              <Ionicons name="attach" size={15} color={colors.muted} />
              <Text style={styles.filesText} numberOfLines={1}>
                {files === 1 ? message.attachments[0]!.name : `${files} dosya`}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
});

/** Özet: eşleşen sözcükler vurgulu */
function Highlighted({ snippet }: { snippet: SearchSnippet }) {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [a, b] of snippet.highlights) {
    if (a > at) parts.push({ text: snippet.text.slice(at, a), mark: false });
    parts.push({ text: snippet.text.slice(a, b), mark: true });
    at = b;
  }
  if (at < snippet.text.length) parts.push({ text: snippet.text.slice(at), mark: false });
  return (
    <Text style={styles.snippet} numberOfLines={4}>
      {parts.map((p, i) =>
        p.mark ? (
          <Text key={i} style={styles.mark}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  inputBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.input,
  },
  input: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  chips: { gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm },
  chip: {
    paddingHorizontal: space.md,
    height: 32,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.field,
    overflow: 'hidden',
  },
  chipText: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  sectionTitle: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  option: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  optionOp: { color: colors.head, fontSize: font.row, fontWeight: '700' },
  optionHint: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
  suggestionText: { color: colors.head, fontSize: font.row, fontWeight: '600', flexShrink: 1 },
  suggestionDetail: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  channelLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  channelLabelText: { color: colors.muted, fontSize: font.caption, fontWeight: '700', flexShrink: 1 },
  card: {
    flexDirection: 'row',
    gap: space.md,
    marginHorizontal: space.md,
    marginVertical: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.side,
    borderWidth: 1,
    borderColor: tint(0.06),
    overflow: 'hidden',
  },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  author: { color: colors.head, fontSize: font.body, fontWeight: '600', flexShrink: 1 },
  deleted: { color: colors.muted, fontStyle: 'italic' },
  stamp: { color: colors.faint, fontSize: font.caption },
  snippet: { color: colors.text, fontSize: font.body, lineHeight: 21, marginTop: 2 },
  mark: { color: colors.head, backgroundColor: brandTint(0.35), fontWeight: '600' },
  files: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  filesText: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  footerError: { color: colors.dangerText, textAlign: 'center', padding: space.md },
}));
