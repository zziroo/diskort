import { useState, type CSSProperties, type ReactNode } from 'react';
import { broadcastMention, DELETED_ROLE_LABEL, parseMarkdown, type MdInline } from '@diskort/client-core';
import type { Message, Role, User } from '@diskort/shared';
import { cn } from '../../lib/utils';

/**
 * Ortak çekirdeğin ayrıştırdığı biçimlendirme ağacını React DOM öğelerine çizer.
 * HTML hiçbir zaman yorumlanmaz; bağlantılar varsayılan tarayıcıda açılır.
 */
export interface MarkdownContext {
  usersByName: Record<string, User>;
  selfId: string | undefined;
  /** Çizilen mesajın @everyone / @here bayrakları: yalnızca bildirim olduysa vurgulanır (yoksa düz metin) */
  flags?: Pick<Message, 'mentionEveryone' | 'mentionHere'>;
  /** Kanalın sunucusunun rolleri (rol etiketleri için; direkt mesajda boş) */
  roles?: Record<string, Role>;
  /** Kendi rollerimiz (o sunucuda): bizim rolümüzün etiketi daha belirgin görünür */
  selfRoleIds?: readonly string[];
}

/** Rol etiketinin rengi: rolün rengi (yoksa bahsetme rengi); bizim rolümüzse arka plan daha koyu */
function roleMentionStyle(color: string | null, mine: boolean): CSSProperties | undefined {
  return color ? { color, backgroundColor: `${color}${mine ? '4d' : '24'}` } : undefined;
}

const BROADCAST_TOOLTIP = {
  everyone: 'Kanalı görebilen herkese bildirildi',
  here: 'Kanalı görebilen ve o an çevrimiçi olan herkese bildirildi',
} as const;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={cn(
        'rounded px-0.5 transition-colors',
        shown ? 'bg-tint' : 'cursor-pointer bg-bg-input text-transparent select-none hover:bg-bg-panel',
      )}
      onClick={() => setShown(true)}
      data-tooltip={shown ? undefined : 'Göstermek için tıkla'}
    >
      <span className={shown ? undefined : 'invisible'}>{children}</span>
    </span>
  );
}

function renderInline(nodes: MdInline[], ctx: MarkdownContext, key: string): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}.${i}`;
    switch (node.type) {
      case 'text':
        return node.text;
      case 'emoji':
        return (
          <span key={k} className="emoji emoji-inline">
            {node.text}
          </span>
        );
      case 'code':
        return (
          <code key={k} className="rounded bg-bg-input px-1 py-px font-mono text-[0.85em] text-text-normal">
            {node.text}
          </code>
        );
      case 'link':
        return (
          <a key={k} href={node.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
            {node.url}
          </a>
        );
      case 'mention': {
        const broadcast = broadcastMention(node.username, ctx.flags);
        if (broadcast) {
          return (
            <span
              key={k}
              className="rounded-[3px] bg-brand/20 px-0.5 font-medium text-mention"
              data-tooltip={BROADCAST_TOOLTIP[broadcast]}
            >
              @{broadcast}
            </span>
          );
        }
        const user = ctx.usersByName[node.username];
        if (!user) return node.raw;
        return (
          <span
            key={k}
            className={cn(
              'rounded-[3px] px-0.5 font-medium',
              user.id === ctx.selfId
                ? 'bg-brand/40 text-text-head'
                : 'bg-brand/20 text-mention hover:bg-brand hover:text-white',
            )}
            data-tooltip={`@${user.username}`}
          >
            @{user.displayName}
          </span>
        );
      }
      case 'roleMention': {
        // Object.hasOwn: `<@&constructor>` gibi anahtarlar prototipten sahte rol getirmesin
        const role = ctx.roles && Object.hasOwn(ctx.roles, node.roleId) ? ctx.roles[node.roleId] : undefined;
        // @everyone rolünün sırası hep 0'dır; onun etiketi yoktur (yerine @everyone bahsetmesi var)
        if (!role || role.position === 0) {
          return (
            <span key={k} className="rounded-[3px] bg-bg-input px-0.5 font-medium text-text-muted">
              @{DELETED_ROLE_LABEL}
            </span>
          );
        }
        const mine = ctx.selfRoleIds?.includes(role.id) ?? false;
        return (
          <span
            key={k}
            className={cn(
              'rounded-[3px] px-0.5 font-medium',
              !role.color && (mine ? 'bg-brand/40 text-text-head' : 'bg-brand/20 text-mention'),
            )}
            style={roleMentionStyle(role.color, mine)}
            data-tooltip="Rol"
          >
            @{role.name}
          </span>
        );
      }
      case 'bold':
        return <strong key={k}>{renderInline(node.children, ctx, k)}</strong>;
      case 'italic':
        return <em key={k}>{renderInline(node.children, ctx, k)}</em>;
      case 'underline':
        return <u key={k}>{renderInline(node.children, ctx, k)}</u>;
      case 'strike':
        return <s key={k}>{renderInline(node.children, ctx, k)}</s>;
      case 'spoiler':
        return <Spoiler key={k}>{renderInline(node.children, ctx, k)}</Spoiler>;
    }
  });
}

export function renderMarkdown(content: string, ctx: MarkdownContext): ReactNode[] {
  return parseMarkdown(content).flatMap((block, i): ReactNode[] => {
    const k = `b${i}`;
    switch (block.type) {
      case 'paragraph':
        return renderInline(block.children, ctx, k);
      case 'quote':
        return [
          <blockquote key={k} className="my-0.5 border-l-4 border-text-faint/60 pl-3">
            {renderInline(block.children, ctx, k)}
          </blockquote>,
        ];
      case 'codeblock':
        return [
          <pre
            key={k}
            className="my-1 max-w-full overflow-x-auto rounded border border-edge bg-bg-side p-2 font-mono text-[0.85em] leading-snug whitespace-pre text-text-normal"
          >
            {block.text}
          </pre>,
        ];
    }
  });
}
