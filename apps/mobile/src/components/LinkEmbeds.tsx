import { useState, type ReactNode } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Attachment, LinkEmbed } from '@diskort/shared';
import { embedColor, embedHost, embedMediaUrl, embedVideoUrl, fitBox, lastPathSegment, parseInline, type MdInline } from '@diskort/client-core';
import { colors, createStyles, font, radius, space } from '../theme';
import { ImageViewer } from './Attachments';

/** Mesaj satırında avatar sütunu ve sağ boşluk (Attachments ile aynı) */
const ROW_INSET = 64 + 14;
const CARD_MAX = 432;
const MEDIA_MAX_HEIGHT = 300;
const THUMB = 72;
/** Kartın iç boşlukları: sol şerit (4) + iki yan (12 + 14) */
const CARD_PADDING = 4 + 12 + 14;

/** YouTube videosunun sayfası (telefonda YouTube uygulaması açar; yoksa tarayıcı) */
function youtubeWatchUrl(embed: LinkEmbed): string {
  const start = embed.youtubeStart && embed.youtubeStart > 0 ? `&t=${embed.youtubeStart}s` : '';
  return `https://www.youtube.com/watch?v=${embed.youtubeId}${start}`;
}

/** Görüntüleyici için resmi dosya eki gibi tanıtır (adres sunucumuzdaki imzalı adres) */
function viewerAttachment(embed: LinkEmbed): Attachment | null {
  if (!embed.image || !embedMediaUrl(embed.image)) return null;
  // Bozuk kodlama (ör. %zz) fırlatmaz: çözülemeyen parça olduğu gibi kalır
  const name = lastPathSegment(embed.url) || embedHost(embed.url);
  return {
    id: `embed:${embed.url}`,
    name,
    size: 0,
    contentType: 'image/webp',
    width: embed.image.width,
    height: embed.image.height,
    url: embed.image.url,
  };
}

/**
 * Mesajdaki bağlantı önizlemeleri (masaüstüyle aynı kart): sol şerit sitenin rengi, site adı, yazar,
 * bağlantı olan başlık, kısaltılmış açıklama, resim (küçükse sağda, büyükse altta). YouTube'a dokununca
 * video YouTube uygulamasında açılır; resimler tam ekran görüntüleyicide. Resimler sunucumuzdan gelir.
 */
export function LinkEmbeds({ embeds, dim = false }: { embeds: LinkEmbed[]; dim?: boolean }) {
  const { width } = useWindowDimensions();
  const maxWidth = Math.min(width - ROW_INSET, CARD_MAX);
  const [viewing, setViewing] = useState<{ attachment: Attachment; source: string } | null>(null);
  const view = (embed: LinkEmbed): (() => void) | undefined => {
    const attachment = viewerAttachment(embed);
    return attachment ? () => setViewing({ attachment, source: embed.url }) : undefined;
  };
  return (
    <View style={[styles.list, dim && { opacity: 0.6 }]}>
      {embeds.map((embed, i) =>
        embed.kind === 'image' ? (
          <EmbedImage key={`${embed.url}#${i}`} embed={embed} maxWidth={maxWidth} onPress={view(embed)} />
        ) : (
          <EmbedCard key={`${embed.url}#${i}`} embed={embed} maxWidth={maxWidth} onImage={view(embed)} />
        ),
      )}
      {viewing && <ImageViewer attachment={viewing.attachment} source={viewing.source} onClose={() => setViewing(null)} />}
    </View>
  );
}

function EmbedImage({ embed, maxWidth, onPress }: { embed: LinkEmbed; maxWidth: number; onPress?: () => void }) {
  const src = embedMediaUrl(embed.image);
  if (!src || !embed.image) return null;
  const box = fitBox(embed.image.width, embed.image.height, { width: maxWidth, height: MEDIA_MAX_HEIGHT }) ?? { width: 240, height: 180 };
  return (
    <Pressable onPress={onPress} style={[styles.media, box]} accessibilityRole="imagebutton" accessibilityLabel="Resim">
      <Image source={{ uri: src }} style={StyleSheet.absoluteFill} resizeMode="cover" resizeMethod="resize" />
    </Pressable>
  );
}

function EmbedCard({ embed, maxWidth, onImage }: { embed: LinkEmbed; maxWidth: number; onImage?: () => void }) {
  const image = embedMediaUrl(embed.image);
  const youtube = embed.kind === 'youtube';
  const video = embed.kind === 'video' ? embedVideoUrl(embed) : null;
  const large = youtube || Boolean(video) || (embed.largeImage && Boolean(image));
  const thumb = !large && image;
  const inner = maxWidth - CARD_PADDING;
  const open = (): void => void Linking.openURL(embed.url);
  const mediaBox =
    youtube || video
      ? { width: inner, height: Math.round((inner * 9) / 16) }
      : embed.image
        ? (fitBox(embed.image.width, embed.image.height, { width: inner, height: MEDIA_MAX_HEIGHT }) ?? undefined)
        : undefined;

  return (
    <View style={[styles.card, { maxWidth, borderLeftColor: embedColor(embed) ?? colors.active }]}>
      <View style={styles.cardRow}>
        <View style={styles.cardBody}>
          {embed.siteName ? (
            <Text style={styles.site} numberOfLines={1}>
              {embed.siteName}
            </Text>
          ) : null}
          {embed.author ? (
            <Text style={styles.author} numberOfLines={1}>
              {embed.author}
            </Text>
          ) : null}
          {embed.title ? (
            <Text style={styles.title} numberOfLines={2} onPress={open} suppressHighlighting={false}>
              {embed.title}
            </Text>
          ) : !embed.siteName ? (
            <Text style={styles.host} numberOfLines={1} onPress={open}>
              {embedHost(embed.url)}
            </Text>
          ) : null}
          {embed.description ? (
            <Text style={styles.description} numberOfLines={4}>
              {renderEmbedText(embed.description)}
            </Text>
          ) : null}
        </View>
        {thumb ? (
          <Pressable onPress={onImage} style={styles.thumb} accessibilityRole="imagebutton" accessibilityLabel="Resim">
            <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" resizeMethod="resize" />
          </Pressable>
        ) : null}
      </View>
      {large && mediaBox ? (
        <Pressable
          onPress={youtube ? () => void Linking.openURL(youtubeWatchUrl(embed)) : video ? () => void Linking.openURL(video) : onImage}
          style={[styles.large, mediaBox]}
          accessibilityRole={youtube || video ? 'button' : 'imagebutton'}
          accessibilityLabel={youtube ? `YouTube'da oynat: ${embed.title ?? 'video'}` : video ? 'Videoyu oynat' : 'Resim'}
        >
          {image ? <Image source={{ uri: image }} style={StyleSheet.absoluteFill} resizeMode="cover" resizeMethod="resize" /> : null}
          {youtube || video ? (
            <View style={styles.playWrap} pointerEvents="none">
              <View style={styles.play}>
                <Ionicons name="play" size={26} color={colors.head} style={{ marginLeft: 3 }} />
              </View>
            </View>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

/** Açıklamadaki sade biçimlendirme (kalın, italik, kod, bağlantı); bahsetmeler düz metin */
function renderEmbedText(text: string): ReactNode[] {
  const walk = (nodes: MdInline[], key: string): ReactNode[] =>
    nodes.map((node, i) => {
      const k = `${key}.${i}`;
      switch (node.type) {
        case 'text':
        case 'emoji':
          return node.text;
        case 'mention':
        case 'roleMention':
          return node.raw;
        case 'code':
          return (
            <Text key={k} style={styles.code}>
              {node.text}
            </Text>
          );
        case 'link':
          return (
            <Text key={k} style={styles.inlineLink} onPress={() => void Linking.openURL(node.url)}>
              {node.url}
            </Text>
          );
        case 'bold':
          return (
            <Text key={k} style={{ fontWeight: '700' }}>
              {walk(node.children, k)}
            </Text>
          );
        case 'italic':
          return (
            <Text key={k} style={{ fontStyle: 'italic' }}>
              {walk(node.children, k)}
            </Text>
          );
        case 'underline':
          return (
            <Text key={k} style={{ textDecorationLine: 'underline' }}>
              {walk(node.children, k)}
            </Text>
          );
        case 'strike':
          return (
            <Text key={k} style={{ textDecorationLine: 'line-through' }}>
              {walk(node.children, k)}
            </Text>
          );
        default:
          return <Text key={k}>{walk(node.children, k)}</Text>;
      }
    });
  return walk(parseInline(text), 'd');
}

const styles = createStyles(() => ({
  list: { gap: 6, marginTop: 4, alignItems: 'flex-start' },
  media: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.side },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.side,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.edge,
    borderLeftWidth: 4,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 14,
  },
  cardRow: { flexDirection: 'row', gap: space.md },
  cardBody: { flex: 1, minWidth: 0, gap: 3 },
  site: { color: colors.muted, fontSize: font.caption },
  author: { color: colors.head, fontSize: font.small, fontWeight: '600' },
  title: { color: colors.link, fontSize: 15, fontWeight: '600' },
  host: { color: colors.link, fontSize: font.small },
  description: { color: colors.text, fontSize: font.small, lineHeight: 19 },
  code: { fontFamily: 'monospace', backgroundColor: colors.code, fontSize: 12.5 },
  inlineLink: { color: colors.link },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm, overflow: 'hidden', marginTop: 2, backgroundColor: colors.deep },
  large: { marginTop: space.sm, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.deep },
  playWrap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backdrop,
  },
}));
