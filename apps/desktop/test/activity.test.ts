import { describe, expect, it } from 'vitest';
import {
  classifyProcess,
  currentGames,
  detectGames,
  isExcludedExe,
  programName,
  resolveName,
  trimName,
  type ClassifyContext,
  type ScannedProcess,
} from '../src/main/activity/classify.js';
import {
  isSteamTool,
  parseAppManifest,
  parseEpicManifest,
  parseVdf,
  pathKey,
  steamLibraryPaths,
  withoutShadowingTools,
  type GameLibraries,
} from '../src/main/activity/libraries.js';
import {
  addManualGame,
  defaultPrefs,
  isKnownPath,
  knownGames,
  rememberSeenGame,
  removeManualGame,
  sanitizePrefs,
  setGameHidden,
} from '../src/main/activity/prefs.js';
import { iconKeyOf, pngChunks, sanitizeIconPng } from '../src/main/activity/png.js';
import { iconRequestLine, parseScannerLine } from '../src/main/activity/protocol.js';

const LIBRARY_FOLDERS = `
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"378269570"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"apps"
		{
			"620"		"12755935432"
		}
	}
}
`;

const APP_MANIFEST = `
"AppState"
{
	"appid"		"620"
	"universe"		"1"
	"name"		"Portal 2"
	"StateFlags"		"4"
	"installdir"		"Portal 2"
	"UserConfig"
	{
		"language"		"turkish"
	}
}
`;

describe('Steam dosyaları', () => {
  it('VDF: iç içe bölümler, kaçışlar ve yorumlar', () => {
    expect(parseVdf('"a" { "b" "1" // yorum\n "c" { "d" "x\\\\y \\"z\\"" } } "e" "2"')).toEqual({
      a: { b: '1', c: { d: 'x\\y "z"' } },
      e: '2',
    });
  });

  it('VDF: yarım dosya atmaz, okunanı döndürür', () => {
    expect(parseVdf('"a" { "b" "1" "c" {')).toEqual({ a: { b: '1', c: {} } });
    expect(parseVdf('')).toEqual({});
  });

  it('kitaplık klasörleri: yeni biçim (bölüm içinde path) ve eski biçim (doğrudan yol)', () => {
    expect(steamLibraryPaths(LIBRARY_FOLDERS)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
    expect(steamLibraryPaths('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "E:\\\\Oyunlar" }')).toEqual(['E:\\Oyunlar']);
    expect(steamLibraryPaths('bozuk')).toEqual([]);
  });

  it('appmanifest: ad ve klasör; eksikse null', () => {
    expect(parseAppManifest(APP_MANIFEST)).toEqual({ appId: '620', name: 'Portal 2', installDir: 'Portal 2' });
    expect(parseAppManifest('"AppState" { "appid" "1" "name" "X" }')).toBeNull();
    expect(parseAppManifest('')).toBeNull();
  });

  it('oyun olmayan Steam uygulamaları ayrılır', () => {
    expect(isSteamTool({ appId: '228980', name: 'Steamworks Common Redistributables', installDir: 'Steamworks Shared' })).toBe(true);
    expect(isSteamTool({ appId: '431960', name: 'Wallpaper Engine', installDir: 'wallpaper_engine' })).toBe(true);
    expect(isSteamTool({ appId: '1', name: 'Hollow Knight - Official Soundtrack', installDir: 'x' })).toBe(true);
    expect(isSteamTool({ appId: '620', name: 'Portal 2', installDir: 'Portal 2' })).toBe(false);
    expect(isSteamTool({ appId: '2', name: 'Lost Ark', installDir: 'Lost Ark' })).toBe(false);
  });
});

describe('Epic manifesti', () => {
  it('oyunun adı ve klasörü', () => {
    const item = JSON.stringify({
      DisplayName: 'Fall Guys',
      InstallLocation: 'C:\\Program Files\\Epic Games\\FallGuys',
      AppCategories: ['games', 'applications'],
    });
    expect(parseEpicManifest(item)).toEqual({ name: 'Fall Guys', dir: 'C:\\Program Files\\Epic Games\\FallGuys' });
  });

  it('oyun olmayan kayıt (motor, eklenti) araç olarak işaretlenir; eksik ya da bozuk manifest atlanır', () => {
    expect(parseEpicManifest(JSON.stringify({ DisplayName: 'Unreal Engine', InstallLocation: 'C:\\UE_5.4', AppCategories: ['engines'] }))).toEqual({
      name: 'Unreal Engine',
      dir: 'C:\\UE_5.4',
      tool: true,
    });
    expect(parseEpicManifest(JSON.stringify({ DisplayName: 'Adsız' }))).toBeNull();
    expect(parseEpicManifest(' '.repeat(2000))).toBeNull();
    expect(parseEpicManifest('[1]')).toBeNull();
    // Kategori alanı olmayan eski manifest oyun sayılır
    expect(parseEpicManifest(JSON.stringify({ DisplayName: 'Eski', InstallLocation: 'D:\\Eski' }))).toEqual({ name: 'Eski', dir: 'D:\\Eski' });
  });
});

const libraries: GameLibraries = {
  games: [
    { dir: pathKey('D:\\SteamLibrary\\steamapps\\common\\Portal 2'), name: 'Portal 2', source: 'steam', steamAppId: '620' },
    { dir: pathKey('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING'), name: 'ELDEN RING', source: 'steam' },
    { dir: pathKey('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Steamworks Shared'), name: 'Steamworks Common Redistributables', source: 'steam', tool: true },
    { dir: pathKey('D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine'), name: 'Wallpaper Engine', source: 'steam', tool: true },
    { dir: pathKey('C:\\Program Files\\Epic Games\\FallGuys'), name: 'Fall Guys', source: 'epic' },
    { dir: pathKey('E:\\Oyunlar\\Overwatch'), name: null, source: 'battlenet' },
  ],
};

const ctx = (extra: Partial<ClassifyContext> = {}): ClassifyContext => ({
  libraries,
  manual: [],
  hidden: [],
  selfPath: 'C:\\Users\\ayse\\AppData\\Local\\Programs\\diskort\\Diskort.exe',
  ...extra,
});

let nextPid = 100;
const proc = (path: string, extra: Partial<ScannedProcess> = {}): ScannedProcess => ({
  pid: nextPid++,
  path,
  startedAt: 1_000_000,
  productName: null,
  fileDescription: null,
  ...extra,
});

const nameOf = (path: string, extra: Partial<ScannedProcess> = {}, context = ctx()): string | null =>
  classifyProcess(proc(path, extra), context)?.name ?? null;

describe('oyun sınıflandırma', () => {
  it('Steam: kayıtlı klasörün içindeki exe oyundur, ad manifestten gelir (harf büyüklüğü ve / fark etmez)', () => {
    expect(nameOf('D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe', { productName: 'Portal 2 Source' })).toBe('Portal 2');
    expect(nameOf('d:/steamlibrary/steamapps/common/elden ring/Game/eldenring.exe')).toBe('ELDEN RING');
    const game = classifyProcess(proc('D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe'), ctx());
    expect(game?.source).toBe('steam');
    // Steam kimliği kayıttan gelir (oyun sayfasındaki mağaza bağlantıları için); kaydı olmayanlarda null
    expect(game?.steamAppId).toBe('620');
    expect(classifyProcess(proc('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe'), ctx())?.steamAppId).toBeNull();
    expect(classifyProcess(proc('C:\\Program Files\\Epic Games\\FallGuys\\FallGuys.exe'), ctx())?.steamAppId).toBeNull();
  });

  it('Epic: manifestteki klasör; manifest yoksa "Epic Games" klasörü', () => {
    expect(nameOf('C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe', { productName: 'FallGuys_client' })).toBe('Fall Guys');
    expect(nameOf('D:\\Epic Games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe', { productName: 'Rocket League' })).toBe('Rocket League');
    expect(nameOf('C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe')).toBeNull();
    expect(nameOf('C:\\Program Files (x86)\\Epic Games\\Launcher\\Engine\\Binaries\\Win64\\Baska.exe')).toBeNull();
  });

  it('kayıtsız Steam kitaplığı: steamapps\\common kalıbıyla tanınır', () => {
    const game = classifyProcess(proc('F:\\Kitaplik\\steamapps\\common\\Balatro\\Balatro.exe'), ctx());
    expect(game).toMatchObject({ name: 'Balatro', source: 'folder' });
  });

  it('klasör kalıpları: Riot, Ubisoft, EA, GOG, Xbox', () => {
    expect(nameOf('C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', { productName: 'VALORANT' })).toBe('VALORANT');
    expect(nameOf('C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe', { fileDescription: 'League of Legends (TM) Client' })).toBe(
      'League of Legends (TM) Client',
    );
    expect(nameOf('C:\\Riot Games\\Riot Client\\UX\\Baska.exe')).toBeNull();
    expect(nameOf('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Anno 1800\\Bin\\Win64\\Anno1800.exe')).toBe('Anno 1800');
    expect(nameOf('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe')).toBeNull();
    expect(nameOf('C:\\Program Files\\EA Games\\It Takes Two\\Nuts\\Binaries\\Win64\\ItTakesTwo.exe')).toBe('It Takes Two');
    expect(nameOf('D:\\GOG Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe', { productName: 'Cyberpunk 2077' })).toBe('Cyberpunk 2077');
    expect(nameOf('C:\\Program Files (x86)\\GOG Galaxy\\Games\\Gwent\\Gwent.exe')).toBe('Gwent');
    expect(nameOf('C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe')).toBeNull();
    expect(nameOf('D:\\XboxGames\\Forza Horizon 5\\Content\\ForzaHorizon5.exe')).toBe('Forza Horizon 5');
  });

  it('Blizzard: kurulum klasörü mağaza kaydı gibi verilir, ad sürüm bilgisinden gelir', () => {
    expect(nameOf('E:\\Oyunlar\\Overwatch\\_retail_\\Overwatch.exe', { productName: 'Overwatch' })).toBe('Overwatch');
    expect(nameOf('C:\\Program Files (x86)\\Battle.net\\Battle.net.exe', { productName: 'Battle.net' })).toBeNull();
  });

  it('kitaplık dışındaki programlar oyun değildir', () => {
    expect(nameOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { productName: 'Google Chrome' })).toBeNull();
    expect(nameOf('C:\\Windows\\explorer.exe')).toBeNull();
    // Klasör adı yalnızca tam eşleşince sayılır; oyun klasörünün kendisi de gerekir
    expect(nameOf('C:\\Benim Riot Games Yedegim\\x\\oyun.exe')).toBeNull();
    expect(nameOf('C:\\Riot Games\\oyun.exe')).toBeNull();
    expect(nameOf('')).toBeNull();
  });

  it('başlatıcılar, yardımcılar, çökme bildiricileri ve araçlar dışlanır', () => {
    for (const path of [
      'C:\\Program Files (x86)\\Steam\\steam.exe',
      'C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win64\\steamwebhelper.exe',
      'D:\\SteamLibrary\\steamapps\\common\\Hollow Knight\\UnityCrashHandler64.exe',
      'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\EasyAntiCheat\\EasyAntiCheat_EOS_Setup.exe',
      'D:\\SteamLibrary\\steamapps\\common\\Palworld\\Engine\\Binaries\\Win64\\CrashReportClient.exe',
      'D:\\SteamLibrary\\steamapps\\common\\Portal 2\\_CommonRedist\\vcredist\\2010\\vcredist_x64.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Steamworks Shared\\_CommonRedist\\DirectX\\DXSETUP.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Steamworks Shared\\baska.exe',
      'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe',
      'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\bin\\ui32.exe',
      'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
      'C:\\Program Files\\Epic Games\\FallGuys\\unins000.exe',
    ]) {
      expect(classifyProcess(proc(path), ctx()), path).toBeNull();
    }
    expect(isExcludedExe('C:\\x\\GameOverlayUI.exe')).toBe(true);
    expect(isExcludedExe('C:\\x\\crashpad_handler.exe')).toBe(true);
    expect(isExcludedExe('C:\\x\\eldenring.exe')).toBe(false);
  });

  it('Diskort kendini asla bildirmez (elle eklenmiş olsa bile)', () => {
    const self = 'C:\\Users\\ayse\\AppData\\Local\\Programs\\diskort\\Diskort.exe';
    expect(classifyProcess(proc(self), ctx({ manual: [{ path: self, name: 'Diskort' }] }))).toBeNull();
    // Geliştirme sürümünde exe'nin adı farklıdır: yoluyla tanınır
    const dev = 'C:\\proje\\node_modules\\electron\\dist\\electron.exe';
    expect(classifyProcess(proc(dev), ctx({ selfPath: dev, manual: [{ path: dev, name: 'Electron' }] }))).toBeNull();
  });

  it('elle eklenen her zaman oyundur (dışlananlar dahil), adı kullanıcının listesindekidir', () => {
    const path = 'C:\\Oyunlar\\Minecraft\\javaw.exe';
    expect(classifyProcess(proc(path, { productName: 'Java Platform SE' }), ctx({ manual: [{ path: path.toUpperCase(), name: 'Minecraft' }] }))).toMatchObject({
      name: 'Minecraft',
      source: 'manual',
    });
    const launcher = 'C:\\Oyunlar\\X\\launcher_overlay.exe';
    expect(nameOf(launcher)).toBeNull();
    expect(nameOf(launcher, {}, ctx({ manual: [{ path: launcher, name: 'X' }] }))).toBe('X');
  });

  it('Unreal Engine oyun değildir: manifesti olsa da olmasa da', () => {
    const editor = 'C:\\Program Files\\Epic Games\\UE_5.4\\Engine\\Binaries\\Win64\\UnrealEditor.exe';
    const other = 'C:\\Program Files\\Epic Games\\UE_5.4\\Engine\\Binaries\\Win64\\Baska.exe';
    // Manifest yok: "Epic Games" klasör kalıbı UE_* klasörlerini oyun saymaz
    expect(nameOf(editor, { productName: 'Unreal Engine' })).toBeNull();
    expect(nameOf(other, { productName: 'Baska' })).toBeNull();
    // Manifest var (oyun kategorisinde değil): araç kaydı klasör kalıbından önce gelir
    const engine = parseEpicManifest(
      JSON.stringify({ DisplayName: 'Unreal Engine', InstallLocation: 'D:\\Epic Games\\Motor', AppCategories: ['engines'] }),
    )!;
    const withEngine = ctx({
      libraries: { games: [...libraries.games, { dir: pathKey(engine.dir), name: engine.name, source: 'epic', tool: engine.tool }] },
    });
    expect(nameOf('D:\\Epic Games\\Motor\\Engine\\Binaries\\Win64\\UnrealEditor.exe', {}, withEngine)).toBeNull();
    expect(nameOf('D:\\Epic Games\\Motor\\Engine\\Binaries\\Win64\\Baska.exe', { productName: 'Baska' }, withEngine)).toBeNull();
    // Kayıt yokken aynı klasör kalıpla oyun sayılırdı (kaydın işe yaradığının denetimi)
    expect(nameOf('D:\\Epic Games\\Motor\\Engine\\Binaries\\Win64\\Baska.exe', { productName: 'Baska' })).toBe('Baska');
    // Adından da tanınır (başka yere kurulmuş motor, elle eklenmedikçe)
    expect(isExcludedExe('E:\\UE\\UnrealEditor-Cmd.exe')).toBe(true);
    expect(isExcludedExe('E:\\UE\\UE4Editor.exe')).toBe(true);
  });

  it('ek paket (DLC) manifesti ana oyunla aynı klasörü gösterse de oyunu gizlemez', () => {
    const dir = pathKey('C:\\Program Files\\Epic Games\\FallGuys');
    const addon = { dir, name: 'Fall Guys - Ek Paket', source: 'epic' as const, tool: true };
    const game = { dir, name: 'Fall Guys', source: 'epic' as const };
    const exe = 'C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe';
    // Sıra ne olursa olsun oyun kaydı kazanır
    expect(nameOf(exe, {}, ctx({ libraries: { games: [addon, game] } }))).toBe('Fall Guys');
    expect(nameOf(exe, {}, ctx({ libraries: { games: [game, addon] } }))).toBe('Fall Guys');
    // Kayıtlar okunurken de oyunla aynı klasördeki araç kaydı atılır; başka klasördeki kalır
    const engine = { dir: pathKey('C:\\Program Files\\Epic Games\\UE_5.4'), name: 'Unreal Engine', source: 'epic' as const, tool: true };
    expect(withoutShadowingTools([addon, game, engine])).toEqual([game, engine]);
    // Yalnızca araç kaydı varsa içindekiler oyun değildir
    expect(nameOf(exe, {}, ctx({ libraries: { games: [addon] } }))).toBeNull();
  });

  it('gizlenen hiçbir koşulda bildirilmez', () => {
    const path = 'D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe';
    expect(nameOf(path, {}, ctx({ hidden: ['d:/steamlibrary/steamapps/common/portal 2/PORTAL2.EXE'] }))).toBeNull();
    expect(nameOf(path, {}, ctx({ hidden: [path], manual: [{ path, name: 'Portal 2' }] }))).toBeNull();
  });
});

describe('ad seçimi', () => {
  const p = (extra: Partial<ScannedProcess>): ScannedProcess => proc('C:\\Oyun\\Klasor\\game-win64.exe', extra);

  it('sıra: mağaza adı → ürün adı → dosya açıklaması → oyun klasörü → exe adı', () => {
    expect(resolveName(p({ productName: 'Ürün', fileDescription: 'Açıklama' }), 'Mağaza', 'Klasor')).toBe('Mağaza');
    expect(resolveName(p({ productName: 'Ürün', fileDescription: 'Açıklama' }), null, 'Klasor')).toBe('Ürün');
    expect(resolveName(p({ productName: '  ', fileDescription: 'Açıklama' }), null, 'Klasor')).toBe('Açıklama');
    expect(resolveName(p({}), null, 'Klasor')).toBe('Klasor');
    expect(resolveName(p({}))).toBe('game-win64');
    expect(programName(p({ fileDescription: 'Not Defteri' }))).toBe('Not Defteri');
  });

  it('motorun bıraktığı genel adlar atlanır', () => {
    expect(resolveName(p({ productName: 'BootstrapPackagedGame', fileDescription: 'Unreal Engine' }), null, 'Klasor')).toBe('Klasor');
    expect(resolveName(p({ productName: 'UnityPlayer', fileDescription: 'Gerçek Ad' }))).toBe('Gerçek Ad');
  });

  it('ad 64 birime kırpılır; çift birimli karakter bölünmez', () => {
    expect(trimName('a'.repeat(80))).toHaveLength(64);
    expect(trimName(`${'a'.repeat(63)}😀b`)).toBe('a'.repeat(63));
    expect(trimName('  Oyun  ')).toBe('Oyun');
    expect(resolveName(p({ productName: `${'x'.repeat(70)}` }))).toHaveLength(64);
  });
});

describe('birden çok oyun', () => {
  it('açık olan bütün oyunlar bildirilir: en son başlatılan ilk sırada', () => {
    const games = detectGames(
      [
        proc('D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe', { startedAt: 5000 }),
        proc('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { startedAt: 9000 }),
        proc('C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe', { startedAt: 7000 }),
        proc('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe', { startedAt: 6000 }),
      ],
      ctx(),
    );
    expect(currentGames(games).map((g) => [g.name, g.startedAt])).toEqual([
      ['Fall Guys', 7000],
      ['ELDEN RING', 6000],
      ['Portal 2', 5000],
    ]);
    expect(currentGames([])).toEqual([]);
  });

  it('en fazla dört oyun bildirilir (en son başlatılanlar)', () => {
    const procs = Array.from({ length: 6 }, (_, i) => proc(`F:\\Kitaplik\\steamapps\\common\\Oyun ${i}\\oyun.exe`, { startedAt: 1000 + i }));
    expect(currentGames(detectGames(procs, ctx())).map((g) => g.name)).toEqual(['Oyun 5', 'Oyun 4', 'Oyun 3', 'Oyun 2']);
  });

  it('aynı exe birkaç süreçse oyun en eskisinin başladığı anda başlamıştır', () => {
    const path = 'D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe';
    const games = detectGames([proc(path, { startedAt: 8000, pid: 2 }), proc(path, { startedAt: 3000, pid: 1 })], ctx());
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ pid: 1, startedAt: 3000 });
  });

  it('aynı oyunun iki exe dosyası (başlatıcısı ve kendisi) tek oyun sayılır', () => {
    const games = detectGames(
      [
        proc('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\start_protected_game.exe', { startedAt: 1000 }),
        proc('D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe', { startedAt: 2000 }),
      ],
      ctx(),
    );
    expect(games).toHaveLength(2);
    expect(currentGames(games)).toMatchObject([{ name: 'ELDEN RING', startedAt: 2000 }]);
  });

  it('gizlenen oyun listeden düşer', () => {
    const procs = [
      proc('D:\\SteamLibrary\\steamapps\\common\\Portal 2\\portal2.exe', { startedAt: 5000 }),
      proc('C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe', { startedAt: 7000 }),
    ];
    const hidden = ['C:\\Program Files\\Epic Games\\FallGuys\\FallGuys_client_game.exe'];
    expect(currentGames(detectGames(procs, ctx({ hidden }))).map((g) => g.name)).toEqual(['Portal 2']);
  });
});

describe('etkinlik ayarları', () => {
  it('varsayılan: açık ve boş; bozuk kayıt varsayılana döner', () => {
    expect(defaultPrefs()).toEqual({ enabled: true, manual: [], hidden: [], seen: [] });
    expect(sanitizePrefs(null)).toEqual(defaultPrefs());
    expect(sanitizePrefs('x')).toEqual(defaultPrefs());
    expect(sanitizePrefs({ enabled: 'evet', manual: 'x', hidden: [1, '', 'C:\\a.exe'], seen: [{ path: 'C:\\b.exe' }] })).toEqual({
      enabled: true,
      manual: [],
      hidden: ['C:\\a.exe'],
      seen: [],
    });
  });

  it('kayıtlı ayarlar korunur; yinelenen yollar teke iner', () => {
    const saved = {
      enabled: false,
      manual: [
        { path: 'C:\\a.exe', name: 'A' },
        { path: 'c:/A.EXE', name: 'A yine' },
      ],
      hidden: ['C:\\b.exe'],
      seen: [{ path: 'C:\\c.exe', name: 'C', lastSeenAt: 5 }],
    };
    expect(sanitizePrefs(JSON.parse(JSON.stringify(saved)))).toEqual({
      enabled: false,
      manual: [{ path: 'C:\\a.exe', name: 'A' }],
      hidden: ['C:\\b.exe'],
      seen: [{ path: 'C:\\c.exe', name: 'C', lastSeenAt: 5 }],
    });
  });

  it('elle ekleme, çıkarma ve gizleme', () => {
    let prefs = setGameHidden(defaultPrefs(), 'C:\\a.exe', true);
    expect(prefs.hidden).toEqual(['C:\\a.exe']);
    // Gizli bir programı elle eklemek gizliliği kaldırır
    prefs = addManualGame(prefs, { path: 'c:\\A.exe', name: ' Oyun A ' });
    expect(prefs).toMatchObject({ manual: [{ path: 'c:\\A.exe', name: 'Oyun A' }], hidden: [] });
    prefs = addManualGame(prefs, { path: 'C:\\a.exe', name: 'Yeni ad' });
    expect(prefs.manual).toEqual([{ path: 'C:\\a.exe', name: 'Yeni ad' }]);
    prefs = setGameHidden(setGameHidden(prefs, 'C:\\a.exe', true), 'C:\\A.EXE', true);
    expect(prefs.hidden).toHaveLength(1);
    expect(setGameHidden(prefs, 'c:/a.exe', false).hidden).toEqual([]);
    prefs = removeManualGame(prefs, 'C:/A.exe');
    expect(prefs).toMatchObject({ manual: [], hidden: [] });
    expect(addManualGame(prefs, { path: 'C:\\a.exe', name: '   ' })).toBe(prefs);
  });

  it('algılanan oyun hatırlanır; bilinen oyun için ayarlar değişmez (dosyaya yeniden yazılmaz)', () => {
    const first = rememberSeenGame(defaultPrefs(), { path: 'C:\\a.exe', name: 'A' }, 10);
    expect(first.seen).toEqual([{ path: 'C:\\a.exe', name: 'A', lastSeenAt: 10 }]);
    expect(rememberSeenGame(first, { path: 'c:\\A.EXE', name: 'A' }, 20)).toBe(first);
    const renamed = rememberSeenGame(first, { path: 'C:\\a.exe', name: 'A 2' }, 30);
    expect(renamed.seen).toEqual([{ path: 'C:\\a.exe', name: 'A 2', lastSeenAt: 30 }]);
    let many = defaultPrefs();
    for (let i = 0; i < 130; i++) many = rememberSeenGame(many, { path: `C:\\${i}.exe`, name: `Oyun ${i}` }, i);
    expect(many.seen).toHaveLength(100);
    expect(many.seen[0]!.name).toBe('Oyun 129');
  });

  it('yalnızca bilinen oyunların ve çalışan programların yolu kabul edilir (gizleme için)', () => {
    const prefs = {
      enabled: true,
      manual: [{ path: 'C:\\m.exe', name: 'Minecraft' }],
      hidden: ['C:\\gizli.exe'],
      seen: [{ path: 'C:\\p.exe', name: 'Portal 2', lastSeenAt: 1 }],
    };
    const running = ['D:\\Programlar\\calisan.exe'];
    expect(isKnownPath(prefs, running, 'c:/M.EXE')).toBe(true);
    expect(isKnownPath(prefs, running, 'C:\\p.exe')).toBe(true);
    expect(isKnownPath(prefs, running, 'C:\\gizli.exe')).toBe(true);
    expect(isKnownPath(prefs, running, 'd:\\programlar\\CALISAN.exe')).toBe(true);
    expect(isKnownPath(prefs, running, 'C:\\baska.exe')).toBe(false);
    expect(isKnownPath(prefs, running, '\\\\sunucu\\paylasim\\x.exe')).toBe(false);
    expect(isKnownPath(prefs, running, '')).toBe(false);
    expect(isKnownPath(prefs, [], 'D:\\Programlar\\calisan.exe')).toBe(false);
  });

  it('bilinen oyunlar: elle eklenenler ve algılananlar ada göre; gizliler işaretli', () => {
    const prefs = {
      enabled: true,
      manual: [{ path: 'C:\\m.exe', name: 'Minecraft' }],
      hidden: ['C:\\P.exe', 'C:\\eski\\unutulan.exe'],
      seen: [
        { path: 'C:\\p.exe', name: 'Portal 2', lastSeenAt: 1 },
        { path: 'C:\\m.exe', name: 'Java', lastSeenAt: 2 },
        { path: 'C:\\e.exe', name: 'Elden Ring', lastSeenAt: 3 },
      ],
    };
    expect(knownGames(prefs)).toEqual([
      { path: 'C:\\e.exe', name: 'Elden Ring', manual: false, hidden: false },
      { path: 'C:\\m.exe', name: 'Minecraft', manual: true, hidden: false },
      { path: 'C:\\p.exe', name: 'Portal 2', manual: false, hidden: true },
      { path: 'C:\\eski\\unutulan.exe', name: 'unutulan', manual: false, hidden: true },
    ]);
  });
});

describe('tarayıcı satırları', () => {
  it('tarama: alanlar doğrulanır, bozuk süreçler atlanır', () => {
    const line = JSON.stringify({
      t: 'scan',
      procs: [
        { pid: 10, path: 'C:\\a.exe', start: 1234, product: ' Ürün ', desc: null },
        { pid: 'x', path: 'C:\\b.exe', start: 1 },
        { pid: 11, path: '', start: 1 },
        { pid: 12, path: 'C:\\c.exe', start: 0, product: 5, desc: 'x'.repeat(500) },
        null,
      ],
    });
    expect(parseScannerLine(line)).toEqual({
      t: 'scan',
      procs: [
        { pid: 10, path: 'C:\\a.exe', startedAt: 1234, productName: 'Ürün', fileDescription: null },
        { pid: 12, path: 'C:\\c.exe', startedAt: 0, productName: null, fileDescription: 'x'.repeat(128) },
      ],
    });
  });

  it('PowerShell tek öğeyi nesne, boş listeyi null yazsa da okunur; liste sınırlıdır', () => {
    expect(parseScannerLine('{"t":"scan","procs":{"pid":1,"path":"C:\\\\a.exe","start":5}}')).toMatchObject({ procs: [{ pid: 1 }] });
    expect(parseScannerLine('{"t":"scan","procs":null}')).toEqual({ t: 'scan', procs: [] });
    const many = { t: 'scan', procs: Array.from({ length: 500 }, (_, i) => ({ pid: i + 1, path: `C:\\${i}.exe`, start: 1 })) };
    expect((parseScannerLine(JSON.stringify(many)) as { procs: unknown[] }).procs).toHaveLength(200);
  });

  it('diğer satırlar; tanınmayan ve bozuk satır yok sayılır', () => {
    expect(parseScannerLine('{"t":"hello","native":true,"steam":"c:/program files (x86)/steam"}')).toEqual({
      t: 'hello',
      native: true,
      steam: 'c:/program files (x86)/steam',
    });
    expect(parseScannerLine('{"t":"hello"}')).toEqual({ t: 'hello', native: false, steam: null });
    expect(parseScannerLine('{"t":"icon","id":3,"png":"AAAA","ok":true}')).toEqual({ t: 'icon', id: 3, png: 'AAAA', ok: true });
    expect(parseScannerLine('{"t":"icon","id":3,"png":null,"ok":false}')).toEqual({ t: 'icon', id: 3, png: null, ok: false });
    expect(parseScannerLine('{"t":"icon","id":"3"}')).toBeNull();
    expect(parseScannerLine('{"t":"baska"}')).toBeNull();
    expect(parseScannerLine('#< CLIXML')).toBeNull();
    expect(parseScannerLine('null')).toBeNull();
  });

  it('ikon isteği tek satır JSON olarak gider (yol betiğe metin olarak eklenmez)', () => {
    const line = iconRequestLine(7, 'C:\\Oyun "x"\n; Remove-Item\\a.exe');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ t: 'icon', id: 7, path: 'C:\\Oyun "x"\n; Remove-Item\\a.exe' });
  });
});

describe('ikon dosyası (PNG)', () => {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC burada denetlenmez
  };
  const ihdr = (width: number, height = width): Buffer => {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = 8;
    data[9] = 6;
    return chunk('IHDR', data);
  };
  const png = (...chunks: Buffer[]): Buffer => Buffer.concat([SIGNATURE, ...chunks]);
  const types = (buffer: Buffer | null): string[] | undefined => (buffer ? pngChunks(buffer)?.map((c) => c.type) : undefined);

  it('yalnızca izin verilen parçalardan oluşan ikon olduğu gibi kalır', () => {
    // Windows yardımcısının (GDI+) yazdığı sıra
    const icon = png(
      ihdr(128),
      chunk('sRGB', Buffer.from([0])),
      chunk('gAMA', Buffer.alloc(4)),
      chunk('pHYs', Buffer.alloc(9)),
      chunk('IDAT', Buffer.alloc(40)),
      chunk('IEND'),
    );
    expect(sanitizeIconPng(icon)).toBe(icon);
    expect(iconKeyOf(icon)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('metin, animasyon ve özel parçalar atılır; anahtar ayıklanmış baytlardan hesaplanır', () => {
    const clean = png(ihdr(48), chunk('IDAT', Buffer.alloc(20, 7)), chunk('IEND'));
    const dirty = png(
      ihdr(48),
      chunk('tEXt', Buffer.from('Software=x')),
      chunk('acTL', Buffer.alloc(8)),
      chunk('iCCP', Buffer.alloc(30)),
      chunk('IDAT', Buffer.alloc(20, 7)),
      chunk('prVt', Buffer.alloc(5)),
      chunk('IEND'),
      Buffer.from('sondaki fazlalık'),
    );
    const result = sanitizeIconPng(dirty);
    expect(types(result)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(result!.equals(clean)).toBe(true);
    expect(iconKeyOf(result!)).toBe(iconKeyOf(clean));
  });

  it('kare olmayan, sınır dışı boyutlu, fazla büyük ya da bozuk dosya kabul edilmez', () => {
    const body = [chunk('IDAT', Buffer.alloc(10)), chunk('IEND')];
    expect(sanitizeIconPng(png(ihdr(64, 48), ...body))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(8), ...body))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(256), ...body))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(16), ...body))).not.toBeNull();
    expect(sanitizeIconPng(png(ihdr(128), chunk('IDAT', Buffer.alloc(70_000)), chunk('IEND')))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(64), chunk('IEND')))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(64), chunk('IDAT', Buffer.alloc(10))))).toBeNull();
    expect(sanitizeIconPng(png(chunk('IDAT'), ihdr(64), chunk('IEND')))).toBeNull();
    expect(sanitizeIconPng(png(ihdr(64), ...body).subarray(0, 40))).toBeNull();
    expect(sanitizeIconPng(Buffer.from('GIF89a'))).toBeNull();
    expect(sanitizeIconPng(Buffer.alloc(0))).toBeNull();
  });
});
