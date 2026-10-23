import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Paperclip, X } from 'lucide-react';
import { Permission, type Message, type Role } from '@diskort/shared';
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
  type MemberUser,
} from '@diskort/client-core';
import { renderMarkdown, type MarkdownContext } from '../../features/messages/markdown';
import { confirmDialog, useDialog } from '../../lib/dialog';
import { useEscapeLayer } from '../../lib/escape';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { Avatar } from '../ui/Avatar';
import { PinIcon } from '../ui/PinIcon';
import { AttachmentList } from './Attachments';
import { formatFull, formatStamp } from './format';
import { GifEmbed } from './GifEmbed';

// Discord'daki sabitlenmiş mesajlar: mesajın sağ tık menüsünden sabitlenir (önizlemeli onayla), kanal
// başlığındaki raptiye düğmesi listeyi açar; listeden mesaja atlanır ya da (yetkiliyse) sabitleme kaldırılır.

const markdownContext = (
  users: Record<string, MemberUser>,
  roles: Record<string, Role>,
  selfId: string | undefined,
  inGuild: boolean,
): MarkdownContext => ({
  usersByName: Object.fromEntries(Object.values(users).map((u) => [u.username, u])),
  selfId: selfId ?? '',
  // Direkt mesajda rol yoktur: açık sunucunun rolleri DM'deki sabitlenmişlere sızmasın
  roles: inGuild ? roles : undefined,
  selfRoleIds: inGuild && selfId ? users[selfId]?.roles : undefined,
});

/** Onay penceresinde ve sabitlenmiş mesajlar listesinde mesajın özeti */
function MessageCard({ message, md, full = false }: { message: Message; md: MarkdownContext; full?: boolean }) {
  const author = useGuild((s) => (message.authorId ? s.users[message.authorId] : undefined));
  const color = useChannelMemberColor(message.authorId, message.channelId);
  const gif = gifOf(message);
  return (
    <div className="flex min-w-0 gap-3">
      <Avatar user={author} size={32} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 leading-snug">
          <span
            className={cn('truncate font-medium', author ? 'text-text-head' : 'text-text-muted italic')}
            style={color ? { color } : undefined}
          >
            {author?.displayName ?? 'Silinmiş Kullanıcı'}
          </span>
          <span className="shrink-0 text-xs text-text-faint" data-tooltip={formatFull(message.createdAt)}>
            {formatStamp(message.createdAt)}
          </span>
        </div>
        {!gif && message.content && (
          <div
            className={cn(
              'text-left text-[15px] leading-[1.375rem] break-words whitespace-pre-wrap text-text-normal select-text',
              !full && 'line-clamp-4',
            )}
          >
            {renderMarkdown(message.content, { ...md, flags: message })}
          </div>
        )}
        {gif && (full ? <GifEmbed embed={gif} /> : <div className="text-sm text-text-muted">GIF</div>)}
        {message.attachments.length > 0 &&
          (full ? (
            <div className="max-w-full overflow-hidden [&_img]:max-w-full [&_video]:max-w-full">
              <AttachmentList attachments={message.attachments} />
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-1 text-sm text-text-muted">
              <Paperclip size={14} />
              {message.attachments.length === 1 ? message.attachments[0]!.name : `${message.attachments.length} dosya`}
            </div>
          ))}
      </div>
    </div>
  );
}

function ConfirmPreview({ message }: { message: Message }) {
  const users = useGuild((s) => s.users);
  const roles = useGuild((s) => s.roles);
  const selfId = useSession((s) => s.user?.id);
  const inGuild = useGuild((s) => s.channelGuild[message.channelId] !== undefined);
  const md = useMemo(() => markdownContext(users, roles, selfId, inGuild), [users, roles, selfId, inGuild]);
  return (
    <div className="max-h-60 overflow-hidden rounded-lg border border-edge bg-bg-main p-3 shadow-sm">
      <MessageCard message={message} md={md} />
    </div>
  );
}

/** "Mesajı Sabitle": önizlemeli onaydan sonra sabitler */
export async function confirmPin(message: Message): Promise<void> {
  const ok = await confirmDialog({
    title: 'Mesajı Sabitle',
    message: 'Bu mesajı bu kanala sabitlemek istediğine emin misin?',
    preview: <ConfirmPreview message={message} />,
    confirmLabel: 'Tamam',
  });
  if (ok) void pinMessage(message);
}

/** "Sabitlemeyi Kaldır": önizlemeli onaydan sonra kaldırır */
export async function confirmUnpin(message: Message, skipConfirm = false): Promise<void> {
  const ok =
    skipConfirm ||
    (await confirmDialog({
      title: 'Sabitlemeyi Kaldır',
      message: 'Bu sabitlenmiş mesajı kaldırmak istediğine emin misin?',
      preview: <ConfirmPreview message={message} />,
      confirmLabel: 'Sabitlemeyi Kaldır',
      danger: true,
    }));
  if (ok) void unpinMessage(message);
}

const EMPTY_PINS: ChannelPins = { items: [], loading: false, loaded: false, stale: false };
const MARGIN = 8;
const GAP = 6;

/** Kanal başlığındaki raptiye düğmesi ve açtığı "Sabitlenmiş Mesajlar" listesi */
export function PinsButton({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const unseen = usePins((s) => Boolean(s.unseen[channelId]));
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchor}
        data-tooltip={open ? undefined : 'Sabitlenmiş Mesajlar'}
        aria-label="Sabitlenmiş Mesajlar"
        aria-expanded={open}
        className={cn(
          'press-icon relative rounded p-1',
          open ? 'text-text-head' : 'text-text-muted hover:text-text-normal',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <PinIcon size={22} className="ico-pin" />
        {unseen && !open && (
          <span className="absolute right-0.5 bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-main bg-danger" />
        )}
      </button>
      <PinsPopout channelId={channelId} open={open} anchorRef={anchor} onClose={() => setOpen(false)} />
    </>
  );
}

function PinsPopout({
  channelId,
  open,
  anchorRef,
  onClose,
}: {
  channelId: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { value: shown, closing } = usePresence(open || null, 100);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; maxHeight: number } | null>(null);
  const pins = usePins((s) => s.channels[channelId] ?? EMPTY_PINS);
  const canPin = useCan(Permission.PIN_MESSAGES, channelId);
  const users = useGuild((s) => s.users);
  const roles = useGuild((s) => s.roles);
  const selfId = useSession((s) => s.user?.id);
  const inGuild = useGuild((s) => s.channelGuild[channelId] !== undefined);
  const md = useMemo(() => markdownContext(users, roles, selfId, inGuild), [users, roles, selfId, inGuild]);

  // Açıkken liste güncel tutulur; açılınca "yeni sabitleme" noktası söner
  useEffect(() => {
    if (!open) return;
    return openPins(channelId);
  }, [open, channelId]);

  // Düğmenin altında, sağ kenarı düğmeyle hizalı; ekranın içinde kalır
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchorRef.current;
    if (!shown || !el || !a) return;
    const place = (): void => {
      const r = a.getBoundingClientRect();
      const width = el.offsetWidth;
      const x = Math.max(MARGIN, Math.min(r.right - width, window.innerWidth - width - MARGIN));
      const y = r.bottom + GAP;
      const maxHeight = Math.max(200, window.innerHeight - y - MARGIN);
      setPos((p) => (p && p.x === x && p.y === y && p.maxHeight === maxHeight ? p : { x, y, maxHeight }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown, anchorRef]);

  // Dışarı tıklayınca kapanır (onay penceresi açıkken ona tıklamak kapatmaz)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (useDialog.getState().current) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);
  useEscapeLayer(onClose, open);

  if (!shown) return null;

  const jump = (message: Message): void => {
    onClose();
    void jumpToPinned(message);
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Sabitlenmiş Mesajlar"
      className={cn(
        'fixed z-50 flex w-[440px] flex-col overflow-hidden rounded-lg border border-edge bg-bg-side shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
        closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
      )}
      style={
        pos
          ? { left: pos.x, top: pos.y, maxHeight: Math.min(pos.maxHeight, 640), transformOrigin: '100% 0' }
          : { left: -9999, top: -9999, visibility: 'hidden' }
      }
      // Portal içindeki tıklamalar React'te kanal başlığına kabarcıklanır (başlık üye listesini açıp kapatır)
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line/60 px-4">
        <PinIcon size={18} className="text-text-muted" />
        <span className="font-semibold text-text-head">Sabitlenmiş Mesajlar</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!pins.loaded ? (
          <div className="flex flex-col gap-2 p-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-bg-main" />
            ))}
          </div>
        ) : pins.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-main text-text-muted">
              <PinIcon size={26} />
            </div>
            <div className="font-semibold text-text-head">Burada henüz sabitlenmiş mesaj yok</div>
            <div className="text-sm text-text-muted">
              Önemli mesajları kaybetmemek için sağ tıklayıp <strong>Mesajı Sabitle</strong>'yi seç.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {pins.items.map((m) => (
              <div
                key={m.id}
                className="group/pin relative rounded-lg border border-edge bg-bg-main p-3 transition-colors hover:border-line"
              >
                <MessageCard message={m} md={md} full />
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/pin:opacity-100 focus-within:opacity-100">
                  <button
                    className="press rounded bg-bg-side px-2 py-0.5 text-xs font-medium text-text-normal shadow hover:bg-bg-hover hover:text-text-head"
                    onClick={() => jump(m)}
                  >
                    Atla
                  </button>
                  {canPin && (
                    <button
                      data-tooltip="Sabitlemeyi kaldır (Shift ile onaysız)"
                      aria-label="Sabitlemeyi kaldır"
                      className="press-icon rounded bg-bg-side p-1 text-text-muted shadow hover:bg-bg-hover hover:text-text-head"
                      onClick={(e) => void confirmUnpin(m, e.shiftKey)}
                    >
                      <X size={14} className="ico-rotate" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
