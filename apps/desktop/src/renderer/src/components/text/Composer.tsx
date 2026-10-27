import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { AtSign, CirclePlus, Lock, X } from 'lucide-react';
import { MESSAGE_MAX_LENGTH, Permission, type Channel, type Role, type User } from '@diskort/shared';
import {
  addFiles,
  broadcastSuggestions,
  encodeRoleMentions,
  typableRoles,
  formatBytes,
  insertText,
  notifyTyping,
  registerComposer,
  removeFile,
  roleMentionText,
  roleSuggestions,
  sendMessage,
  setEditing,
  useCan,
  useMessages,
  useGuild,
  type BroadcastMention,
  type LocalFile,
} from '@diskort/client-core';
import { toLocalFiles } from '../../features/messages/files';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import { PresenceAvatar } from '../ui/Avatar';
import { FileIcon } from './Attachments';
import { ComposerToolbar } from './ComposerToolbar';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { ReplyBar } from './ReplyBar';

/** Kanal değiştirince yarım kalan mesaj kaybolmasın */
const drafts = new Map<string, string>();

// Rol adlarında Türkçe harfler olabilir; boşluk içeren rol adının ilk sözcüğüyle aranır
const MENTION_QUERY = /(?:^|[\s(])@([a-z0-9_.çğıöşüâîûÇĞİÖŞÜÂÎÛ]{0,32})$/i;
const MAX_SUGGESTIONS = 8;
const MAX_ROLE_SUGGESTIONS = 5;
const NO_FILES: LocalFile[] = [];
const NO_ROLES: Record<string, Role> = {};

/** Bahsetme önerisi: üye, rol (sunucu kanalında) ya da (yetkisi varsa) @everyone / @here */
type Suggestion =
  | { kind: 'user'; user: User }
  | { kind: 'role'; role: Role }
  | { kind: 'broadcast'; mention: BroadcastMention };

export interface ComposerHandle {
  focus: () => void;
}

/** Yazma kutusunun üstündeki eklenmiş dosyalar (resimler küçük önizlemeyle) */
function FileTray({ channelId, files }: { channelId: string; files: LocalFile[] }) {
  return (
    <div className="flex gap-2 overflow-x-auto border-b border-edge px-3 pt-3 pb-2">
      {files.map((file, i) => (
        <div key={`${file.name}-${i}`} className="anim-pop-in group/file relative w-[132px] shrink-0 rounded-md bg-bg-side p-2">
          <FilePreview file={file} />
          <div className="mt-1.5 truncate text-xs text-text-normal" data-tooltip={file.name}>
            {file.name}
          </div>
          <div className="text-[11px] text-text-muted">{formatBytes(file.size)}</div>
          <button
            className="press-icon absolute -top-1.5 -right-1.5 rounded-full bg-bg-float p-1 text-text-muted shadow hover:text-danger"
            data-tooltip="Kaldır"
            aria-label="Kaldır"
            onClick={() => removeFile(channelId, i)}
          >
            <X size={14} className="ico-rotate" />
          </button>
        </div>
      ))}
    </div>
  );
}

function FilePreview({ file }: { file: LocalFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.blob || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    const objectUrl = URL.createObjectURL(file.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return (
    <div className="flex h-[84px] items-center justify-center overflow-hidden rounded bg-bg-main">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <FileIcon type={file.type} size={36} className="text-text-muted" />
      )}
    </div>
  );
}

interface Props {
  channel: Pick<Channel, 'id' | 'name'>;
  self: User;
  onSend: () => void;
  /** Kutudaki ipucu (verilmezse "#kanal kanalına mesaj gönder") */
  placeholder?: string;
  /** Yazılamıyorsa kutu yerine gösterilecek açıklama (verilmezse izin yok mesajı) */
  lockedText?: string;
  /** Açıklamanın yanındaki düğme (ör. engellediğin kişide "Engeli kaldır") */
  lockedAction?: { label: string; onClick: () => void };
  /** Bahsetme önerilerinde yalnızca bu kişiler (ör. konuşmanın katılımcıları) */
  mentionable?: readonly string[];
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { channel, self, onSend, placeholder, lockedText, lockedAction, mentionable },
  handle,
) {
  const [value, setValue] = useState(() => drafts.get(channel.id) ?? '');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const ref = useRef<MarkdownEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = useMessages((s) => s.pendingFiles[channel.id] ?? NO_FILES);
  const users = useGuild((s) => s.users);
  const online = useGuild((s) => s.online);
  const usernames = useMemo(() => new Set(Object.values(users).map((u) => u.username)), [users]);
  const isUsername = useCallback((name: string) => usernames.has(name), [usernames]);
  // Rol etiketi yalnızca sunucu kanalında (direkt mesajda `mentionable` verilir, rol yoktur)
  const roleScope = useGuild((s) => (mentionable ? null : (s.channelGuild[channel.id] ?? null)));
  const roles = useGuild((s) => (roleScope ? (s.guilds[roleScope]?.roles ?? NO_ROLES) : NO_ROLES));
  const canSend = useCan(Permission.SEND_MESSAGES, channel.id);
  const canAttach = useCan(Permission.ATTACH_FILES, channel.id);
  // @everyone / @here yalnızca yetkisi olana önerilir (direkt mesajda bu yetki yoktur)
  const canMentionEveryone = useCan(Permission.MENTION_EVERYONE, channel.id);

  useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);

  // ---------- @bahsetme önerileri ----------
  const query = MENTION_QUERY.exec(value.slice(0, caret))?.[1];
  const suggestions = useMemo((): Suggestion[] => {
    if (query === undefined || query === dismissed) return [];
    const q = query.toLocaleLowerCase('tr');
    const members = Object.values(users)
      .filter((u) => !u.removed && (!mentionable || mentionable.includes(u.id)))
      .filter((u) => u.username.startsWith(q) || u.displayName.toLocaleLowerCase('tr').includes(q))
      .sort((a, b) => Number(!!online[b.id]) - Number(!!online[a.id]) || a.username.localeCompare(b.username))
      .slice(0, MAX_SUGGESTIONS);
    const roleItems = roleScope ? roleSuggestions(q, roles, roleScope, MAX_ROLE_SUGGESTIONS) : [];
    return [
      ...members.map((user): Suggestion => ({ kind: 'user', user })),
      ...roleItems.map((role): Suggestion => ({ kind: 'role', role })),
      ...broadcastSuggestions(q, canMentionEveryone).map((mention): Suggestion => ({ kind: 'broadcast', mention })),
    ];
  }, [query, dismissed, users, online, mentionable, canMentionEveryone, roles, roleScope]);
  const active = Math.min(selected, Math.max(0, suggestions.length - 1));

  const update = (next: string, nextCaret: number): void => {
    setValue(next);
    setCaret(nextCaret);
    setSelected(0);
    if (next) drafts.set(channel.id, next);
    else drafts.delete(channel.id);
  };

  /** Emoji panelinden: metni imlecin olduğu yere (seçiliyse yerine) ekler */
  const insert = (text: string): void => {
    const editor = ref.current;
    if (!editor) return;
    const { start, end } = editor.getSelection();
    editor.replace(start, end, text);
  };
  const focusInput = useCallback(() => ref.current?.focus(), []);

  const pick = (suggestion: Suggestion): void => {
    // Rol kutuda adıyla görünür (`@Rol Adı`); gönderirken gömülü biçime çevrilir (bkz. send)
    const text =
      suggestion.kind === 'role'
        ? roleMentionText(suggestion.role, isUsername)
        : `@${suggestion.kind === 'user' ? suggestion.user.username : suggestion.mention.name} `;
    const typed = /@[a-z0-9_.çğıöşüâîûÇĞİÖŞÜÂÎÛ]*$/i.exec(value.slice(0, caret));
    // Değer editörün onChange'iyle güncellenir (bkz. update)
    ref.current?.replace(typed ? typed.index : caret, caret, text);
  };

  // Dışarıdan erişim (ada tıklayınca bahsetme, "Yanıtla" deyince odaklanma): bkz. client-core/composer
  const insertAtCaret = useRef((_text: string) => {});
  insertAtCaret.current = (text: string): void => {
    const editor = ref.current;
    if (!editor) return;
    const current = editor.getText();
    const { start, end } = editor.getSelection();
    const next = insertText(current, start, end, text);
    // insertText araya boşluk koyabilir, sonraki boşluğu yutabilir: değişen aralık [start, sonrası başlangıcı)
    const afterLength = next.value.length - next.caret;
    editor.replace(start, current.length - afterLength, next.value.slice(start, next.caret));
  };
  useEffect(() => {
    if (!canSend) return;
    return registerComposer(channel.id, {
      focus: () => ref.current?.focus(),
      insert: (text) => insertAtCaret.current(text),
    });
  }, [channel.id, canSend]);

  const send = (): void => {
    const typed = value.trim();
    if (!typed && files.length === 0) return;
    // `@Rol Adı` yazıları rol etiketine (`<@&kimlik>`) çevrilir; sınır gönderilecek metne uygulanır
    const content = roleScope ? encodeRoleMentions(typed, typableRoles(roles, roleScope), isUsername) : typed;
    if (content.length > MESSAGE_MAX_LENGTH) {
      toast(`Mesaj en fazla ${MESSAGE_MAX_LENGTH} karakter olabilir.`, 'error');
      return;
    }
    sendMessage(channel.id, content);
    ref.current?.reset('');
    update('', 0);
    onSend();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((active + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(query ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !value) {
      // Discord gibi: boş kutuda yukarı ok son mesajını düzenler
      const own = useMessages
        .getState()
        .channels[channel.id]?.messages.findLast((m) => m.authorId === self.id && !m.status && m.type !== 'call');
      if (own) {
        e.preventDefault();
        setEditing(own.id);
      }
    }
  };

  // Panodaki resim ya da dosya yapıştırılınca eklenir
  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    if (e.clipboardData.files.length === 0) return;
    e.preventDefault();
    if (!canAttach) {
      toast('Bu kanala dosya gönderme iznin yok.', 'error');
      return;
    }
    addFiles(channel.id, toLocalFiles(e.clipboardData.files));
  };

  const remaining = MESSAGE_MAX_LENGTH - value.trim().length;

  // Salt okunur kanal: yazma kutusu yerine açıklama
  if (!canSend || lockedText) {
    return (
      <div className="px-4">
        <div className="flex min-h-11 items-center gap-2 rounded-lg bg-bg-hover px-4 text-text-muted">
          <Lock size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{lockedText ?? 'Bu kanala mesaj gönderme iznin yok.'}</span>
          {lockedAction && (
            <button
              type="button"
              onClick={lockedAction.onClick}
              className="press shrink-0 rounded bg-bg-raised px-3 py-1 text-sm font-medium text-text-head transition-colors hover:bg-bg-raised-hover"
            >
              {lockedAction.label}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative px-4">
      {suggestions.length > 0 && (
        <div
          className="anim-drop-in absolute right-4 bottom-full left-4 mb-2 origin-bottom overflow-hidden rounded-lg border border-edge bg-bg-side py-2 shadow-xl"
          style={{ ['--drop-from' as string]: '6px' }}
        >
          <div className="px-3 pb-1 text-xs font-bold text-text-muted uppercase">Üyeler</div>
          {suggestions.map((item, i) => (
            <button
              key={
                item.kind === 'user' ? item.user.id : item.kind === 'role' ? `&${item.role.id}` : `@${item.mention.name}`
              }
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-75',
                i === active ? 'bg-bg-active text-text-head' : 'text-text-normal',
              )}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
            >
              {item.kind === 'user' ? (
                <>
                  <PresenceAvatar userId={item.user.id} user={item.user} size={24} ringClassName="bg-bg-float" />
                  <span className="font-medium">{item.user.displayName}</span>
                  <span className="text-sm text-text-muted">{item.user.username}</span>
                </>
              ) : item.kind === 'role' ? (
                <>
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                      !item.role.color && 'bg-brand/30 text-mention',
                    )}
                    style={
                      item.role.color ? { color: item.role.color, backgroundColor: `${item.role.color}33` } : undefined
                    }
                  >
                    <AtSign size={14} />
                  </span>
                  <span className="min-w-0 truncate font-medium" style={{ color: item.role.color ?? undefined }}>
                    @{item.role.name}
                  </span>
                  <span className="text-sm text-text-muted">Rol</span>
                </>
              ) : (
                <>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/30 text-mention">
                    <AtSign size={14} />
                  </span>
                  <span className="font-medium">@{item.mention.name}</span>
                  <span className="min-w-0 truncate text-sm text-text-muted">{item.mention.description}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-divider bg-bg-hover">
        <ReplyBar channelId={channel.id} />
        {files.length > 0 && <FileTray channelId={channel.id} files={files} />}
        <div className="flex items-end">
          {canAttach ? (
            <button
              className="press-icon shrink-0 py-[11px] pr-1 pl-3.5 text-text-muted hover:text-text-head"
              data-tooltip="Dosya ekle"
              aria-label="Dosya ekle"
              onClick={() => fileInput.current?.click()}
            >
              <CirclePlus size={22} className="ico-rotate" />
            </button>
          ) : (
            <span className="w-2 shrink-0" />
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(channel.id, toLocalFiles(e.target.files));
              e.target.value = '';
              ref.current?.focus();
            }}
          />
          <MarkdownEditor
            ref={ref}
            initialValue={value}
            autoFocus
            maxLength={MESSAGE_MAX_LENGTH * 2}
            placeholder={placeholder ?? `#${channel.name} kanalına mesaj gönder`}
            onChange={(text, nextCaret, textChanged) => {
              if (!textChanged) {
                setCaret(nextCaret);
                return;
              }
              update(text, nextCaret);
              if (text.trim()) notifyTyping(channel.id);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="max-h-[50vh] min-h-11 w-full min-w-0 flex-1 overflow-y-auto px-2.5 py-[11px] leading-[1.375rem] text-text-normal"
          />
          {remaining < 200 && (
            <span className={cn('shrink-0 px-3 py-3 text-xs', remaining < 0 ? 'text-danger' : 'text-text-muted')}>
              {remaining}
            </span>
          )}
          <ComposerToolbar channelId={channel.id} onEmoji={insert} onClosed={focusInput} onSent={onSend} />
        </div>
      </div>
    </div>
  );
});
