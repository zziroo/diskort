import {
  canMessageIn,
  guildVoiceStateOf,
  memberActions,
  moderation,
  moveTargets,
  showsGuildInfo,
  useGuild,
  useSession,
  type ProfileContext,
} from '@diskort/client-core';
import { toast, useUi, type ContextMenuItem } from '../stores/ui';
import { blockMenuItem } from './blocks';
import { startDm } from './dm';
import { friendMenuItems } from './friends';
import { confirmDialog } from './dialog';

/**
 * Bir üyeye sağ tıklanınca: başkasıysa "Mesaj Gönder", sonra yetkilere ve hiyerarşiye göre yönetim
 * öğeleri: seste sunucuda susturma, sağırlaştırma, taşıma, sesten çıkarma; rol verme/alma; atma ve
 * yasaklama. Kendisi için ve yetki yoksa boş liste. `context`: menünün açıldığı yer; DM'de (ya da seçili
 * olmayan sunucuda) yönetim yok, yalnızca hesap düzeyi işlemler (mesaj, kullanıcı adını kopyala, arkadaşlık).
 */
export function memberMenuItems(userId: string, context: ProfileContext): ContextMenuItem[] {
  const guild = useGuild.getState();
  const user = guild.users[userId];
  if (!user) return [];
  const selfId = useSession.getState().user?.id;
  const self = userId === selfId;
  const message: ContextMenuItem[] = canMessageIn(guild, context, userId, selfId)
    ? [{ label: 'Mesaj Gönder', onClick: () => void startDm(userId) }]
    : [];
  // DM'de sunucu yok: yalnızca hesap düzeyi işlemler
  if (!showsGuildInfo(guild, context)) {
    if (self) return [];
    return [
      ...message,
      {
        label: 'Kullanıcı Adını Kopyala',
        onClick: () =>
          void navigator.clipboard.writeText(user.username).then(
            () => toast('Kullanıcı adı kopyalandı.', 'success'),
            () => undefined,
          ),
      },
      ...friendMenuItems(userId),
      ...blockMenuItem(userId, selfId),
    ];
  }
  // Seçili sunucunun üyesi değil: ortak sunucu varsa yalnızca mesaj
  if (user.removed) return [...message, ...friendMenuItems(userId), ...blockMenuItem(userId, selfId)];
  const name = user.displayName;
  const actions = memberActions(userId);
  // Yalnızca sunucu kanalındaki ses (DM aramasındaki kişi burada seste sayılmaz)
  const voice = guildVoiceStateOf(guild, userId);
  // Arkadaşlık hesap düzeyidir: mesajın hemen ardından
  const items: ContextMenuItem[] = [...message, ...friendMenuItems(userId)];

  if (voice && (actions.mute || actions.deafen || actions.move)) {
    items.push({ label: 'Sesli sohbet', heading: true });
    if (actions.mute) {
      items.push({
        label: 'Sunucuda Sustur',
        checked: voice.serverMute,
        onClick: () => void moderation.setServerMute(userId, !voice.serverMute),
      });
    }
    if (actions.deafen) {
      items.push({
        label: 'Sunucuda Sağırlaştır',
        checked: voice.serverDeaf,
        onClick: () => void moderation.setServerDeaf(userId, !voice.serverDeaf),
      });
    }
    if (actions.move) {
      for (const channel of moveTargets(user)) {
        items.push({
          label: `Taşı: ${channel.name}`,
          onClick: () => void moderation.move(userId, channel.id),
        });
      }
      items.push({
        label: 'Sesten Çıkar',
        danger: true,
        onClick: () =>
          void moderation.disconnect(userId).then((ok) => ok && toast(`${name} sesten çıkarıldı.`, 'success')),
      });
    }
  }

  if (actions.roles.length > 0) {
    items.push({ label: 'Roller', heading: true });
    for (const role of actions.roles) {
      const has = user.roles.includes(role.id);
      items.push({
        label: role.name,
        color: role.color,
        checked: has,
        onClick: () => void moderation.setRole(userId, role.id, !has),
      });
    }
  }

  if (actions.kick || actions.ban) items.push({ label: 'Üyelik', heading: true });
  if (actions.kick) {
    items.push({ label: `${name} kişisini at`, danger: true, onClick: () => void kickMember(userId) });
  }
  if (actions.ban) {
    items.push({
      label: `${name} kişisini yasakla`,
      danger: true,
      onClick: () => useUi.getState().setBanUser(user),
    });
  }
  // Engelleme hesap düzeyidir (yalnızca DM'leri etkiler); sunucuda da menünün sonunda
  items.push(...blockMenuItem(userId, selfId));
  return items;
}

/** Onay sorup üyeyi atar */
export async function kickMember(userId: string): Promise<void> {
  const user = useGuild.getState().users[userId];
  if (!user) return;
  const ok = await confirmDialog({
    title: `${user.displayName} atılsın mı?`,
    message: 'Sunucudan çıkarılır ve bu sunucudaki rolleri alınır. Mesajları kalır; yeni bir davetle geri dönebilir.',
    confirmLabel: 'At',
    danger: true,
  });
  if (ok && (await moderation.kick(userId))) toast(`${user.displayName} sunucudan atıldı.`, 'success');
}
