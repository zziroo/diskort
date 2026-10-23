// Oyun mağazalarının kurulu oyun kayıtları: Steam (libraryfolders.vdf + appmanifest_*.acf) ve Epic Games
// (Manifests\*.item). Oyunun klasörü ve mağazadaki adı buradan gelir; ayrıştırıcılar saf işlevlerdir.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Yolların karşılaştırma anahtarı: ters eğik çizgi, sonda çizgi yok, küçük harf (Windows yolları harfe duyarsız) */
export const pathKey = (path: string): string =>
  path
    .replace(/\//g, '\\')
    .replace(/(?!^)\\{2,}/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();

export type LibrarySource = 'steam' | 'epic' | 'battlenet';

export interface LibraryGame {
  /** Oyunun klasörü (pathKey biçiminde) */
  dir: string;
  /** Mağazadaki adı; bilinmiyorsa null (ad, exe'nin sürüm bilgisinden alınır) */
  name: string | null;
  source: LibrarySource;
  /** Oyun değil (ortak kurulum dosyaları, araç, film müziği…): içinden çalışan hiçbir şey oyun sayılmaz */
  tool?: boolean;
  /** Steam kaydından geldiyse uygulama kimliği (oyun sayfasındaki mağaza bağlantıları için) */
  steamAppId?: string;
}

export interface GameLibraries {
  games: readonly LibraryGame[];
}

export const EMPTY_LIBRARIES: GameLibraries = { games: [] };

// ---------- Steam ----------

export type VdfNode = { [key: string]: string | VdfNode };

/**
 * Valve'ın metin biçimi (VDF/ACF): tırnaklı anahtar-değer çiftleri ve süslü parantezli iç içe bölümler.
 * Bozuk ya da yarım dosyada o ana dek okunanı döndürür (atmaz).
 */
export function parseVdf(text: string): VdfNode {
  const root: VdfNode = {};
  const stack: VdfNode[] = [root];
  let key: string | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
    } else if (ch === '"') {
      let value = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else value += text[i++];
      }
      i++;
      if (key === null) key = value;
      else {
        stack[stack.length - 1]![key] = value;
        key = null;
      }
    } else if (ch === '{') {
      const node: VdfNode = {};
      if (key !== null) stack[stack.length - 1]![key] = node;
      stack.push(node);
      key = null;
      i++;
    } else if (ch === '}') {
      if (stack.length > 1) stack.pop();
      key = null;
      i++;
    } else i++;
  }
  return root;
}

/** Anahtar büyük/küçük harfe duyarsız aranır (Steam sürümleri arasında değişiyor) */
function vdfGet(node: VdfNode | undefined, name: string): string | VdfNode | undefined {
  if (!node) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(node)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

const vdfSection = (node: VdfNode | undefined, name: string): VdfNode | undefined => {
  const value = vdfGet(node, name);
  return typeof value === 'object' ? value : undefined;
};

const vdfString = (node: VdfNode | undefined, name: string): string | null => {
  const value = vdfGet(node, name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** libraryfolders.vdf içindeki kitaplık klasörleri (yeni biçim: bölüm içinde "path"; eski biçim: doğrudan yol) */
export function steamLibraryPaths(vdfText: string): string[] {
  const root = parseVdf(vdfText);
  const folders = vdfSection(root, 'libraryfolders') ?? vdfSection(root, 'LibraryFolders') ?? root;
  const paths: string[] = [];
  for (const [key, value] of Object.entries(folders)) {
    if (!/^\d+$/.test(key)) continue;
    const path = typeof value === 'string' ? value.trim() : vdfString(value, 'path');
    if (path) paths.push(path);
  }
  return paths;
}

export interface SteamApp {
  appId: string;
  name: string;
  installDir: string;
}

/** appmanifest_<id>.acf: oyunun adı ve steamapps\common altındaki klasörü; eksikse null */
export function parseAppManifest(acfText: string): SteamApp | null {
  const state = vdfSection(parseVdf(acfText), 'AppState');
  const appId = vdfString(state, 'appid');
  const name = vdfString(state, 'name');
  const installDir = vdfString(state, 'installdir');
  return appId && name && installDir ? { appId, name, installDir } : null;
}

/** Oyun olmayan Steam uygulamaları: ortak kurulum dosyaları, SteamVR, Wallpaper Engine */
const STEAM_TOOL_APP_IDS = new Set(['228980', '250820', '431960']);
const STEAM_TOOL_NAME = /\b(soundtrack|ost|sdk|dedicated server|redistributables?)\b/i;

export const isSteamTool = (app: SteamApp): boolean => STEAM_TOOL_APP_IDS.has(app.appId) || STEAM_TOOL_NAME.test(app.name);

// ---------- Epic Games ----------

/**
 * Epic manifesti (.item, JSON): adı ve kurulu olduğu klasör; bozuksa null. Oyun olmayan kayıt (Unreal Engine,
 * eklenti…) `tool` olarak döner: klasörü bilinsin ki "Epic Games" klasör kalıbı onu oyun saymasın.
 */
export function parseEpicManifest(itemText: string): { name: string; dir: string; tool?: true } | null {
  let data: unknown;
  try {
    data = JSON.parse(itemText);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const item = data as Record<string, unknown>;
  const name = typeof item.DisplayName === 'string' ? item.DisplayName.trim() : '';
  const dir = typeof item.InstallLocation === 'string' ? item.InstallLocation.trim() : '';
  if (!name || !dir) return null;
  // Unreal Engine, eklentiler vb. 'games' kategorisinde değildir; kategori yoksa oyun sayılır
  const categories = item.AppCategories;
  if (Array.isArray(categories) && categories.length > 0 && !categories.includes('games')) return { name, dir, tool: true };
  return { name, dir };
}

// ---------- Diskten okuma ----------

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function steamGames(steamPath: string): Promise<LibraryGame[]> {
  const libraries = new Map<string, string>([[pathKey(steamPath), steamPath]]);
  for (const file of [join(steamPath, 'steamapps', 'libraryfolders.vdf'), join(steamPath, 'config', 'libraryfolders.vdf')]) {
    const text = await readText(file);
    if (!text) continue;
    for (const path of steamLibraryPaths(text)) libraries.set(pathKey(path), path);
    break;
  }
  const games: LibraryGame[] = [];
  for (const library of libraries.values()) {
    const apps = join(library, 'steamapps');
    let files: string[];
    try {
      files = await readdir(apps);
    } catch {
      continue; // ör. takılı olmayan disk
    }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
      const text = await readText(join(apps, file));
      const app = text ? parseAppManifest(text) : null;
      if (!app) continue;
      games.push({
        dir: pathKey(join(apps, 'common', app.installDir)),
        name: app.name,
        source: 'steam',
        steamAppId: app.appId,
        ...(isSteamTool(app) ? { tool: true } : {}),
      });
    }
  }
  return games;
}

async function epicGames(programData: string): Promise<LibraryGame[]> {
  const dir = join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const games: LibraryGame[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.item')) continue;
    const text = await readText(join(dir, file));
    const game = text ? parseEpicManifest(text) : null;
    if (game) games.push({ dir: pathKey(game.dir), name: game.name, source: 'epic', ...(game.tool ? { tool: true } : {}) });
  }
  return games;
}

/** Kurulu oyunların kaydını okur; okunamayan mağaza atlanır */
export async function loadGameLibraries(steamPath: string | null, programData: string | undefined): Promise<GameLibraries> {
  const [steam, epic] = await Promise.all([
    steamPath ? steamGames(steamPath).catch(() => []) : [],
    programData ? epicGames(programData).catch(() => []) : [],
  ]);
  return { games: withoutShadowingTools([...steam, ...epic]) };
}

/**
 * Bir oyunla aynı klasörü gösteren araç kayıtları atılır: Epic'te ek paket (DLC) manifestleri ana oyunun
 * klasörünü taşır ve oyunu gizlememelidir.
 */
export function withoutShadowingTools(games: readonly LibraryGame[]): LibraryGame[] {
  const gameDirs = new Set(games.filter((g) => !g.tool).map((g) => g.dir));
  return games.filter((g) => !g.tool || !gameDirs.has(g.dir));
}
