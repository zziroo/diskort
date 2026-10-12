import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { jumpToMessage, plainText, useGuild, useChannelMemberColor, type LocalMessage } from '@diskort/client-core';
import { colors, createStyles } from '../theme';
import { Avatar } from './Avatar';
import type { MarkdownContext } from './Markdown';

/** Alıntı satırının yüksekliği; MessageRow avatarı bu kadar aşağı kaydırır */
export const REPLY_PREVIEW_HEIGHT = 22;

/**
 * Yanıtın üstündeki tek satırlık alıntı (Discord'daki gibi): avatardan kavisli çizgiyle bağlanır,
 * asıl yazar rol rengiyle (bildirildiyse başında @) ve metnin başı. Dokununca asıl mesaja atlanır.
 */
export function ReplyPreview({ message, md }: { message: LocalMessage; md: MarkdownContext }) {
  const reference = message.referencedMessage;
  const author = useGuild((s) => (reference?.authorId ? s.users[reference.authorId] : undefined));
  const color = useChannelMemberColor(reference?.authorId, message.channelId);
  const snippet = useMemo(
    () =>
      reference
        ? plainText(
            reference.content,
            (u) => md.usersByName[u]?.displayName,
            (id) => (md.roles && Object.hasOwn(md.roles, id) ? md.roles[id]?.name : undefined),
          )
        : '',
    [reference, md.usersByName, md.roles],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.spine} />
      {reference ? (
        <Pressable
          onPress={() => void jumpToMessage(message.channelId, reference.id)}
          hitSlop={{ top: 6, bottom: 4 }}
          style={({ pressed }) => [styles.line, pressed && { opacity: 0.6 }]}
          accessibilityLabel="Asıl mesaja git"
        >
          <Avatar user={author} size={16} />
          <Text style={[styles.name, color ? { color } : null]} numberOfLines={1}>
            {message.replyMentionUserId ? '@' : ''}
            {author?.displayName ?? 'Silinmiş Kullanıcı'}
          </Text>
          <Text style={[styles.snippet, !snippet && styles.italic]} numberOfLines={1}>
            {snippet || 'Ek'}
          </Text>
          {reference.hasAttachments && snippet ? <Ionicons name="image-outline" size={14} color={colors.muted} /> : null}
        </Pressable>
      ) : (
        <View style={styles.line}>
          <View style={styles.deletedIcon}>
            <Ionicons name="arrow-undo" size={9} color={colors.muted} />
          </View>
          <Text style={[styles.snippet, styles.italic]}>Orijinal mesaj silindi</Text>
        </View>
      )}
    </View>
  );
}

const styles = createStyles(() => ({
  wrap: { height: 20, marginBottom: 2, justifyContent: 'center' },
  // Satırın ortasından sola, oradan avatarın ortasına inen kavisli çizgi (gövde avatar sütunundan 64 px sağda)
  spine: {
    position: 'absolute',
    top: 9,
    left: -33,
    width: 29,
    height: 12,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 6,
    borderColor: colors.control,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 8 },
  name: { color: colors.head, fontSize: 13.5, fontWeight: '600', flexShrink: 0, maxWidth: '45%' },
  snippet: { color: colors.muted, fontSize: 13.5, flexShrink: 1 },
  italic: { fontStyle: 'italic' },
  deletedIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.active,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
