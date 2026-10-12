import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  discardMessage,
  gifOf,
  isMentioned,
  mentionInComposer,
  retryMessage,
  toggleReaction,
  useGuild,
  useChannelMemberColor,
  useMessages,
  visibleLinkEmbeds,
  type LocalMessage,
} from '@diskort/client-core';
import type { User } from '@diskort/shared';
import type { MemberUser } from '@diskort/client-core';

/** Satırda kullanılan yazar alanları (hepsi ilkel değer: bkz. useRowAuthor) */
type RowAuthor = Pick<MemberUser, 'id' | 'displayName' | 'username' | 'avatarColor' | 'avatarUrl' | 'avatarDecoration' | 'removed'>;

/**
 * Yazarı `users` haritasının tamamı yerine tek tek ilkel alanlarla okur. `users` her profil/üye
 * değişikliğinde (ör. başka birinin rolü, çevrimiçi durumu değil ama profili) baştan kurulur; satır bu
 * nesnenin tamamına bağlı olsaydı ilgisiz her güncellemede yeniden çizilirdi (bkz. ChannelChat.renderItem).
 * İlkel değerler (string/boolean) yalnızca gerçekten değişince referans/değer farkı yaratır.
 */
function useRowAuthor(authorId: string | null | undefined, channelId: string): RowAuthor | undefined {
  const exists = useGuild((s) => (authorId ? authorId in s.users : false));
  const displayName = useGuild((s) => (authorId ? s.users[authorId]?.displayName : undefined));
  const username = useGuild((s) => (authorId ? s.users[authorId]?.username : undefined));
  const avatarColor = useGuild((s) => (authorId ? s.users[authorId]?.avatarColor : undefined));
  const avatarUrl = useGuild((s) => (authorId ? s.users[authorId]?.avatarUrl : undefined));
  const avatarDecoration = useGuild((s) => (authorId ? s.users[authorId]?.avatarDecoration : undefined));
  // Artık burada değil: kanalda sunucunun üyesi değil; DM'de (sunucu yok) ortak sunucusu kalmadı
  const removed = useGuild((s) =>
    !authorId ? undefined : s.dms[channelId] ? !s.reachable[authorId] : s.users[authorId]?.removed,
  );
  return useMemo(
    () =>
      exists && authorId && displayName !== undefined && username !== undefined && avatarColor !== undefined
        ? { id: authorId, displayName, username, avatarColor, avatarUrl, avatarDecoration, removed: removed ?? false }
        : undefined,
    [exists, authorId, displayName, username, avatarColor, avatarUrl, avatarDecoration, removed],
  );
}
import { feedback } from '../haptics';
import { duration, useAppear } from '../motion';
import { colors, createStyles, font, layout, radius, ripple, space } from '../theme';
import { Avatar } from './Avatar';
import { AttachmentList, UploadList } from './Attachments';
import { GifEmbed } from './GifEmbed';
import { PinIcon } from './icons';
import { LinkEmbeds } from './LinkEmbeds';
import { Markdown, type MarkdownContext } from './Markdown';
import { ReactionPill } from './ReactionPill';
import { openReactionsSheet } from './ReactionsSheet';
import { REPLY_PREVIEW_HEIGHT, ReplyPreview } from './ReplyPreview';

const time = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const longDate = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);

/** Gün ayracındaki yazı: "Bugün", "Dün" ya da "12 Eylül 2026" */
function dayLabel(ts: number): string {
  const diff = startOfDay(Date.now()) - startOfDay(ts);
  if (diff <= 0) return 'Bugün';
  if (diff <= 86_400_000) return 'Dün';
  return longDate.format(ts);
}

/** Mesaj başlığındaki zaman: "Bugün 14:32", "Dün 09:10" ya da "24.09.2026 18:05" */
export function messageStamp(ts: number): string {
  const diff = startOfDay(Date.now()) - startOfDay(ts);
  if (diff <= 0) return `Bugün ${time.format(ts)}`;
  if (diff <= 86_400_000) return `Dün ${time.format(ts)}`;
  return `${shortDate.format(ts)} ${time.format(ts)}`;
}

interface Props {
  message: LocalMessage;
  /** Yazarın kimliği (satır kendi ilkel alanlarını useRowAuthor ile okur; bkz. yukarısı) */
  authorId: string | null | undefined;
  compact: boolean;
  /** Bu mesajın üstünde gün ayracı gösterilsin mi */
  dayBreak: boolean;
  /** Okunmamış ilk mesaj: üstünde kırmızı "YENİ" ayracı */
  newDivider?: boolean;
  self: User;
  md: MarkdownContext;
  onLongPress: (message: LocalMessage) => void;
  /** Yeni gelen mesaj: hafifçe yükselerek belirir (geçmiş yüklenirken false) */
  animateIn?: boolean;
  /** Alıntıdan bu mesaja atlandı: değiştikçe (0 değilse) satır kısa süre vurgulanır */
  flash?: number;
  /** Satırı sola kaydırınca yanıtla (yoksa ya da yazma izni yoksa kaydırma kapalı) */
  onReply?: (message: LocalMessage) => void;
  /** Avatara dokununca kişinin profili (üye kartı) açılır */
  onAvatarPress?: (userId: string) => void;
  /**
   * Salt okunur direkt mesaj (engel, ortak sunucu kalmadı): başkasının tepkisine katılınamaz (sunucu 403);
   * kendi tepkini kaldırmak serbest. Sunucu kanallarında hiç verilmez.
   */
  lockReactions?: boolean;
}

/** Bu kadar sola kaydırılınca bırakınca yanıtlanır (titreşimle bildirilir) */
const REPLY_TRIGGER = 64;

export const MessageRow = memo(function MessageRow({
  message,
  authorId,
  compact,
  dayBreak,
  newDivider = false,
  self,
  md,
  onLongPress,
  animateIn = false,
  flash = 0,
  onReply,
  onAvatarPress,
  lockReactions = false,
}: Props) {
  const author = useRowAuthor(authorId, message.channelId);
  const mentioned = isMentioned(message, self, md.selfRoleIds);
  // Metni yalnızca GIPHY bağlantısı olan mesaj: bağlantı yerine GIF gösterilir
  const gif = gifOf(message);
  // Bağlantı önizlemeleri hep gösterilir (gönderen kaldırdıysa hiç gelmez)
  const linkEmbeds = visibleLinkEmbeds(message);
  const authorColor = useChannelMemberColor(message.authorId, message.channelId);
  const appear = useAppear(animateIn, 240);
  // Yazma kutusunun üstünde bu mesaja yanıt veriliyor
  const replying = useMessages((s) => s.replies[message.channelId]?.messageId === message.id);
  const isReply = Boolean(message.replyToId) && !compact;
  // Satır ekrandayken eklenen tepkiler animasyonla belirir
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const highlight = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!flash) return;
    highlight.setValue(1);
    Animated.timing(highlight, { toValue: 0, duration: 1400, delay: duration(700), useNativeDriver: true }).start();
  }, [flash, highlight]);
  // Sola kaydırıp bırakınca yanıtla (Discord mobildeki gibi). Sağa kaydırma sohbetin her yerinde sol
  // paneli açar (NavShell), dikey kaydırma listenindir; dokunma ve uzun basma olduğu gibi çalışır.
  // `swipe` sola kaydırılan mesafedir (pozitif).
  const swipe = useSharedValue(0);
  const armed = useSharedValue(false);
  const canSwipe = Boolean(onReply) && !message.status;
  const pan = useMemo(() => {
    const reply = (): void => onReply?.(message);
    return Gesture.Pan()
      .enabled(canSwipe)
      .activeOffsetX(-16)
      .failOffsetX(10)
      .failOffsetY([-12, 12])
      .onUpdate((e) => {
        const x = Math.max(0, -e.translationX);
        // Eşikten sonra direnç: satır parmaktan geri kalır
        swipe.value = x <= REPLY_TRIGGER ? x : REPLY_TRIGGER + (x - REPLY_TRIGGER) * 0.25;
        const past = x >= REPLY_TRIGGER;
        if (past !== armed.value) {
          armed.value = past;
          if (past) scheduleOnRN(feedback, 'reply');
        }
      })
      .onEnd(() => {
        if (armed.value) scheduleOnRN(reply);
      })
      .onFinalize(() => {
        armed.value = false;
        swipe.value = withTiming(0, { duration: 180 });
      });
  }, [canSwipe, onReply, message, swipe, armed]);
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -swipe.value }] }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(swipe.value, [8, REPLY_TRIGGER], [0, 1], 'clamp'),
    transform: [{ scale: interpolate(swipe.value, [8, REPLY_TRIGGER, REPLY_TRIGGER + 10], [0.5, 1, 1.15], 'clamp') }],
  }));
  // Ada dokununca yazma kutusuna bahsetme eklenir
  const mentionAuthor = (): void => {
    if (author && !author.removed) mentionInComposer(message.channelId, author.username);
  };
  return (
    <Animated.View
      style={{
        opacity: appear,
        transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }}
    >
      {(dayBreak || newDivider) && <Separator day={dayBreak ? message.createdAt : null} unread={newDivider} />}
      <View>
        {canSwipe && (
          <Reanimated.View pointerEvents="none" style={[styles.replyIcon, iconStyle]}>
            <Ionicons name="arrow-undo" size={20} color={colors.head} />
          </Reanimated.View>
        )}
        <GestureDetector gesture={pan}>
          <Reanimated.View style={rowStyle}>
            <Pressable
              onLongPress={() => !message.status && onLongPress(message)}
              delayLongPress={300}
              // Kaydırmaya başlarken dokunulan satır parlamasın: basma kısa bir gecikmeyle başlar
              unstable_pressDelay={90}
              android_ripple={ripple.row}
              accessibilityHint="Seçenekler için uzun bas"
              style={[
                styles.row,
                compact ? styles.compact : styles.full,
                mentioned && !replying && styles.mentioned,
                replying && styles.replying,
              ]}
            >
              <Animated.View pointerEvents="none" style={[styles.flash, { opacity: highlight }]} />
              <View style={[styles.gutter, isReply && { paddingTop: REPLY_PREVIEW_HEIGHT }]}>
                {!compact &&
                  (author && onAvatarPress ? (
                    <Pressable onPress={() => onAvatarPress(author.id)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`${author.displayName} profili`}>
                      <Avatar user={author} size={40} decoration={author.avatarDecoration} />
                    </Pressable>
                  ) : (
                    <Avatar user={author} size={40} />
                  ))}
                {compact && message.pinned ? (
                  <PinIcon size={12} color={colors.faint} accessibilityLabel="Sabitlendi" style={styles.compactPin} />
                ) : null}
              </View>
              <View style={styles.body}>
                {isReply && <ReplyPreview message={message} md={md} />}
                {!compact && (
                  <View style={styles.header}>
                    <Text
                      style={[styles.author, !author && styles.deleted, author && authorColor ? { color: authorColor } : null]}
                      numberOfLines={1}
                      onPress={author ? mentionAuthor : undefined}
                      onLongPress={() => !message.status && onLongPress(message)}
                      suppressHighlighting
                    >
                      {author?.displayName ?? 'Silinmiş Kullanıcı'}
                    </Text>
                    <Text style={styles.time}>{messageStamp(message.createdAt)}</Text>
                    {message.pinned ? (
                      <PinIcon size={12} color={colors.faint} accessibilityLabel="Sabitlendi" style={styles.pin} />
                    ) : null}
                  </View>
                )}
                {message.content && !gif ? <Markdown content={message.content} ctx={{ ...md, flags: message }} dim={message.status === 'pending'} /> : null}
                {gif ? <GifEmbed embed={gif} dim={message.status === 'pending'} /> : null}
                {message.editedAt ? <Text style={styles.edited}>(düzenlendi)</Text> : null}
                {message.uploads ? (
                  <UploadList message={message} />
                ) : message.attachments.length > 0 ? (
                  <AttachmentList attachments={message.attachments} />
                ) : null}
                {linkEmbeds.length > 0 ? (
                  <LinkEmbeds embeds={linkEmbeds} dim={message.status === 'pending'} />
                ) : null}
                {message.status === 'failed' && message.nonce && (
                  <Text style={styles.failed}>
                    Gönderilemedi.{' '}
                    <Text style={styles.action} onPress={() => retryMessage(message.channelId, message.nonce!)}>
                      Tekrar dene
                    </Text>
                    {'  ·  '}
                    <Text style={styles.action} onPress={() => discardMessage(message.channelId, message.nonce!)}>
                      Vazgeç
                    </Text>
                  </Text>
                )}
                {message.reactions.length > 0 && (
                  <View style={styles.reactions}>
                    {message.reactions.map((r) => (
                      <ReactionPill
                        key={r.emoji}
                        emoji={r.emoji}
                        count={r.count}
                        me={r.me}
                        animateIn={mounted.current}
                        onPress={
                          lockReactions && !r.me ? undefined : () => void toggleReaction(message.channelId, message.id, r.emoji)
                        }
                        onLongPress={() => openReactionsSheet({ channelId: message.channelId, messageId: message.id, emoji: r.emoji })}
                      />
                    ))}
                  </View>
                )}
              </View>
            </Pressable>
          </Reanimated.View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
});

/** Gün ayracı ve/veya okunmamışların başladığı yer (kırmızı çizgi, sağda "YENİ") */
export function Separator({ day, unread }: { day: number | null; unread: boolean }) {
  const line = [styles.dayLine, unread && { backgroundColor: colors.danger }];
  return (
    <View style={[styles.dayBreak, !day && { marginTop: 10 }]} accessibilityRole="header">
      <View style={line} />
      {day !== null && <Text style={[styles.dayText, unread && { color: colors.dangerText }]}>{dayLabel(day)}</Text>}
      {day !== null && <View style={line} />}
      {unread && (
        <View style={styles.newTag} accessibilityLabel="Yeni mesajlar buradan başlıyor">
          <Text style={styles.newTagText}>YENİ</Text>
        </View>
      )}
    </View>
  );
}

const styles = createStyles(() => ({
  row: { flexDirection: 'row', paddingRight: 14 },
  full: { paddingTop: 12, paddingBottom: 2, marginTop: 4 },
  compact: { paddingVertical: 2 },
  mentioned: { backgroundColor: colors.warnSoft, borderLeftWidth: 2, borderLeftColor: colors.warn },
  replying: { backgroundColor: 'rgba(88,101,242,0.1)', borderLeftWidth: 2, borderLeftColor: colors.brand },
  flash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(88,101,242,0.25)' },
  gutter: { width: layout.avatarColumn, alignItems: 'center' },
  body: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginBottom: 2 },
  author: { color: colors.head, fontSize: font.row, fontWeight: '600', flexShrink: 1 },
  deleted: { color: colors.muted, fontStyle: 'italic' },
  time: { color: colors.faint, fontSize: font.caption },
  pin: { alignSelf: 'center' },
  compactPin: { marginTop: 4 },
  edited: { color: colors.faint, fontSize: 11 },
  failed: { color: colors.muted, fontSize: 13, marginTop: 2 },
  action: { color: colors.link },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  replyIcon: {
    position: 'absolute',
    right: space.lg,
    top: 0,
    bottom: 0,
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayBreak: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.lg, marginBottom: 2, minHeight: 16 },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dayText: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  newTag: { backgroundColor: colors.danger, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 1, marginLeft: -space.sm },
  newTagText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
}));
