/**
 * Discord benzeri sade biçimlendirmenin ayrıştırıcısı: **kalın**, *italik*, __altı çizili__,
 * ~~üstü çizili~~, ||sürpriz||, `kod`, ```kod bloğu```, > alıntı, bağlantılar ve @bahsetmeler.
 * Çıktı platformdan bağımsız bir ağaçtır; masaüstü React DOM'a, mobil React Native'e çizer.
 * HTML hiçbir zaman yorumlanmaz.
 */

import { splitEmoji } from './emoji';

export type MdStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler';

export type MdInline =
  | { type: 'text'; text: string }
  /** Metindeki tek bir emoji (çiziciler metinden büyük gösterir; kod içindekiler düz metin kalır) */
  | { type: 'emoji'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; url: string }
  /** Kullanıcı adı küçük harfle; böyle bir kullanıcı yoksa çizici `raw` metni gösterir */
  | { type: 'mention'; username: string; raw: string }
  /** Rol etiketi (`<@&kimlik>`); çizici rol adıyla ve rengiyle gösterir, rol yoksa "@silinmiş-rol" */
  | { type: 'roleMention'; roleId: string; raw: string }
  | { type: MdStyle; children: MdInline[] };

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'quote'; children: MdInline[] }
  | { type: 'codeblock'; lang: string | null; text: string };

type InlineRule = { name: 'code' | 'url' | 'mention' | 'roleMention' | MdStyle; re: RegExp };

// Aynı konumda eşleşen kurallardan listede önce gelen kazanır (** önce *, __ önce _).
const INLINE: InlineRule[] = [
  { name: 'code', re: /`([^`\n]+)`/ },
  { name: 'url', re: /https?:\/\/[^\s<>"]*[^\s<>".,:;'!?)\]]/i },
  { name: 'mention', re: /(?<![\w.@])@([a-z0-9_.]*[a-z0-9_])/i },
  { name: 'roleMention', re: /<@&([A-Za-z0-9_-]{1,64})>/ },
  { name: 'bold', re: /\*\*([\s\S]+?)\*\*/ },
  { name: 'underline', re: /__([\s\S]+?)__/ },
  { name: 'italic', re: /\*([^*\s](?:[^*]*?[^*\s])?)\*|(?<![a-z0-9])_([^_\n]+?)_(?![a-z0-9])/i },
  { name: 'strike', re: /~~([\s\S]+?)~~/ },
  { name: 'spoiler', re: /\|\|([\s\S]+?)\|\|/ },
];

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const pushText = (t: string): void => {
    for (const part of splitEmoji(t)) {
      const last = out.at(-1);
      if (part.emoji) out.push({ type: 'emoji', text: part.text });
      else if (last?.type === 'text') last.text += part.text;
      else out.push({ type: 'text', text: part.text });
    }
  };
  // Rol etiketinin (`<@&ab__cd>`) içindeki biçim işaretleri kuralları yanıltmasın: eşleştirme, etiketlerin
  // içi 'x' ile maskelenmiş kopyada yapılır (uzunluk aynı), parçalar ise özgün metinden alınır. Böylece
  // `__x <@&ab__cd> y__` altı çizili olarak kalır ve etiket bölünmez.
  const masked = text.replace(/<@&[A-Za-z0-9_-]{1,64}>/g, (t) => t.replace(/[_*~|]/g, 'x'));
  let pos = 0;
  while (pos < text.length) {
    const rest = masked.slice(pos);
    let best: { rule: InlineRule; m: RegExpExecArray } | null = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      pushText(text.slice(pos));
      break;
    }
    const { rule, m } = best;
    if (m.index > 0) pushText(text.slice(pos, pos + m.index));
    const full = text.slice(pos + m.index, pos + m.index + m[0].length);
    switch (rule.name) {
      case 'code':
        out.push({ type: 'code', text: full.slice(1, -1) });
        break;
      case 'url':
        out.push({ type: 'link', url: full });
        break;
      case 'mention':
        out.push({ type: 'mention', username: full.slice(1).toLowerCase(), raw: full });
        break;
      case 'roleMention':
        out.push({ type: 'roleMention', roleId: full.slice(3, -1), raw: full });
        break;
      default: {
        const d = rule.name === 'italic' ? 1 : 2;
        out.push({ type: rule.name, children: parseInline(full.slice(d, -d)) });
      }
    }
    pos += m.index + m[0].length;
  }
  return out;
}

/** Kod bloğu dışındaki metin: "> " ile başlayan ardışık satırlar alıntı bloğu olur. */
function parseText(text: string): MdBlock[] {
  const groups: { quote: boolean; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const q = /^> ?(.*)$/.exec(line);
    const quote = q !== null;
    const last = groups.at(-1);
    if (last && last.quote === quote) last.lines.push(q ? q[1]! : line);
    else groups.push({ quote, lines: [q ? q[1]! : line] });
  }
  return groups.map((g) => ({ type: g.quote ? 'quote' : 'paragraph', children: parseInline(g.lines.join('\n')) }));
}

/**
 * Bahsetme düğümü gerçek bir @everyone / @here bahsetmesi mi: yalnızca mesajda bildirim olduysa (yazarın
 * yetkisi vardı ve kod içinde değildi; sunucu bayrağı koyar). Değilse düz metin gösterilir, Discord gibi.
 */
export function broadcastMention(
  username: string,
  message: { mentionEveryone?: boolean; mentionHere?: boolean } | undefined,
): 'everyone' | 'here' | null {
  if (username === 'everyone' && message?.mentionEveryone) return 'everyone';
  if (username === 'here' && message?.mentionHere) return 'here';
  return null;
}

/** Silinmiş (ya da bu sunucuda olmayan) rolün etiketi */
export const DELETED_ROLE_LABEL = 'silinmiş-rol';

/**
 * Tek satırlık düz metin (yanıtın üstündeki alıntı gibi): biçim işaretleri atılır, satırlar
 * birleştirilir, bahsetmeler görünen adla yazılır, sürprizler gizli kalır. `roleNameOf` verilmezse
 * rol etiketleri "@silinmiş-rol" yazılır.
 */
export function plainText(
  content: string,
  displayNameOf: (username: string) => string | undefined,
  roleNameOf?: (roleId: string) => string | undefined,
): string {
  const flatten = (nodes: MdInline[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
          case 'emoji':
          case 'code':
            return node.text;
          case 'link':
            return node.url;
          case 'mention': {
            const name = displayNameOf(node.username);
            return name ? `@${name}` : node.raw;
          }
          case 'roleMention':
            return `@${roleNameOf?.(node.roleId) ?? DELETED_ROLE_LABEL}`;
          case 'spoiler':
            return '▒▒▒▒';
          default:
            return flatten(node.children);
        }
      })
      .join('');
  return parseMarkdown(content)
    .map((block) => (block.type === 'codeblock' ? block.text : flatten(block.children)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CODE_BLOCK = /```(?:([a-z0-9+#.-]+)\n)?\n?([\s\S]*?)\n?```/gi;

export function parseMarkdown(content: string): MdBlock[] {
  const out: MdBlock[] = [];
  let last = 0;
  for (const m of content.matchAll(CODE_BLOCK)) {
    // Bloğun hemen önündeki/ardındaki satır sonu fazladan boş satır oluşturmasın
    const before = content.slice(last, m.index).replace(/\n$/, '');
    if (before) out.push(...parseText(before));
    out.push({ type: 'codeblock', lang: m[1]?.toLowerCase() ?? null, text: m[2] ?? '' });
    last = m.index + m[0].length;
    if (content[last] === '\n') last++;
  }
  if (last < content.length) out.push(...parseText(content.slice(last)));
  return out;
}
