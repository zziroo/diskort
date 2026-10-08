import { useShallow } from 'zustand/react/shallow';
import type { DmChannel, User } from '@diskort/shared';
import { api, errorMessage } from './api';
import { env } from './env';
import { useGuild } from './guild';
import { useMessages } from './messages';

// Direkt mesajlar: bire bir ve küçük grup konuşmaları. Konuşmanın mesajları metin kanallarıyla aynı
// yoldan yüklenir/gönderilir (kanal kimliği yerine konuşmanın kimliği); buradakiler listeye özgü işler.

/** Konuşmalar son etkinliğe göre, en yeni üstte */
export function sortDms(dms: Record<string, DmChannel>): DmChannel[] {
  return Object.values(dms).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
}

/** Oturumdaki kullanıcının konuşma listesi (sıralı; konuşmalar değişmedikçe aynı dizi) */
export function useDmList(): DmChannel[] {
  return useGuild(useShallow((s) => sortDms(s.dms)));
}

/** Konuşmadaki diğer kişiler (sen hariç), katılma sırasıyla */
export function dmRecipients(dm: Pick<DmChannel, 'participantIds'>, selfId: string | undefined): string[] {
  return dm.participantIds.filter((id) => id !== selfId);
}

/**
 * Konuşmanın görünen adı: grubun adı, yoksa diğer kişilerin adları. Karşı tarafın hesabı silinmiş bire
 * bir konuşma "Silinmiş Kullanıcı", tek başına kalınan grup "Boş grup" olur.
 */
export function dmTitle(
  dm: Pick<DmChannel, 'participantIds' | 'group' | 'name'>,
  users: Record<string, User>,
  selfId: string | undefined,
): string {
  if (dm.group && dm.name) return dm.name;
  const names = dmRecipients(dm, selfId)
    .map((id) => users[id]?.displayName)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return dm.group ? 'Boş grup' : 'Silinmiş Kullanıcı';
  return names.join(', ');
}

/** Bire bir konuşmada karşı taraf (grupta ve karşı taraf silinmişse undefined) */
export function dmPartner(
  dm: Pick<DmChannel, 'participantIds' | 'group'>,
  users: Record<string, User>,
  selfId: string | undefined,
): User | undefined {
  if (dm.group) return undefined;
  const id = dmRecipients(dm, selfId)[0];
  return id ? users[id] : undefined;
}

/** Konuşmada okunmamış mesaj sayısı (DM'de karşı tarafın her mesajı sayılır) */
export function useDmUnreadCount(channelId: string): number {
  return useMessages((s) => s.mentionCounts[channelId] ?? 0);
}

/** Tüm konuşmalardaki okunmamış mesajların toplamı (ana sayfa düğmesindeki rozet) */
export function useDmUnreadTotal(): number {
  const ids = useGuild(useShallow((s) => Object.keys(s.dms)));
  return useMessages((s) => ids.reduce((n, id) => n + (s.mentionCounts[id] ?? 0), 0));
}

/** Okunmamış mesajı olan konuşmalar, en yeni üstte (ana sayfa düğmesinin altında gösterilir) */
export function useUnreadDms(limit = 3): DmChannel[] {
  const list = useDmList();
  return useMessages(useShallow((s) => list.filter((d) => (s.mentionCounts[d.id] ?? 0) > 0).slice(0, limit)));
}

/** Kişiyle bire bir konuşmayı açar (yoksa oluşturur). Hata olursa gösterir ve null döner. */
export async function openDirectMessage(userId: string): Promise<DmChannel | null> {
  return createDm([userId]);
}

/** Tek kişi: bire bir konuşma; birden çok kişi: yeni grup (isteğe bağlı adıyla). */
export async function createDm(userIds: string[], name?: string | null): Promise<DmChannel | null> {
  try {
    const dm = await api.createDm(userIds, name);
    useGuild.getState().upsertDm(dm);
    return dm;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return null;
  }
}

/** Bire bir konuşmayı listeden kaldırır (yeni mesaj gelince yeniden görünür); gruptan ayrılır. */
export async function closeDm(id: string): Promise<boolean> {
  try {
    await api.closeDm(id);
    useGuild.getState().removeDm(id);
    return true;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return false;
  }
}

export async function renameDm(id: string, name: string | null): Promise<boolean> {
  try {
    useGuild.getState().upsertDm(await api.renameDm(id, name?.trim() || null));
    return true;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return false;
  }
}

export async function addDmParticipant(id: string, userId: string): Promise<boolean> {
  try {
    useGuild.getState().upsertDm(await api.addDmParticipant(id, userId));
    return true;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return false;
  }
}

/**
 * Konuşmaya mesaj yazılabiliyor mu değilse neden (arayüzde yazma kutusu yerine gösterilir). Bire bir
 * konuşmada karşı tarafla en az bir ortak sunucu ya da arkadaşlık olmalı (`reachable`) ve engel
 * olmamalı. Karşı tarafı sen engellediysen (`blockedIds`) bu söylenir; seni engellediyse yalnızca genel
 * "artık mesaj gönderemezsin" (sunucu yönünü söylemez, bkz. DmChannel.readOnly). Aynı koşulda arama da
 * yapılamaz (bkz. dmCallBlockedReason).
 */
export function dmBlockedReason(
  dm: Pick<DmChannel, 'participantIds' | 'group' | 'readOnly'>,
  users: Record<string, User>,
  selfId: string | undefined,
  reachable: Record<string, true>,
  blockedIds: Record<string, true> = {},
): string | null {
  if (dm.group) return null;
  const partner = dmPartner(dm, users, selfId);
  if (!partner) return 'Bu kullanıcının hesabı silindi; artık mesaj gönderemezsin.';
  if (blockedIds[partner.id]) return `${partner.displayName} kişisini engelledin; mesaj göndermek için engeli kaldır.`;
  if (!reachable[partner.id]) {
    return `${partner.displayName} ile artık ortak bir sunucunuz yok ve arkadaş değilsiniz; mesaj gönderemezsin.`;
  }
  if (dm.readOnly) return 'Bu konuşmaya artık mesaj gönderemezsin.';
  return null;
}
