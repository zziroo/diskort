import {
  Permission,
  TEXT_CHANNEL_PERMISSIONS,
  VOICE_CHANNEL_PERMISSIONS,
  type ChannelType,
  type PermissionName,
} from '@diskort/shared';

/** Yetkinin arayüzdeki adı ve açıklaması */
export interface PermissionInfo {
  name: PermissionName;
  flag: number;
  label: string;
  description: string;
}

export interface PermissionGroup {
  title: string;
  permissions: PermissionInfo[];
}

const info = (name: PermissionName, label: string, description: string): PermissionInfo => ({
  name,
  flag: Permission[name],
  label,
  description,
});

/** Rol düzenleme ekranındaki yetkiler, gruplarıyla */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: 'Genel',
    permissions: [
      info(
        'ADMINISTRATOR',
        'Yönetici',
        'Her yetkiye sahip olur ve kanal izinlerinden etkilenmez. Tehlikeli bir yetkidir, yalnızca güvendiğin kişilere ver.',
      ),
      info('MANAGE_GUILD', 'Sunucuyu Yönet', 'Sunucunun adını ve simgesini değiştirebilir.'),
      info(
        'MANAGE_SOUNDBOARD',
        'Ses Panelini Yönet',
        'Sunucunun ses paneline ses yükleyebilir, sesleri yeniden adlandırabilir ve silebilir.',
      ),
      info(
        'MANAGE_ROLES',
        'Rolleri Yönet',
        'Kendi en üst rolünün altındaki rolleri oluşturup düzenleyebilir, üyelere verebilir ve kanal izinlerini ayarlayabilir. Kendinde olmayan bir yetkiyi kimseye veremez.',
      ),
      info('MANAGE_CHANNELS', 'Kanalları Yönet', 'Kanal oluşturabilir, yeniden adlandırabilir ve silebilir.'),
      info(
        'CREATE_INVITE',
        'Davet Oluştur',
        'Sunucuya davet bağlantısı oluşturup arkadaşlarını getirebilir; kendi davetlerini görür ve silebilir.',
      ),
      info('MANAGE_INVITES', 'Davetleri Yönet', 'Herkesin oluşturduğu davetleri görebilir ve silebilir.'),
      info(
        'KICK_MEMBERS',
        'Üyeleri At',
        'Kendinden aşağıdaki üyeleri sunucudan çıkarabilir. Atılan kişi yeni bir davet koduyla geri dönebilir.',
      ),
      info(
        'BAN_MEMBERS',
        'Üyeleri Yasakla',
        'Kendinden aşağıdaki üyeleri sunucudan yasaklayabilir; yasaklı kişi yeni davetle geri dönemez. Yasakları kaldırabilir.',
      ),
    ],
  },
  {
    title: 'Metin Kanalları',
    permissions: [
      info(
        'VIEW_CHANNEL',
        'Kanalları Gör',
        'Kanalı listede görür, mesajlarını okur, ses kanalında kimlerin olduğunu görür. Bir kanalda kapatılırsa kanal gizli olur.',
      ),
      info('SEND_MESSAGES', 'Mesaj Gönder', 'Metin kanallarına mesaj yazabilir. Kapatılırsa kanal salt okunur olur.'),
      info('ATTACH_FILES', 'Dosya Ekle', 'Mesajlara dosya ve resim ekleyebilir.'),
      info(
        'ADD_REACTIONS',
        'Tepki Ekle',
        'Mesajlara yeni emoji tepkisi ekleyebilir. Kapalıyken de var olan tepkilere katılabilir.',
      ),
      info('MANAGE_MESSAGES', 'Mesajları Yönet', 'Başkalarının mesajlarını silebilir.'),
      info(
        'PIN_MESSAGES',
        'Mesajları Sabitle',
        'Mesajları kanala sabitleyebilir ve sabitlemelerini kaldırabilir. Sabitlenen mesajları kanalı gören herkes görür.',
      ),
      info(
        'MENTION_EVERYONE',
        '@everyone ve @here Bahset',
        '@everyone yazarak kanalı gören herkese, @here yazarak kanalı gören ve o an çevrimiçi olanlara bildirim gönderebilir. Yetkisi olmayanın yazdığı @everyone düz metin kalır.',
      ),
    ],
  },
  {
    title: 'Ses Kanalları',
    permissions: [
      info('CONNECT', 'Bağlan', 'Ses kanallarına katılabilir.'),
      info('SPEAK', 'Konuş', 'Ses kanalında mikrofonunu açabilir. Kapalıyken yalnızca dinler.'),
      info('STREAM', 'Ekran Paylaş', 'Ses kanalında ekranını ya da bir pencereyi paylaşabilir.'),
      info(
        'MUTE_MEMBERS',
        'Üyeleri Sustur',
        'Sesteki üyeleri sunucuda susturabilir; susturulan kişi mikrofonunu kendisi açamaz.',
      ),
      info(
        'DEAFEN_MEMBERS',
        'Üyeleri Sağırlaştır',
        'Sesteki üyeleri sunucuda sağırlaştırabilir; sağırlaştırılan kişi kimseyi duymaz ve konuşamaz.',
      ),
      info('MOVE_MEMBERS', 'Üyeleri Taşı', 'Sesteki üyeleri başka bir ses kanalına taşıyabilir ya da sesten çıkarabilir.'),
    ],
  },
];

const ALL_INFO = PERMISSION_GROUPS.flatMap((g) => g.permissions);

export function permissionInfo(flag: number): PermissionInfo | undefined {
  return ALL_INFO.find((p) => p.flag === flag);
}

/** Kanal düzenleme ekranında ayarlanabilen yetkiler (kanal türüne göre) */
export function channelPermissionInfos(type: ChannelType): PermissionInfo[] {
  const allowed = type === 'text' ? TEXT_CHANNEL_PERMISSIONS : VOICE_CHANNEL_PERMISSIONS;
  return ALL_INFO.filter((p) => (allowed & p.flag) === p.flag);
}
