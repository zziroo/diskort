import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Yayın üstündeki düğmelerin ortak dili (büyük görünüm, tam ekran, ızgara kutucuğu, yüzen pencere): yarı
 * saydam bulanık bir grup zemininde simge düğmeleri. `danger` ("İzlemeyi bırak") üstüne gelince kırmızıya
 * döner; `text` verilirse simgenin yanında yazı da çıkar ve düğme baştan kırmızımsı durur.
 */
export function StreamButton({
  label,
  shortcut,
  onClick,
  children,
  tone = 'default',
  text,
  size = 'sm',
}: {
  /** Erişilebilir ad ve ipucu */
  label: string;
  /** İpucunda parantez içinde gösterilen kısayol (ör. "F") */
  shortcut?: string;
  onClick: () => void;
  /** Simge */
  children: ReactNode;
  tone?: 'default' | 'danger';
  /** Simgenin yanında görünen yazı (büyük görünümde) */
  text?: string;
  /** md: büyük görünüm ve tam ekran (36 px), sm: kutucuk ve yüzen pencere (28 px) */
  size?: 'sm' | 'md';
}) {
  const danger = tone === 'danger';
  return (
    <button
      type="button"
      // Dar kutuda yazı gizlenir, ipucu adı yine gösterir
      data-tooltip={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // Hızlı iki basış yayını tam ekrana almasın
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'press-icon pointer-events-auto flex shrink-0 items-center justify-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-white/80',
        size === 'md' ? 'h-9 min-w-9' : 'h-7 min-w-7',
        // Yazı yalnız yayın kutusu yeterince genişse (@md, StreamView kökü @container); darda yalnız simge
        text ? (size === 'md' ? 'px-0 text-sm font-semibold @md:px-3' : 'px-0 text-xs font-semibold @md:px-2') : 'px-0',
        danger
          ? text
            ? 'bg-danger/85 text-white hover:bg-danger-hover focus-visible:bg-danger-hover'
            : 'text-white/90 hover:bg-danger hover:text-white focus-visible:bg-danger'
          : 'text-white/90 hover:bg-white/15 hover:text-white focus-visible:bg-white/15',
      )}
    >
      {children}
      {text && <span className="hidden whitespace-nowrap @md:inline">{text}</span>}
    </button>
  );
}

/** Düğmeleri tek bir yarı saydam, bulanık zemin üstünde toplar. */
export function StreamButtonGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-black/55 p-0.5 ring-1 ring-white/10 backdrop-blur-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Grup içinde "İzlemeyi bırak"ı diğerlerinden ayıran ince çizgi */
export function StreamButtonDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-white/20" />;
}
