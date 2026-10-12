import { useMemo } from 'react';
import { Image, Reply } from 'lucide-react';
import { jumpToMessage, plainText, useGuild, useChannelMemberColor, type LocalMessage } from '@diskort/client-core';
import type { MarkdownContext } from '../../features/messages/markdown';
import { Avatar } from '../ui/Avatar';

/**
 * Yanıtın üstündeki tek satırlık alıntı (Discord'daki gibi): avatardan kavisli bir çizgiyle bağlanır;
 * asıl mesajın yazarı rol rengiyle (bildirildiyse başında @) ve metninin başı. Tıklayınca asıl mesaja
 * atlanır. Yükseklik 22 px'tir; MessageItem avatarı buna göre aşağı kaydırır (bkz. styles.css .reply-spine).
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

  if (!reference) {
    return (
      <div className="reply-spine relative mb-0.5 flex h-5 items-center gap-1 text-sm text-text-muted select-none">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-active">
          <Reply size={10} />
        </span>
        <span className="italic">Orijinal mesaj silindi</span>
      </div>
    );
  }

  const name = author?.displayName ?? 'Silinmiş Kullanıcı';
  return (
    <button
      type="button"
      className="reply-spine group/reply relative mb-0.5 flex h-5 max-w-full min-w-0 items-center gap-1 text-left text-sm select-none"
      aria-label={`${name} kişisinin mesajına git`}
      onClick={() => void jumpToMessage(message.channelId, reference.id)}
    >
      <Avatar user={author} size={16} />
      <span
        className="shrink-0 font-medium text-text-head opacity-80 group-hover/reply:opacity-100"
        style={color ? { color } : undefined}
      >
        {message.replyMentionUserId ? '@' : ''}
        {name}
      </span>
      {snippet ? (
        <span className="min-w-0 truncate text-text-muted group-hover/reply:text-text-normal">{snippet}</span>
      ) : (
        <span className="text-text-muted italic group-hover/reply:text-text-normal">Ek</span>
      )}
      {reference.hasAttachments && <Image size={14} className="shrink-0 text-text-muted" aria-label="Ek" />}
    </button>
  );
}
