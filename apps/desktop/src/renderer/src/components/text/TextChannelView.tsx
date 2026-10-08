import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Hash, Phone, PhoneCall, Upload, UserPlus, Users } from 'lucide-react';
import { DM_GROUP_MAX_PARTICIPANTS, Permission, type Channel, type DmChannel } from '@diskort/shared';
import {
  ackChannel,
  addFiles,
  dmBlockedReason,
  dmPartner,
  loadInitial,
  useCan,
  useCanCallDm,
  useDmCall,
  useIsBlocked,
  useMessages,
  useGuild,
  useSession,
} from '@diskort/client-core';
import { cn } from '../../lib/utils';
import { toast, useUi } from '../../stores/ui';
import { DmAvatar } from '../dms/DmAvatar';
import { DmCallPanel } from '../dms/DmCallPanel';
import { DmMembers } from '../dms/DmMembers';
import { FriendButton } from '../friends/FriendButton';
import { unblock } from '../../lib/blocks';
import { joinDmCall } from '../../lib/calls';
import { useVoice } from '../../stores/voice';
import { MemberList } from '../members/MemberList';
import { toLocalFiles } from '../../features/messages/files';
import { Composer, type ComposerHandle } from './Composer';
import { MessageList } from './MessageList';
import { PinsButton } from './Pins';
import { SearchBox, SearchPanel, useSearchOpen } from '../search/Search';

const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files');

/**
 * Metin kanalı ya da direkt mesaj konuşması (`dm` verilir; `channel.name` konuşmanın görünen adıdır):
 * başlık, mesaj listesi, yazma kutusu ve "yazıyor" göstergesi.
 */
export function TextChannelView({ channel, dm }: { channel: Pick<Channel, 'id' | 'name'>; dm?: DmChannel }) {
  const self = useSession((s) => s.user)!;
  const loaded = useMessages((s) => s.channels[channel.id]?.loaded ?? false);
  const lastId = useGuild((s) => s.lastMessageIds[channel.id]);
  const readId = useGuild((s) => s.readStates[channel.id]);
  const [atBottom, setAtBottom] = useState(true);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [scrollSignal, setScrollSignal] = useState(0);
  const composer = useRef<ComposerHandle>(null);
  const canAttach = useCan(Permission.SEND_MESSAGES | Permission.ATTACH_FILES, channel.id);
  const memberListOpen = useUi((s) => s.memberListOpen);
  // Arama kapsamı: açık konuşma ya da seçili sunucu; sonuçlar açıkken üye listesinin yerinde
  const guildId = useGuild((s) => s.guild?.id ?? '');
  const guildName = useGuild((s) => s.guild?.name ?? '');
  const searchScope = useMemo(() => (dm ? { dmId: dm.id } : { guildId }), [dm, guildId]);
  const searchOpen = useSearchOpen(searchScope);
  // Bire bir konuşmada karşı taraf ayrıldıysa ya da engel varsa yazma kutusu yerine neden gösterilir (karşı
  // tarafı sen engellediysen açıkça, seni engellediyse yalnızca genel bir metin)
  const blocked = useGuild((s) => (dm ? dmBlockedReason(dm, s.users, self.id, s.reachable, s.blockedIds) : null));
  const partner = useGuild((s) => (dm ? dmPartner(dm, s.users, self.id) : undefined));
  const partnerBlocked = useIsBlocked(dm && !dm.group ? partner?.id : null);
  // Arama alanı konuşmanın tamamını kaplıyor mu (mesajlar gizli)
  const [callExpanded, setCallExpanded] = useState(false);
  const inThisCall = useVoice((s) => Boolean(dm) && s.channelId === dm?.id && s.status !== 'idle');
  useEffect(() => {
    if (!inThisCall) setCallExpanded(false);
  }, [inThisCall]);
  const callShown = Boolean(dm) && inThisCall && callExpanded;
  // Adı kanal gibi "#ad", bire bir konuşmada "@ad" olarak geçer
  const label = dm ? (dm.group ? channel.name : `@${channel.name}`) : `#${channel.name}`;

  // Kanal açıldığında okunmamış ilk mesajın üstüne "YENİ" ayracı konur.
  const readAtOpen = useRef(readId);
  const [dividerId, setDividerId] = useState<string | null>(null);
  const dividerDecided = useRef(false);
  const messages = useMessages((s) => s.channels[channel.id]?.messages);

  useEffect(() => {
    void loadInitial(channel.id);
  }, [channel.id]);

  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const watching = focused && atBottom;

  useEffect(() => {
    if (!loaded || !messages) return;
    if (!dividerDecided.current) {
      dividerDecided.current = true;
      const first = messages.find(
        (m) => !m.status && m.authorId !== self.id && Number(m.id) > Number(readAtOpen.current ?? 0),
      );
      setDividerId(first?.id ?? null);
      return;
    }
    // Bakmıyorken gelen ilk mesaj için ayraç
    if (!watching && dividerId === null && lastId && Number(lastId) > Number(readId ?? 0)) {
      const first = messages.find((m) => !m.status && m.authorId !== self.id && Number(m.id) > Number(readId ?? 0));
      if (first) setDividerId(first.id);
    }
  }, [loaded, messages, watching, dividerId, lastId, readId, self.id]);

  // Kanal görünür, pencere odakta ve en alttaysa okundu say
  useEffect(() => {
    if (loaded && watching && lastId && Number(lastId) > Number(readId ?? 0)) ackChannel(channel.id);
  }, [loaded, watching, lastId, readId, channel.id]);

  // Herhangi bir yere yazmaya başlayınca yazma kutusuna odaklan
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || useUi.getState().modal)) return;
      composer.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const unreadBelow = !atBottom && lastId !== undefined && Number(lastId) > Number(readId ?? 0);

  // Dosya sürükleyip bırakma: alt öğelere girip çıkarken titremesin diye derinlik sayılır
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dropHandlers = {
    onDragEnter: (e: DragEvent): void => {
      if (!hasFiles(e) || !canAttach) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent): void => {
      if (!hasFiles(e) || !canAttach) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!canAttach) {
        toast('Bu kanala dosya gönderme iznin yok.', 'error');
        return;
      }
      dragDepth.current = 0;
      setDragging(false);
      addFiles(channel.id, toLocalFiles(e.dataTransfer.files));
      composer.current?.focus();
    },
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg-main">
      {/* Discord gibi: başlık sohbetin ve üye listesinin üstünde tam genişlikte, arama kutusu listenin hizasında.
          Üye listesi yalnızca düğmeyle açılıp kapanır (başlığa tıklamak telefona özgü) */}
      <header className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-bg-main pr-2 pl-4 shadow-sm">
        {dm ? <DmAvatar dm={dm} size={24} status /> : <Hash size={22} className="text-text-muted" />}
        <span className="min-w-0 truncate font-semibold text-text-head">{channel.name}</span>
        {partner && <span className="min-w-0 truncate text-sm text-text-muted">@{partner.username}</span>}
        <span className="flex-1" />
        {/* Bire bir konuşmada karşı tarafla arkadaşlık (engellediysen gösterilmez) */}
        {dm && !dm.group && partner && <FriendButton userId={partner.id} variant="header" />}
        {dm && <CallButton dmId={dm.id} />}
        {dm?.group && dm.participantIds.length < DM_GROUP_MAX_PARTICIPANTS && (
          <button
            data-tooltip="Kişi ekle"
            aria-label="Kişi ekle"
            className="press-icon rounded p-1 text-text-muted hover:text-text-normal"
            onClick={() => useUi.getState().openModal({ type: 'newDm', addTo: dm.id })}
          >
            <UserPlus size={22} className="ico-pop" />
          </button>
        )}
        <PinsButton key={channel.id} channelId={channel.id} />
        <button
          data-tooltip={memberListOpen ? 'Üye listesini gizle' : 'Üye listesini göster'}
          aria-label={memberListOpen ? 'Üye listesini gizle' : 'Üye listesini göster'}
          aria-pressed={memberListOpen}
          className={cn(
            'press-icon rounded p-1',
            memberListOpen ? 'text-text-head' : 'text-text-muted hover:text-text-normal',
          )}
          onClick={() => useUi.getState().toggleMemberList()}
        >
          <Users size={22} className="ico-spread" />
        </button>
        <SearchBox scope={searchScope} placeholder={dm ? 'Ara' : guildName ? `${guildName} sunucusunu ara` : 'Sunucuda ara'} />
      </header>
      {dm && <DmCallPanel dm={dm} expanded={callExpanded} onToggleExpand={() => setCallExpanded((v) => !v)} />}
      <div className={cn('flex min-h-0 flex-1', callShown && 'hidden')}>
        <div className="anim-fade-in relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg-main" {...dropHandlers}>
          {dragging && (
            <div className="anim-fade-in pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/60">
              <div className="anim-modal-in flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-white/60 bg-brand px-10 py-8 text-white shadow-2xl">
                <Upload size={40} />
                <div className="text-lg font-bold">{dm ? `${label} ile paylaş` : `${label} kanalına yükle`}</div>
                <div className="text-sm text-white/80">Göndermeden önce bir not ekleyebilirsin.</div>
              </div>
            </div>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col">
            {unreadBelow && (
              <button
                className="anim-bar-in absolute top-0 right-4 left-4 z-10 flex items-center justify-between rounded-b-lg bg-brand px-3 py-1 text-sm font-medium text-white shadow transition-colors hover:bg-brand-hover"
                onClick={() => setScrollSignal((n) => n + 1)}
              >
                <span>Yeni mesajların var</span>
                <span>Şimdiye atla ↓</span>
              </button>
            )}
            <MessageList
              channel={channel}
              dm={dm}
              self={self}
              dividerId={dividerId}
              onAtBottomChange={setAtBottom}
              scrollToBottomSignal={scrollSignal}
            />
          </div>

          <Composer
            ref={composer}
            channel={channel}
            self={self}
            placeholder={dm ? `${label} ${dm.group ? 'grubuna' : 'kişisine'} mesaj gönder` : undefined}
            lockedText={blocked ?? undefined}
            lockedAction={
              partnerBlocked && partner
                ? { label: 'Engeli kaldır', onClick: () => void unblock(partner.id) }
                : undefined
            }
            mentionable={dm?.participantIds}
            onSend={() => {
              setDividerId(null);
              setScrollSignal((n) => n + 1);
            }}
          />
          <TypingIndicator channelId={channel.id} selfId={self.id} />
        </div>
        {searchOpen ? <SearchPanel /> : memberListOpen && (dm ? <DmMembers dm={dm} /> : <MemberList />)}
      </div>
    </div>
  );
}

/**
 * Konuşma başlığındaki arama düğmesi: arama yoksa "Ara" (başlatır, diğerleri çalınır), süren aramada değilsen
 * "Aramaya katıl"; zaten aramadaysan gösterilmez. Salt okunur konuşmada devre dışı.
 */
function CallButton({ dmId }: { dmId: string }) {
  const canCall = useCanCallDm(dmId);
  const call = useDmCall(dmId);
  const inCall = useVoice((s) => s.channelId === dmId && s.status !== 'idle');
  if (inCall) return null;
  if (call) {
    return (
      <button
        data-tooltip={canCall ? 'Aramaya katıl' : 'Bu konuşmada arama yapılamaz'}
        aria-label="Aramaya katıl"
        disabled={!canCall}
        className="press flex h-7 items-center gap-1.5 rounded-full bg-ok px-3 text-sm font-semibold text-white transition-colors hover:bg-ok-hover disabled:opacity-40"
        onClick={() => void joinDmCall(dmId)}
      >
        <PhoneCall size={16} aria-hidden /> Aramaya katıl
      </button>
    );
  }
  return (
    <button
      data-tooltip={canCall ? 'Sesli arama başlat' : 'Bu konuşmada arama yapılamaz'}
      aria-label="Ara"
      aria-disabled={!canCall || undefined}
      className={cn(
        'press-icon rounded p-1',
        canCall ? 'text-text-muted hover:text-text-normal' : 'cursor-not-allowed text-text-muted opacity-40',
      )}
      onClick={canCall ? () => void joinDmCall(dmId) : undefined}
    >
      <Phone size={22} className="ico-nod" />
    </button>
  );
}

function TypingIndicator({ channelId, selfId }: { channelId: string; selfId: string }) {
  const typing = useMessages((s) => s.typing[channelId]);
  const users = useGuild((s) => s.users);
  const names = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName)
    .filter((n): n is string => Boolean(n));

  let text = '';
  if (names.length === 1) text = `${names[0]} yazıyor…`;
  else if (names.length === 2) text = `${names[0]} ve ${names[1]} yazıyor…`;
  else if (names.length === 3) text = `${names[0]}, ${names[1]} ve ${names[2]} yazıyor…`;
  else if (names.length > 3) text = 'Birkaç kişi yazıyor…';

  return (
    <div className="flex h-6 shrink-0 items-center gap-1.5 px-4 text-xs text-text-normal">
      {text && (
        <span className="anim-fade-in flex min-w-0 items-center gap-1.5">
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-normal"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
          <span className="truncate">
            <strong>{text.replace(/ yazıyor…$/, '')}</strong> yazıyor…
          </span>
        </span>
      )}
    </div>
  );
}
