import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from '@diskort/shared';
import { channelNameFor, guildSettingsSections, typedChannelName } from '../src';

describe('sunucu ayarları bölümleri', () => {
  it('varsayılan üye yalnızca davetleri görür', () => {
    expect(guildSettingsSections(DEFAULT_EVERYONE_PERMISSIONS, false)).toEqual(['invites']);
  });

  it('hiç yetkisi olmayan hiçbir bölüm görmez', () => {
    expect(guildSettingsSections(0, false)).toEqual([]);
  });

  it('sahip genel bakışı her zaman görür', () => {
    expect(guildSettingsSections(0, true)).toEqual(['overview']);
  });

  it('yönetici (bütün yetkiler) hepsini ekrandaki sırayla görür', () => {
    expect(guildSettingsSections(ALL_PERMISSIONS, false)).toEqual([
      'overview',
      'channels',
      'roles',
      'members',
      'sounds',
      'invites',
      'bans',
    ]);
  });

  it('yetkiye göre: rolleri yönetmek kanal izinlerini, rolleri ve üyeleri açar', () => {
    expect(guildSettingsSections(P.MANAGE_ROLES, false)).toEqual(['channels', 'roles', 'members']);
    expect(guildSettingsSections(P.MANAGE_CHANNELS, false)).toEqual(['channels']);
    expect(guildSettingsSections(P.BAN_MEMBERS, false)).toEqual(['members', 'bans']);
    expect(guildSettingsSections(P.MANAGE_SOUNDBOARD, false)).toEqual(['sounds']);
    expect(guildSettingsSections(P.MOVE_MEMBERS, false)).toEqual(['members']);
    expect(guildSettingsSections(P.MANAGE_INVITES, false)).toEqual(['invites']);
  });
});

describe('kanal adı', () => {
  it('metin kanalı yazılırken küçük harf ve tireli olur (boşluk yazmaya devam edilebilir)', () => {
    expect(typedChannelName('text', 'Genel Sohbet ')).toBe('genel-sohbet-');
    expect(typedChannelName('text', 'İÇERİK')).toBe('içerik');
    expect(typedChannelName('voice', 'Oyun Odası ')).toBe('Oyun Odası ');
  });

  it('kaydedilen adın başındaki ve sonundaki boşluk ve tire atılır', () => {
    expect(channelNameFor('text', '  Genel   Sohbet  ')).toBe('genel-sohbet');
    expect(channelNameFor('text', '-duyurular-')).toBe('duyurular');
    expect(channelNameFor('voice', '  Oyun Odası  ')).toBe('Oyun Odası');
    expect(channelNameFor('text', '   ')).toBe('');
  });
});
