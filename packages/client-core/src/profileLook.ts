// Profil süsleri (afiş, tema): iki platformun ortak kısmı. Tema hazır renkleri ve degradesi burada
// tanımlanır.

import type { ProfileTheme } from '@diskort/shared';

/** Hazır temalar (ayarlarda seçilir; masaüstünde renkler ayrıca elle de seçilebilir) */
export const PROFILE_THEME_PRESETS: readonly (ProfileTheme & { name: string })[] = [
  { name: 'Kor', primary: '#5c0f0f', accent: '#ea580c' },
  { name: 'Gün batımı', primary: '#f97316', accent: '#be185d' },
  { name: 'Gece', primary: '#1e3a8a', accent: '#6d28d9' },
  { name: 'Okyanus', primary: '#0e7490', accent: '#1e40af' },
  { name: 'Orman', primary: '#14532d', accent: '#65a30d' },
  { name: 'Nane', primary: '#059669', accent: '#0ea5e9' },
  { name: 'Şeker', primary: '#f472b6', accent: '#8b5cf6' },
  { name: 'Gece yarısı', primary: '#0f172a', accent: '#475569' },
];

/**
 * Baş harfli avatarda yazının rengi: zemin açıksa koyu, değilse beyaz. Zemin artık tema rengi olabildiği
 * (serbest seçilen bir renk) için sabit beyaz yazı açık zeminde okunmazdı.
 */
export function avatarInk(background: string | undefined): string {
  const m = /^#([0-9a-f]{6})$/i.exec(background ?? '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1] ?? '', 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return luminance > 0.5 ? '#1e1f22' : '#ffffff';
}

/** Tema degradesi (CSS ve React Native'in backgroundImage'ı aynı sözdizimini kullanır) */
export const profileGradient = (theme: ProfileTheme): string =>
  `linear-gradient(180deg, ${theme.primary} 0%, ${theme.accent} 100%)`;
