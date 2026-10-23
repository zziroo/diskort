import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import { Permission, type Message, type PinnedMessage } from '@diskort/shared';
import {
  gifOf,
  jumpToPinned,
  openPins,
  pinMessage,
  unpinMessage,
  useCan,
  useGuild,
  useChannelMemberColor,
  usePins,
  useSession,
  type ChannelPins,
} from '@diskort/client-core';
import { colors, createStyles, font, radius, space, tint } from '../theme';
import { Avatar } from './Avatar';
import { BottomSheet, SheetHeader } from './BottomSheet';
import { confirmDialog } from './Dialog';
import { PinIcon, pinIcon, unpinIcon } from './icons';
import { Markdown, type MarkdownContext } from './Markdown';
import { messageStamp } from './MessageRow';

/** Açık "Sabitlenmiş mesajlar" sayfası (sohbet başlığındaki raptiye düğmesiyle açılır) */
const usePinsSheet = create<{ channelId: string | null }>()(() => ({ channelId: null }));

export function openPinsSheet(channelId: string): void {
  usePinsSheet.setState({ channelId });
}

const closeSheet = (): void => usePinsSheet.setState({ channelId: null });

const EMPTY_PINS: ChannelPins = { items: [], loading: false, loaded: false, stale: false };

/**
 * Kanalın sabitlenmiş mesajları (en son sabitlenen üstte). Dokununca sohbette mesaja atlanır; yetkisi
 * olan sağdaki düğmeyle sabitlemeyi kaldırır. Sohbet ekranında bir kez bulunur.
 */
export function PinsSheet() {
  const open = usePinsSheet((s) => s.channelId);
  // Kapanış animasyonu sürerken içerik kaybolmasın: son kanal tutulur
  const [channelId, setChannelId] = useState<string | null>(open);
  useEffect(() => {
    if (open) setChannelId(open);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return openPins(open);
  }, [open]);

  const { height } = useWindowDimensions();

  const jump = (message: PinnedMessage): void => {
    closeSheet();
    // Sayfa kapandıktan sonra kaydırılır
    setTimeout(() => void jumpToPinned(message), 230);
  };

  return (
    <BottomSheet visible={open !== null} onClose={closeSheet}>
      <SheetHeader title="Sabitlenmiş mesajlar" />
      {channelId ? <PinList channelId={channelId} onJump={jump} style={{ maxHeight: height * 0.65 }} /> : null}
    </BottomSheet>
  );
}

/**
 * Kanalın sabitlenmiş mesajlarının listesi (yükleniyor / boş / liste): sabitlemeler sayfasında ve kanal
 * panelinin "Sabitlemeler" sekmesinde. Listeyi açık tutmak (openPins) çağıranın işidir. `onRefresh`
 * verilirse aşağı çekerek yenilenir.
 */
export function PinList({
  channelId,
  onJump,
  style,
  onRefresh,
  refreshing = false,
}: {
  channelId: string;
  onJump: (message: PinnedMessage) => void;
  style?: StyleProp<ViewStyle>;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const pins = usePins((s) => s.channels[channelId] ?? EMPTY_PINS);
  const canPin = useCan(Permission.PIN_MESSAGES, channelId);
  const md = useMarkdownContext(channelId);

  if (!pins.loaded) return <ActivityIndicator color={colors.muted} style={styles.loading} />;
  if (pins.items.length === 0) {
    return (
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <PinIcon size={28} color={colors.muted} />
        </View>
        <Text style={styles.emptyTitle}>Burada henüz sabitlenmiş mesaj yok</Text>
        <Text style={styles.emptyText}>Önemli bir mesajı sabitlemek için ona uzun bas ve “Sabitle”yi seç.</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={pins.items}
      keyExtractor={(m) => m.id}
      style={style}
      contentContainerStyle={styles.list}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.brand]} />
        ) : undefined
      }
      renderItem={({ item }) => <PinRow message={item} md={md} canUnpin={canPin} onJump={() => onJump(item)} />}
    />
  );
}

function PinRow({
  message,
  md,
  canUnpin,
  onJump,
}: {
  message: PinnedMessage;
  md: MarkdownContext;
  canUnpin: boolean;
  onJump: () => void;
}) {
  const author = useGuild((s) => (message.authorId ? s.users[message.authorId] : undefined));
  return (
    <Pressable
      onPress={onJump}
      android_ripple={{ color: tint(0.08) }}
      accessibilityRole="button"
      accessibilityLabel={`${author?.displayName ?? 'Silinmiş Kullanıcı'} kişisinin mesajına git`}
      style={styles.card}
    >
      <MessageSummary message={message} md={md} inset>
        <Text style={styles.jump}>Mesaja git</Text>
      </MessageSummary>
      {canUnpin && (
        <Pressable
          hitSlop={8}
          onPress={() => void confirmUnpin(message)}
          accessibilityRole="button"
          accessibilityLabel="Sabitlemeyi kaldır"
          android_ripple={{ color: tint(0.15), borderless: true, radius: 18 }}
          style={styles.unpin}
        >
          <Ionicons name="close" size={18} color={colors.muted} />
        </Pressable>
      )}
    </Pressable>
  );
}

/** Mesajın özeti (yazar, zaman, metin, GIF/dosya): listede ve sabitleme onayında */
function MessageSummary({
  message,
  md,
  inset = false,
  children,
}: {
  message: Message;
  md: MarkdownContext;
  /** Sağ üstteki kaldırma düğmesine yer bırakır */
  inset?: boolean;
  children?: ReactNode;
}) {
  const author = useGuild((s) => (message.authorId ? s.users[message.authorId] : undefined));
  const color = useChannelMemberColor(message.authorId, message.channelId);
  const gif = gifOf(message);
  const files = message.attachments.length;
  return (
    <>
      <Avatar user={author} size={36} />
      <View style={styles.body}>
        <View style={[styles.header, inset && styles.headerInset]}>
          <Text style={[styles.author, !author && styles.deleted, color ? { color } : null]} numberOfLines={1}>
            {author?.displayName ?? 'Silinmiş Kullanıcı'}
          </Text>
          <Text style={styles.time}>{messageStamp(message.createdAt)}</Text>
        </View>
        {message.content && !gif ? (
          <View style={styles.content}>
            <Markdown content={message.content} ctx={{ ...md, flags: message }} />
          </View>
        ) : null}
        {gif ? <Text style={styles.meta}>GIF</Text> : null}
        {files > 0 ? (
          <View style={styles.files}>
            <Ionicons name="attach" size={15} color={colors.muted} />
            <Text style={styles.meta} numberOfLines={1}>
              {files === 1 ? message.attachments[0]!.name : `${files} dosya`}
            </Text>
          </View>
        ) : null}
        {children}
      </View>
    </>
  );
}

function useMarkdownContext(channelId: string): MarkdownContext {
  const users = useGuild((s) => s.users);
  const roles = useGuild((s) => s.roles);
  const selfId = useSession((s) => s.user?.id);
  const inGuild = useGuild((s) => s.channelGuild[channelId] !== undefined);
  return useMemo(
    () => ({
      usersByName: Object.fromEntries(Object.values(users).map((u) => [u.username, u])),
      selfId,
      // Direkt mesajda rol yoktur: açık sunucunun rolleri DM'deki sabitlenmişlere sızmasın
      roles: inGuild ? roles : undefined,
      selfRoleIds: inGuild && selfId ? users[selfId]?.roles : undefined,
    }),
    [users, roles, selfId, inGuild],
  );
}

/** Onay penceresindeki mesaj önizlemesi */
function ConfirmPreview({ message }: { message: Message }) {
  const md = useMarkdownContext(message.channelId);
  return (
    <View style={styles.preview}>
      <MessageSummary message={message} md={md} />
    </View>
  );
}

/** "Mesajı sabitle": önizlemeli onaydan sonra sabitler (masaüstündeki gibi). Sabitlendiyse true. */
export async function confirmPin(message: Message): Promise<boolean> {
  const ok = await confirmDialog({
    title: 'Mesaj sabitlensin mi?',
    message: 'Bu mesaj kanalın sabitlenmiş mesajlarına eklenir.',
    icon: pinIcon,
    preview: <ConfirmPreview message={message} />,
    confirmLabel: 'Sabitle',
  });
  return ok && pinMessage(message);
}

/** "Sabitlemeyi kaldır": önizlemeli onaydan sonra kaldırır. Kaldırıldıysa true. */
export async function confirmUnpin(message: Message): Promise<boolean> {
  const ok = await confirmDialog({
    title: 'Sabitleme kaldırılsın mı?',
    message: 'Mesaj silinmez; yalnızca sabitlenmiş mesajlardan çıkar.',
    icon: unpinIcon,
    preview: <ConfirmPreview message={message} />,
    confirmLabel: 'Kaldır',
    danger: true,
  });
  return ok && unpinMessage(message);
}

const styles = createStyles(() => ({
  loading: { paddingVertical: space.xl },
  list: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  card: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.main,
    overflow: 'hidden',
  },
  body: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginBottom: 2 },
  headerInset: { paddingRight: 28 },
  preview: { flexDirection: 'row', gap: space.md },
  author: { color: colors.head, fontSize: font.row, fontWeight: '600', flexShrink: 1 },
  deleted: { color: colors.muted, fontStyle: 'italic' },
  time: { color: colors.faint, fontSize: font.caption },
  content: { maxHeight: 132, overflow: 'hidden' },
  files: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  meta: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  jump: { color: colors.link, fontSize: font.small, fontWeight: '600', marginTop: space.xs },
  unpin: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.side,
  },
  empty: { alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.xl, gap: space.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.main,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { color: colors.head, fontSize: font.row, fontWeight: '700', textAlign: 'center' },
  emptyText: { color: colors.muted, fontSize: font.small, textAlign: 'center', lineHeight: 19 },
}));
