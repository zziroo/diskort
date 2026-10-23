import { isSteamAppId, type Activity } from '@diskort/shared';

// Oyun sayfasındaki dış bağlantılar (saf mantık; masaüstü popover'ı bunları sistem tarayıcısında açar).
// Steam kimliği biliniyorsa Steam, SteamDB ve ProtonDB doğrudan oyunun sayfasına gider; bilinmiyorsa
// (Epic, Battle.net, elle eklenen ya da kayıtsız oyun) ada göre arama. Öteki platformlar her zaman ada
// göre aranır: Steam'de olmayan bir oyunun da bağlantıları olsun.

export type ActivityLinkGroup = 'store' | 'info' | 'watch' | 'search';

export interface ActivityLink {
  /** Düğmenin yazısı (Türkçe) */
  label: string;
  url: string;
  group: ActivityLinkGroup;
  /** Oyunun kendi sayfası (kimlikle); false: ada göre arama sonucu */
  direct: boolean;
}

export const ACTIVITY_LINK_GROUP_LABELS: Record<ActivityLinkGroup, string> = {
  store: 'Mağazalar',
  info: 'Bilgi',
  watch: 'İzle',
  search: 'Ara',
};

const q = (name: string): string => encodeURIComponent(name.trim());

/** Oyunun bağlantıları, gösterim sırasında (grup sırası: mağaza, bilgi, izle, ara) */
export function activityLinks(activity: Pick<Activity, 'name' | 'steamAppId'>): ActivityLink[] {
  const name = activity.name.trim();
  const id = isSteamAppId(activity.steamAppId) ? activity.steamAppId : null;
  const term = q(name);
  const links: ActivityLink[] = [];
  const add = (label: string, url: string, group: ActivityLinkGroup, direct = false): void => {
    links.push({ label, url, group, direct });
  };

  if (id) add("Steam'de aç", `https://store.steampowered.com/app/${id}`, 'store', true);
  else add("Steam'de ara", `https://store.steampowered.com/search/?term=${term}`, 'store');
  add('Epic Games Store', `https://store.epicgames.com/tr/browse?q=${term}`, 'store');
  add('GOG', `https://www.gog.com/tr/games?query=${term}`, 'store');

  if (id) add('SteamDB', `https://steamdb.info/app/${id}/`, 'info', true);
  else add('SteamDB', `https://steamdb.info/search/?a=app&q=${term}`, 'info');
  if (id) add('ProtonDB (Linux uyumu)', `https://www.protondb.com/app/${id}`, 'info', true);
  add('Nasıl geçiliyor (HowLongToBeat)', `https://howlongtobeat.com/?q=${term}`, 'info');
  add('Metacritic', `https://www.metacritic.com/search/${term}/?category=13`, 'info');

  add("YouTube'da ara", `https://www.youtube.com/results?search_query=${term}`, 'watch');
  add("Twitch'te ara", `https://www.twitch.tv/search?term=${term}&type=categories`, 'watch');

  add("Google'da ara", `https://www.google.com/search?q=${term}`, 'search');
  return links;
}
