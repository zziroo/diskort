import { create } from 'zustand';
import {
  foldSearchText,
  hasPermission,
  Permission,
  SEARCH_HAS_LABELS,
  SEARCH_HAS_VALUES,
  SEARCH_PAGE_SIZE,
  type SearchResult,
  type SearchScope,
  type User,
} from '@diskort/shared';
import { api, errorMessage } from './api';
import { useGuild, type GuildStore } from './guild';
import { permissionsOf } from './permissions';
import { jumpToMessage } from './replies';
import { sessionUserChanged, useSession } from './session';

// Mesaj araması (Discord gibi): kapsam seçili sunucu ya da açık direkt mesaj konuşması; sorguda
// from:, in:, has:, önce:, sonra:, tarih: işleçleri yazılabilir (sunucu çözer, bkz. @diskort/shared search.ts).

export interface SearchState {
  scope: SearchScope | null;
  /** Aranan (gönderilen) sorgu */
  query: string;
  status: 'idle' | 'loading' | 'done' | 'error';
  results: SearchResult[];
  total: number;
  totalCapped: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  /** Vurgulanan sözcükler */
  terms: string[];
  /** Sonuçlardaki yazarlar (istemcinin tanımadığı eski üyeler de) */
  users: Record<string, User>;
  error: string | null;
}

const initial = (): SearchState => ({
  scope: null,
  query: '',
  status: 'idle',
  results: [],
  total: 0,
  totalCapped: false,
  nextCursor: null,
  loadingMore: false,
  terms: [],
  users: {},
  error: null,
});

export const useSearch = create<SearchState>()(initial);

// Oturum değişince sonuçlar temizlenir
useSession.subscribe((s, prev) => {
  if (sessionUserChanged(s, prev)) useSearch.setState(initial());
});

/** Kapsamın anahtarı (aynı kapsam mı karşılaştırması için) */
export const searchScopeKey = (scope: SearchScope | null): string =>
  !scope ? '' : 'dmId' in scope ? `dm:${scope.dmId}` : `g:${scope.guildId}:${scope.channelId ?? ''}`;

let seq = 0;

function scopeParams(scope: SearchScope): Record<string, string> {
  if ('dmId' in scope) return { dmId: scope.dmId };
  return scope.channelId ? { guildId: scope.guildId, channelId: scope.channelId } : { guildId: scope.guildId };
}

async function fetchPage(scope: SearchScope, query: string, cursor: string | null) {
  const params: Record<string, string> = {
    ...scopeParams(scope),
    q: query,
    limit: String(SEARCH_PAGE_SIZE),
    tz: String(new Date().getTimezoneOffset()),
  };
  if (cursor) params.cursor = cursor;
  return api.search(params);
}

const usersOf = (list: User[], prev: Record<string, User> = {}): Record<string, User> => {
  const next = { ...prev };
  for (const u of list) next[u.id] = u;
  return next;
};

/** Aramayı başlatır (önceki sonuçların yerine) */
export async function runSearch(scope: SearchScope, query: string): Promise<void> {
  const q = query.trim();
  if (!q) {
    clearSearchResults();
    return;
  }
  const mine = ++seq;
  useSearch.setState({ ...initial(), scope, query: q, status: 'loading' });
  try {
    const page = await fetchPage(scope, q, null);
    if (mine !== seq) return;
    useSearch.setState({
      status: 'done',
      results: page.results,
      total: page.total,
      totalCapped: page.totalCapped,
      nextCursor: page.nextCursor,
      terms: page.terms,
      users: usersOf(page.users),
    });
  } catch (err) {
    if (mine !== seq) return;
    useSearch.setState({ status: 'error', error: errorMessage(err) });
  }
}

/** Sonraki sayfa (sonsuz kaydırma / "daha fazla") */
export async function loadMoreSearch(): Promise<void> {
  const s = useSearch.getState();
  if (!s.scope || !s.nextCursor || s.loadingMore || s.status !== 'done') return;
  const mine = seq;
  useSearch.setState({ loadingMore: true });
  try {
    const page = await fetchPage(s.scope, s.query, s.nextCursor);
    if (mine !== seq) return;
    const known = new Set(s.results.map((r) => r.message.id));
    useSearch.setState((cur) => ({
      loadingMore: false,
      results: [...cur.results, ...page.results.filter((r) => !known.has(r.message.id))],
      nextCursor: page.nextCursor,
      users: usersOf(page.users, cur.users),
    }));
  } catch (err) {
    if (mine !== seq) return;
    useSearch.setState({ loadingMore: false, error: errorMessage(err) });
  }
}

/** Aramayı kapatır (sonuçlar silinir) */
export function clearSearchResults(): void {
  seq++;
  useSearch.setState(initial());
}

/** Sonuca atlar: kanalın geçmişi mesaja kadar (en fazla 3000 mesaj) yüklenip mesaj vurgulanır */
export function jumpToSearchResult(result: SearchResult): Promise<boolean> {
  return jumpToMessage(result.channel.id, result.message.id, {
    maxPages: 30,
    notFound: 'Mesaj bulunamadı; silinmiş ya da çok eskide kalmış olabilir.',
  });
}

/**
 * Kanalı görebilen çevrimiçi üyelerin sayısı (başlıktaki "● 4 çevrim içi"). Direkt mesajda çevrimiçi
 * katılımcılar. Sayı döndüğünden seçicide doğrudan kullanılabilir.
 */
export function onlineViewerCount(
  s: Pick<GuildStore, 'guild' | 'roles' | 'users' | 'channels' | 'online' | 'dms' | 'guilds' | 'channelGuild' | 'reachable'>,
  channelId: string,
): number {
  const dm = s.dms[channelId];
  if (dm) return dm.participantIds.filter((id) => s.online[id]).length;
  let n = 0;
  for (const id of Object.keys(s.online)) {
    const user = s.users[id];
    if (!user || user.removed) continue;
    if (hasPermission(permissionsOf(s, id, channelId), Permission.VIEW_CHANNEL)) n++;
  }
  return n;
}

/** Seçili sunucudaki kanalı görebilen çevrimiçi üye sayısı */
export function useOnlineViewerCount(channelId: string | undefined): number {
  return useGuild((s) => (channelId ? onlineViewerCount(s, channelId) : 0));
}

// ---------- Sorgu yazarken öneriler ----------

/** Kutunun altındaki arama seçenekleri (işleçler); `dm`: konuşmada da geçerli */
export const SEARCH_OPTIONS: readonly { op: string; label: string; hint: string; dm: boolean }[] = [
  { op: 'from:', label: 'Kimden', hint: 'kullanıcı', dm: true },
  { op: 'in:', label: 'Kanal', hint: 'kanal', dm: false },
  { op: 'has:', label: 'İçerir', hint: 'bağlantı, resim, video ya da dosya', dm: true },
  { op: 'önce:', label: 'Önce', hint: 'GG.AA.YYYY', dm: true },
  { op: 'sonra:', label: 'Sonra', hint: 'GG.AA.YYYY', dm: true },
  { op: 'tarih:', label: 'Tarih', hint: 'GG.AA.YYYY, bugün, dün', dm: true },
];

export interface SearchSuggestion {
  key: string;
  /** Son sözcüğün yerine yazılacak (sonunda boşlukla) */
  insert: string;
  label: string;
  detail?: string;
  user?: User;
}

/** Son sözcük bir işleç değeriyse öneriler: from: → üyeler, in: → metin kanalları, has: → türler */
export function searchSuggestions(
  text: string,
  s: Pick<GuildStore, 'users' | 'channels'>,
  dm: boolean,
  limit = 8,
): SearchSuggestion[] {
  const last = text.split(/\s/).at(-1) ?? '';
  const m = last.match(/^([^:\s]+):(.*)$/);
  if (!m) return [];
  const all = suggestionsFor(m[1]!, m[2]!, s, dm, limit);
  // Değer zaten tamamsa (ör. arama yapılmış "from:ali") öneri gösterilmez
  return all.some((x) => foldSearchText(x.insert.trim()) === foldSearchText(last)) ? [] : all;
}

function suggestionsFor(
  op: string,
  raw: string,
  s: Pick<GuildStore, 'users' | 'channels'>,
  dm: boolean,
  limit: number,
): SearchSuggestion[] {
  const key = foldSearchText(op);
  const value = foldSearchText(raw.replace(/^[@#]/, ''));
  if (key === 'from' || key === 'kimden') {
    return Object.values(s.users)
      .filter((u) => !u.removed)
      .filter((u) => foldSearchText(u.username).startsWith(value) || foldSearchText(u.displayName).startsWith(value))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'))
      .slice(0, limit)
      .map((u) => ({
        key: u.id,
        insert: `${op}:${u.username} `,
        label: u.displayName,
        // Kullanıcı adı görünen adla aynıysa tekrar yazılmaz
        detail: foldSearchText(u.displayName) === foldSearchText(u.username) ? undefined : u.username,
        user: u,
      }));
  }
  if (!dm && (key === 'in' || key === 'kanal')) {
    return s.channels
      .filter((c) => c.type === 'text' && foldSearchText(c.name).startsWith(value))
      .slice(0, limit)
      .map((c) => ({ key: c.id, insert: `${op}:${c.name} `, label: `#${c.name}` }));
  }
  if (key === 'has' || key === 'iceren' || key === 'icerir') {
    return SEARCH_HAS_VALUES.map((h) => SEARCH_HAS_LABELS[h])
      .filter((label) => foldSearchText(label).startsWith(value))
      .map((label) => ({ key: label, insert: `${op}:${label} `, label }));
  }
  return [];
}

/** Metnin son sözcüğünü değiştirir (öneri seçilince) */
export function replaceLastWord(text: string, insert: string): string {
  const parts = text.split(/(\s)/);
  parts[parts.length - 1] = insert;
  return parts.join('');
}
