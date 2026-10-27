import { memo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react';
import {
  isImageAttachment,
  isVideoAttachment,
  MESSAGE_MAX_LENGTH,
  MESSAGE_MAX_REACTIONS,
  Permission,
  type User,
} from '@diskort/shared';
import {
  decodeRoleMentions,
  deleteMessage,
  discardMessage,
  editMessage,
  encodeRoleMentions,
  gifOf,
  isJumboEmoji,
  isMentioned,
  mentionInComposer,
  typableRoles,
  useGuild,
  QUICK_REACTIONS,
  retryMessage,
  setEditing,
  startReply,
  suppressEmbeds,
  toggleReaction,
  useCan,
  contextOfChannel,
  useChannelMemberColor,
  useMessages,
  visibleLinkEmbeds,
  type LocalMessage,
  type MemberUser,
} from '@diskort/client-core';
import { renderMarkdown, type MarkdownContext } from '../../features/messages/markdown';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { confirmDialog } from '../../lib/dialog';
import { startDm } from '../../lib/dm';
import { memberMenuItems } from '../../lib/memberMenu';
import { useMountedRef } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { toast, useUi, type EmojiPickerAnchor } from '../../stores/ui';
import { Avatar } from '../ui/Avatar';
import { PinIcon } from '../ui/PinIcon';
import { downloadAttachment } from '../../features/messages/files';
import { openProfile } from '../members/ProfilePopover';
import { AttachmentList, UploadList } from './Attachments';
import { formatFull, formatStamp, formatTime } from './format';
import { GifEmbed } from './GifEmbed';
import { LinkEmbeds } from './LinkEmbeds';
import { confirmPin, confirmUnpin } from './Pins';
import { ReactionPill } from './ReactionPill';
import { ReplyPreview } from './ReplyPreview';

interface Props {
  message: LocalMessage;
  author: MemberUser | undefined;
  /** Aynı yazarın art arda mesajı: avatar/başlık gösterilmez */
  compact: boolean;
  editing: boolean;
  self: User;
  md: MarkdownContext;
}

async function confirmDelete(message: LocalMessage, skipConfirm: boolean): Promise<void> {
  if (
    !skipConfirm &&
    !(await confirmDialog({
      title: 'Mesajı sil',
      message: 'Bu mesaj silinsin mi? Bu işlem geri alınamaz. İpucu: Shift basılıyken silersen onay sorulmaz.',
      confirmLabel: 'Sil',
      danger: true,
    }))
  ) {
    return;
  }
  void deleteMessage(message);
}

/** Mesajın üstündeki düğmelerdeki hızlı tepkiler */
const HOVER_REACTIONS = QUICK_REACTIONS.slice(0, 3);

export const MessageItem = memo(function MessageItem({ message, author, compact, editing, self, md }: Props) {
  const openContextMenu = useUi((s) => s.openContextMenu);
  const openEmojiPicker = useUi((s) => s.openEmojiPicker);
  const openModal = useUi((s) => s.openModal);
  // Mesaj ekrandayken eklenen tepkiler animasyonla belirir
  const mounted = useMountedRef();
  const own = message.authorId === self.id;
  // Başkasının mesajını kanalda MANAGE_MESSAGES yetkisi olan siler
  const canManage = useCan(Permission.MANAGE_MESSAGES, message.channelId);
  // Yeni tepki eklemek yetki ister; var olan tepkiye katılmak serbest
  const canReact = useCan(Permission.ADD_REACTIONS, message.channelId);
  const canReply = useCan(Permission.SEND_MESSAGES, message.channelId);
  // Metin kanalında PIN_MESSAGES yetkisi olan, direkt mesajda her katılımcı sabitler
  const canPin = useCan(Permission.PIN_MESSAGES, message.channelId);
  // DM'de rol rengi yok (ad varsayılan renkte); sunucu kanalında o sunucudaki rol rengi
  const authorColor = useChannelMemberColor(message.authorId, message.channelId);
  const canDelete = own || canManage;
  const confirmed = !message.status;
  const mentioned = isMentioned(message, self, md.selfRoleIds);
  const jumbo = isJumboEmoji(message.content);
  // Metni yalnızca GIPHY bağlantısı olan mesaj: bağlantı yerine GIF gösterilir
  const gif = gifOf(message);
  // Bağlantı önizlemeleri (yazar ya da yönetici kaldırmışsa hiç gelmez)
  const linkEmbeds = visibleLinkEmbeds(message);
  // Yazma kutusunun üstünde bu mesaja yanıt veriliyor
  const replying = useMessages((s) => s.replies[message.channelId]?.messageId === message.id);
  const isReply = Boolean(message.replyToId);
  // Yazara mesaj gönderilebilir mi: başkası, ortak sunucumuz var ve zaten onunla bire bir konuşmada değiliz
  const inDirect = useGuild((s) => s.dms[message.channelId]?.group === false);
  const inDm = useGuild((s) => s.dms[message.channelId] !== undefined);
  const reachable = useGuild((s) => (author ? Boolean(s.reachable[author.id]) : false));
  // Yazar artık burada değil: kanalda sunucunun üyesi değil, DM'de ortak sunucu yok
  const authorGone = !author || (inDm ? !reachable : author.removed);
  const canMessageAuthor = !own && !inDirect && !authorGone && reachable;
  // Salt okunur bire bir konuşmada (engel, ortak sunucu yok) düzenleme ve yeni tepki yok; sunucu kanalında
  // düzenleme yazma iznine bağlı değildir
  const readOnlyDirect = inDirect && !canReply;
  const ownEditable = own && !readOnlyDirect;
  /**
   * Yazarın adına ya da resmine sağ tıklayınca: kişi menüsü (mesaj gönder, ses seviyesi, yönetim).
   * Sol tık: ad yazma kutusuna bahsetme ekler, resim profil kartını açar.
   */
  const openAuthorMenu = (e: MouseEvent): void => {
    if (!author || authorGone) return;
    const items = memberMenuItems(author.id, contextOfChannel(useGuild.getState(), message.channelId));
    if (own && items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, userId: own ? undefined : author.id, items });
  };
  const react = (emoji: string): void => void toggleReaction(message.channelId, message.id, emoji);
  const pickReaction = (anchor: EmojiPickerAnchor): void => openEmojiPicker({ anchor, onPick: react });
  const reply = (): void => startReply(message);
  const showReactions = (emoji?: string): void =>
    openModal({ type: 'reactions', channelId: message.channelId, messageId: message.id, emoji });
  const showProfile = (el: HTMLElement): void => {
    if (!author) return;
    openProfile({
      userId: author.id,
      context: contextOfChannel(useGuild.getState(), message.channelId),
      anchor: el.getBoundingClientRect(),
      side: 'right',
    });
  };
  // Ada tıklamak yazma kutusuna bahsetme ekler; kanala yazılamıyorsa profil kartı açılır
  const mentionAuthor = (el: HTMLElement): void => {
    if (author && !authorGone && mentionInComposer(message.channelId, author.username)) return;
    showProfile(el);
  };

  const onContextMenu = (e: MouseEvent): void => {
    if (!confirmed) return;
    e.preventDefault();
    const selection = window.getSelection()?.toString();
    const point = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY };
    // Sağ tıklanan dosya (resim ya da dosya kartı)
    const attachmentId = (e.target as HTMLElement).closest<HTMLElement>('[data-attachment-id]')?.dataset.attachmentId;
    const attachment = message.attachments.find((a) => a.id === attachmentId);
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(canReact ? [{ label: 'Tepki Ekle', onClick: () => pickReaction(point) }] : []),
        ...(message.reactions.length > 0 ? [{ label: 'Tepkiler', onClick: () => showReactions() }] : []),
        ...(canReply ? [{ label: 'Yanıtla', onClick: reply }] : []),
        ...(canMessageAuthor && author ? [{ label: 'Yazara Mesaj Gönder', onClick: () => void startDm(author.id) }] : []),
        ...(attachment
          ? [
              {
                label: isImageAttachment(attachment)
                  ? 'Resmi Kaydet'
                  : isVideoAttachment(attachment)
                    ? 'Videoyu Kaydet'
                    : 'Dosyayı İndir',
                onClick: () => downloadAttachment(attachment),
              },
            ]
          : []),
        ...(selection || message.content
          ? [
              {
                label: selection ? 'Seçimi Kopyala' : 'Metni Kopyala',
                onClick: () => void navigator.clipboard.writeText(selection || message.content),
              },
            ]
          : []),
        ...(ownEditable ? [{ label: 'Mesajı Düzenle', onClick: () => setEditing(message.id) }] : []),
        ...(canPin
          ? [
              message.pinned
                ? { label: 'Sabitlemeyi Kaldır', onClick: () => void confirmUnpin(message) }
                : { label: 'Mesajı Sabitle', onClick: () => void confirmPin(message) },
            ]
          : []),
        ...(canDelete && linkEmbeds.length > 0
          ? [{ label: 'Önizlemeyi Kaldır', onClick: () => void suppressEmbeds(message) }]
          : []),
        ...(canDelete
          ? [{ label: 'Mesajı Sil', danger: true, onClick: () => void confirmDelete(message, false) }]
          : []),
      ],
    });
  };

  return (
    <div
      className={cn(
        'group relative flex pr-12 pl-4 transition-colors duration-75 hover:bg-msg-hover',
        compact ? 'py-0.5' : 'mt-[17px] py-0.5',
        mentioned && !replying && 'border-l-2 border-warn bg-warn/[0.08] pl-[14px] hover:bg-warn/[0.12]',
        replying && 'border-l-2 border-brand bg-brand/[0.08] pl-[14px] hover:bg-brand/[0.12]',
        editing && 'bg-msg-hover',
      )}
      onContextMenu={onContextMenu}
      data-message-id={message.id}
    >
      <div className="w-14 shrink-0">
        {compact ? (
          <span className="relative block">
            <span
              className="block pt-[3px] pr-2 text-right text-[11px] text-text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100"
              data-tooltip={formatFull(message.createdAt)}
            >
              {formatTime(message.createdAt)}
            </span>
            {message.pinned && (
              // Sabitli mesaj: saat görünmezken gutter'da küçük raptiye
              <PinIcon
                size={12}
                aria-label="Sabitlendi"
                className="absolute top-[6px] right-2 text-text-faint transition-opacity duration-100 group-hover:opacity-0"
              />
            )}
          </span>
        ) : author ? (
          // Avatara tıklayınca profil kartı; yanıtlarda üstteki alıntının altına iner
          <button
            type="button"
            aria-label={`${author.displayName} profili`}
            className={cn('press block rounded-full', isReply ? 'mt-6' : 'mt-0.5')}
            onClick={(e) => showProfile(e.currentTarget)}
            onContextMenu={openAuthorMenu}
          >
            <Avatar user={author} size={40} />
          </button>
        ) : (
          <Avatar user={author} size={40} className={isReply ? 'mt-6' : 'mt-0.5'} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {isReply && !compact && <ReplyPreview message={message} md={md} />}
        {!compact && (
          <div className="flex items-baseline gap-2 leading-snug">
            {author ? (
              <button
                type="button"
                className="font-medium text-text-head hover:underline"
                style={authorColor ? { color: authorColor } : undefined}
                onClick={(e) => mentionAuthor(e.currentTarget)}
                onContextMenu={openAuthorMenu}
              >
                {author.displayName}
              </button>
            ) : (
              <span className="font-medium text-text-muted italic">Silinmiş Kullanıcı</span>
            )}
            <span className="text-xs text-text-faint" data-tooltip={formatFull(message.createdAt)}>
              {formatStamp(message.createdAt)}
            </span>
            {message.pinned && (
              <span className="self-center text-text-faint" data-tooltip="Sabitlenmiş mesaj">
                <PinIcon size={12} aria-label="Sabitlendi" />
              </span>
            )}
          </div>
        )}

        {editing ? (
          <EditBox message={message} md={md} />
        ) : (
          !gif &&
          (message.content || message.editedAt) && (
            <div
              className={cn(
                'leading-[1.375rem] break-words whitespace-pre-wrap text-text-normal select-text',
                // Yalnızca emojiden oluşan mesaj: dev emojiler (Discord gibi)
                jumbo && 'emoji-jumbo',
                message.status === 'pending' && 'opacity-50',
                message.status === 'failed' && 'text-danger',
              )}
            >
              {renderMarkdown(message.content, { ...md, flags: message })}
              {message.editedAt && (
                <span className="ml-1 text-[10px] text-text-faint select-none" data-tooltip={formatFull(message.editedAt)}>
                  (düzenlendi)
                </span>
              )}
            </div>
          )
        )}

        {gif && !editing && (
          <div className={cn(message.status === 'pending' && 'opacity-60')}>
            <GifEmbed embed={gif} />
          </div>
        )}

        {message.uploads ? (
          <UploadList message={message} />
        ) : (
          message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />
        )}

        {linkEmbeds.length > 0 && !editing && (
          <LinkEmbeds embeds={linkEmbeds} dim={message.status === 'pending'} />
        )}

        {message.status === 'failed' && message.nonce && (
          <div className="mt-0.5 text-xs text-text-muted">
            Gönderilemedi.{' '}
            <button className="text-link hover:underline" onClick={() => retryMessage(message.channelId, message.nonce!)}>
              Tekrar dene
            </button>{' '}
            ·{' '}
            <button className="text-link hover:underline" onClick={() => discardMessage(message.channelId, message.nonce!)}>
              Vazgeç
            </button>
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {message.reactions.map((r) => (
              <ReactionPill
                key={r.emoji}
                messageId={message.id}
                emoji={r.emoji}
                count={r.count}
                me={r.me}
                animateIn={mounted.current}
                // Salt okunur konuşmada yalnızca kendi tepkini geri alabilirsin
                disabled={readOnlyDirect && !r.me}
                onToggle={() => react(r.emoji)}
                onShowAll={() => showReactions(r.emoji)}
              />
            ))}
            {canReact && message.reactions.length < MESSAGE_MAX_REACTIONS && (
              <button
                data-tooltip="Tepki ekle"
                aria-label="Tepki ekle"
                className="press-icon flex h-6 items-center rounded-lg bg-bg-side px-1.5 text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-head focus-visible:opacity-100"
                onClick={(e) => pickReaction(e.currentTarget.getBoundingClientRect())}
              >
                <SmilePlus size={16} className="ico-bounce" />
              </button>
            )}
          </div>
        )}
      </div>

      {confirmed && !editing && (canReact || canReply || ownEditable || canDelete) && (
        // Üstüne gelince hafifçe belirip yükselen düğme şeridi
        <div className="pointer-events-none absolute -top-4 right-4 flex translate-y-1 overflow-hidden rounded-md border border-edge bg-bg-main opacity-0 shadow transition-[opacity,translate] duration-150 ease-out group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
          {canReact &&
            HOVER_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                className="group/emo emoji flex w-8 items-center justify-center text-lg hover:bg-bg-hover"
                data-tooltip={`${emoji} tepkisi ver`}
                aria-label={`${emoji} tepkisi ver`}
                onClick={() => react(emoji)}
              >
                <span className="transition-transform duration-200 ease-(--ease-hov) group-hover/emo:scale-125">{emoji}</span>
              </button>
            ))}
          {canReact && (
            <button
              className="p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-head"
              data-tooltip="Tepki ekle"
              aria-label="Tepki ekle"
              onClick={(e) => pickReaction(e.currentTarget.getBoundingClientRect())}
            >
              <SmilePlus size={18} className="ico-bounce" />
            </button>
          )}
          {canReply && (
            <button
              className="p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-head"
              data-tooltip="Yanıtla"
              aria-label="Yanıtla"
              onClick={reply}
            >
              <Reply size={18} className="ico-nudge-l" />
            </button>
          )}
          {ownEditable && (
            <button
              className="p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-head"
              data-tooltip="Düzenle"
              aria-label="Düzenle"
              onClick={() => setEditing(message.id)}
            >
              <Pencil size={18} className="ico-scribble" />
            </button>
          )}
          {canDelete && (
            <button
              className="p-1.5 text-danger transition-colors hover:bg-bg-hover"
              data-tooltip="Sil (Shift ile onaysız)"
              aria-label="Sil"
              onClick={(e) => void confirmDelete(message, e.shiftKey)}
            >
              <Trash2 size={18} className="ico-shake" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function EditBox({ message, md }: { message: LocalMessage; md: MarkdownContext }) {
  // Rol etiketleri (`<@&kimlik>`) kutuda `@Rol Adı` görünür, kaydederken geri çevrilir (direkt mesajda rol yok)
  const isUsername = (name: string): boolean => md.usersByName[name] !== undefined;
  // @everyone ve "everyone"/"here" adlı roller gönderirkenki gibi düzenlemede de çevrilmez
  const guildId = useGuild((s) => s.channelGuild[message.channelId] ?? null);
  const [initial] = useState(() =>
    md.roles ? decodeRoleMentions(message.content, md.roles, isUsername) : message.content,
  );
  const ref = useRef<MarkdownEditorHandle>(null);
  const save = (): void => {
    const typed = (ref.current?.getText() ?? initial).trim();
    const content = md.roles && guildId ? encodeRoleMentions(typed, typableRoles(md.roles, guildId), isUsername) : typed;
    // Dosyası olmayan mesajın metni silinirse mesajın kendisi silinir (Discord gibi)
    if (!content && message.attachments.length === 0) {
      setEditing(null);
      void confirmDelete(message, false);
      return;
    }
    if (content.length > MESSAGE_MAX_LENGTH) {
      toast(`Mesaj en fazla ${MESSAGE_MAX_LENGTH} karakter olabilir.`, 'error');
      return;
    }
    setEditing(null);
    if (content !== message.content) void editMessage(message, content);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="anim-fade-in py-1">
      <MarkdownEditor
        ref={ref}
        initialValue={initial}
        autoFocus
        maxLength={MESSAGE_MAX_LENGTH * 2}
        onKeyDown={onKeyDown}
        className="max-h-[400px] overflow-y-auto rounded-lg border border-transparent bg-bg-hover px-4 py-2.5 leading-[1.375rem] text-text-normal transition-colors focus:border-brand/50"
      />
      <div className="mt-1 text-xs text-text-muted">
        iptal için <span className="text-link">esc</span> • kaydetmek için{' '}
        <span className="text-link">enter</span>
      </div>
    </div>
  );
}
