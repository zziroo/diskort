import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Feather, Ionicons } from '@expo/vector-icons';
import {
  DM_GROUP_MAX_PARTICIPANTS,
  isCallMessage,
  isImageAttachment,
  Permission,
  STATUS_LABELS,
  type DmChannel,
  type User,
} from '@diskort/shared';
import {
  ackChannel,
  clearJump,
  deleteMessage,
  channelById,
  dmBlockedReason,
  dmPartner,
  dmTitle,
  loadInitial,
  loadOlder,
  openDirectMessage,
  QUICK_REACTIONS,
  startReply,
  suppressEmbeds,
  toggleReaction,
  unblockUser,
  useCan,
  useChannelContext,
  useCustomStatus,
  useGuild,
  useMessages,
  useOnlineViewerCount,
  usePins,
  useSession,
  useStatus,
  visibleLinkEmbeds,
  type LocalMessage,
} from '@diskort/client-core';
import { CountBadge } from './Badge';
import { BottomSheet, SheetGroup, SheetItem } from './BottomSheet';
import { confirmDialog } from './Dialog';
import { openReactionsSheet, ReactionsSheet } from './ReactionsSheet';
import { confirmPin, confirmUnpin, openPinsSheet, PinsSheet } from './PinsSheet';
import { pinIcon, unpinIcon } from './icons';
import { Composer } from './Composer';
import { ConnectionBanner } from './ConnectionBanner';
import { DmAvatar } from './DmAvatar';
import { CallRecordRow, DmCallButton, DmCallStrip } from './DmCall';
import { EmojiGrid } from './EmojiGrid';
import { HeaderButton } from './HeaderButton';
import type { MarkdownContext } from './Markdown';
import { MemberSheet } from './MemberSheet';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { MessageRow, sameDay } from './MessageRow';
import { PressableScale } from './PressableScale';
import { MessageSkeleton } from './Skeleton';
import { ErrorState } from './States';
import { TypingDots } from './TypingDots';
import { VoiceBar } from './VoiceBar';
import { canSaveToGallery, saveToGallery } from '../attachments';
import { useKeyboardInset } from '../keyboard';
import { animateNextLayout, useSpringTo, useTimingTo } from '../motion';
import { showChat, useNav } from '../stores/nav';
import { toast, useUi } from '../stores/ui';
import { colors, createStyles, font, radius, space, tint } from '../theme';
import { useVoice } from '../voice/voice';

const GROUP_WINDOW_MS = 7 * 60_000;
const EMPTY: LocalMessage[] = [];
// Seçiciler her çağrıda aynı boş diziyi döndürmeli: yeni dizi (?? []) zustand 5'te sonsuz yeniden çizime,
// yani ekranın açılamamasına yol açar.
const NO_REACTIONS: NonNullable<LocalMessage['reactions']> = [];
const keyOf = (m: LocalMessage): string => m.nonce ?? m.id;
/** Alttan bu kadar yukarıdaysa "en altta" sayılmaz (aşağı atla düğmesi görünür) */
const BOTTOM_THRESHOLD = 60;
/** Yazıyor şeridinin yüksekliği: listenin altında bu kadar boşluk bırakılır, son mesaj örtülmez */
const TYPING_HEIGHT = 22;
/** Sohbet başlığının yüksekliği (durum çubuğu payı hariç) */
const HEADER_HEIGHT = 56;

/** Listede bir satır: mesaj ve üstündeki ayraçlar/gruplama (ters sırada; en yeni en başta) */
interface Row {
  message: LocalMessage;
  compact: boolean;
  dayBreak: boolean;
  newDivider: boolean;
}

/**
 * Ana ekrandaki sohbet: metin kanalı ya da direkt mesaj konuşması (kimlik bir konuşmanınsa). Üstünde
 * kendi başlığı vardır (soldaki düğme kanal/sunucu panelini açar).
 */
export function ChannelChat({ id, onOpenPanel }: { id: string; onOpenPanel: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const channel = useGuild((s) => channelById(s, id));
  const self = useSession((s) => s.user);
  const dm = useGuild((s) => (id ? s.dms[id] : undefined));
  const dmName = useGuild((s) => (dm ? dmTitle(dm, s.users, self?.id) : ''));
  const partner = useGuild((s) => (dm ? dmPartner(dm, s.users, self?.id) : undefined));
  // Bire bir konuşmada karşı taraf ayrıldıysa ya da engel varsa yazma kutusu yerine neden gösterilir (karşı
  // tarafı sen engellediysen açıkça, seni engellediyse yalnızca genel metin: bkz. dmBlockedReason)
  const blocked = useGuild((s) => (dm ? dmBlockedReason(dm, s.users, self?.id, s.reachable, s.blockedIds) : null));
  // Karşı tarafı sen engelledin: kilitli yazma kutusunda "Engeli kaldır"
  const blockedByMe = useGuild((s) => Boolean(partner && s.blockedIds[partner.id]));
  const target = useMemo(
    () => channel ?? (dm ? { id: dm.id, name: dmName } : undefined),
    [channel, dm, dmName],
  );
  // Kanal "#ad", bire bir konuşma "@ad", grup adıyla geçer
  const label = channel ? `#${channel.name}` : dm && !dm.group ? `@${dmName}` : dmName;
  const users = useGuild((s) => s.users);
  const messages = useMessages((s) => (id ? s.channels[id]?.messages : undefined) ?? EMPTY);
  const loaded = useMessages((s) => (id ? s.channels[id]?.loaded : false) ?? false);
  const hasMore = useMessages((s) => (id ? s.channels[id]?.hasMore : true) ?? true);
  const loading = useMessages((s) => (id ? s.channels[id]?.loading : false) ?? false);
  const lastId = useGuild((s) => (id ? s.lastMessageIds[id] : undefined));
  const readId = useGuild((s) => (id ? s.readStates[id] : undefined));
  // Başkasının mesajını silmek ve yeni tepki eklemek kanaldaki yetkiye bağlı
  const canManageMessages = useCan(Permission.MANAGE_MESSAGES, id);
  const canReact = useCan(Permission.ADD_REACTIONS, id);
  const canSend = useCan(Permission.SEND_MESSAGES, id);
  // Metin kanalında PIN_MESSAGES yetkisi olan, direkt mesajda her katılımcı sabitler
  const canPin = useCan(Permission.PIN_MESSAGES, id);
  const jump = useMessages((s) => s.jump);
  // Alıntıdan atlanan mesaj: kısa süre vurgulanır
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [menuFor, setMenuFor] = useState<LocalMessage | null>(null);
  // Sohbette avatara dokununca açılan üye kartı
  const [profileOf, setProfileOf] = useState<string | null>(null);
  // Kartın bağlamı: DM'de sunucu yok (rol, rol rengi, yönetim gösterilmez); kanalda o sunucu
  const profileContext = useChannelContext(id);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  // Geçmiş yüklenemedi (bağlantı yok): iskelet yerine hata ve "Tekrar dene"
  const [failed, setFailed] = useState(false);
  const list = useRef<FlatList<Row>>(null);
  const keyboard = useKeyboardInset();
  const inVoice = useVoice((s) => s.status !== 'idle');

  const load = useCallback(() => {
    if (!id) return;
    setFailed(false);
    void loadInitial(id).then(() => setFailed(!useMessages.getState().channels[id]?.loaded));
  }, [id]);
  useEffect(load, [load]);

  // Bu kanal ekrandayken bahsetmeler bildirim yerine doğrudan okunur
  useFocusEffect(
    useCallback(() => {
      useUi.setState({ viewingChannelId: id ?? null });
      return () => useUi.setState({ viewingChannelId: null });
    }, [id]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);

  // Sol panel açıkken sohbet yalnızca kenardan görünür: okundu sayılmaz
  const panelOpen = useNav((s) => s.panelOpen);
  const watching = active && atBottom && !panelOpen;

  // Ekran açık, uygulama önde ve en alttayken okundu say
  useEffect(() => {
    if (id && loaded && watching && lastId && Number(lastId) > Number(readId ?? 0)) ackChannel(id);
  }, [id, loaded, watching, lastId, readId]);

  // Kanal açıldığında okunmamış ilk mesajın üstüne "YENİ" ayracı konur (masaüstündeki gibi);
  // bakmıyorken (aşağıda değilken ya da uygulama arkadayken) gelen ilk mesaj için de.
  // Okunma bilgisi sunucudan (READY) gelmeden karar verilmez: yoksa bildirimle soğuk açılışta
  // bütün geçmiş "yeni" sayılırdı
  const guildReady = useGuild((s) => s.status === 'ready');
  const readAtOpen = useRef(readId);
  const dividerDecided = useRef(false);
  if (!dividerDecided.current && readAtOpen.current === undefined) readAtOpen.current = readId;
  const [dividerId, setDividerId] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded || !self || !guildReady) return;
    if (!dividerDecided.current) {
      dividerDecided.current = true;
      const first = messages.find(
        (m) => !m.status && m.authorId !== self.id && Number(m.id) > Number(readAtOpen.current ?? 0),
      );
      setDividerId(first?.id ?? null);
      return;
    }
    if (!watching && dividerId === null && lastId && Number(lastId) > Number(readId ?? 0)) {
      const first = messages.find((m) => !m.status && m.authorId !== self.id && Number(m.id) > Number(readId ?? 0));
      if (first) setDividerId(first.id);
    }
  }, [loaded, messages, watching, dividerId, lastId, readId, self, guildReady]);

  // Markdown yalnızca mesaj içindeki @bahsetmeleri çözerken kullanıcıya bakar (ad, kimlik); bir üyenin
  // rolü/çevrimiçiliği/avatarı gibi bahsetmeyle ilgisiz alanları değişince `users` yine de baştan kurulur
  // (bkz. client-core/guild usersOf). Burada yalnızca gerçekten ilgili alanlar (kullanıcı adı, görünen ad,
  // kimlik) anahtara girer: onlar değişmediyse `md` aynı nesne kalır, satırlar (memo'lu) yeniden çizilmez.
  const usersByNameKey = useMemo(
    () => Object.values(users).map((u) => `${u.username}:${u.id}:${u.displayName}`).join('|'),
    [users],
  );
  // Rol etiketleri yalnızca sunucu kanalında (direkt mesajda rol yoktur); kendi rollerimiz anahtar olarak
  const roles = useGuild((s) => s.roles);
  const selfRolesKey = useGuild((s) => (self && !dm ? (s.users[self.id]?.roles.join(',') ?? '') : ''));
  const md: MarkdownContext = useMemo(
    () => ({
      usersByName: Object.fromEntries(Object.values(users).map((u) => [u.username, u])),
      selfId: self?.id,
      roles: dm ? undefined : roles,
      selfRoleIds: dm || !selfRolesKey ? undefined : selfRolesKey.split(','),
    }),
    // usersByNameKey değişmediği sürece `users`'ın içeriği bahsetmeler için aynıdır (yalnızca ilgisiz
    // alanlar değişmiştir); en güncel `users` yine de kapanışta okunur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usersByNameKey, self?.id, roles, selfRolesKey, Boolean(dm)],
  );

  // Ters liste: en yeni mesaj en altta (indeks 0). Gruplama ve ayraçlar burada bir kez hesaplanır;
  // satır bileşenine yalnızca ilkel değerler gider (memo'lu satırlar gereksiz yere çizilmez).
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]!;
      const older = messages[i - 1];
      const dayBreak = !older || !sameDay(older.createdAt, item.createdAt);
      const newDivider = dividerId !== null && item.id === dividerId;
      // Yanıt her zaman başlıklı gösterilir (üstünde alıntısı olur); "YENİ" ayracından sonra da
      const compact =
        !!older &&
        !dayBreak &&
        !newDivider &&
        !item.replyToId &&
        !isCallMessage(older) &&
        older.authorId === item.authorId &&
        older.status !== 'failed' &&
        item.createdAt - older.createdAt < GROUP_WINDOW_MS;
      out.push({ message: item, compact, dayBreak, newDivider });
    }
    return out;
  }, [messages, dividerId]);

  const dividerIndex = useMemo(() => (dividerId ? rows.findIndex((r) => r.message.id === dividerId) : -1), [rows, dividerId]);
  // Ayraç ekranda göründü mü (göründüyse üstteki "yeni mesajlar" şeridi kapanır)
  const [dividerSeen, setDividerSeen] = useState(false);
  const dividerRef = useRef(dividerIndex);
  dividerRef.current = dividerIndex;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
    const at = dividerRef.current;
    if (at < 0) return;
    if (viewableItems.some((v) => v.index !== null && v.index >= at)) setDividerSeen(true);
  }).current;

  // Yanıtın alıntısına dokununca asıl mesaja kaydır (yüklü değilse çekirdek önce geçmişi yükler)
  const pendingPosition = useRef(0.5);
  const scrollToRow = useCallback((index: number, viewPosition: number) => {
    pendingPosition.current = viewPosition;
    list.current?.scrollToIndex({ index, viewPosition, animated: true });
  }, []);
  useEffect(() => {
    if (!jump || jump.channelId !== id) return;
    const index = rows.findIndex((r) => r.message.id === jump.messageId && !r.message.status);
    if (index < 0) return;
    clearJump(jump.seq);
    scrollToRow(index, 0.5);
    setFlash({ id: jump.messageId, seq: jump.seq });
  }, [jump, rows, id, scrollToRow]);

  // Yeni gelen mesajlar animasyonla belirir; geçmiş yüklenirken, eski mesajlar eklenirken ve
  // bekleyen mesajımız onaylanırken (anahtarı değişir) oynatılmaz.
  const seen = useRef<Map<string, LocalMessage>>(new Map());
  const armed = useRef(false);
  const fresh = useMemo(() => {
    const keys = new Set<string>();
    if (!armed.current || !loaded) return keys;
    const prev = seen.current;
    let lastKnown = -1;
    messages.forEach((m, i) => {
      if (prev.has(keyOf(m))) lastKnown = i;
    });
    const current = new Set(messages.map(keyOf));
    const confirmed = new Set(
      [...prev.entries()].filter(([key, m]) => m.status === 'pending' && !current.has(key)).map(([, m]) => m.content),
    );
    for (const m of messages.slice(lastKnown + 1)) {
      if (!m.status && m.authorId === self?.id && confirmed.has(m.content)) continue;
      keys.add(keyOf(m));
    }
    return keys;
  }, [messages, loaded, self?.id]);
  useEffect(() => {
    seen.current = new Map(messages.map((m) => [keyOf(m), m]));
    armed.current = loaded;
  }, [messages, loaded]);

  // Aşağıdan ayrılınca gelen (başkalarının) mesajları sayılır: aşağı atla düğmesindeki sayı
  const [leftAt, setLeftAt] = useState<string | null>(null);
  const unseen = useMemo(() => {
    if (atBottom || leftAt === null) return 0;
    let n = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.status) continue;
      if (Number(m.id) <= Number(leftAt)) break;
      if (m.authorId !== self?.id) n++;
    }
    return n;
  }, [atBottom, leftAt, messages, self?.id]);

  const atBottomRef = useRef(true);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const bottom = e.nativeEvent.contentOffset.y < BOTTOM_THRESHOLD;
      if (bottom === atBottomRef.current) return;
      atBottomRef.current = bottom;
      if (!bottom) {
        // Ayrılırken görülen en yeni mesaj: bundan sonra gelenler sayılır
        const all = (id ? useMessages.getState().channels[id]?.messages : undefined) ?? EMPTY;
        let newest = '0';
        for (let i = all.length - 1; i >= 0; i--) {
          if (!all[i]!.status) {
            newest = all[i]!.id;
            break;
          }
        }
        setLeftAt(newest);
      }
      setAtBottom(bottom);
    },
    [id],
  );

  const scrollToBottom = useCallback(() => list.current?.scrollToOffset({ offset: 0, animated: true }), []);

  const typingNames = useTypingNames(id, self?.id);
  // Kaydırarak yanıtlama: kanala yazabiliyorsa ve (direkt mesajda) konuşma kapanmamışsa
  const canReply = canSend && !blocked;
  // Salt okunur direkt mesaj: başkasının tepkisine katılma ve düzenleme yok (sunucu 403); kanallarda geçerli değil
  const readOnlyDm = Boolean(dm) && !canReply;

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item }) => (
      // Bozuk veri tek satırı düşürür, sohbetin tamamını değil
      <MessageErrorBoundary resetKey={item.message}>
        {isCallMessage(item.message) ? (
          // Arama kaydı: kısa sistem satırı (yanıt, düzenleme, menü yok)
          <CallRecordRow message={item.message} dayBreak={item.dayBreak} newDivider={item.newDivider} />
        ) : (
          <MessageRow
            message={item.message}
            authorId={item.message.authorId}
            compact={item.compact}
            dayBreak={item.dayBreak}
            newDivider={item.newDivider}
            self={self!}
            md={md}
            onLongPress={setMenuFor}
            animateIn={fresh.has(keyOf(item.message))}
            flash={flash?.id === item.message.id ? flash.seq : 0}
            onReply={canReply ? startReply : undefined}
            onAvatarPress={setProfileOf}
            lockReactions={readOnlyDm}
          />
        )}
      </MessageErrorBoundary>
    ),
    // `md` yalnızca bahsetmeyle ilgili alanlar değişince yeni nesne olur (bkz. yukarısı); yazar artık
    // satırın kendisinde (useRowAuthor) okunuyor, `users`in tamamına burada gerek yok.
    [self, md, fresh, flash, canReply, readOnlyDm],
  );

  const canAddPeople = dm?.group === true && dm.participantIds.length < DM_GROUP_MAX_PARTICIPANTS;
  const header = (
    <View style={[styles.header, { paddingTop: insets.top, height: HEADER_HEIGHT + insets.top }]}>
      <HeaderButton icon="menu" label="Kanallar ve sunucular" size={25} color={colors.text} onPress={onOpenPanel}>
        <OtherUnread channelId={id} />
      </HeaderButton>
      <View style={styles.headerTitle}>
        {dm ? (
          <DmTitle
            dm={dm}
            name={dmName}
            onPress={setProfileOf}
            onOpenPanel={() => router.push({ pathname: '/channel-panel', params: { id: dm.id } })}
          />
        ) : (
          <ChannelTitle
            channelId={id}
            name={channel?.name ?? ''}
            onPress={() => router.push({ pathname: '/channel-panel', params: { id } })}
          />
        )}
      </View>
      <HeaderButton icon={pinIcon} label="Sabitlenmiş mesajlar" size={22} onPress={() => openPinsSheet(id)}>
        <UnseenPins channelId={id} />
      </HeaderButton>
      {dm ? <DmCallButton dmId={dm.id} /> : null}
      {dm ? (
        canAddPeople ? (
          <HeaderButton
            icon="person-add"
            label="Kişi ekle"
            size={21}
            onPress={() => router.push({ pathname: '/dm-new', params: { addTo: dm.id } })}
          />
        ) : null
      ) : null}
      {/* Discord gibi: sağda arama (üyeler başlığa dokununca açılır) */}
      <HeaderButton
        icon="search"
        label="Mesajlarda ara"
        size={22}
        onPress={() =>
          router.push({ pathname: '/search', params: dm ? { dmId: dm.id } : { guildId: channel?.guildId ?? '' } })
        }
      />
    </View>
  );

  if (!target || !self || !id) {
    return <View style={styles.page}>{header}</View>;
  }

  const showNewBar = dividerIndex >= 8 && !dividerSeen;

  return (
    <View
      ref={keyboard.ref}
      onLayout={keyboard.onLayout}
      // Klavye açıkken boşluk klavye kadar; kapalıyken gezinme çubuğu kadar (ses çubuğu varsa o üstlenir)
      style={[styles.page, { paddingBottom: keyboard.open ? keyboard.inset : inVoice ? 0 : insets.bottom }]}
    >
      {header}
      <ConnectionBanner />
      {dm ? <DmCallStrip dmId={dm.id} /> : null}
      <View style={styles.listArea}>
        {failed && !loaded && !loading ? (
          <ErrorState text="Mesajlar yüklenemedi. Bağlantını denetleyip yeniden dene." onRetry={load} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={rows}
            keyExtractor={(r) => keyOf(r.message)}
            renderItem={renderItem}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onEndReached={() => void loadOlder(id)}
            onEndReachedThreshold={0.5}
            onViewableItemsChanged={onViewableItemsChanged}
            // Uzun sohbetlerde akıcı kaydırma: az sayıda ekran boyu çizili tutulur, parti parti eklenir
            initialNumToRender={14}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={40}
            windowSize={11}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            // Satır yükseklikleri değişken: hedef henüz ölçülmediyse önce tahmini yere, sonra tam yerine kaydır
            onScrollToIndexFailed={(info) => {
              list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
              setTimeout(() => {
                if (info.index < rows.length) {
                  list.current?.scrollToIndex({ index: info.index, viewPosition: pendingPosition.current, animated: true });
                }
              }, 120);
            }}
            // Ters listede üst boşluk en alttadır: yazıyor şeridi son mesajı örtmesin
            contentContainerStyle={{ paddingTop: TYPING_HEIGHT, paddingBottom: space.sm }}
            // Geçmiş gelene kadar mesaj biçimli iskelet
            ListEmptyComponent={!loaded ? <MessageSkeleton rows={8} /> : null}
            ListFooterComponent={
              hasMore || !loaded ? (
                // Eski mesajlar yüklenirken üstte iki iskelet satırı
                <View style={styles.loading}>{loading && messages.length > 0 ? <MessageSkeleton rows={2} /> : null}</View>
              ) : (
                <Intro dm={dm} name={dmName} label={label} username={partner?.username} empty={messages.length === 0} />
              )
            }
          />
        )}
        {showNewBar && (
          <NewMessagesBar
            count={dividerIndex + 1}
            onJump={() => {
              setDividerSeen(true);
              scrollToRow(dividerIndex, 0.85);
            }}
            onDismiss={() => {
              setDividerSeen(true);
              if (id) ackChannel(id);
            }}
          />
        )}
        <TypingBar names={typingNames} />
        <JumpToBottom visible={!atBottom && loaded} count={unseen} onPress={scrollToBottom} />
      </View>
      <Composer
        key={editing?.id ?? 'yeni'}
        channel={target}
        placeholder={dm ? `${label} ${dm.group ? 'grubuna' : 'kişisine'} mesaj gönder` : undefined}
        lockedText={blocked ?? undefined}
        lockedAction={
          blockedByMe && partner ? { title: 'Engeli kaldır', onPress: () => void unblockUser(partner.id) } : undefined
        }
        mentionable={dm?.participantIds}
        editing={editing}
        onDoneEditing={() => setEditing(null)}
        onSent={() => {
          // Gönderince "YENİ" ayracı kalkar ve en alta inilir (masaüstündeki gibi)
          setDividerId(null);
          scrollToBottom();
        }}
      />
      {/* Klavye açıkken ses çubuğu yer kaplamasın */}
      {!keyboard.open && <VoiceBar bottomInset={insets.bottom} />}

      <MessageMenu
        message={menuFor}
        self={self}
        canManageMessages={canManageMessages}
        canReact={canReact}
        canReply={canReply}
        inDirect={Boolean(dm)}
        canPin={canPin}
        onClose={() => setMenuFor(null)}
        onEdit={(m) => setEditing(m)}
      />
      <ReactionsSheet />
      <PinsSheet />
      <MemberSheet userId={profileOf} context={profileContext} onClose={() => setProfileOf(null)} />
    </View>
  );
}

/** Kanalda (kendin dışında) yazanların adları; seçici kararlı nesne döndürür */
function useTypingNames(channelId: string | undefined, selfId: string | undefined): string[] {
  const typing = useMessages((s) => (channelId ? s.typing[channelId] : undefined));
  const users = useGuild((s) => s.users);
  return useMemo(
    () =>
      Object.keys(typing ?? {})
        .filter((uid) => uid !== selfId)
        .map((uid) => users[uid]?.displayName)
        .filter((n): n is string => Boolean(n)),
    [typing, users, selfId],
  );
}

/** Panel düğmesindeki rozet: başka kanallardaki bahsetmeler ve okunmamış direkt mesajlar */
function OtherUnread({ channelId }: { channelId: string }) {
  const count = useMessages((s) => {
    let n = 0;
    for (const key in s.mentionCounts) if (key !== channelId) n += s.mentionCounts[key] ?? 0;
    return n;
  });
  return count > 0 ? <CountBadge count={count} ring={colors.main} /> : null;
}

/** Raptiye düğmesindeki nokta: bu oturumda başkası yeni bir mesaj sabitledi, liste henüz açılmadı */
function UnseenPins({ channelId }: { channelId: string }) {
  const unseen = usePins((s) => Boolean(s.unseen[channelId]));
  return unseen ? <View style={styles.pinDot} /> : null;
}

/**
 * Başlık (Discord mobil gibi): "# kanal ›" ve altında kanalı görebilen çevrimiçi üye sayısı; dokununca
 * üye listesi açılır.
 */
function ChannelTitle({ channelId, name, onPress }: { channelId: string; name: string; onPress: () => void }) {
  const online = useOnlineViewerCount(channelId);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name} kanalı, ${online} çevrim içi. Kanal panelini göster`}
      style={({ pressed }) => [styles.channelTitle, pressed && { backgroundColor: colors.hover }]}
    >
      <View style={styles.title}>
        <Feather name="hash" size={18} color={colors.muted} />
        <Text style={[styles.titleText, { fontSize: 17 }]} numberOfLines={1}>
          {name}
        </Text>
        <Feather name="chevron-right" size={18} color={colors.muted} style={{ marginLeft: -2 }} />
      </View>
      <View style={styles.onlineRow}>
        <View style={styles.onlineDot} />
        <Text style={styles.titleSub} numberOfLines={1}>
          {online} çevrim içi
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Başlık: konuşmanın resmi, adı ve bire bir konuşmada karşı tarafın durumu. Bire bir konuşmada resme ya
 * da ada dokununca karşı tarafın profil kartı (DM bağlamında) açılır.
 */
function DmTitle({
  dm,
  name,
  onPress,
  onOpenPanel,
}: {
  dm: DmChannel;
  name: string;
  onPress: (userId: string) => void;
  /** Grup konuşmasında başlığa dokununca: konuşmanın paneli (katılımcılar, medya, sabitlemeler, bağlantılar, dosyalar) */
  onOpenPanel: () => void;
}) {
  const selfId = useSession((s) => s.user?.id);
  const partner = useGuild((s) => dmPartner(dm, s.users, selfId));
  const status = useStatus(partner?.id);
  const custom = useCustomStatus(partner?.id);
  const reachable = useGuild((s) => (partner ? Boolean(s.reachable[partner.id]) : false));
  // Bire bir konuşmada karşı tarafın özel durumu, yoksa durumu
  const sub = dm.group
    ? `${dm.participantIds.length} üye`
    : !reachable
      ? undefined
      : custom
        ? `${custom.emoji ? `${custom.emoji} ` : ''}${custom.text ?? ''}`
        : STATUS_LABELS[status];
  const content = (
    <View style={styles.title}>
      <DmAvatar dm={dm} size={30} status surfaceColor={colors.main} />
      <View style={{ flexShrink: 1, marginLeft: 4 }}>
        <Text style={[styles.titleText, { fontSize: 16.5 }]} numberOfLines={1}>
          {name}
        </Text>
        {sub ? <Text style={styles.titleSub}>{sub}</Text> : null}
      </View>
    </View>
  );
  if (dm.group) {
    return (
      <Pressable
        onPress={onOpenPanel}
        accessibilityRole="button"
        accessibilityLabel={`${name}. Katılımcıları, medyayı ve bağlantıları göster`}
        style={({ pressed }) => [styles.channelTitle, pressed && { backgroundColor: colors.hover }]}
      >
        {content}
      </Pressable>
    );
  }
  if (!partner) return content;
  return (
    <Pressable
      onPress={() => onPress(partner.id)}
      accessibilityRole="button"
      accessibilityLabel={`${name} profilini göster`}
      style={({ pressed }) => [styles.channelTitle, pressed && { backgroundColor: colors.hover }]}
    >
      {content}
    </Pressable>
  );
}

/** Konuşmanın başı: kanalın ya da konuşmanın tanıtımı */
function Intro({
  dm,
  name,
  label,
  username,
  empty,
}: {
  dm: DmChannel | undefined;
  name: string;
  label: string;
  username?: string;
  empty: boolean;
}) {
  return (
    <View style={styles.intro}>
      {dm ? (
        <>
          <DmAvatar dm={dm} size={72} />
          <Text style={styles.introTitle}>{name}</Text>
          {username && <Text style={styles.introUser}>@{username}</Text>}
          <Text style={styles.introText}>
            {dm.group ? `${name} grubunun başlangıcı.` : `${name} ile direkt mesaj geçmişinin başlangıcı.`} Bu konuşmayı
            yalnızca {dm.group ? 'gruptakiler' : 'ikiniz'} görebilir.
          </Text>
        </>
      ) : (
        <>
          <View style={styles.introIcon}>
            <Feather name="hash" size={38} color={colors.onControl} />
          </View>
          <Text style={styles.introTitle}>{label} kanalına hoş geldin!</Text>
          <Text style={styles.introText}>Bu, {label} kanalının başlangıcı.</Text>
        </>
      )}
      {empty && <Text style={[styles.introText, { marginTop: space.md }]}>Henüz mesaj yok. İlk mesajı sen gönder 👋</Text>}
    </View>
  );
}

/** Üstte: açılışta okunmamış çok mesaj varsa "N yeni mesaj" şeridi; dokununca ilk okunmamışa atlar */
function NewMessagesBar({ count, onJump, onDismiss }: { count: number; onJump: () => void; onDismiss: () => void }) {
  const appear = useSpringTo(1);
  return (
    <Animated.View
      style={[
        styles.newBar,
        { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] }) }] },
      ]}
    >
      <Pressable style={styles.newBarMain} onPress={onJump} android_ripple={{ color: 'rgba(255,255,255,0.15)' }}>
        <Text style={styles.newBarText}>{count > 99 ? '99+' : count} yeni mesaj</Text>
        <Text style={styles.newBarAction}>Atla</Text>
        <Ionicons name="arrow-up" size={15} color="#fff" />
      </Pressable>
      <Pressable hitSlop={8} onPress={onDismiss} style={styles.newBarClose} accessibilityLabel="Okundu say">
        <Ionicons name="checkmark-done" size={17} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

/** Listenin altında "X yazıyor…": yumuşakça belirip kaybolur, yer kaplamaz (liste boşluğu bırakır) */
function TypingBar({ names }: { names: string[] }) {
  const shown = useTimingTo(names.length > 0 ? 1 : 0, 160);
  // Kaybolurken son metin kalsın
  const last = useRef('');
  if (names.length > 0) {
    last.current =
      names.length === 1
        ? `${names[0]} yazıyor…`
        : names.length <= 3
          ? `${names.join(', ')} yazıyor…`
          : 'Birkaç kişi yazıyor…';
  }
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.typing, { opacity: shown }]}
      accessibilityLiveRegion="polite"
      importantForAccessibility={names.length ? 'yes' : 'no-hide-descendants'}
    >
      <TypingDots color={colors.text} size={5} />
      <Text style={styles.typingText} numberOfLines={1}>
        {last.current}
      </Text>
    </Animated.View>
  );
}

/** Sağ altta "en alta in" düğmesi: aşağıdan ayrılınca yaylanarak belirir; yeni mesaj sayısıyla */
function JumpToBottom({ visible, count, onPress }: { visible: boolean; count: number; onPress: () => void }) {
  const shown = useSpringTo(visible ? 1 : 0, 6);
  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        styles.jump,
        {
          opacity: shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
            { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
          ],
        },
      ]}
    >
      <PressableScale
        scaleTo={0.88}
        onPress={onPress}
        ripple={{ color: tint(0.15), borderless: true, radius: 22 }}
        style={styles.jumpButton}
        accessibilityRole="button"
        accessibilityLabel={count > 0 ? `En alta in, ${count} yeni mesaj` : 'En alta in'}
      >
        <Ionicons name="arrow-down" size={22} color={colors.head} />
      </PressableScale>
      {count > 0 && (
        <View style={styles.jumpBadge} pointerEvents="none">
          <CountBadge count={count} ring={colors.main} />
        </View>
      )}
    </Animated.View>
  );
}

/** Uzun basınca menüdeki hızlı tepkiler (sonrasında tüm emojiler için +) */
const MENU_REACTIONS = QUICK_REACTIONS.slice(0, 6);

/** Uzun basınca alttan kayarak açılan mesaj menüsü (tepkiler, yanıtla, kopyala, düzenle, sil). */
function MessageMenu({
  message,
  self,
  canManageMessages,
  canReact,
  canReply,
  inDirect,
  canPin,
  onClose,
  onEdit,
}: {
  message: LocalMessage | null;
  self: User;
  /** Kanalda başkalarının mesajlarını silebilir mi */
  canManageMessages: boolean;
  /** Yeni tepki ekleyebilir mi (var olan tepkilere katılmak her zaman serbest) */
  canReact: boolean;
  /** Kanala yazabiliyor mu (yanıt da bir mesajdır) */
  canReply: boolean;
  /** Direkt mesaj konuşması (salt okunurken düzenleme ve başkasının tepkisine katılma yok) */
  inDirect: boolean;
  /** Mesaj sabitleyebilir mi */
  canPin: boolean;
  onClose: () => void;
  onEdit: (m: LocalMessage) => void;
}) {
  const [allEmojis, setAllEmojis] = useState(false);
  // Kapanış animasyonu sürerken menünün içeriği değişmesin: son mesaj tutulur
  const last = useRef(message);
  if (message) last.current = message;
  const shown = message ?? last.current;
  // Arama kaydı düzenlenemez (sunucu 400 not_editable)
  const canEdit = shown?.authorId === self.id && !isCallMessage(shown) && (!inDirect || canReply);
  // Salt okunur direkt mesajda yalnızca kendi tepkini kaldırabilirsin (sunucu kanallarında yazma izni aranmaz)
  const reactLocked = inDirect && !canReply;
  const canDelete = shown?.authorId === self.id || canManageMessages;
  // Yazara mesaj (masaüstündeki "Yazara Mesaj Gönder"): başkasının mesajı ve ortak sunucusu var
  const canMessageAuthor = useGuild((s) =>
    Boolean(shown?.authorId && shown.authorId !== self.id && s.reachable[shown.authorId] && s.dms[shown.channelId] === undefined),
  );

  // Her açılışta menü baştan başlar
  useEffect(() => {
    if (!message) return;
    setAllEmojis(false);
  }, [message]);

  // Sabitli mi (menü açıkken değişirse de doğru görünsün)
  const pinned = useMessages((s) =>
    shown ? Boolean(s.channels[shown.channelId]?.messages.find((m) => m.id === shown.id)?.pinned) : false,
  );
  // Menü açıkken gelen tepki değişiklikleri de görünsün
  const reactions = useMessages(
    (s) => (shown ? s.channels[shown.channelId]?.messages.find((m) => m.id === shown.id)?.reactions : undefined) ?? NO_REACTIONS,
  );
  const react = (emoji: string): void => {
    if (shown) void toggleReaction(shown.channelId, shown.id, emoji);
    onClose();
  };
  const mine = (emoji: string): boolean => reactions.some((r) => r.emoji === emoji && r.me);
  // Galeriye kaydedilebilecek resimler (gönderilmiş mesajda; yeni APK'larda)
  const images = shown && !shown.status && canSaveToGallery() ? shown.attachments.filter(isImageAttachment) : [];
  const existing = (emoji: string): boolean => reactions.some((r) => r.emoji === emoji);
  // Yetki yoksa yalnızca mesajdaki tepkiler gösterilir
  const quick = reactLocked ? MENU_REACTIONS.filter(mine) : canReact ? MENU_REACTIONS : MENU_REACTIONS.filter(existing);
  const close = onClose;
  return (
    <BottomSheet visible={message !== null} onClose={onClose}>
      {allEmojis ? (
        <EmojiGrid onPick={react} />
      ) : (
        <>
          {(quick.length > 0 || canReact) && (
            <View style={styles.quickRow}>
              {quick.map((emoji) => (
                <PressableScale
                  key={emoji}
                  scaleTo={0.82}
                  onPress={() => react(emoji)}
                  accessibilityLabel={`${emoji} tepkisi${mine(emoji) ? ', kaldır' : ''}`}
                  style={[styles.quick, mine(emoji) && styles.quickMine]}
                >
                  <Text style={styles.quickEmoji}>{emoji}</Text>
                </PressableScale>
              ))}
              {canReact && (
                <PressableScale
                  scaleTo={0.82}
                  accessibilityLabel="Tüm emojiler"
                  onPress={() => {
                    animateNextLayout(220);
                    setAllEmojis(true);
                  }}
                  style={styles.quick}
                >
                  <Ionicons name="add" size={26} color={colors.text} />
                </PressableScale>
              )}
            </View>
          )}
          <SheetGroup>
            {canReply && (
              <SheetItem
                key="reply"
                icon="arrow-undo-outline"
                label="Yanıtla"
                onPress={() => {
                  if (shown) startReply(shown);
                  close();
                }}
              />
            )}
            {canPin && shown && !shown.status ? (
              <SheetItem
                key="pin"
                icon={pinned ? unpinIcon : pinIcon}
                label={pinned ? 'Sabitlemeyi kaldır' : 'Mesajı sabitle'}
                onPress={() => {
                  const target = shown;
                  close();
                  // Önizlemeli onay (masaüstündeki gibi)
                  void (pinned ? confirmUnpin(target) : confirmPin(target)).then((ok) => {
                    if (ok) toast(pinned ? 'Sabitleme kaldırıldı' : 'Mesaj sabitlendi');
                  });
                }}
              />
            ) : null}
            {canEdit && (
              <SheetItem
                key="edit"
                icon="create-outline"
                label="Mesajı düzenle"
                onPress={() => {
                  if (shown) onEdit(shown);
                  close();
                }}
              />
            )}
            {canMessageAuthor && shown?.authorId ? (
              <SheetItem
                key="dm"
                icon="chatbubble-outline"
                label="Yazara mesaj gönder"
                onPress={() => {
                  const authorId = shown.authorId!;
                  close();
                  void openDirectMessage(authorId).then((dm) => dm && showChat(dm.id));
                }}
              />
            ) : null}
            {reactions.length > 0 ? (
              <SheetItem
                key="reactions"
                icon="people-outline"
                label="Tepkiler"
                onPress={() => {
                  const target = shown ? { channelId: shown.channelId, messageId: shown.id } : null;
                  close();
                  // Menü kapandıktan sonra açılır (iki sayfa üst üste açılmasın)
                  if (target) setTimeout(() => openReactionsSheet(target), 230);
                }}
              />
            ) : null}
            {canDelete && shown && visibleLinkEmbeds(shown).length > 0 ? (
              <SheetItem
                key="suppress"
                icon="eye-off-outline"
                label="Önizlemeyi kaldır"
                onPress={() => {
                  void suppressEmbeds(shown);
                  close();
                }}
              />
            ) : null}
            {images.length > 0 ? (
              <SheetItem
                key="save"
                icon="download-outline"
                label={images.length === 1 ? 'Resmi galeriye kaydet' : `Resimleri galeriye kaydet (${images.length})`}
                onPress={() => {
                  void saveToGallery(images);
                  close();
                }}
              />
            ) : null}
            {shown?.content ? (
              <SheetItem
                key="copy"
                icon="copy-outline"
                label="Metni kopyala"
                onPress={() => {
                  void Clipboard.setStringAsync(shown.content).then(() => toast('Kopyalandı'));
                  close();
                }}
              />
            ) : null}
          </SheetGroup>
          {canDelete && (
            <SheetGroup>
              <SheetItem
                icon="trash-outline"
                label="Mesajı sil"
                danger
                onPress={() => {
                  const target = shown;
                  close();
                  if (!target) return;
                  // Temalı onay penceresi (masaüstündeki gibi)
                  void confirmDialog({
                    title: 'Mesaj silinsin mi?',
                    message: 'Bu mesaj herkesten kalıcı olarak silinir. Bu işlem geri alınamaz.',
                    icon: 'trash-outline',
                    confirmLabel: 'Sil',
                    danger: true,
                  }).then((ok) => {
                    if (ok) void deleteMessage(target);
                  });
                }}
              />
            </SheetGroup>
          )}
        </>
      )}
    </BottomSheet>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    backgroundColor: colors.main,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.edge,
    elevation: 2,
    zIndex: 1,
  },
  headerTitle: { flex: 1, alignSelf: 'stretch', marginLeft: space.xs },
  listArea: { flex: 1 },
  loading: { minHeight: 60, justifyContent: 'center', paddingBottom: space.sm },
  title: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titleText: { color: colors.head, fontSize: 18, fontWeight: '700', flexShrink: 1 },
  titleSub: { color: colors.muted, fontSize: 12, marginTop: -1 },
  // Başlık yazısı değil, geri düğmesi ile sağdaki simgeler arasındaki bütün boş alan dokunma alanı (Discord gibi)
  channelTitle: { flex: 1, justifyContent: 'center', borderRadius: 10, paddingHorizontal: space.xs },
  onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 2 },
  onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ok },
  intro: { paddingHorizontal: space.lg, paddingTop: space.xxl, paddingBottom: space.sm },
  introIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  introTitle: { color: colors.head, fontSize: font.hero, fontWeight: '800', marginTop: space.md },
  introText: { color: colors.muted, fontSize: font.body, marginTop: space.xs, lineHeight: 21 },
  introUser: { color: colors.text, fontSize: font.row, marginTop: 2 },
  typing: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: TYPING_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: colors.mainTranslucent,
  },
  typingText: { color: colors.text, fontSize: font.caption, fontWeight: '600', flexShrink: 1 },
  jump: { position: 'absolute', right: space.md, bottom: TYPING_HEIGHT + space.sm },
  jumpButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.active,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  jumpBadge: { position: 'absolute', top: -6, right: -6 },
  pinDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.main,
    backgroundColor: colors.danger,
    marginTop: 4,
    marginRight: 4,
  },
  newBar: {
    position: 'absolute',
    top: 0,
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.brand,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    overflow: 'hidden',
    elevation: 4,
  },
  newBarMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: 7 },
  newBarText: { color: '#fff', fontSize: font.small, fontWeight: '700', flex: 1 },
  newBarAction: { color: '#fff', fontSize: font.small, fontWeight: '700' },
  newBarClose: {
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.35)',
  },
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  quick: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.main,
  },
  quickMine: { backgroundColor: 'rgba(88,101,242,0.35)', borderWidth: 1, borderColor: colors.brand },
  quickEmoji: { fontSize: 24 },
}));
