import { create } from 'zustand';
import type { GatewayServerMessage, Message, MessageUpdate, PinnedMessage } from '@diskort/shared';
import { api, errorMessage } from './api';
import { env } from './env';
import { gateway } from './gateway';
import { useMessages } from './messages';
import { jumpToMessage } from './replies';
import { sessionUserChanged, useSession } from './session';

// Discord'daki gibi sabitlenmiş mesajlar: yetkili biri (metin kanalında PIN_MESSAGES, direkt mesajda her
// katılımcı) bir mesajı kanala sabitler; kanal başlığındaki raptiye düğmesi listeyi açar. Liste açılınca
// sunucudan istenir, açıkken gelen değişikliklerle (CHANNEL_PINS_UPDATE, MESSAGE_UPDATE/DELETE) güncel kalır.

export interface ChannelPins {
  /** En son sabitlenen önce */
  items: PinnedMessage[];
  loading: boolean;
  loaded: boolean;
  /** Liste yüklendikten sonra değişti; bir sonraki açılışta (ya da açıksa hemen) yeniden istenir */
  stale: boolean;
}

interface PinsStore {
  channels: Record<string, ChannelPins>;
  /**
   * Bu oturumda başkasının yeni sabitlediği, henüz listesi açılmamış kanallar (başlıktaki raptiyede nokta).
   * Oturumlar arasında saklanmaz.
   */
  unseen: Record<string, true>;
}

const initialState = (): PinsStore => ({ channels: {}, unseen: {} });

export const usePins = create<PinsStore>()(initialState);

useSession.subscribe((s, prev) => {
  if (!sessionUserChanged(s, prev)) return;
  usePins.setState(initialState());
  ownChanges.clear();
  lastPins.clear();
});

const EMPTY: ChannelPins = { items: [], loading: false, loaded: false, stale: false };

function patch(channelId: string, fn: (c: ChannelPins) => Partial<ChannelPins>): void {
  usePins.setState((s) => {
    const current = s.channels[channelId] ?? EMPTY;
    return { channels: { ...s.channels, [channelId]: { ...current, ...fn(current) } } };
  });
}

/** Açık olan sabitlenmiş mesajlar listeleri (kanal → açık pencere sayısı) */
const openLists = new Map<string, number>();

/** Kanalın sabitlenmiş mesajlarını ister (yüklüyse ve eskimediyse yeniden istemez; `force` her zaman) */
export async function loadPins(channelId: string, force = false): Promise<void> {
  const current = usePins.getState().channels[channelId];
  if (current?.loading || (current?.loaded && !current.stale && !force)) return;
  patch(channelId, () => ({ loading: true, stale: false }));
  try {
    const items = await api.listPins(channelId);
    patch(channelId, (c) => ({ items, loading: false, loaded: true, stale: c.stale }));
    // Yükleme sürerken yeni bir değişiklik geldiyse bir kez daha iste
    if (usePins.getState().channels[channelId]?.stale && openLists.has(channelId)) void loadPins(channelId);
  } catch (err) {
    patch(channelId, () => ({ loading: false, stale: true })); // başta kaldırılmıştı: açılışta yeniden istensin
    env().notifyError(errorMessage(err));
  }
}

/**
 * Sabitlenmiş mesajlar listesi açıldı: liste istenir ve kanalın "yeni sabitleme" noktası söner. Dönen
 * işlev liste kapanınca çağrılır.
 */
export function openPins(channelId: string): () => void {
  openLists.set(channelId, (openLists.get(channelId) ?? 0) + 1);
  markPinsSeen(channelId);
  void loadPins(channelId);
  return () => {
    const n = (openLists.get(channelId) ?? 1) - 1;
    if (n > 0) openLists.set(channelId, n);
    else openLists.delete(channelId);
  };
}

export function markPinsSeen(channelId: string): void {
  if (!usePins.getState().unseen[channelId]) return;
  usePins.setState((s) => {
    const { [channelId]: _seen, ...unseen } = s.unseen;
    return { unseen };
  });
}

/**
 * Kendi yaptığımız değişikliklerin duyurusu yeni sabitleme noktası yakmasın: kanal → bekleyen duyuruların
 * zamanları (her duyuru birini tüketir; gelmeyenler bir süre sonra düşer)
 */
const ownChanges = new Map<string, number[]>();
const OWN_CHANGE_WINDOW_MS = 10_000;

function expectOwnChange(channelId: string): void {
  const now = Date.now();
  ownChanges.set(channelId, [...(ownChanges.get(channelId) ?? []).filter((t) => now - t < OWN_CHANGE_WINDOW_MS), now]);
}

function consumeOwnChange(channelId: string): boolean {
  const now = Date.now();
  const pending = (ownChanges.get(channelId) ?? []).filter((t) => now - t < OWN_CHANGE_WINDOW_MS);
  if (pending.length > 1) ownChanges.set(channelId, pending.slice(1));
  else ownChanges.delete(channelId);
  return pending.length > 0;
}

/** Kanal → bilinen en son sabitleme zamanı (yeni sabitleme mi, kaldırma mı ayırt etmek için) */
const lastPins = new Map<string, number | null>();
/** Önceki durum bilinmiyorsa bu kadar yeni bir sabitleme "yeni" sayılır */
const FRESH_PIN_MS = 60_000;

/** Ekrandaki mesajın sabitli işaretini değiştirir */
function setPinnedLocal(channelId: string, messageId: string, pinned: boolean): void {
  const channel = useMessages.getState().channels[channelId];
  if (!channel?.messages.some((m) => m.id === messageId && Boolean(m.pinned) !== pinned)) return;
  useMessages.setState((s) => {
    const c = s.channels[channelId];
    if (!c) return {};
    return {
      channels: {
        ...s.channels,
        [channelId]: { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, pinned } : m)) },
      },
    };
  });
}

/** Mesajı kanala sabitler (onay penceresinden sonra çağrılır) */
export async function pinMessage(message: Pick<Message, 'id' | 'channelId'>): Promise<boolean> {
  expectOwnChange(message.channelId);
  try {
    await api.pinMessage(message.channelId, message.id);
    setPinnedLocal(message.channelId, message.id, true);
    if (usePins.getState().channels[message.channelId]?.loaded) patch(message.channelId, () => ({ stale: true }));
    markPinsSeen(message.channelId);
    return true;
  } catch (err) {
    consumeOwnChange(message.channelId);
    env().notifyError(errorMessage(err));
    return false;
  }
}

/** Mesajın sabitlemesini kaldırır; liste hemen güncellenir (sunucu reddederse geri gelir) */
export async function unpinMessage(message: Pick<Message, 'id' | 'channelId'>): Promise<boolean> {
  const { channelId, id } = message;
  expectOwnChange(channelId);
  const before = usePins.getState().channels[channelId]?.items;
  if (before) patch(channelId, (c) => ({ items: c.items.filter((m) => m.id !== id) }));
  try {
    await api.unpinMessage(channelId, id);
    setPinnedLocal(channelId, id, false);
    return true;
  } catch (err) {
    consumeOwnChange(channelId);
    if (before) patch(channelId, () => ({ items: before }));
    env().notifyError(errorMessage(err));
    return false;
  }
}

/** Sabitlenmiş mesaja atlar: mesaj yüklü değilse geçmiş daha derine kadar yüklenir */
export function jumpToPinned(message: Pick<Message, 'id' | 'channelId'>): Promise<boolean> {
  return jumpToMessage(message.channelId, message.id, {
    maxPages: 30,
    notFound: 'Sabitlenmiş mesaj geçmişte bulunamadı; çok eskide kalmış olabilir.',
  });
}

function applyUpdate(update: MessageUpdate): void {
  const pins = usePins.getState().channels[update.channelId];
  if (!pins?.loaded) return;
  const index = pins.items.findIndex((m) => m.id === update.id);
  if (index < 0) return;
  // Sabitlemesi kalkan mesaj CHANNEL_PINS_UPDATE ile de gelir; burada yalnızca içeriği güncellenir
  if (update.pinned === false) {
    patch(update.channelId, (c) => ({ items: c.items.filter((m) => m.id !== update.id) }));
    return;
  }
  patch(update.channelId, (c) => ({
    items: c.items.map((m) => (m.id === update.id ? { ...m, ...update, pinned: true, reactions: m.reactions } : m)),
  }));
}

gateway.on((msg: GatewayServerMessage) => {
  switch (msg.t) {
    case 'CHANNEL_PINS_UPDATE': {
      const { channelId, lastPinAt } = msg.d;
      if (usePins.getState().channels[channelId]?.loaded) {
        patch(channelId, () => ({ stale: true }));
        if (openLists.has(channelId)) void loadPins(channelId);
      }
      // Yalnızca başkasının yeni sabitlemesi nokta yakar (kaldırmalar ve kendi değişikliklerimiz yakmaz)
      const own = consumeOwnChange(channelId);
      const known = lastPins.has(channelId)
        ? lastPins.get(channelId)
        : usePins.getState().channels[channelId]?.items[0]?.pinnedAt;
      const added =
        lastPinAt !== null && (known === undefined ? Date.now() - lastPinAt < FRESH_PIN_MS : lastPinAt > (known ?? 0));
      lastPins.set(channelId, lastPinAt);
      if (added && !own && !openLists.has(channelId)) {
        usePins.setState((s) => ({ unseen: { ...s.unseen, [channelId]: true } }));
      } else if (lastPinAt === null) {
        markPinsSeen(channelId);
      }
      break;
    }
    case 'MESSAGE_UPDATE':
      applyUpdate(msg.d);
      break;
    case 'MESSAGE_DELETE':
      if (usePins.getState().channels[msg.d.channelId]?.items.some((m) => m.id === msg.d.id)) {
        patch(msg.d.channelId, (c) => ({ items: c.items.filter((m) => m.id !== msg.d.id) }));
      }
      break;
    case 'READY':
      // Kopukken değişmiş olabilir
      usePins.setState((s) => ({
        channels: Object.fromEntries(Object.entries(s.channels).map(([id, c]) => [id, { ...c, stale: true }])),
      }));
      for (const channelId of openLists.keys()) void loadPins(channelId);
      break;
    case 'CHANNEL_DELETE':
    case 'DM_CHANNEL_DELETE':
      usePins.setState((s) => {
        const { [msg.d.id]: _removed, ...channels } = s.channels;
        const { [msg.d.id]: _seen, ...unseen } = s.unseen;
        return { channels, unseen };
      });
      break;
  }
});
