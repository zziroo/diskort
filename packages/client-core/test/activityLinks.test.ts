import { describe, expect, it } from 'vitest';
import { activityLinks } from '../src/activityLinks';

describe('oyun sayfası bağlantıları', () => {
  it("Steam kimliği varsa Steam, SteamDB ve ProtonDB doğrudan oyunun sayfasına gider", () => {
    const links = activityLinks({ name: 'Portal 2', steamAppId: '620' });
    const byLabel = Object.fromEntries(links.map((l) => [l.label, l]));
    expect(byLabel["Steam'de aç"]).toMatchObject({ url: 'https://store.steampowered.com/app/620', direct: true, group: 'store' });
    expect(byLabel['SteamDB']).toMatchObject({ url: 'https://steamdb.info/app/620/', direct: true });
    expect(byLabel['ProtonDB (Linux uyumu)']).toMatchObject({ url: 'https://www.protondb.com/app/620', direct: true });
    expect(byLabel["Steam'de ara"]).toBeUndefined();
  });

  it('kimlik yoksa (Epic, elle eklenen) ada göre arama; ProtonDB yok, öteki platformlar yine var', () => {
    const links = activityLinks({ name: 'Fall Guys', steamAppId: null });
    const labels = links.map((l) => l.label);
    expect(labels).toEqual([
      "Steam'de ara",
      'Epic Games Store',
      'GOG',
      'SteamDB',
      'Nasıl geçiliyor (HowLongToBeat)',
      'Metacritic',
      "YouTube'da ara",
      "Twitch'te ara",
      "Google'da ara",
    ]);
    expect(links.every((l) => !l.direct)).toBe(true);
    expect(links[0]!.url).toBe('https://store.steampowered.com/search/?term=Fall%20Guys');
    expect(links.find((l) => l.label === 'SteamDB')!.url).toBe('https://steamdb.info/search/?a=app&q=Fall%20Guys');
  });

  it('ad adrese kodlanır (boşluk, &, Türkçe harf); geçersiz kimlik yok sayılır', () => {
    const links = activityLinks({ name: 'Şans & Zar: Yeni', steamAppId: 'abc' });
    expect(links.find((l) => l.label === "Google'da ara")!.url).toBe(
      'https://www.google.com/search?q=%C5%9Eans%20%26%20Zar%3A%20Yeni',
    );
    expect(links[0]!.label).toBe("Steam'de ara");
    expect(links.find((l) => l.label === "Steam'de ara")).toBeDefined();
    // Alan eski istemciden hiç gelmemiş olabilir
    expect(activityLinks({ name: 'Hades' })[0]!.label).toBe("Steam'de ara");
  });

  it('her bağlantı https ile başlar ve gruplar sıralıdır', () => {
    const links = activityLinks({ name: 'Hades', steamAppId: '1145360' });
    expect(links.every((l) => l.url.startsWith('https://'))).toBe(true);
    const order = ['store', 'info', 'watch', 'search'];
    const groups = links.map((l) => order.indexOf(l.group));
    expect([...groups].sort((a, b) => a - b)).toEqual(groups);
  });
});
