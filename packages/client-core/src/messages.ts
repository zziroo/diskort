import { create } from 'zustand';
import {
  extractMentions,
  extractRoleMentions,
  type DmChannel,
  MESSAGE_MAX_ATTACHMENTS,
  MESSAGE_MAX_REACTIONS,
  MESSAGE_PAGE_SIZE,
  referenceOf,
  TYPING_TIMEOUT_MS,
  type Attachment,
  type Embed,
  type GatewayServerMessage,
  type GifResult,
  type Message,
  type MessageUpdate,
  type Reaction,
} from '@diskort/shared';
import { api, ApiError, errorMessage } from './api';
import { env, type LocalFile } from './env';
import { gateway } from './gateway';
import { gifEmbed } from './gifs';
import { forgetReactionUsers } from './reactions';
import { useGuild } from './guild';
import { useSession } from './session';
import { DELETED_ROLE_LABEL } from './markdown';
import { formatBytes, uploadFile } from './uploads';

/** Gönderilmekte olan mesajın bir dosyası: yüklenen bayt ve yüklendiyse sunucudaki karşılığı */
export interface LocalUpload {
  file: LocalFile;
  sent: number;
  attachment?: Attachment;
}

/** Sunucuya henüz ulaşmamış (pending) veya gönderilemeyen (failed) yerel mesajlar da listede tutulur. */
export type LocalMessage = Message & { status?: 'pending' | 'failed'; nonce?: string; uploads?: LocalUpload[] };

export interface ChannelMessages {
  messages: LocalMessage[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

/** Yazma kutusunun üstündeki "… kişisine yanıt veriliyor": gönderilecek mesaj buna yanıt olur */
export interface ReplyDraft {
  messageId: string;
  /** Asıl mesajın yazarı (hesabı silindiyse null) */
  authorId: string | null;
  /** Asıl yazar bildirilsin mi (Discord'daki "@ AÇIK") */
  mention: boolean;
}

/** Mesaja atlama isteği: arayüz o mesaja kaydırıp kısa süre vurgular, sonra clearJump() çağırır */
export interface JumpRequest {
  channelId: string;
  messageId: string;
  /** Aynı mesaja art arda atlamalar da ayrı istek sayılsın */
  seq: number;
}

interface MessagesStore {
  channels: Record<string, ChannelMessages>;
  /** Kanal → kullanıcı → "yazıyor" göstergesinin bitiş zamanı */
  typing: Record<string, Record<string, number>>;
  /** Kanal → okunmamış bahsetme sayısı (bu oturumda gelenler) */
  mentionCounts: Record<string, number>;
  /** Düzenlenmekte olan mesaj */
  editingId: string | null;
  /** Kanal → yazma kutusuna eklenmiş, mesajla birlikte gönderilecek dosyalar */
  pendingFiles: Record<string, LocalFile[]>;
  /** Kanal → yanıt verilecek mesaj */
  replies: Record<string, ReplyDraft>;
  /** Son mesaja atlama isteği (bkz. jumpToMessage) */
  jump: JumpRequest | null;
}

const initialState = (): MessagesStore => ({
  channels: {},
  typing: {},
  mentionCounts: {},
  editingId: null,
  pendingFiles: {},
  replies: {},
  jump: null,
});

export const useMessages = create<MessagesStore>()(initialState);

export const setEditing = (editingId: string | null): void => useMessages.setState({ editingId });

// Oturum değişince (çıkış / başka hesap) tüm mesaj önbelleği temizlenir.
useSession.subscribe((s, prev) => {
  if (s.token !== prev.token) useMessages.setState(initialState());
});

const EMPTY: ChannelMessages = { messages: [], hasMore: true, loading: false, loaded: false };

function patch(channelId: string, fn: (c: ChannelMessages) => Partial<ChannelMessages>): void {
  useMessages.setState((s) => {
    const current = s.channels[channelId] ?? EMPTY;
    return { channels: { ...s.channels, [channelId]: { ...current, ...fn(current) } } };
  });
}

/** Onaylı mesajlar kimliğe göre sıralı; bekleyen/başarısız yerel mesajlar sonda. */
function merge(existing: LocalMessage[], incoming: Message[]): LocalMessage[] {
  const byId = new Map<string, LocalMessage>();
  for (const m of existing) if (!m.status) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const confirmed = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return [...confirmed, ...existing.filter((m) => m.status)];
}

/** Mesaj kimliklerini (sıfırla başlamayan ondalık tam sayılar) büyüklüğe göre karşılaştırır */
const idCompare = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Önbellekteki mesajları kanalın en yeni sayfasıyla eşitler (ilk yükleme ve yeniden bağlanınca tazeleme).
 * `before`: istek gönderilirken önbellekte olan onaylı mesajların kimlikleri. Sayfanın kapsadığı aralıkta
 * olup sayfada olmayan önbellek mesajları kopukken silinmiştir, çıkarılır; istek sürerken gelenler kalır.
 * Sayfa önbellekle hiç örtüşmüyorsa (kopukken bir sayfadan fazla mesaj geldi) önbellek sayfayla değiştirilir:
 * birleştirmek arada kalıcı bir boşluk bırakırdı. Bekleyen/başarısız yerel mesajlara dokunulmaz.
 */
function reconcileNewest(existing: LocalMessage[], page: Message[], before: ReadonlySet<string>, full: boolean): LocalMessage[] {
  if (page.length === 0) {
    // Kanal boş: istekten önce önbellekte olanların hepsi silinmiş
    return merge(existing.filter((m) => m.status || !before.has(m.id)), []);
  }
  const inPage = new Set(page.map((m) => m.id));
  let oldest = page[0]!.id;
  let newest = oldest;
  for (const m of page) {
    if (idCompare(m.id, oldest) < 0) oldest = m.id;
    if (idCompare(m.id, newest) > 0) newest = m.id;
  }
  // Tam sayfa değilse sayfa kanalın tamamıdır: alt sınır yok
  const noOverlap = full && before.size > 0 && [...before].every((id) => idCompare(id, oldest) < 0);
  const kept = existing.filter((m) => {
    if (m.status || inPage.has(m.id)) return true;
    if (idCompare(m.id, newest) > 0) return !before.has(m.id); // sayfadan yeni: istek sürerken geldiyse kalır
    if (idCompare(m.id, oldest) >= 0 || !full) return false; // sayfanın aralığında ama sayfada yok: silinmiş
    return !noOverlap; // sayfadan eski: örtüşme yoksa boşluk kalmasın diye atılır
  });
  return merge(kept, page);
}

const selfId = (): string | undefined => useSession.getState().user?.id;

// ---------- Yükleme ----------

export async function loadInitial(channelId: string): Promise<void> {
  const current = useMessages.getState().channels[channelId];
  if (current?.loaded || current?.loading) return;
  patch(channelId, () => ({ loading: true }));
  const before = new Set((current?.messages ?? []).filter((m) => !m.status).map((m) => m.id));
  try {
    const page = await api.listMessages(channelId);
    patch(channelId, (c) => ({
      messages: reconcileNewest(c.messages, page, before, page.length >= MESSAGE_PAGE_SIZE),
      hasMore: page.length >= MESSAGE_PAGE_SIZE,
      loading: false,
      loaded: true,
    }));
  } catch (err) {
    patch(channelId, () => ({ loading: false }));
    env().notifyError(errorMessage(err));
  }
}

export async function loadOlder(channelId: string, limit: number = MESSAGE_PAGE_SIZE): Promise<void> {
  const current = useMessages.getState().channels[channelId];
  if (!current || current.loading || !current.hasMore) return;
  const oldest = current.messages.find((m) => !m.status);
  if (!oldest) return;
  patch(channelId, () => ({ loading: true }));
  try {
    const page = await api.listMessages(channelId, oldest.id, limit === MESSAGE_PAGE_SIZE ? undefined : limit);
    patch(channelId, (c) => ({
      messages: merge(c.messages, page),
      hasMore: page.length >= limit,
      loading: false,
    }));
  } catch (err) {
    patch(channelId, () => ({ loading: false }));
    env().notifyError(errorMessage(err));
  }
}

// ---------- Eklenecek dosyalar ----------

/** Dosyaları yazma kutusuna ekler; boş, çok büyük ya da fazla dosyalar için hata gösterir. */
export function addFiles(channelId: string, files: LocalFile[]): void {
  const max = useGuild.getState().attachmentMaxBytes;
  const current = useMessages.getState().pendingFiles[channelId] ?? [];
  const accepted: LocalFile[] = [];
  for (const file of files) {
    if (current.length + accepted.length >= MESSAGE_MAX_ATTACHMENTS) {
      env().notifyError(`Bir mesaja en fazla ${MESSAGE_MAX_ATTACHMENTS} dosya eklenebilir.`);
      break;
    }
    if (file.size === 0) env().notifyError(`"${file.name}" boş bir dosya.`);
    else if (file.size > max) env().notifyError(`"${file.name}" çok büyük (en fazla ${formatBytes(max)}).`);
    else accepted.push(file);
  }
  if (accepted.length === 0) return;
  useMessages.setState((s) => ({ pendingFiles: { ...s.pendingFiles, [channelId]: [...current, ...accepted] } }));
}

export function removeFile(channelId: string, index: number): void {
  useMessages.setState((s) => ({
    pendingFiles: { ...s.pendingFiles, [channelId]: (s.pendingFiles[channelId] ?? []).filter((_, i) => i !== index) },
  }));
}

function takeFiles(channelId: string): LocalFile[] {
  const files = useMessages.getState().pendingFiles[channelId] ?? [];
  if (files.length) {
    useMessages.setState((s) => {
      const { [channelId]: _taken, ...pendingFiles } = s.pendingFiles;
      return { pendingFiles };
    });
  }
  return files;
}

/** Gönderilmekte olan mesajın dosyalarının toplam ilerlemesi */
export function uploadProgress(message: LocalMessage): { sent: number; total: number } | null {
  if (!message.uploads?.length) return null;
  let sent = 0;
  let total = 0;
  for (const u of message.uploads) {
    sent += u.attachment ? u.file.size : Math.min(u.sent, u.file.size);
    total += u.file.size;
  }
  return { sent, total };
}

// ---------- Gönderme / düzenleme / silme ----------

let nonceCounter = 0;
/** Gönderilmekte olan mesajın dosya yüklemesini iptal etmek için */
const uploadControllers = new Map<string, AbortController>();
const PROGRESS_INTERVAL_MS = 100;

/** Yanıtlanan mesajın yerel özeti ve bildirilecek yazar (gönderilecek mesaja yazılır) */
function takeReply(channelId: string, authorId: string): Partial<Message> {
  const draft = useMessages.getState().replies[channelId];
  if (!draft) return {};
  useMessages.setState((s) => {
    const { [channelId]: _taken, ...replies } = s.replies;
    return { replies };
  });
  const original = useMessages.getState().channels[channelId]?.messages.find((m) => m.id === draft.messageId);
  return {
    replyToId: draft.messageId,
    referencedMessage: original ? referenceOf(original, original.attachments.length > 0) : null,
    replyMentionUserId: draft.mention && draft.authorId && draft.authorId !== authorId ? draft.authorId : null,
  };
}

/**
 * Metni ve kanalın yazma kutusundaki dosyaları gönderir (dosyalar önce yüklenir). Yazma kutusunda bir
 * yanıt varsa mesaj ona yanıt olur.
 */
export function sendMessage(channelId: string, content: string): void {
  if (!selfId()) return;
  const files = takeFiles(channelId);
  if (!content && files.length === 0) return;
  startSending(channelId, content, files);
}

/**
 * Seçicideki GIF'i hemen gönderir (Discord gibi): mesajın metni GIF'in GIPHY bağlantısıdır, GIF'i
 * sunucu ekler. Yazma kutusundaki metin ve dosyalar yerinde kalır. Onay gelene kadar GIF ekranda gösterilir.
 */
export function sendGif(channelId: string, gif: GifResult): void {
  startSending(channelId, gif.url, [], [gifEmbed(gif)]);
}

function startSending(channelId: string, content: string, files: LocalFile[], embeds: Embed[] = []): void {
  const authorId = selfId();
  if (!authorId) return;
  const nonce = `yerel-${Date.now()}-${++nonceCounter}`;
  const pending: LocalMessage = {
    id: nonce,
    channelId,
    authorId,
    content,
    createdAt: Date.now(),
    editedAt: null,
    attachments: [],
    reactions: [],
    mentionEveryone: false,
    ...takeReply(channelId, authorId),
    status: 'pending',
    nonce,
    ...(files.length ? { uploads: files.map((file) => ({ file, sent: 0 })) } : {}),
    ...(embeds.length ? { embeds } : {}),
  };
  patch(channelId, (c) => ({ messages: [...c.messages, pending] }));
  // Gönderilen mesaj karşı tarafta "yazıyor"u kapatır; hemen yeniden yazmaya başlanırsa tekrar bildirilsin
  lastTypingSent.delete(channelId);
  void deliver(channelId, pending);
}

function updateLocal(channelId: string, nonce: string, fn: (m: LocalMessage) => LocalMessage): void {
  patch(channelId, (c) => ({ messages: c.messages.map((m) => (m.nonce === nonce ? fn(m) : m)) }));
}

function setUpload(channelId: string, nonce: string, index: number, change: Partial<LocalUpload>): void {
  updateLocal(channelId, nonce, (m) => ({
    ...m,
    uploads: m.uploads?.map((u, i) => (i === index ? { ...u, ...change } : u)),
  }));
}

async function deliver(channelId: string, pending: LocalMessage): Promise<void> {
  const nonce = pending.nonce!;
  const controller = new AbortController();
  uploadControllers.set(nonce, controller);
  try {
    // Dosyalar sırayla yüklenir; önceki denemede yüklenenler atlanır
    const attachmentIds: string[] = [];
    for (const [index, upload] of (pending.uploads ?? []).entries()) {
      if (upload.attachment) {
        attachmentIds.push(upload.attachment.id);
        continue;
      }
      let reported = 0;
      const attachment = await uploadFile(
        channelId,
        upload.file,
        (sent) => {
          if (Date.now() - reported < PROGRESS_INTERVAL_MS) return;
          reported = Date.now();
          setUpload(channelId, nonce, index, { sent });
        },
        controller.signal,
      );
      setUpload(channelId, nonce, index, { sent: upload.file.size, attachment });
      attachmentIds.push(attachment.id);
    }
    const reply = pending.replyToId
      ? { replyToId: pending.replyToId, replyMention: Boolean(pending.replyMentionUserId) }
      : undefined;
    const message = await api.sendMessage(channelId, pending.content, attachmentIds, reply);
    patch(channelId, (c) => ({
      messages: merge(
        c.messages.filter((m) => m.nonce !== nonce),
        [message],
      ),
    }));
    useGuild.getState().markRead(channelId, message.id);
  } catch (err) {
    if (controller.signal.aborted) return; // kullanıcı vazgeçti
    // Sunucu yüklenen dosyaları artık tanımıyorsa (süresi doldu) yeniden denemede baştan yüklenir
    const expired = err instanceof ApiError && err.code === 'invalid_attachment';
    // Yanıt verilen mesaj bu arada silindiyse yeniden denemede normal mesaj olarak gider
    const orphan = err instanceof ApiError && err.code === 'invalid_reply';
    updateLocal(channelId, nonce, (m) => ({
      ...m,
      status: 'failed',
      uploads: expired ? m.uploads?.map((u) => ({ file: u.file, sent: 0 })) : m.uploads,
      ...(orphan ? { replyToId: null, referencedMessage: null, replyMentionUserId: null } : {}),
    }));
    env().notifyError(errorMessage(err));
  } finally {
    if (uploadControllers.get(nonce) === controller) uploadControllers.delete(nonce);
  }
}

export function retryMessage(channelId: string, nonce: string): void {
  const failed = useMessages.getState().channels[channelId]?.messages.find((m) => m.nonce === nonce);
  if (!failed) return;
  patch(channelId, (c) => ({
    messages: c.messages.map((m) => (m.nonce === nonce ? { ...m, status: 'pending' as const } : m)),
  }));
  void deliver(channelId, { ...failed, status: 'pending' });
}

/** Gönderilemeyen ya da dosyası hâlâ yüklenen mesajdan vazgeçer. */
export function discardMessage(channelId: string, nonce: string): void {
  uploadControllers.get(nonce)?.abort();
  uploadControllers.delete(nonce);
  patch(channelId, (c) => ({ messages: c.messages.filter((m) => m.nonce !== nonce) }));
}

export async function editMessage(message: Message, content: string): Promise<void> {
  try {
    const updated = await api.updateMessage(message.id, content);
    applyUpdate(updated.channelId, updated);
  } catch (err) {
    env().notifyError(errorMessage(err));
  }
}

/**
 * Düzenlenen mesajı listeye yazar. Ona verilmiş, ekranda duran yanıtların özeti de burada tazelenir
 * (sunucu yanıtlar için ayrı olay göndermez; yeniden yüklenen yanıtlar zaten günceldir).
 */
function applyUpdate(channelId: string, updated: MessageUpdate): void {
  patch(channelId, (c) => ({
    messages: c.messages.map((m) => {
      if (m.id === updated.id) return { ...m, ...updated };
      if (m.referencedMessage?.id === updated.id) {
        return { ...m, referencedMessage: referenceOf(updated, updated.attachments.length > 0) };
      }
      return m;
    }),
  }));
}

/** "Önizlemeyi kaldır": mesajın bağlantı önizlemelerini kaldırır (sunucu herkese MESSAGE_UPDATE gönderir) */
export async function suppressEmbeds(message: Message): Promise<void> {
  try {
    const updated = await api.suppressEmbeds(message.id);
    applyUpdate(updated.channelId, updated);
  } catch (err) {
    env().notifyError(errorMessage(err));
  }
}

export async function deleteMessage(message: Message): Promise<void> {
  try {
    await api.deleteMessage(message.id);
    removeLocal(message.channelId, message.id);
  } catch (err) {
    env().notifyError(errorMessage(err));
  }
}

function removeLocal(channelId: string, id: string): void {
  // Silinen mesaja verilmiş yanıtlar "asıl mesaj silindi" olarak kalır; ona yazılmakta olan yanıt iptal olur
  patch(channelId, (c) => ({
    messages: c.messages
      .filter((m) => m.id !== id)
      .map((m) => (m.referencedMessage?.id === id ? { ...m, referencedMessage: null } : m)),
  }));
  if (useMessages.getState().replies[channelId]?.messageId === id) {
    useMessages.setState((s) => {
      const { [channelId]: _cancelled, ...replies } = s.replies;
      return { replies };
    });
  }
  // Silinen mesaj kanalın son mesajıysa okunmamış göstergesini yüklü listeye göre düzelt
  const guild = useGuild.getState();
  const channel = useMessages.getState().channels[channelId];
  if (guild.lastMessageIds[channelId] === id && channel?.loaded) {
    const last = [...channel.messages].reverse().find((m) => !m.status);
    guild.setLastMessageId(channelId, last?.id ?? null);
  }
}

// ---------- Tepkiler ----------

/**
 * Mesajdaki bir tepkinin sayısını değiştirir. Kendi tepkimiz (`self`) için işlem tekrarlanabilir:
 * ekranda zaten öyleyse bir şey yapmaz. Böylece iyimser güncelleme ile gateway'den gelen aynı olay
 * iki kez sayılmaz.
 */
function applyReaction(channelId: string, messageId: string, emoji: string, add: boolean, self: boolean): void {
  // Tepki verenler listesi eskidi (ipucu / Tepkiler penceresi yeniden ister)
  forgetReactionUsers(messageId, emoji);
  if (!useMessages.getState().channels[channelId]) return;
  patch(channelId, (c) => ({
    messages: c.messages.map((m) => {
      if (m.id !== messageId || m.status) return m;
      const reactions = m.reactions ?? [];
      const current = reactions.find((r) => r.emoji === emoji);
      if (self && (current?.me ?? false) === add) return m;
      if (!current) {
        return add ? { ...m, reactions: [...reactions, { emoji, count: 1, me: self }] } : m;
      }
      const next: Reaction = {
        emoji,
        count: current.count + (add ? 1 : -1),
        me: self ? add : current.me,
      };
      return {
        ...m,
        reactions:
          next.count > 0 ? reactions.map((r) => (r.emoji === emoji ? next : r)) : reactions.filter((r) => r.emoji !== emoji),
      };
    }),
  }));
}

/** Kendi tepkimizi ekler ya da kaldırır (hemen ekrana yansır; sunucu reddederse geri alınır). */
export async function toggleReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
  const message = useMessages.getState().channels[channelId]?.messages.find((m) => m.id === messageId);
  if (!message || message.status) return;
  const reactions = message.reactions ?? [];
  const current = reactions.find((r) => r.emoji === emoji);
  const add = !current?.me;
  if (add && !current && reactions.length >= MESSAGE_MAX_REACTIONS) {
    env().notifyError(`Bir mesaja en fazla ${MESSAGE_MAX_REACTIONS} farklı tepki verilebilir.`);
    return;
  }
  applyReaction(channelId, messageId, emoji, add, true);
  try {
    await (add ? api.addReaction(messageId, emoji) : api.removeReaction(messageId, emoji));
  } catch (err) {
    applyReaction(channelId, messageId, emoji, !add, true);
    env().notifyError(errorMessage(err));
  }
}

// ---------- Okundu bilgisi ----------

const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Sunucuya henüz bildirilmemiş okundu bilgileri (kanal → mesaj) */
const pendingAcks = new Map<string, string>();

/**
 * Bekleyen okundu bilgilerini hemen gönderir (ör. telefon uygulaması arka plana geçerken: zamanlayıcılar
 * orada durabilir, diğer cihazlar okunduğunu geç öğrenirdi).
 */
export function flushAcks(): void {
  for (const [channelId, messageId] of pendingAcks) {
    clearTimeout(ackTimers.get(channelId));
    ackTimers.delete(channelId);
    api.ack(channelId, messageId).catch(() => undefined);
  }
  pendingAcks.clear();
}

/** Kanaldaki en son mesajı okundu olarak işaretler (sunucuya kısa bir gecikmeyle bildirir). */
export function ackChannel(channelId: string): void {
  if (useMessages.getState().mentionCounts[channelId]) {
    useMessages.setState((s) => {
      const { [channelId]: _cleared, ...mentionCounts } = s.mentionCounts;
      return { mentionCounts };
    });
  }
  const guild = useGuild.getState();
  const last = guild.lastMessageIds[channelId];
  if (last) env().onChannelRead?.(channelId, last);
  if (!last || Number(last) <= Number(guild.readStates[channelId] ?? 0)) return;
  guild.markRead(channelId, last);
  clearTimeout(ackTimers.get(channelId));
  pendingAcks.set(channelId, last);
  ackTimers.set(
    channelId,
    setTimeout(() => {
      ackTimers.delete(channelId);
      pendingAcks.delete(channelId);
      api.ack(channelId, last).catch(() => undefined);
    }, 500),
  );
}

// ---------- "Yazıyor…" ----------

const lastTypingSent = new Map<string, number>();

export function notifyTyping(channelId: string): void {
  const now = Date.now();
  if (now - (lastTypingSent.get(channelId) ?? 0) < TYPING_TIMEOUT_MS * 0.6) return;
  lastTypingSent.set(channelId, now);
  gateway.send({ t: 'TYPING_START', d: { channelId } });
}

function setTyping(channelId: string, userId: string, until: number | null): void {
  useMessages.setState((s) => {
    const channel = { ...(s.typing[channelId] ?? {}) };
    if (until) channel[userId] = until;
    else delete channel[userId];
    return { typing: { ...s.typing, [channelId]: channel } };
  });
}

// ---------- Bahsetmeler ----------

/** İçerikte bu kullanıcıdan bahsediliyor mu (sunucudaki sayımla aynı kural) */
export const mentions = (content: string, username: string): boolean => extractMentions(content).includes(username);

/**
 * Mesaj bu kullanıcıyı ilgilendiriyor mu: adıyla, (yetkili bir yazarın) @everyone ya da @here
 * bahsetmesiyle, sahip olduğu bir rolün etiketiyle (`roleIds`: kullanıcının mesajın sunucusundaki rolleri)
 * veya bildirimli ("@ AÇIK") bir yanıtla. @here yalnızca o an çevrimiçi olanlara bildirilir;
 * canlı gelen mesajı alan istemci zaten çevrimiçidir, geçmişteki @here ise Discord'daki gibi herkeste vurgulanır.
 * Rol etiketinde rolün sonradan verilmesi/alınması geçmiş mesajların vurgusunu da değiştirir (Discord gibi).
 */
export const isMentioned = (
  message: Pick<Message, 'content' | 'mentionEveryone' | 'mentionHere' | 'authorId' | 'replyMentionUserId'>,
  user: { id: string; username: string },
  roleIds?: readonly string[],
): boolean =>
  message.authorId !== user.id &&
  (message.mentionEveryone === true ||
    message.mentionHere === true ||
    message.replyMentionUserId === user.id ||
    mentions(message.content, user.username) ||
    (roleIds !== undefined && roleIds.length > 0 && extractRoleMentions(message.content).some((id) => roleIds.includes(id))));

/**
 * Bildirim metni için: rol etiketleri (`<@&kimlik>`) kanalın sunucusundaki rol adıyla yazılır (rol yoksa
 * "@silinmiş-rol"). Ham metin dışında biçim değişmez.
 */
export function withRoleNames(content: string, channelId: string): string {
  if (!content.includes('<@&')) return content;
  const s = useGuild.getState();
  const guildId = s.channelGuild[channelId];
  const roles = guildId ? s.guilds[guildId]?.roles : undefined;
  return content.replace(/<@&([A-Za-z0-9_-]{1,64})>/g, (_raw, id: string) => {
    const role = id !== guildId && roles && Object.hasOwn(roles, id) ? roles[id] : undefined;
    return `@${role?.name ?? DELETED_ROLE_LABEL}`;
  });
}

/** Kullanıcının kanalın sunucusundaki rolleri (@everyone hariç; direkt mesajda ya da üye değilse boş) */
export function memberRoleIdsIn(channelId: string, userId: string): readonly string[] {
  const s = useGuild.getState();
  const guildId = s.channelGuild[channelId];
  const member = guildId ? s.guilds[guildId]?.members[userId] : undefined;
  return member && !member.removed ? member.roles : [];
}

function countUnread(channelId: string): void {
  useMessages.setState((s) => ({
    mentionCounts: { ...s.mentionCounts, [channelId]: (s.mentionCounts[channelId] ?? 0) + 1 },
  }));
}

function notifyMention(message: Message): void {
  if (env().isViewingChannel?.(message.channelId)) return;
  countUnread(message.channelId);
  env().onMention?.(message);
}

/**
 * Direkt mesajda karşı tarafın her mesajı bahsetme gibi sayılır (sunucudaki sayımla aynı). Arama kaydı da
 * okunmamış sayılır ama mesaj bildirimi olmaz: gelen arama kendi penceresi ve zil sesiyle duyurulur
 * (DM_CALL_UPDATE), telefona da ayrı arama bildirimi gider.
 */
function notifyDirectMessage(message: Message, dm: DmChannel): void {
  if (env().isViewingChannel?.(message.channelId)) return;
  countUnread(message.channelId);
  if (message.type === 'call') return;
  env().onDirectMessage?.(message, dm);
}

// ---------- Gateway olayları ----------

/** Gateway'den gelen mesaj, bizim bekleyen (dosyaları yüklenmiş) mesajımızın onayı mı */
function isPendingOf(local: LocalMessage, m: Message): boolean {
  if (local.status !== 'pending' || local.content !== m.content) return false;
  if ((local.replyToId ?? null) !== (m.replyToId ?? null)) return false;
  const uploaded = (local.uploads ?? []).map((u) => u.attachment?.id);
  return uploaded.length === m.attachments.length && uploaded.every((id, i) => id === m.attachments[i]!.id);
}

gateway.on((msg: GatewayServerMessage) => {
  switch (msg.t) {
    case 'MESSAGE_CREATE': {
      const m = msg.d;
      const me = useSession.getState().user;
      if (m.authorId) setTyping(m.channelId, m.authorId, null);
      // Yüklenirken (ör. yeniden bağlanınca tazelenirken) gelen de tutulur: sayfa ondan önce hazırlanmış olabilir
      const cached = useMessages.getState().channels[m.channelId];
      if (cached?.loaded || cached?.loading) {
        patch(m.channelId, (c) => {
          // Kendi bekleyen mesajımızın onayı gateway'den önce geldiyse onu yerine koy
          const pendingIndex = m.authorId === me?.id ? c.messages.findIndex((x) => isPendingOf(x, m)) : -1;
          const rest = pendingIndex >= 0 ? c.messages.filter((_, i) => i !== pendingIndex) : c.messages;
          return { messages: merge(rest, [m]) };
        });
      }
      const dm = useGuild.getState().dms[m.channelId];
      if (dm) {
        if (me && m.authorId !== me.id) notifyDirectMessage(m, dm);
      } else if (me && isMentioned(m, me, memberRoleIdsIn(m.channelId, me.id))) notifyMention(m);
      break;
    }
    case 'MESSAGE_UPDATE':
      // Güncelleme tepkileri taşımaz (kişiye özel); ekrandakiler korunur
      applyUpdate(msg.d.channelId, msg.d);
      break;
    case 'MESSAGE_DELETE':
      removeLocal(msg.d.channelId, msg.d.id);
      break;
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const { channelId, messageId, userId, emoji } = msg.d;
      applyReaction(channelId, messageId, emoji, msg.t === 'MESSAGE_REACTION_ADD', userId === selfId());
      break;
    }
    case 'TYPING_START': {
      const { channelId, userId } = msg.d;
      const until = Date.now() + TYPING_TIMEOUT_MS;
      setTyping(channelId, userId, until);
      setTimeout(() => {
        if ((useMessages.getState().typing[channelId]?.[userId] ?? 0) <= Date.now()) setTyping(channelId, userId, null);
      }, TYPING_TIMEOUT_MS + 50);
      break;
    }
    case 'READY': {
      useMessages.setState({ mentionCounts: msg.d.mentionCounts });
      // Kopukken başka cihazda okunanlar (ör. telefonun bildirimleri kalksın)
      for (const [channelId, lastReadId] of Object.entries(msg.d.readStates)) env().onChannelRead?.(channelId, lastReadId);
      // Yeniden bağlanınca yüklü kanalları tazele (kopukken gelen mesajlar kaçmasın). Kopukken görülemez olan
      // kanal ya da listeden kalkan konuşma (ör. başka cihazdan gruptan ayrılındı) yüklenmez, önbellekten çıkar.
      const known = new Set([
        ...msg.d.guilds.flatMap((g) => g.channels.map((c) => c.id)),
        ...(msg.d.dms ?? []).map((d) => d.id),
      ]);
      for (const channelId of Object.keys(useMessages.getState().channels)) {
        if (!known.has(channelId)) {
          useMessages.setState((s) => {
            const { [channelId]: _gone, ...channels } = s.channels;
            return { channels };
          });
          continue;
        }
        patch(channelId, () => ({ loaded: false }));
        void loadInitial(channelId);
      }
      break;
    }
    case 'READ_STATE_UPDATE': {
      // Başka cihazda okundu (okunma durumunun kendisi useGuild'de). Sunucu bahsetme sayısını ya sıfırlar
      // ya da olduğu gibi bırakır; yerel sayım (ör. bakılan kanalda hiç sayılmamış) hiçbir zaman artırılmaz.
      const { channelId, lastReadId, mentionCount } = msg.d;
      const local = useMessages.getState().mentionCounts[channelId];
      if (local !== undefined && mentionCount < local) {
        useMessages.setState((s) => {
          const { [channelId]: _cleared, ...rest } = s.mentionCounts;
          return { mentionCounts: mentionCount > 0 ? { ...rest, [channelId]: mentionCount } : rest };
        });
      }
      env().onChannelRead?.(channelId, lastReadId);
      break;
    }
    case 'GUILD_CREATE':
      // Katılınan sunucunun okunmamış bahsetmeleri
      useMessages.setState((s) => ({ mentionCounts: { ...s.mentionCounts, ...msg.d.mentionCounts } }));
      break;
    case 'GUILD_DELETE': {
      // Sunucudan çıkıldı: artık görülemeyen kanalların önbelleği ve sayaçları gider
      const guild = useGuild.getState();
      const visible = (id: string): boolean => Boolean(guild.channelGuild[id] || guild.dms[id]);
      useMessages.setState((s) => ({
        channels: Object.fromEntries(Object.entries(s.channels).filter(([id]) => visible(id))),
        mentionCounts: Object.fromEntries(Object.entries(s.mentionCounts).filter(([id]) => visible(id))),
      }));
      break;
    }
    case 'CHANNEL_DELETE':
    // Konuşma listeden kalktı (kapatıldı ya da gruptan ayrılındı): yeniden açılınca baştan yüklenir
    case 'DM_CHANNEL_DELETE':
      useMessages.setState((s) => {
        const { [msg.d.id]: _removed, ...channels } = s.channels;
        const { [msg.d.id]: _count, ...mentionCounts } = s.mentionCounts;
        const { [msg.d.id]: _files, ...pendingFiles } = s.pendingFiles;
        const { [msg.d.id]: _reply, ...replies } = s.replies;
        return { channels, mentionCounts, pendingFiles, replies };
      });
      break;
  }
});
