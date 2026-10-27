import { Fragment, useState, type ReactNode } from 'react';
import { Linking, Platform, Text, View, type StyleProp, type TextStyle } from 'react-native';
import {
  broadcastMention,
  DELETED_ROLE_LABEL,
  isJumboEmoji,
  markdownSegments,
  parseMarkdown,
  type MdInline,
  type MdMark,
} from '@diskort/client-core';
import type { Message, Role, User } from '@diskort/shared';
import { brandTint, colors, createStyles, tint } from '../theme';

/** Ortak çekirdeğin ayrıştırdığı biçimlendirmeyi React Native metnine çizer. */
export interface MarkdownContext {
  usersByName: Record<string, User>;
  selfId: string | undefined;
  /** Çizilen mesajın @everyone / @here bayrakları: yalnızca bildirim olduysa vurgulanır (yoksa düz metin) */
  flags?: Pick<Message, 'mentionEveryone' | 'mentionHere'>;
  /** Kanalın sunucusunun rolleri (rol etiketleri için; direkt mesajda boş) */
  roles?: Record<string, Role>;
  /** Kendi rollerimiz (o sunucuda): bizim rolümüzün etiketi daha belirgin görünür */
  selfRoleIds?: readonly string[];
  /** Mesaj yalnızca emojiden oluşuyor: emojiler dev boyutta (Markdown kendisi belirler) */
  jumbo?: boolean;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <Text
      onPress={() => setShown(true)}
      style={shown ? styles.spoilerShown : styles.spoilerHidden}
      suppressHighlighting
    >
      {children}
    </Text>
  );
}

function inline(nodes: MdInline[], ctx: MarkdownContext, key: string): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}.${i}`;
    switch (node.type) {
      case 'text':
        return <Fragment key={k}>{node.text}</Fragment>;
      case 'emoji':
        // Metinden büyük (Discord gibi); yalnızca emojiden oluşan mesajda dev boyutta
        return (
          <Text key={k} style={ctx.jumbo ? styles.emojiJumbo : styles.emoji}>
            {node.text}
          </Text>
        );
      case 'code':
        return (
          <Text key={k} style={styles.code}>
            {node.text}
          </Text>
        );
      case 'link':
        return (
          <Text key={k} style={styles.link} onPress={() => void Linking.openURL(node.url)}>
            {node.url}
          </Text>
        );
      case 'mention': {
        const broadcast = broadcastMention(node.username, ctx.flags);
        if (broadcast) {
          return (
            <Text key={k} style={styles.mention}>
              @{broadcast}
            </Text>
          );
        }
        const user = ctx.usersByName[node.username];
        if (!user) return <Fragment key={k}>{node.raw}</Fragment>;
        return (
          <Text key={k} style={[styles.mention, user.id === ctx.selfId && styles.mentionSelf]}>
            @{user.displayName}
          </Text>
        );
      }
      case 'roleMention': {
        // Object.hasOwn: `<@&constructor>` gibi anahtarlar prototipten sahte rol getirmesin
        const role = ctx.roles && Object.hasOwn(ctx.roles, node.roleId) ? ctx.roles[node.roleId] : undefined;
        // @everyone rolünün sırası hep 0'dır; onun etiketi yoktur (yerine @everyone bahsetmesi var)
        if (!role || role.position === 0) {
          return (
            <Text key={k} style={styles.roleDeleted}>
              @{DELETED_ROLE_LABEL}
            </Text>
          );
        }
        const mine = ctx.selfRoleIds?.includes(role.id) ?? false;
        return (
          <Text
            key={k}
            style={[
              styles.mention,
              mine && styles.mentionSelf,
              role.color ? { color: role.color, backgroundColor: `${role.color}${mine ? '4d' : '29'}` } : null,
            ]}
          >
            @{role.name}
          </Text>
        );
      }
      case 'bold':
        return (
          <Text key={k} style={styles.bold}>
            {inline(node.children, ctx, k)}
          </Text>
        );
      case 'italic':
        return (
          <Text key={k} style={styles.italic}>
            {inline(node.children, ctx, k)}
          </Text>
        );
      case 'underline':
        return (
          <Text key={k} style={styles.underline}>
            {inline(node.children, ctx, k)}
          </Text>
        );
      case 'strike':
        return (
          <Text key={k} style={styles.strike}>
            {inline(node.children, ctx, k)}
          </Text>
        );
      case 'spoiler':
        return <Spoiler key={k}>{inline(node.children, ctx, k)}</Spoiler>;
    }
  });
}

export function Markdown({ content, ctx, dim }: { content: string; ctx: MarkdownContext; dim?: boolean }) {
  const blocks = parseMarkdown(content);
  const c = isJumboEmoji(content) ? { ...ctx, jumbo: true } : ctx;
  return (
    <View style={dim && styles.dim}>
      {blocks.map((block, i) => {
        const k = `b${i}`;
        switch (block.type) {
          case 'paragraph':
            return (
              <Text key={k} style={[styles.text, c.jumbo && styles.jumboLine]} selectable>
                {inline(block.children, c, k)}
              </Text>
            );
          case 'quote':
            return (
              <View key={k} style={styles.quote}>
                <Text style={styles.text} selectable>
                  {inline(block.children, c, k)}
                </Text>
              </View>
            );
          case 'codeblock':
            return (
              <View key={k} style={styles.codeBlock}>
                <Text style={styles.codeBlockText} selectable>
                  {block.text}
                </Text>
              </View>
            );
        }
      })}
    </View>
  );
}

/** Yazma kutusunda bundan uzun metin biçimlendirilmez (her tuşta ayrıştırma ve yüzlerce iç içe Text) */
const LIVE_PREVIEW_MAX = 4000;

/**
 * Yazma kutusunun canlı önizlemesi: `TextInput`'a `value` yerine verilen stilli çocuklar (Discord gibi).
 * Metin harfi harfine aynı kalır, yalnızca görünüş değişir: işaretler (`**`, `~~`, `||`, `` ` ``, `> `)
 * soluk görünür; boyut (fontSize) hiçbir parçada değişmez, satır yüksekliği sabit kalır.
 */
export function ComposerText({ text, lineHeight }: { text: string; lineHeight: number }) {
  if (!text) return null;
  if (text.length > LIVE_PREVIEW_MAX) return <Text>{text}</Text>;
  const parts: ReactNode[] = [];
  for (const seg of markdownSegments(text)) {
    const part = text.slice(seg.start, seg.end);
    if (seg.marks.length === 0) {
      parts.push(part);
      continue;
    }
    // Alıntı işareti (satır başındaki `> `) dikey çizginin yerine vurgulu renkte; aynı parçada ardından
    // gelen başka işaretler (ör. `> **`) normal soluk işaret olarak kalır
    const lineStart = seg.start === 0 || text[seg.start - 1] === '\n';
    if (lineStart && seg.marks.includes('quote') && seg.marks.includes('marker') && part.startsWith('>')) {
      const q = part.startsWith('> ') ? 2 : 1;
      parts.push(
        <Text key={`q${seg.start}`} style={styles.composerQuoteMarker}>
          {part.slice(0, q)}
        </Text>,
      );
      if (q < part.length) {
        parts.push(
          <Text key={seg.start} style={composerStyle(seg.marks, lineHeight)}>
            {part.slice(q)}
          </Text>,
        );
      }
      continue;
    }
    parts.push(
      <Text key={seg.start} style={composerStyle(seg.marks, lineHeight)}>
        {part}
      </Text>,
    );
  }
  return <Text>{parts}</Text>;
}

function composerStyle(marks: MdMark[], lineHeight: number): StyleProp<TextStyle> {
  const has = (m: MdMark): boolean => marks.includes(m);
  const code = has('code') || has('codeblock');
  const decoration =
    has('underline') && has('strike') ? 'underline line-through' : has('underline') ? 'underline' : has('strike') ? 'line-through' : null;
  // Sıra önemli: sonraki öncekini ezer (kalın bahsetmenin kalınlığı, işaretin soluk rengi en son)
  return [
    has('quote') && styles.composerQuote,
    has('spoiler') && styles.composerSpoiler,
    has('link') && styles.link,
    has('mention') && styles.mention,
    has('bold') && styles.bold,
    has('italic') && styles.italic,
    decoration && { textDecorationLine: decoration },
    // Monospace yazı tipinin kendi satır aralığı kutuyu büyütmesin: satır yüksekliği aynen verilir
    code && [styles.composerCode, { lineHeight }],
    has('marker') && styles.composerMarker,
  ];
}

const mono = 'monospace';
// iOS'ta "monospace" diye bir yazı tipi yok: yazma kutusunda sistemin sabit genişlikli yazı tipi
const composerMono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Kod/sürpriz zemini: temanın kod rengi kutu zemininden yeterince ayrılmıyorsa (açık, AMOLED) saydam ton */
function composerShade(alpha: number): string {
  const rgb = (hex: string): number[] | null =>
    /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
  const a = rgb(colors.code);
  const b = rgb(colors.field);
  const distinct = a && b && a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) > 40;
  return distinct ? colors.code : tint(alpha);
}

const styles = createStyles(() => ({
  text: { color: colors.text, fontSize: 15.5, lineHeight: 22 },
  // Satır yüksekliği metinle aynı: emojili satırlar düz satırlardan uzun olmaz
  emoji: { fontSize: 20, lineHeight: 22 },
  emojiJumbo: { fontSize: 44, lineHeight: 54 },
  jumboLine: { lineHeight: 54 },
  dim: { opacity: 0.5 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },
  strike: { textDecorationLine: 'line-through' },
  code: { fontFamily: mono, fontSize: 13.5, backgroundColor: colors.code },
  link: { color: colors.link },
  mention: { color: colors.mention, backgroundColor: brandTint(0.3), fontWeight: '500' },
  mentionSelf: { color: colors.head, backgroundColor: brandTint(0.45) },
  roleDeleted: { color: colors.muted, backgroundColor: colors.code, fontWeight: '500' },
  spoilerHidden: { backgroundColor: colors.code, color: colors.code },
  spoilerShown: { backgroundColor: tint(0.1) },
  quote: { borderLeftWidth: 4, borderLeftColor: colors.faint, paddingLeft: 10, marginVertical: 2 },
  codeBlock: {
    backgroundColor: colors.side,
    borderColor: colors.edge,
    borderWidth: 1,
    borderRadius: 4,
    padding: 8,
    marginVertical: 4,
  },
  codeBlockText: { fontFamily: mono, fontSize: 13, color: colors.text, lineHeight: 18 },
  // Yazma kutusu (ComposerText)
  composerMarker: { color: colors.faint },
  composerQuoteMarker: { color: colors.brandText, fontWeight: '700' },
  composerQuote: { color: colors.muted },
  composerCode: { fontFamily: composerMono, backgroundColor: composerShade(0.1) },
  composerSpoiler: { backgroundColor: composerShade(0.18) },
}));
