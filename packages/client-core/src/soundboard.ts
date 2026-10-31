import { create } from 'zustand';
import {
  SOUNDBOARD_NAME_MAX,
  SOUNDBOARD_SOUND_MAX_BYTES,
  SOUNDBOARD_SOUND_MAX_SECONDS,
  soundboardCooldownMs,
  type GuildSound,
} from '@diskort/shared';
import { api, ApiError, normalizeServerUrl } from './api';
import { env, type LocalFile } from './env';
import { useGuild } from './guild';
import { formatBytes, sendFile } from './uploads';

// Ses paneli: sunucuya bağlı sesler (sözleşme docs/ses-paneli.md). REST yanıtları depoya hemen uygulanır
// (gateway olayı da gelir; tekrar zararsız). Çalma, dinleme ve ses seviyesi platforma özgü (sfx / sounds.ts).

/** Sesin tam adresi (kimliksiz, immutable; içerik değişince adres değişir) */
export const guildSoundUrl = (sound: Pick<GuildSound, 'url'>): string =>
  normalizeServerUrl(env().serverUrl()) + sound.url;

/** Sunucunun seslerini sunucudan alır ve depoya yazar (READY'de zaten gelir; yeniden bağlanınca tazelemek için) */
export async function fetchGuildSounds(guildId: string): Promise<GuildSound[]> {
  const sounds = await api.listGuildSounds(guildId);
  const store = useGuild.getState();
  const known = new Set(sounds.map((s) => s.id));
  for (const old of store.guilds[guildId]?.sounds ?? []) {
    if (!known.has(old.id)) store.apply({ t: 'GUILD_SOUND_DELETE', d: { guildId, soundId: old.id } });
  }
  for (const sound of sounds) store.apply({ t: 'GUILD_SOUND_UPDATE', d: { sound } });
  return sounds;
}

export interface UploadGuildSoundOptions {
  guildId: string;
  /** 1..SOUNDBOARD_NAME_MAX karakter (kırpılır) */
  name: string;
  /** Tek bir emoji; yoksa boş */
  emoji?: string | null;
  /** Kesit başlangıcı, saniye (varsayılan 0) */
  start?: number;
  /** Kesit süresi, saniye (varsayılan ve en çok SOUNDBOARD_SOUND_MAX_SECONDS) */
  duration?: number;
}

/** Sunucunun yalnızca düz ondalık sayı kabul ettiği saniye değeri (milisaniyeye yuvarlanır) */
const seconds = (value: number | undefined, fallback: number): string => {
  const n = Number.isFinite(value) && (value as number) > 0 ? Math.round((value as number) * 1000) / 1000 : fallback;
  return n.toFixed(3);
};

/**
 * Sunucunun ses paneline ses yükler (MANAGE_SOUNDBOARD). Sunucu sesi `start` saniyesinden `duration` saniyeye
 * kırpar, ses yüksekliğini eşitler ve MP3'e çevirir; dönen ses depoya yazılır. Hatalar: 400
 * invalid_name|invalid_emoji|invalid_start|invalid_duration|unsupported|empty, 409 sound_limit, 413 too_large,
 * 429 rate_limited, 503 unavailable (ffmpeg yok), 507 no_space.
 */
export async function uploadGuildSound(
  file: LocalFile,
  opts: UploadGuildSoundOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<GuildSound> {
  const name = opts.name.trim();
  if (name.length === 0 || name.length > SOUNDBOARD_NAME_MAX) {
    throw new ApiError(400, 'invalid_name', `Ses adı 1–${SOUNDBOARD_NAME_MAX} karakter olmalı.`);
  }
  if (file.size > SOUNDBOARD_SOUND_MAX_BYTES) {
    throw new ApiError(413, 'too_large', `Ses dosyası çok büyük (en fazla ${formatBytes(SOUNDBOARD_SOUND_MAX_BYTES)}).`);
  }
  const query = new URLSearchParams({
    name,
    start: seconds(opts.start, 0),
    duration: seconds(opts.duration, SOUNDBOARD_SOUND_MAX_SECONDS),
  });
  if (opts.emoji) query.set('emoji', opts.emoji);
  const { sound } = await sendFile<{ sound: GuildSound }>(
    `/api/guilds/${opts.guildId}/sounds?${query.toString()}`,
    file,
    201,
    'Ses yüklenemedi',
    () => undefined,
    signal,
  );
  useGuild.getState().apply({ t: 'GUILD_SOUND_CREATE', d: { sound } });
  return sound;
}

/** Sesin adını ve/veya emojisini değiştirir (emoji null: kaldır); MANAGE_SOUNDBOARD */
export async function updateGuildSound(
  guildId: string,
  soundId: string,
  patch: { name?: string; emoji?: string | null },
): Promise<GuildSound> {
  const sound = await api.updateGuildSound(guildId, soundId, patch);
  useGuild.getState().apply({ t: 'GUILD_SOUND_UPDATE', d: { sound } });
  return sound;
}

/** Sesi siler (MANAGE_SOUNDBOARD ya da hesap yöneticisi) */
export async function removeGuildSound(guildId: string, soundId: string): Promise<void> {
  await api.removeGuildSound(guildId, soundId);
  useGuild.getState().apply({ t: 'GUILD_SOUND_DELETE', d: { guildId, soundId } });
}

/**
 * Kullanıcının çaldığı ses bitene dek true. Yalnızca görünüm içindir, kural sunucudadır. Bekleme yanıttan sonra
 * başladığı için sunucununkinden biraz geç biter: düğme açıldığında sunucu reddetmez.
 */
export const useSoundboardCooldown = create<{ cooling: boolean }>()(() => ({ cooling: false }));
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

export const useSoundboardCooling = (): boolean => useSoundboardCooldown((s) => s.cooling);

/** Sesi bulunulan ses kanalındaki herkese çalar; SOUNDBOARD_PLAY olayı gönderene de gelir (hatalar: bkz. api.playGuildSound) */
export async function playGuildSound(sound: Pick<GuildSound, 'guildId' | 'id' | 'durationMs'>): Promise<void> {
  await api.playGuildSound(sound.guildId, sound.id);
  if (cooldownTimer) clearTimeout(cooldownTimer);
  useSoundboardCooldown.setState({ cooling: true });
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    useSoundboardCooldown.setState({ cooling: false });
  }, soundboardCooldownMs(sound.durationMs));
}
