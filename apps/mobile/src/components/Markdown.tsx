import { Fragment, useState, type ReactNode } from 'react';
import { Linking, Text, View } from 'react-native';
import { broadcastMention, DELETED_ROLE_LABEL, isJumboEmoji, parseMarkdown, type MdInline } from '@diskort/client-core';
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

const mono = 'monospace';

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
}));
