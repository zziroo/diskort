import { hasPermission, Permission, type ChannelType } from '@diskort/shared';

// Sunucu ayarlarının hangi bölümlerinin kime görüneceği ve kanal adı kuralı. Arayüzler yalnızca yetkisi
// olmayanın göremeyeceği işleri gizler; asıl denetim sunucudadır.

export type GuildSettingsSection = 'overview' | 'roles' | 'members' | 'invites' | 'bans' | 'channels' | 'sounds';

const P = Permission;

/** Bölümler ve onları gösteren yetkiler (herhangi biri yeter); sıra ekrandaki sıradır */
export const GUILD_SETTINGS_SECTIONS: readonly { id: GuildSettingsSection; any: readonly number[] }[] = [
  { id: 'overview', any: [P.MANAGE_GUILD] },
  { id: 'channels', any: [P.MANAGE_CHANNELS, P.MANAGE_ROLES] },
  { id: 'roles', any: [P.MANAGE_ROLES] },
  { id: 'members', any: [P.MANAGE_ROLES, P.KICK_MEMBERS, P.BAN_MEMBERS, P.MUTE_MEMBERS, P.DEAFEN_MEMBERS, P.MOVE_MEMBERS] },
  { id: 'sounds', any: [P.MANAGE_SOUNDBOARD] },
  { id: 'invites', any: [P.CREATE_INVITE, P.MANAGE_INVITES] },
  { id: 'bans', any: [P.BAN_MEMBERS] },
];

/**
 * Kullanıcının görebildiği sunucu ayarları bölümleri (masaüstündeki Sunucu Ayarları ile aynı kural):
 * genel bakışı sahip her zaman görür. Hiçbiri yoksa sunucu menüsünde "Sunucu ayarları" çıkmaz.
 */
export function guildSettingsSections(permissions: number, owner: boolean): GuildSettingsSection[] {
  return GUILD_SETTINGS_SECTIONS.filter(
    (s) => (s.id === 'overview' && owner) || s.any.some((flag) => hasPermission(permissions, flag)),
  ).map((s) => s.id);
}

/**
 * Yazılırken kutuda görünen kanal adı: metin kanalı adları Discord'daki gibi küçük harf ve tirelidir
 * ("Genel Sohbet" → "genel-sohbet"); ses kanallarının adı olduğu gibi kalır.
 */
export function typedChannelName(type: ChannelType, text: string): string {
  return type === 'text' ? text.toLocaleLowerCase('tr').replace(/\s+/g, '-') : text;
}

/** Kaydedilecek kanal adı: yazılan ad, baştaki/sondaki boşluklar (metin kanalında tireler de) atılmış */
export function channelNameFor(type: ChannelType, name: string): string {
  const typed = typedChannelName(type, name.trim());
  return type === 'text' ? typed.replace(/^-+|-+$/g, '') : typed;
}
