import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import { useEscapeLayer } from '../../lib/escape';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { Slider } from './Slider';

const MARGIN = 8;
const GAP = 8;
/** Alt menüden fare çıkınca kapanmadan önce beklenen süre (çapraz fare hareketi için) */
const SUBMENU_CLOSE_MS = 180;

const ITEM_SELECTOR = '[data-menu-item]:not(:disabled)';

const MenuContext = createContext<{ close: () => void }>({
  close: () => undefined,
});

const surface = 'rounded-lg border border-edge bg-bg-float p-1.5 text-text-normal shadow-[0_8px_24px_rgb(0_0_0/0.45)]';

/** Bu menü öğesinin (iç içe alt menüler hariç) klavyeyle gezilebilen öğeleri */
function itemsOf(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter((el) => el.closest('[role="menu"]') === menu);
}

/** Yukarı/aşağı ok, Home/End ile öğeler arasında gezinme (her menü kendi öğelerinde) */
function navigate(e: ReactKeyboardEvent<HTMLElement>): boolean {
  const menu = e.currentTarget;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return false;
  const items = itemsOf(menu);
  if (!items.length) return false;
  e.preventDefault();
  e.stopPropagation();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
  items[next]!.focus();
  return true;
}

/**
 * Alt panellerdeki (mikrofon, kulaklık, gürültü engelleme) Discord tarzı açılır menü: açan düğmenin üstünde
 * açılır; dışarı tıklayınca, Esc'e basınca ya da bir seçim yapılınca kapanır. Oklarla gezilir, → alt menüyü açar.
 */
export function PanelMenu({
  open,
  anchorRef,
  placeAboveRef,
  onClose,
  label,
  width = 240,
  align = 'start',
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Menünün üstünde açılacağı öğe (yoksa açan düğme); dışarı tıklama ve odak yine açan düğmeye göre işler */
  placeAboveRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Ekran okuyucular için menü adı */
  label: string;
  width?: number;
  /** Açan düğmenin soluna (start) ya da sağına (end) hizalanır */
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const { value: shown, closing } = usePresence(open || null, 100);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useEscapeLayer(onClose, open);

  useLayoutEffect(() => {
    const anchor = placeAboveRef?.current ?? anchorRef.current;
    if (!shown || !anchor) return;
    const place = (): void => {
      const a = anchor.getBoundingClientRect();
      const wanted = align === 'end' ? a.right - width : a.left;
      const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
      setPos({
        left,
        bottom: Math.max(MARGIN, window.innerHeight - a.top + GAP),
      });
    };
    place();
    window.addEventListener('resize', place);
    // Üstünde açılan öğenin boyu değişirse (ör. ses çalınca kart büyür) menü yeniden konumlanır
    const observer = placeAboveRef && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    observer?.observe(anchor);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [shown, anchorRef, placeAboveRef, align, width]);

  // Açılınca ilk öğe odaklanır (klavyeyle hemen gezilebilsin); kapanınca odak açan düğmeye döner
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const frame = requestAnimationFrame(() => {
      const menu = ref.current;
      if (menu) (itemsOf(menu)[0] ?? menu).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (ref.current?.contains(document.activeElement)) anchor?.focus({ preventScroll: true });
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
    };
  }, [open, anchorRef, onClose]);

  if (!shown) return null;

  return createPortal(
    <MenuContext.Provider value={{ close: onClose }}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'fixed z-50 outline-none',
          surface,
          closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
          !pos && 'invisible',
        )}
        style={{
          left: pos?.left ?? 0,
          bottom: pos?.bottom ?? 0,
          width,
          transformOrigin: 'bottom left',
        }}
        onKeyDown={(e) => {
          if (navigate(e)) return;
          if (e.key === 'Tab') {
            e.preventDefault();
            onClose();
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
    </MenuContext.Provider>,
    document.body,
  );
}

const itemClass =
  'flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-sm outline-none transition-colors duration-75 disabled:cursor-default disabled:opacity-40';
const itemHover =
  'enabled:hover:bg-bg-hover enabled:hover:text-text-head focus-visible:bg-bg-hover focus-visible:text-text-head';

export function MenuItem({
  label,
  hint,
  icon,
  onSelect,
  danger,
  disabled,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { close } = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item
      disabled={disabled}
      className={cn(
        itemClass,
        danger
          ? 'text-danger-text enabled:hover:bg-danger enabled:hover:text-white focus-visible:bg-danger focus-visible:text-white'
          : itemHover,
      )}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-xs text-text-muted">{hint}</span>}
      </span>
      {icon && <span className="shrink-0 opacity-80">{icon}</span>}
    </button>
  );
}

/** Tek seçimli öğe (ör. aygıt, gürültü engelleme türü): seçiliyse sağda dolu daire. Seçince menü açık kalır. */
export function MenuRadioItem({
  label,
  hint,
  checked,
  onSelect,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-menu-item
      className={cn(itemClass, itemHover, checked && 'text-text-head')}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-xs text-text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors',
          checked ? 'border-brand' : 'border-text-muted',
        )}
      >
        {checked && <span className="anim-pill-in h-2 w-2 rounded-full bg-brand" />}
      </span>
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-line/70" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[11px] font-bold text-text-muted uppercase">{children}</div>;
}

/** Ses seviyesi kaydırıcısı (%0–max); ←/→ ile değişir, ↑/↓ ile öğeler arasında gezilir */
export function MenuSlider({
  label,
  value,
  max = 200,
  onChange,
}: {
  label: string;
  /** Yüzde */
  value: number;
  max?: number;
  onChange: (percent: number) => void;
}) {
  const id = useId();
  return (
    <div className="px-2 pt-1.5 pb-2">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text-muted">
        <label htmlFor={id}>{label}</label>
        <span className="tabular-nums">%{value}</span>
      </div>
      <Slider
        id={id}
        data-menu-item
        className="w-full"
        aria-label={label}
        aria-valuetext={`%${value}`}
        min={0}
        max={max}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
}

/**
 * Alt menü: fareyle üstüne gelince ya da → / Enter ile sağında açılır; ← ya da Esc ile kapanıp
 * açan öğeye dönülür. `hint` açan öğenin altında küçük yazıyla (ör. seçili aygıt) görünür.
 */
export function MenuSubmenu({
  label,
  hint,
  width = 260,
  children,
}: {
  label: string;
  hint?: string;
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  const openAndFocus = useCallback(() => {
    clearTimer();
    setOpen(true);
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const items = itemsOf(list);
      (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true });
    });
  }, []);

  const closeAndReturn = (): void => {
    clearTimer();
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        clearTimer();
        setOpen(true);
      }}
      onMouseLeave={() => {
        clearTimer();
        timer.current = window.setTimeout(() => setOpen(false), SUBMENU_CLOSE_MS);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-item
        className={cn(itemClass, itemHover, open && 'bg-bg-hover text-text-head')}
        onClick={openAndFocus}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            openAndFocus();
          }
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint && <span className="block truncate text-xs text-text-muted">{hint}</span>}
        </span>
        <ChevronRight size={16} className="ico-nudge-r shrink-0 opacity-70" />
      </button>
      {open && (
        // Soldaki boşluk fareyle alt menüye geçerken köprü olur
        <div className="absolute -bottom-1.5 left-full z-10 pl-2" style={{ width: width + 8 }}>
          <div
            ref={listRef}
            role="menu"
            aria-label={label}
            className={cn(surface, 'anim-pop-in max-h-[min(420px,calc(100vh-96px))] overflow-y-auto')}
            onKeyDown={(e) => {
              if (navigate(e)) return;
              if (e.key === 'ArrowLeft' || e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeAndReturn();
              }
            }}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
