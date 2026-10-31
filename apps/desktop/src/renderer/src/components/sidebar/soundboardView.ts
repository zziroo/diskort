import { SOUNDBOARD_MAX_SOUNDS, type GuildSound } from '@diskort/shared';
import { ApiError, type GuildSoundGroup } from '@diskort/client-core';

/** Ses panelinde gösterilen bir sunucu grubu */
export interface SoundboardGroup {
  guild: GuildSoundGroup['guild'];
  /** Aramaya uyan sesler */
  sounds: GuildSound[];
  /** Kullanıcı bu sunucuya ses ekleyebilir (MANAGE_SOUNDBOARD) */
  canAdd: boolean;
  /** Sunucu ses sınırında */
  full: boolean;
}

const normalize = (text: string): string => text.trim().toLocaleLowerCase('tr');

/**
 * Panelde gösterilecek gruplar: bulunulan sunucu üstte, gerisi gelen sırada (sunucu adı). Sesi olmayan sunucu
 * yalnız kullanıcı ses ekleyebiliyorsa görünür; arama sürerken eşleşmesi olmayan gruplar gizlenir.
 */
export function soundboardGroups(
  groups: readonly GuildSoundGroup[],
  opts: { currentGuildId: string | null | undefined; canAdd: (guildId: string) => boolean; query?: string },
): SoundboardGroup[] {
  const query = normalize(opts.query ?? '');
  const shown: SoundboardGroup[] = [];
  for (const { guild, sounds: all } of groups) {
    const canAdd = opts.canAdd(guild.id);
    const sounds = query ? all.filter((s) => normalize(s.name).includes(query)) : all;
    if (sounds.length === 0 && (query || !canAdd)) continue;
    const group = { guild, sounds, canAdd, full: all.length >= SOUNDBOARD_MAX_SOUNDS };
    if (guild.id === opts.currentGuildId) shown.unshift(group);
    else shown.push(group);
  }
  return shown;
}

/** Çalma hatasının kullanıcıya gösterilecek metni; hız sınırı sessiz geçilir (null) */
export function soundboardPlayError(err: unknown): string | null {
  switch (err instanceof ApiError ? err.code : '') {
    case 'rate_limited':
      return null;
    case 'muted':
      return 'Susturulmuşken ya da sağırken ses çalamazsın.';
    case 'not_in_voice':
      return 'Önce bir ses kanalına katıl.';
    default:
      return 'Ses çalınamadı.';
  }
}
