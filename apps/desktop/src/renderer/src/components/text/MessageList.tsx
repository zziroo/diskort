import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Hash } from 'lucide-react';
import type { Channel, DmChannel, User } from '@diskort/shared';
import { clearJump, dmPartner, loadOlder, useMessages, type LocalMessage, useGuild } from '@diskort/client-core';
import { DmAvatar } from '../dms/DmAvatar';
import type { MarkdownContext } from '../../features/messages/markdown';
import { animate, riseIn } from '../../lib/motion';
import { MessageSkeleton } from '../ui/Skeleton';
import { CallMessage } from './CallMessage';
import { MessageItem } from './MessageItem';
import { BrokenMessage, ErrorBoundary } from '../ErrorBoundary';
import { formatDay, sameDay } from './format';

const GROUP_WINDOW_MS = 7 * 60_000;
const STICK_THRESHOLD_PX = 24;
const LOAD_OLDER_THRESHOLD_PX = 600;

const EMPTY: LocalMessage[] = [];

const keyOf = (m: LocalMessage): string => m.nonce ?? m.id;

interface Props {
  channel: Pick<Channel, 'id' | 'name'>;
  /** Direkt mesaj konuşmasıysa (başlangıçtaki tanıtım farklıdır) */
  dm?: DmChannel;
  self: User;
  /** "YENİ" ayracının üstünde duracağı mesaj */
  dividerId: string | null;
  onAtBottomChange: (atBottom: boolean) => void;
  /** Dışarıdan "en alta kaydır" isteği (sayaç arttıkça) */
  scrollToBottomSignal: number;
}

export function MessageList({ channel, dm, self, dividerId, onAtBottomChange, scrollToBottomSignal }: Props) {
  const messages = useMessages((s) => s.channels[channel.id]?.messages ?? EMPTY);
  const hasMore = useMessages((s) => s.channels[channel.id]?.hasMore ?? true);
  const loaded = useMessages((s) => s.channels[channel.id]?.loaded ?? false);
  const editingId = useMessages((s) => s.editingId);
  const jump = useMessages((s) => s.jump);
  const users = useGuild((s) => s.users);
  const roles = useGuild((s) => s.roles);

  // Rol etiketleri yalnızca sunucu kanalında (direkt mesajda rol yoktur)
  const md: MarkdownContext = useMemo(
    () => ({
      usersByName: Object.fromEntries(Object.values(users).map((u) => [u.username, u])),
      selfId: self.id,
      roles: dm ? undefined : roles,
      selfRoleIds: dm ? undefined : users[self.id]?.roles,
    }),
    [users, roles, dm, self.id],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const snapshot = useRef<{ firstId: string | undefined; height: number; top: number }>({
    firstId: undefined,
    height: 0,
    top: 0,
  });

  // Yeni mesajda en altta kal; eski mesajlar yukarı eklenince görünen konumu koru.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    const prev = snapshot.current;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (prev.firstId !== firstId) el.scrollTop = prev.top + (el.scrollHeight - prev.height);
    snapshot.current = { firstId, height: el.scrollHeight, top: el.scrollTop };
  }, [messages, hasMore]);

  // Yeni gelen mesajlar hafifçe yükselerek belirir; geçmiş yüklenirken ve eski mesajlar eklenirken
  // animasyon oynatılmaz. Bekleyen mesajımız onaylanınca (anahtarı değişir) yeniden oynatılmaz.
  const rendered = useRef<Map<string, LocalMessage>>(new Map());
  const armed = useRef(false);
  useLayoutEffect(() => {
    const prev = rendered.current;
    const next = new Map(messages.map((m) => [keyOf(m), m]));
    if (!loaded) {
      armed.current = false;
    } else if (!armed.current) {
      armed.current = true;
      // Geçmiş ilk kez geldi: iskeletten içeriğe yumuşak geçiş
      animate(contentRef.current, [{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    } else {
      let lastKnown = -1;
      messages.forEach((m, i) => {
        if (prev.has(keyOf(m))) lastKnown = i;
      });
      const confirmed = new Set(
        [...prev.entries()].filter(([key, m]) => m.status === 'pending' && !next.has(key)).map(([, m]) => m.content),
      );
      for (const m of messages.slice(lastKnown + 1)) {
        if (!m.status && m.authorId === self.id && confirmed.has(m.content)) continue;
        riseIn(contentRef.current?.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`));
      }
    }
    rendered.current = next;
  }, [messages, loaded, self.id]);

  // Pencere/yazma kutusu boyutu değişince de altta kal
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      snapshot.current.height = el.scrollHeight;
      snapshot.current.top = el.scrollTop;
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (scrollToBottomSignal === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
  }, [scrollToBottomSignal]);

  // Yanıtın alıntısına tıklanınca asıl mesaja kaydır ve kısa süre vurgula
  useLayoutEffect(() => {
    if (!jump || jump.channelId !== channel.id) return;
    const target = contentRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jump.messageId)}"]`);
    if (!target) return;
    clearJump(jump.seq);
    stick.current = false;
    onAtBottomChange(false);
    // Anında (Discord gibi): yumuşak kaydırmanın ilk adımları "en altta" sayılıp listeyi geri çekebilir
    target.scrollIntoView({ block: 'center' });
    // Sınıf değil Web Animations: satır yeniden çizilince (className) vurgu silinmesin; son kare örtük
    // olduğundan satırın kendi arka planına (ör. bahsetme rengi) döner
    const flash = 'rgb(88 101 242 / 0.22)';
    animate(target, [{ backgroundColor: flash, offset: 0 }, { backgroundColor: flash, offset: 0.4 }], {
      duration: 2000,
      easing: 'ease-out',
    });
  }, [jump, messages, channel.id, onAtBottomChange]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    if (atBottom !== stick.current) onAtBottomChange(atBottom);
    stick.current = atBottom;
    snapshot.current.top = el.scrollTop;
    snapshot.current.height = el.scrollHeight;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX && loaded) void loadOlder(channel.id);
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll" onScroll={onScroll}>
      <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-6">
        {!loaded && !messages.length ? (
          <MessageSkeleton rows={8} className="shrink-0" />
        ) : hasMore || !loaded ? (
          <MessageSkeleton rows={2} className="shrink-0 pb-2" />
        ) : dm ? (
          <DmIntro dm={dm} name={channel.name} selfId={self.id} />
        ) : (
          <div className="anim-fade-in mx-4 mt-4 mb-2">
            <div className="mb-2 flex h-[68px] w-[68px] items-center justify-center rounded-full bg-bg-active">
              <Hash size={42} className="text-text-head" />
            </div>
            <h2 className="text-[32px] leading-tight font-bold text-text-head">#{channel.name} kanalına hoş geldin!</h2>
            <p className="text-text-muted">Bu, #{channel.name} kanalının başlangıcı.</p>
          </div>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
          const divider = m.id === dividerId;
          // Yanıt her zaman başlıklı gösterilir (üstünde alıntısı olur)
          const compact =
            !!prev &&
            !newDay &&
            !divider &&
            !m.replyToId &&
            prev.type !== 'call' &&
            m.type !== 'call' &&
            prev.authorId === m.authorId &&
            prev.status !== 'failed' &&
            m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
          return (
            <Fragment key={m.nonce ?? m.id}>
              {(newDay || divider) && <Separator day={newDay ? m.createdAt : null} unread={divider} />}
              {/* Bozuk veri tek mesajı düşürür, kanalın tamamını değil */}
              <ErrorBoundary where="mesaj" resetKey={m} fallback={<BrokenMessage />}>
                {m.type === 'call' ? (
                  <CallMessage message={m} author={m.authorId ? users[m.authorId] : undefined} self={self} />
                ) : (
                  <MessageItem
                    message={m}
                    author={m.authorId ? users[m.authorId] : undefined}
                    compact={compact}
                    editing={editingId === m.id}
                    self={self}
                    md={md}
                  />
                )}
              </ErrorBoundary>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Konuşmanın başı: kiminle (ya da hangi grupla) konuşulduğu */
function DmIntro({ dm, name, selfId }: { dm: DmChannel; name: string; selfId: string }) {
  const partner = useGuild((s) => dmPartner(dm, s.users, selfId));
  return (
    <div className="anim-fade-in mx-4 mt-4 mb-2">
      <DmAvatar dm={dm} size={80} className="mb-3" decorated />
      <h2 className="text-[32px] leading-tight font-bold text-text-head">{name}</h2>
      {partner && <div className="mb-2 text-lg text-text-normal">@{partner.username}</div>}
      <p className="text-text-muted">
        {dm.group ? (
          <>
            <strong className="text-text-normal">{name}</strong> grubunun başlangıcı.
          </>
        ) : (
          <>
            <strong className="text-text-normal">{name}</strong> ile direkt mesaj geçmişinin başlangıcı.
          </>
        )}{' '}
        Bu konuşmayı yalnızca {dm.group ? 'gruptakiler' : 'ikiniz'} görebilir.
      </p>
    </div>
  );
}

function Separator({ day, unread }: { day: number | null; unread: boolean }) {
  const color = unread ? 'bg-danger' : 'bg-line';
  return (
    <div className="relative mx-4 mt-6 mb-2 flex h-0 items-center">
      <div className={`h-px flex-1 ${color}`} />
      {day !== null && (
        <span className="bg-bg-main px-1 text-xs font-semibold text-text-muted">{formatDay(day)}</span>
      )}
      {day !== null && <div className={`h-px flex-1 ${color}`} />}
      {unread && (
        <span className="absolute right-0 rounded-sm bg-danger px-1 text-[10px] leading-4 font-bold text-white">
          YENİ
        </span>
      )}
    </div>
  );
}
