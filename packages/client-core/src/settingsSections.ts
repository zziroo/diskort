// Kullanıcı Ayarları'nın yapısı (Discord'daki gibi başlıklı gruplar ve satırlar). Masaüstü ve mobil aynı
// listeyi kullanır; birbirinden ayrışmasın diye bölümlerin kimliği, adı, grubu, sırası, simgesi, arama
// sözcükleri ve hangi platformda bulunduğu burada tek yerdedir. İçerikleri her platform kendisi çizer.

export type SettingsPlatform = 'desktop' | 'mobile';

export type SettingsSectionId =
  | 'account'
  | 'profile'
  | 'voice'
  | 'stream'
  | 'appearance'
  | 'notifications'
  | 'keybinds'
  | 'activity'
  | 'advanced'
  | 'feedbackAdmin'
  | 'accountAdmin'
  | 'webAdmin'
  | 'feedback'
  | 'whatsNew'
  | 'privacy';

export type SettingsGroupId = 'account' | 'app' | 'admin' | 'support';

export interface SettingsSectionInfo {
  id: SettingsSectionId;
  label: string;
  /** Aramada eşleşen başka sözcükler (bölümün içindeki ayarların adları) */
  keywords: readonly string[];
  /** Simge: mobilde Ionicons, masaüstünde lucide adı */
  icon: { mobile: string; desktop: string };
  /** Satırın simge kutusunun rengi (mobil) */
  color: string;
  platforms: readonly SettingsPlatform[];
  /** Yalnızca hesap yöneticilerine */
  adminOnly?: boolean;
  /**
   * 'page': kendi sayfası/bölümü var; 'link': dışarıda açılan adres (sunucu adresine göre `path`);
   * 'action': bir pencere/ekran açar (ör. geri bildirim gönder)
   */
  kind: 'page' | 'link' | 'action';
  /** kind 'link' için sunucu adresine eklenen yol */
  path?: string;
}

export interface SettingsGroupInfo {
  id: SettingsGroupId;
  title: string;
  sections: readonly SettingsSectionInfo[];
}

const both: readonly SettingsPlatform[] = ['desktop', 'mobile'];
const desktopOnly: readonly SettingsPlatform[] = ['desktop'];

export const SETTINGS_GROUPS: readonly SettingsGroupInfo[] = [
  {
    id: 'account',
    title: 'Hesap Ayarları',
    sections: [
      {
        id: 'account',
        label: 'Hesabım',
        keywords: ['görünen ad', 'kullanıcı adı', 'şifre', 'parola', 'hesabı sil', 'hesap'],
        icon: { mobile: 'person-circle', desktop: 'UserRound' },
        color: '#5865f2',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'profile',
        label: 'Profil',
        keywords: [
          'profil fotoğrafı',
          'avatar',
          'resim',
          'durum',
          'özel durum',
          'afiş',
          'kapak',
        ],
        icon: { mobile: 'color-palette', desktop: 'Palette' },
        color: '#eb459e',
        platforms: both,
        kind: 'page',
      },
    ],
  },
  {
    id: 'app',
    title: 'Uygulama Ayarları',
    sections: [
      {
        id: 'voice',
        label: 'Ses ve Görüntü',
        keywords: [
          'mikrofon',
          'hoparlör',
          'aygıt',
          'ses seviyesi',
          'gürültü engelleme',
          'yankı',
          'ses algılama',
          'bas-konuş',
          'titreşim',
          'mikrofon testi',
          'ses kalitesi',
        ],
        icon: { mobile: 'mic', desktop: 'Mic' },
        color: '#3ba55d',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'stream',
        label: 'Yayın',
        keywords: ['ekran paylaşımı', 'kalite', 'kodek', 'sistem sesi'],
        icon: { mobile: 'tv', desktop: 'MonitorUp' },
        color: '#3ba55d',
        platforms: desktopOnly,
        kind: 'page',
      },
      {
        id: 'appearance',
        label: 'Görünüm',
        keywords: ['tema', 'koyu', 'açık', 'siyah', 'oled', 'renk'],
        icon: { mobile: 'contrast', desktop: 'SunMoon' },
        color: '#00a8fc',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'notifications',
        label: 'Bildirimler ve Sesler',
        keywords: ['bildirim sesi', 'arayüz sesleri', 'sesli sohbet sesleri', 'sesleri dinle', 'bas-konuş sesleri'],
        icon: { mobile: 'notifications', desktop: 'Bell' },
        color: '#faa61a',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'keybinds',
        label: 'Kısayollar',
        keywords: ['kısayol', 'tuş', 'susturma', 'sağırlaştırma', 'bas-konuş'],
        icon: { mobile: 'keypad', desktop: 'Keyboard' },
        color: '#747f8d',
        platforms: desktopOnly,
        kind: 'page',
      },
      {
        id: 'activity',
        label: 'Etkinlik',
        keywords: ['oyun', 'oynuyor', 'oynadığım oyun', 'oyun algılama', 'oyun ekle', 'durum'],
        icon: { mobile: 'game-controller', desktop: 'Gamepad2' },
        color: '#5865f2',
        // Oyun algılama yalnızca masaüstünde (şimdilik Windows) var
        platforms: desktopOnly,
        kind: 'page',
      },
      {
        id: 'advanced',
        label: 'Gelişmiş',
        keywords: ['sistem tepsisi', 'başlangıç', 'açılışta başlat', 'sunucu adresi', 'sürüm'],
        icon: { mobile: 'construct', desktop: 'SlidersHorizontal' },
        color: '#747f8d',
        platforms: desktopOnly,
        kind: 'page',
      },
    ],
  },
  {
    id: 'admin',
    title: 'Yönetim',
    sections: [
      {
        id: 'feedbackAdmin',
        label: 'Geri bildirimler',
        keywords: ['hata', 'öneri', 'yönetim'],
        icon: { mobile: 'file-tray-full', desktop: 'Inbox' },
        color: '#faa61a',
        platforms: both,
        adminOnly: true,
        kind: 'page',
      },
      {
        id: 'accountAdmin',
        label: 'Hesaplar ve davetler',
        keywords: ['hesap yöneticileri', 'hesap davetleri', 'şifre sıfırlama', 'hesap sil'],
        icon: { mobile: 'people', desktop: 'UsersRound' },
        color: '#ed4245',
        platforms: both,
        adminOnly: true,
        kind: 'page',
      },
      {
        id: 'webAdmin',
        label: 'Web yönetim paneli',
        keywords: ['kullanım', 'sunucu yükü', 'trafik', 'istatistik', 'panel'],
        icon: { mobile: 'globe', desktop: 'Globe' },
        color: '#747f8d',
        platforms: both,
        adminOnly: true,
        kind: 'link',
        path: '/admin',
      },
    ],
  },
  {
    id: 'support',
    title: 'Destek',
    sections: [
      {
        id: 'feedback',
        label: 'Geri bildirim',
        keywords: ['hata bildir', 'öneri', 'geri bildirimlerim', 'destek'],
        icon: { mobile: 'chatbubble-ellipses', desktop: 'MessageSquareHeart' },
        color: '#3ba55d',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'whatsNew',
        label: 'Yenilikler',
        keywords: ['sürüm notları', 'değişiklikler', 'güncelleme'],
        icon: { mobile: 'sparkles', desktop: 'Sparkles' },
        color: '#5865f2',
        platforms: both,
        kind: 'page',
      },
      {
        id: 'privacy',
        label: 'Gizlilik',
        keywords: ['gizlilik politikası', 'veri'],
        icon: { mobile: 'shield-checkmark', desktop: 'ShieldCheck' },
        color: '#747f8d',
        platforms: both,
        kind: 'link',
        path: '/privacy',
      },
    ],
  },
];

/** Bölümün bilgisi (kimlikle) */
export function settingsSection(id: SettingsSectionId): SettingsSectionInfo | undefined {
  for (const g of SETTINGS_GROUPS) for (const s of g.sections) if (s.id === id) return s;
  return undefined;
}

/** Platformda görünen gruplar ve bölümler (yönetici olmayana yönetim yok); boş gruplar atılır */
export function settingsGroupsFor(platform: SettingsPlatform, options: { isAdmin: boolean }): SettingsGroupInfo[] {
  return SETTINGS_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter((s) => s.platforms.includes(platform) && (!s.adminOnly || options.isAdmin)),
  })).filter((g) => g.sections.length > 0);
}

/** Aramada karşılaştırma için: Türkçe küçük harf, aksanlar/noktalar atılmış ("Görünüm" → "gorunum") */
export function normalizeSearch(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Aramaya uyan bölümler: adında, grubun adında ya da arama sözcüklerinde geçen. Boş aramada gruplar olduğu
 * gibi döner. Eşleşmesi kalmayan gruplar atılır.
 */
export function searchSettings(groups: readonly SettingsGroupInfo[], query: string): SettingsGroupInfo[] {
  const q = normalizeSearch(query);
  if (!q) return [...groups];
  return groups
    .map((g) => {
      const groupMatch = normalizeSearch(g.title).includes(q);
      return {
        ...g,
        sections: g.sections.filter(
          (s) =>
            groupMatch ||
            normalizeSearch(s.label).includes(q) ||
            s.keywords.some((k) => normalizeSearch(k).includes(q)),
        ),
      };
    })
    .filter((g) => g.sections.length > 0);
}
