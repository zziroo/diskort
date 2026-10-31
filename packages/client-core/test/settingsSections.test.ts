import { describe, expect, it } from 'vitest';
import { normalizeSearch, searchSettings, SETTINGS_GROUPS, settingsGroupsFor, settingsSection } from '../src';

const ids = (groups: ReturnType<typeof settingsGroupsFor>): string[] => groups.flatMap((g) => g.sections.map((s) => s.id));

describe('ayarların yapısı', () => {
  it('bölüm kimlikleri tekildir', () => {
    const all = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it('bağlantı bölümlerinin yolu vardır', () => {
    for (const g of SETTINGS_GROUPS) for (const s of g.sections) if (s.kind === 'link') expect(s.path).toMatch(/^\//);
  });

  it('telefonda masaüstüne özgü bölümler ve yönetici olmayana yönetim görünmez', () => {
    const mobile = settingsGroupsFor('mobile', { isAdmin: false });
    expect(mobile.map((g) => g.id)).toEqual(['account', 'app', 'support']);
    expect(ids(mobile)).toEqual(['account', 'profile', 'voice', 'appearance', 'notifications', 'feedback', 'whatsNew', 'privacy']);
  });

  it('masaüstünde yöneticiye bütün gruplar aynı sırayla görünür', () => {
    const desktop = settingsGroupsFor('desktop', { isAdmin: true });
    expect(desktop.map((g) => g.title)).toEqual(['Hesap Ayarları', 'Uygulama Ayarları', 'Yönetim', 'Destek']);
    expect(ids(desktop)).toContain('keybinds');
    expect(ids(desktop)).toContain('accountAdmin');
    expect(ids(settingsGroupsFor('mobile', { isAdmin: true }))).toContain('webAdmin');
  });

  it('bölüm kimlikle bulunur', () => {
    expect(settingsSection('appearance')?.label).toBe('Görünüm');
  });
});

describe('ayarlarda arama', () => {
  const groups = settingsGroupsFor('desktop', { isAdmin: false });

  it('Türkçe harfler ve büyük/küçük harf fark etmez', () => {
    expect(normalizeSearch('  GÖRÜNÜM ')).toBe('gorunum');
    expect(normalizeSearch('Işık Şifre')).toBe('isik sifre');
  });

  it('adda, grup adında ve arama sözcüklerinde arar', () => {
    expect(ids(searchSettings(groups, 'gorunum'))).toEqual(['appearance']);
    expect(ids(searchSettings(groups, 'şifre'))).toEqual(['account']);
    expect(ids(searchSettings(groups, 'tema'))).toEqual(['appearance']);
    expect(ids(searchSettings(groups, 'ses paneli'))).toEqual(['voice']);
    expect(ids(searchSettings(groups, 'giriş sesi'))).toEqual(['voice']);
    expect(ids(searchSettings(groups, 'destek'))).toEqual(['feedback', 'whatsNew', 'privacy']);
  });

  it('boş arama hepsini, eşleşmeyen arama hiçbirini döndürür', () => {
    expect(searchSettings(groups, '  ')).toEqual(groups);
    expect(searchSettings(groups, 'zzzz')).toEqual([]);
  });
});
