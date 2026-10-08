import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  friendStatusOf,
  removeFriend,
  sendFriendRequest,
  useGuild,
  useSession,
} from '@diskort/client-core';
import { toast, useUi, type ContextMenuItem } from '../stores/ui';
import { confirmDialog } from './dialog';

// Arkadaşlık işlemlerinin masaüstü tarafı: onay pencereleri ve kısa bildirimler. İstek ve listenin kendisi
// client-core'da (friends.ts); hata bildirimini oradaki işlemler kendisi gösterir.

const nameOf = (userId: string): string => useGuild.getState().users[userId]?.displayName ?? 'Bu kişi';

/** Onay sorup arkadaşlıktan çıkarır */
export async function confirmRemoveFriend(userId: string): Promise<void> {
  const name = nameOf(userId);
  const ok = await confirmDialog({
    title: `${name} arkadaşlıktan çıkarılsın mı?`,
    message:
      'Ortak bir sunucunuz yoksa bire bir konuşmanız salt okunur olur (geçmiş kalır) ve yeni konuşma açılamaz. ' +
      'Gruplar etkilenmez.',
    confirmLabel: 'Arkadaşlıktan Çıkar',
    danger: true,
  });
  if (ok && (await removeFriend(userId))) toast(`${name} arkadaşlıktan çıkarıldı.`, 'success');
}

export async function acceptFriend(userId: string): Promise<void> {
  if (await acceptFriendRequest(userId)) toast(`${nameOf(userId)} ile artık arkadaşsınız.`, 'success');
}

export async function declineFriend(userId: string): Promise<void> {
  await declineFriendRequest(userId);
}

export async function cancelFriend(userId: string): Promise<void> {
  if (await cancelFriendRequest(userId)) toast('Arkadaşlık isteği geri çekildi.', 'info');
}

/** Profil kartından ya da konuşma başlığından istek: kullanıcı adıyla gönderilir, sonuç bildirimle */
export async function addFriend(userId: string): Promise<void> {
  const user = useGuild.getState().users[userId];
  if (!user) return;
  const result = await sendFriendRequest(user.username);
  if ('error' in result) toast(result.error, 'error');
  else toast(result.status === 'friends' ? `${user.displayName} ile artık arkadaşsınız.` : 'Arkadaşlık isteği gönderildi.', 'success');
}

/** "Arkadaş" düğmesinin menüsü: arkadaşlıktan çıkar */
export function openFriendMenu(userId: string, x: number, y: number): void {
  useUi.getState().openContextMenu({
    x,
    y,
    items: [{ label: 'Arkadaşlıktan Çıkar', danger: true, onClick: () => void confirmRemoveFriend(userId) }],
  });
}

/** Kişi menüsündeki arkadaşlık öğesi (kendin ve engellediğin kişi için yok) */
export function friendMenuItems(userId: string): ContextMenuItem[] {
  const guild = useGuild.getState();
  if (guild.blockedIds[userId]) return [];
  switch (friendStatusOf(guild, userId, useSession.getState().user?.id)) {
    case 'none':
      return [{ label: 'Arkadaş Ekle', onClick: () => void addFriend(userId) }];
    case 'incoming':
      return [{ label: 'Arkadaşlık İsteğini Kabul Et', onClick: () => void acceptFriend(userId) }];
    case 'outgoing':
      return [{ label: 'Arkadaşlık İsteğini Geri Çek', onClick: () => void cancelFriend(userId) }];
    case 'friend':
      return [{ label: 'Arkadaşlıktan Çıkar', danger: true, onClick: () => void confirmRemoveFriend(userId) }];
    default:
      return [];
  }
}
