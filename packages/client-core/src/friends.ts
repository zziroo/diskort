import type { FriendEntry, FriendRequestResponse, FriendsList } from '@diskort/shared';
import { api, errorMessage } from './api';
import { env } from './env';
import { useGuild, type GuildStore } from './guild';
import { useSession } from './session';

// Arkadaşlar: liste ve bekleyen istekler guild store'da tutulur (friends, friendIds; READY ve FRIENDS_UPDATE
// ile gelir). Arkadaşlar `reachable`a da girer: ortak sunucu olmasa da bire bir DM açılabilir, gruba eklenebilir.
// Buradakiler listeye özgü işler; her REST yanıtı güncel listeyi hemen uygular (gateway olayı da gelir).

/** Bir kişiyle arkadaşlık durumu: kendin, arkadaş, senden istek bekliyor, sen istek gönderdin, hiçbiri */
export type FriendStatus = 'self' | 'friend' | 'incoming' | 'outgoing' | 'none';

const inList = (list: FriendEntry[], userId: string): boolean => list.some((e) => e.userId === userId);

export function friendStatusOf(
  s: Pick<GuildStore, 'friends' | 'friendIds'>,
  userId: string | null | undefined,
  selfId: string | undefined,
): FriendStatus {
  if (!userId) return 'none';
  if (userId === selfId) return 'self';
  if (s.friendIds[userId]) return 'friend';
  if (inList(s.friends.incoming, userId)) return 'incoming';
  if (inList(s.friends.outgoing, userId)) return 'outgoing';
  return 'none';
}

/** Oturumdaki kullanıcının bu kişiyle arkadaşlık durumu (profil kartı, kişi menüsü) */
export function useFriendStatus(userId: string | null | undefined): FriendStatus {
  const selfId = useSession((s) => s.user?.id);
  return useGuild((s) => friendStatusOf(s, userId, selfId));
}

export const isFriend = (s: Pick<GuildStore, 'friendIds'>, userId: string | null | undefined): boolean =>
  Boolean(userId && s.friendIds[userId]);

/** Arkadaşlar (görünen ada göre) ve bekleyen istekler (en yeni önce); değişmedikçe aynı nesne */
export function useFriends(): FriendsList {
  return useGuild((s) => s.friends);
}

/** Yanıt bekleyen gelen isteklerin sayısı (arkadaşlar düğmesindeki rozet) */
export function useIncomingFriendRequestCount(): number {
  return useGuild((s) => s.friends.incoming.length);
}

/** Listeyi sunucudan yeniden okur (READY'de zaten gelir; ör. sayfa açılınca tazelemek için) */
export async function loadFriends(): Promise<FriendsList | null> {
  try {
    const list = await api.listFriends();
    useGuild.getState().setFriends(list);
    return list;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return null;
  }
}

/**
 * Kullanıcı adıyla arkadaşlık isteği ("@" ile başlayabilir). Sonuç: 'pending' (istek gönderildi ya da zaten
 * bekliyordu) ya da 'friends' (karşı tarafın sana isteği vardı, artık arkadaşsınız; ya da zaten
 * arkadaştınız). Hata bildirimi gösterilmez: hata iletisi döner (ör. formun altında gösterilir). Kullanıcı
 * yoksa (ya da seni engellediyse; bu ayırt edilmez) "Kullanıcı bulunamadı."
 */
export async function sendFriendRequest(
  username: string,
): Promise<{ status: FriendRequestResponse['status'] } | { error: string }> {
  try {
    const { status, ...list } = await api.sendFriendRequest(username.trim());
    useGuild.getState().setFriends(list);
    return { status };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function change(run: () => Promise<FriendsList>): Promise<boolean> {
  try {
    useGuild.getState().setFriends(await run());
    return true;
  } catch (err) {
    env().notifyError(errorMessage(err));
    return false;
  }
}

/** Gelen isteği kabul eder */
export function acceptFriendRequest(userId: string): Promise<boolean> {
  return change(() => api.acceptFriendRequest(userId));
}

/** Gelen isteği reddeder ya da gönderdiğin isteği geri çeker (karşı tarafa reddedildiği söylenmez) */
export function declineFriendRequest(userId: string): Promise<boolean> {
  return change(() => api.deleteFriendRequest(userId));
}

/** Gönderdiğin isteği geri çeker (declineFriendRequest ile aynı uç) */
export const cancelFriendRequest = declineFriendRequest;

/**
 * Arkadaşlıktan çıkarır. Ortak sunucunuz yoksa bire bir konuşmanız salt okunur olur (geçmiş kalır), yeni
 * konuşma açılamaz; gruplar etkilenmez.
 */
export function removeFriend(userId: string): Promise<boolean> {
  return change(() => api.removeFriend(userId));
}
