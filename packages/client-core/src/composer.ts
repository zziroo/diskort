// Ekrandaki yazma kutularına dışarıdan erişim: mesajın yazarının adına tıklayınca bahsetme eklemek,
// "Yanıtla" deyince kutuya odaklanmak gibi. Metnin kendisi platformun yazma kutusunda durur; kutu
// açılınca registerComposer ile kendini kaydeder.

import { roleMentionToken, type Role } from '@diskort/shared';

export interface ComposerHandle {
  /** Kutuya odaklanır (klavye açılır) */
  focus(): void;
  /** Metni imlecin olduğu yere ekler ve odaklanır */
  insert(text: string): void;
}

const composers: { channelId: string; handle: ComposerHandle }[] = [];

/** Kanalın yazma kutusunu kaydeder; dönen işlev kaydı siler. Aynı kanalda en son açılan kullanılır. */
export function registerComposer(channelId: string, handle: ComposerHandle): () => void {
  const entry = { channelId, handle };
  composers.push(entry);
  return () => {
    const index = composers.indexOf(entry);
    if (index >= 0) composers.splice(index, 1);
  };
}

function composerOf(channelId: string): ComposerHandle | undefined {
  for (let i = composers.length - 1; i >= 0; i--) if (composers[i]!.channelId === channelId) return composers[i]!.handle;
  return undefined;
}

/** Kanalın yazma kutusu ekrandaysa ona odaklanır */
export function focusComposer(channelId: string): boolean {
  const composer = composerOf(channelId);
  composer?.focus();
  return composer !== undefined;
}

/** Kullanıcıdan bahsetmeyi (`@kullanıcıadı `) kanalın yazma kutusuna, imlecin olduğu yere ekler. */
export function mentionInComposer(channelId: string, username: string): boolean {
  const composer = composerOf(channelId);
  composer?.insert(`@${username} `);
  return composer !== undefined;
}

/** Yazma kutusu açık mı (ör. "Bahset" düğmesi yalnızca o zaman gösterilir) */
export function hasComposer(channelId: string): boolean {
  return composerOf(channelId) !== undefined;
}

/**
 * Metni seçimin yerine ekler. Eklenen bahsetme önceki sözcüğe yapışmasın diye (yoksa bahsetme
 * sayılmaz) gerekirse önüne boşluk konur; sonrası zaten boşlukla başlıyorsa iki boşluk yan yana gelmez.
 */
export function insertText(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  let after = value.slice(end);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  if (text.endsWith(' ') && after.startsWith(' ')) after = after.slice(1);
  const head = before + pad + text;
  return { value: head + after, caret: head.length };
}

/** Yazma kutusunda önerilen toplu bahsetme: @everyone ya da @here */
export interface BroadcastMention {
  name: 'everyone' | 'here';
  description: string;
}

export const BROADCAST_MENTIONS: readonly BroadcastMention[] = [
  { name: 'everyone', description: 'Bu kanalı görebilen herkese bildirim gönderir.' },
  { name: 'here', description: 'Bu kanalı görebilen ve şu an çevrimiçi olan herkese bildirim gönderir.' },
];

/**
 * "@…" yazılırken önerilecek @everyone / @here. Yalnızca kanalda MENTION_EVERYONE yetkisi varsa (`allowed`);
 * yetkisi olmayanın yazdığı @everyone düz metin kalır. Direkt mesajlarda bu yetki hiç yoktur.
 */
export function broadcastSuggestions(query: string, allowed: boolean): BroadcastMention[] {
  if (!allowed) return [];
  const q = query.toLowerCase();
  return BROADCAST_MENTIONS.filter((m) => m.name.startsWith(q));
}

// ---------- Rol etiketleri ----------

/** Rol etiketi için gereken rol bilgisi */
type RoleRef = Pick<Role, 'id' | 'name'>;

/**
 * Rol adı karşılaştırması için küçültme: Türkçe I/İ/ı hepsi `i` olur ki `@ADMIN` "admin" rolüne eşleşsin.
 * Karakter başına çalışır, uzunluk korunur (kesme/slice hesapları bozulmasın).
 */
function fold(s: string): string {
  let out = '';
  for (const c of s) {
    if (c === 'I' || c === 'İ' || c === 'ı') out += 'i';
    else {
      const l = c.toLowerCase();
      out += l.length === c.length ? l : c;
    }
  }
  return out;
}

const startsWith = (role: RoleRef, q: string): boolean => fold(role.name).startsWith(q);

/**
 * "@…" yazılırken önerilecek roller (önce adı yazılanla başlayanlar) (@everyone hariç: onun yerine @everyone bahsetmesi var), yukarıdan
 * aşağı rol sırasıyla. Ek yetki istemez; direkt mesajda sunucu olmadığı için çağrılmaz.
 */
export function roleSuggestions(query: string, roles: Record<string, Role>, guildId: string, max: number): Role[] {
  const q = fold(query);
  return Object.values(roles)
    .filter((r) => r.id !== guildId && fold(r.name).includes(q))
    .sort((a, b) => Number(startsWith(b, q)) - Number(startsWith(a, q)) || b.position - a.position)
    .slice(0, max);
}

/** Kod blokları, satır içi kod ve bağlantılar (markdown.ts'teki URL kuralıyla aynı): içlerindeki etiketler çevrilmez */
const CODE = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>"]*[^\s<>".,:;'!?)\]]/gi;
// \p{…} kullanılmaz (telefonlardaki Hermes her Unicode özelliğini tanımıyor); Türkçe harfler açıkça yazılır
const WORD_CHAR = /[a-z0-9_çğıöşüâîûÇĞİÖŞÜÂÎÛ]/i;
const MENTION_BEFORE = /[\w.@]/;

/** Kod dışındaki parçalara uygular */
function outsideCode(content: string, fn: (text: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of content.matchAll(CODE)) {
    out += fn(content.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(content.slice(last));
}

/**
 * Yazma kutusunda rol adıyla yazılabilir mi: adı bir kullanıcı adıyla aynıysa `@ad` kullanıcı etiketi
 * sayılır, o rol kutuda gömülü biçimiyle (`<@&kimlik>`) kalır.
 */
const typable = (role: RoleRef, isUsername: (name: string) => boolean): boolean =>
  role.name.length > 0 && !isUsername(role.name.toLowerCase());

/** Yayın adları: bu adlı rol `@everyone`/`@here` ile karışırdı, adla yazılıp çevrilmez */
const BROADCAST_NAMES = new Set<string>(BROADCAST_MENTIONS.map((m) => m.name));

/**
 * Yazma kutusundaki `@RolAdı` çevirisi için aday roller: @everyone rolü (kimliği sunucu kimliğidir) ve adı
 * `everyone`/`here` olan roller çıkarılır.
 */
export function typableRoles(roles: Record<string, RoleRef>, guildId: string): RoleRef[] {
  return Object.values(roles).filter((r) => r.id !== guildId && !BROADCAST_NAMES.has(fold(r.name)));
}

/**
 * Gönderirken yazma kutusundaki `@RolAdı` yazılarını mesajdaki gömülü biçime (`<@&kimlik>`) çevirir.
 * Rol adları boşluk içerebildiği için en uzun ad önce denenir; büyük/küçük harf fark etmez. Kod
 * içindekiler ve kullanıcı adıyla aynı adlı roller (bkz. `typable`) çevrilmez.
 */
export function encodeRoleMentions(
  content: string,
  roles: readonly RoleRef[],
  isUsername: (name: string) => boolean,
): string {
  const candidates = roles
    .filter((r) => typable(r, isUsername))
    .map((r) => ({ id: r.id, name: r.name, lower: fold(r.name) }))
    .sort((a, b) => b.name.length - a.name.length);
  if (candidates.length === 0 || !content.includes('@')) return content;
  return outsideCode(content, (text) => {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const at = text.indexOf('@', i);
      if (at < 0) break;
      out += text.slice(i, at);
      i = at + 1;
      const prev = at > 0 ? text[at - 1]! : '';
      if (MENTION_BEFORE.test(prev) || (prev === '<' && text[at + 1] === '&')) {
        out += '@';
        continue;
      }
      const role = candidates.find((r) => {
        const after = text[at + 1 + r.name.length];
        return (
          fold(text.slice(at + 1, at + 1 + r.name.length)) === r.lower &&
          (after === undefined || !WORD_CHAR.test(after) || !WORD_CHAR.test(r.name.at(-1)!))
        );
      });
      if (!role) {
        out += '@';
        continue;
      }
      out += roleMentionToken(role.id);
      i = at + 1 + role.name.length;
    }
    return out + text.slice(i);
  });
}

/**
 * Düzenlenecek mesajın metni: gömülü rol etiketleri (`<@&kimlik>`) kutuda `@RolAdı` görünür; kaydederken
 * `encodeRoleMentions` geri çevirir. Bilinmeyen (silinmiş) roller ve adla yazılamayanlar olduğu gibi kalır.
 */
export function decodeRoleMentions(
  content: string,
  roles: Record<string, RoleRef>,
  isUsername: (name: string) => boolean,
): string {
  if (!content.includes('<@&')) return content;
  const decoded = outsideCode(content, (text) =>
    text.replace(/<@&([A-Za-z0-9_-]{1,64})>/g, (raw, id: string) => {
      const role = Object.hasOwn(roles, id) ? roles[id] : undefined;
      return role && typable(role, isUsername) ? `@${role.name}` : raw;
    }),
  );
  // Geri çevirince aynı metin çıkmıyorsa (ör. "Admin" etiketinin ardından " Ekibi" yazılmış ve "Admin Ekibi"
  // diye bir rol de var) çevrilmeden gösterilir: düzenleme etiketi başka bir role kaydırmasın.
  return encodeRoleMentions(decoded, Object.values(roles), isUsername) === content ? decoded : content;
}

/** Öneriden seçilen rolün kutuya yazılacak hâli (sonuna boşluk dahil) */
export const roleMentionText = (role: RoleRef, isUsername: (name: string) => boolean): string =>
  typable(role, isUsername) ? `@${role.name} ` : `${roleMentionToken(role.id)} `;
