import { describe, expect, it } from 'vitest';
import { ApiError, type GuildSoundGroup } from '@diskort/client-core';
import { SOUNDBOARD_MAX_SOUNDS, type GuildSound } from '@diskort/shared';
import { soundboardGroups, soundboardPlayError } from '../src/renderer/src/components/sidebar/soundboardView.js';

const sound = (guildId: string, id: string, name: string): GuildSound => ({
  id,
  guildId,
  name,
  emoji: null,
  url: `/api/sounds/${guildId}/${id}.mp3`,
  uploaderId: null,
  createdAt: 0,
  durationMs: 1000,
});

const group = (id: string, ...names: string[]): GuildSoundGroup =>
  ({ guild: { id, name: id }, sounds: names.map((n, i) => sound(id, `${id}${i}`, n)) }) as GuildSoundGroup;

const names = (groups: { guild: { id: string } }[]): string[] => groups.map((g) => g.guild.id);

describe('soundboardGroups', () => {
  const all = [group('a', 'Kuş'), group('b', 'Düdük'), group('c')];

  it('bulunulan sunucu üstte, gerisi gelen sırada', () => {
    expect(names(soundboardGroups(all, { currentGuildId: 'b', canAdd: () => true }))).toEqual(['b', 'a', 'c']);
  });
  it('sesi olmayan sunucu yalnız ses eklenebiliyorsa görünür', () => {
    expect(names(soundboardGroups(all, { currentGuildId: 'c', canAdd: () => false }))).toEqual(['a', 'b']);
    expect(names(soundboardGroups(all, { currentGuildId: 'c', canAdd: (id) => id === 'c' }))).toEqual(['c', 'a', 'b']);
  });
  it('arama Türkçe küçük harfle eşleşir, eşleşmeyen grup (ses eklenebilse de) gizlenir', () => {
    const shown = soundboardGroups(all, { currentGuildId: null, canAdd: () => true, query: ' KUŞ ' });
    expect(names(shown)).toEqual(['a']);
    expect(shown[0]!.sounds.map((s) => s.name)).toEqual(['Kuş']);
  });
  it('sınırdaki sunucu dolu sayılır (arama sonucu az olsa da)', () => {
    const many = group('d', ...Array.from({ length: SOUNDBOARD_MAX_SOUNDS }, (_, i) => `ses ${i}`));
    expect(soundboardGroups([many], { currentGuildId: null, canAdd: () => true })[0]!.full).toBe(true);
    expect(soundboardGroups([many], { currentGuildId: null, canAdd: () => true, query: 'ses 1' })[0]!.full).toBe(true);
    expect(soundboardGroups([group('e', 'x')], { currentGuildId: null, canAdd: () => true })[0]!.full).toBe(false);
  });
});

describe('soundboardPlayError', () => {
  const err = (status: number, code: string): ApiError => new ApiError(status, code, 'sunucu metni');

  it('hız sınırı sessiz geçilir', () => {
    expect(soundboardPlayError(err(429, 'rate_limited'))).toBeNull();
  });
  it('bilinen hatalar kendi metniyle, gerisi genel metinle', () => {
    expect(soundboardPlayError(err(403, 'muted'))).toBe('Susturulmuşken ya da sağırken ses çalamazsın.');
    expect(soundboardPlayError(err(409, 'not_in_voice'))).toBe('Önce bir ses kanalına katıl.');
    expect(soundboardPlayError(err(404, 'unknown_sound'))).toBe('Ses çalınamadı.');
    expect(soundboardPlayError(new Error('ağ'))).toBe('Ses çalınamadı.');
  });
});
