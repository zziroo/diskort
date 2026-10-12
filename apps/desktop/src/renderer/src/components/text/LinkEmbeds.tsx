import { useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import type { Attachment, LinkEmbed } from '@diskort/shared';
import {
  embedColor,
  embedHost,
  embedMediaUrl,
  embedVideoUrl,
  fitBox,
  lastPathSegment,
  parseInline,
  youtubePlayerUrl,
  type MdInline,
} from '@diskort/client-core';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { IMAGE_MAX } from './Attachments';

/** Kartın en büyük genişliği ve içindeki büyük resmin/videonun kutusu (Discord gibi) */
const CARD_WIDTH = 432;
const MEDIA_MAX = { width: 400, height: 300 };
const PLAYER = { width: 400 };
const THUMB = 80;

/**
 * Mesajdaki bağlantı önizlemeleri (Discord'daki embed kartları): sol şerit sitenin rengi, site adı,
 * yazar, bağlantı olan başlık, kısaltılmış açıklama ve resim (küçükse sağda, büyükse altta). YouTube
 * videoları tıklanınca kart içinde (youtube-nocookie) oynar; doğrudan resim bağlantıları resim olarak
 * gösterilir ve tıklanınca görüntüleyicide açılır. Resimler sunucumuz üzerinden gelir.
 */
export function LinkEmbeds({ embeds, dim = false }: { embeds: LinkEmbed[]; dim?: boolean }) {
  return (
    <div className={cn('mt-1 flex flex-col gap-1.5', dim && 'opacity-60')}>
      {embeds.map((embed, i) =>
        embed.kind === 'image' ? (
          <EmbedImage key={`${embed.url}#${i}`} embed={embed} />
        ) : (
          <EmbedCard key={`${embed.url}#${i}`} embed={embed} />
        ),
      )}
    </div>
  );
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

function useOpenImage(embed: LinkEmbed): (() => void) | undefined {
  const openModal = useUi((s) => s.openModal);
  const attachment = viewerAttachment(embed);
  return attachment ? () => openModal({ type: 'image', attachment, source: embed.url }) : undefined;
}

function EmbedImage({ embed }: { embed: LinkEmbed }) {
  const src = embedMediaUrl(embed.image);
  const open = useOpenImage(embed);
  if (!src || !embed.image) return null;
  const box = fitBox(embed.image.width, embed.image.height, IMAGE_MAX) ?? { width: 300, height: 200 };
  return (
    <button
      className="block overflow-hidden rounded-lg bg-bg-side transition-[filter] duration-150 hover:brightness-110"
      style={box}
      data-tooltip={embedHost(embed.url)}
      onClick={open}
    >
      <img src={src} alt="" loading="lazy" draggable={false} className="block h-full w-full object-cover" />
    </button>
  );
}

function EmbedCard({ embed }: { embed: LinkEmbed }) {
  const color = embedColor(embed);
  const image = embedMediaUrl(embed.image);
  const open = useOpenImage(embed);
  const youtube = embed.kind === 'youtube';
  const video = embed.kind === 'video' ? embedVideoUrl(embed) : null;
  // Küçük resim sağda; büyük resim, YouTube ve video altta
  const large = youtube || Boolean(video) || (embed.largeImage && Boolean(image));
  const thumb = !large && image && embed.image;

  return (
    <div
      className="w-fit max-w-full overflow-hidden rounded border border-edge border-l-4 bg-bg-side"
      style={{ maxWidth: CARD_WIDTH, borderLeftColor: color ?? 'var(--color-bg-active)' }}
    >
      <div className="flex gap-4 py-2.5 pr-4 pl-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {embed.siteName && <div className="truncate text-xs text-text-muted">{embed.siteName}</div>}
          {embed.author && <div className="truncate text-sm font-semibold text-text-head">{embed.author}</div>}
          {embed.title ? (
            <a
              href={embed.url}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-2 font-semibold break-words text-link hover:underline"
              data-tooltip={embed.url}
            >
              {embed.title}
            </a>
          ) : (
            !embed.siteName && (
              <a href={embed.url} target="_blank" rel="noreferrer" className="truncate text-sm text-link hover:underline">
                {embedHost(embed.url)}
              </a>
            )
          )}
          {embed.description && (
            <div className="line-clamp-4 text-sm leading-[1.125rem] break-words whitespace-pre-line text-text-normal select-text">
              {renderEmbedText(embed.description)}
            </div>
          )}
          {youtube && <YoutubePlayer embed={embed} image={image} />}
          {video && <DirectVideo url={video} host={embedHost(embed.url)} />}
          {!youtube && !video && large && image && embed.image && (
            <button
              className="mt-2 block overflow-hidden rounded bg-bg-deep/40 transition-[filter] duration-150 hover:brightness-110"
              style={fitBox(embed.image.width, embed.image.height, MEDIA_MAX) ?? undefined}
              onClick={open}
            >
              <img src={image} alt="" loading="lazy" draggable={false} className="block h-full w-full object-cover" />
            </button>
          )}
        </div>
        {thumb && (
          <button
            className="mt-1 block shrink-0 overflow-hidden rounded transition-[filter] duration-150 hover:brightness-110"
            style={{ width: THUMB, height: THUMB }}
            onClick={open}
          >
            <img src={image} alt="" loading="lazy" draggable={false} className="block h-full w-full object-cover" />
          </button>
        )}
      </div>
    </div>
  );
}

/** YouTube: büyük kapak resmi ve oynat düğmesi; tıklanınca kart içinde oynar (çerezsiz alan adı) */
function YoutubePlayer({ embed, image }: { embed: LinkEmbed; image: string | null }) {
  const [playing, setPlaying] = useState(false);
  const player = youtubePlayerUrl(embed);
  if (!player) return null;
  return (
    <div className="mt-2 max-w-full overflow-hidden rounded bg-bg-deep" style={{ width: PLAYER.width, aspectRatio: '16 / 9' }}>
      {playing ? (
        <iframe
          src={player}
          title={embed.title ?? 'YouTube videosu'}
          className="block h-full w-full border-0"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      ) : (
        <button
          className="group/play relative block h-full w-full"
          aria-label={`Oynat: ${embed.title ?? 'YouTube videosu'}`}
          onClick={() => setPlaying(true)}
        >
          {image && <img src={image} alt="" loading="lazy" draggable={false} className="block h-full w-full object-cover" />}
          <PlayBadge />
        </button>
      )}
    </div>
  );
}

/** Doğrudan video dosyası: yalnızca tıklanınca yüklenir (asıl siteden) */
function DirectVideo({ url, host }: { url: string; host: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="mt-2 max-w-full overflow-hidden rounded bg-bg-deep" style={{ width: PLAYER.width, aspectRatio: '16 / 9' }}>
      {playing ? (
        <video src={url} controls autoPlay playsInline className="block h-full w-full bg-bg-deep object-contain" />
      ) : (
        <button className="group/play relative block h-full w-full" aria-label="Videoyu oynat" onClick={() => setPlaying(true)}>
          <span className="absolute bottom-2 left-3 text-xs text-text-muted">{host}</span>
          <PlayBadge />
        </button>
      )}
    </div>
  );
}

function PlayBadge() {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-float/80 text-text-head shadow-lg transition-transform duration-200 ease-(--ease-hov) group-hover/play:scale-110">
        <Play size={22} fill="currentColor" className="ml-0.5" />
      </span>
    </span>
  );
}

/**
 * Açıklamadaki sade biçimlendirme: kalın/italik/altı çizili/üstü çizili, kod ve bağlantılar. Bahsetmeler
 * ve sürprizler düz metin kalır (açıklama siteden gelir, kullanıcı yazmadı).
 */
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
            <code key={k} className="rounded bg-bg-input px-1 font-mono text-[0.85em]">
              {node.text}
            </code>
          );
        case 'link':
          return (
            <a key={k} href={node.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
              {node.url}
            </a>
          );
        case 'bold':
          return <strong key={k}>{walk(node.children, k)}</strong>;
        case 'italic':
          return <em key={k}>{walk(node.children, k)}</em>;
        case 'underline':
          return <u key={k}>{walk(node.children, k)}</u>;
        case 'strike':
          return <s key={k}>{walk(node.children, k)}</s>;
        default:
          return <span key={k}>{walk(node.children, k)}</span>;
      }
    });
  return walk(parseInline(text), 'd');
}
