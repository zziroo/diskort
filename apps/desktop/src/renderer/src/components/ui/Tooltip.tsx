import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** Fare üstünde bekleyince gösterilme gecikmesi; bir ipucu az önce açıksa yenisi beklemeden açılır */
const SHOW_DELAY_MS = 400;
const WARM_MS = 500;
const GAP = 8;
const MARGIN = 8;
const OPPOSITE: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Öğeye temalı ipucu ekler: `<Tooltip label="Sustur"><button …/></Tooltip>`.
 * Aslında yalnızca `data-tooltip` (ve yoksa `aria-label`) ekler; göstermeyi TooltipHost üstlenir.
 * Bir bileşenin içinde doğrudan `data-tooltip="…"` yazmak da aynı işi görür.
 */
export function Tooltip({
  label,
  side,
  children,
}: {
  label: string | null | undefined;
  side?: TooltipSide;
  children: ReactElement<Record<string, unknown>>;
}) {
  const props = children.props;
  return cloneElement(children, {
    'data-tooltip': label || undefined,
    'data-tooltip-side': side,
    'aria-label': props['aria-label'] ?? (label || undefined),
  });
}

interface Tip {
  el: HTMLElement;
  text: string;
  side: TooltipSide;
}

function readTip(el: HTMLElement): Tip | null {
  const text = el.dataset.tooltip?.trim();
  if (!text) return null;
  const side = el.dataset.tooltipSide as TooltipSide | undefined;
  return { el, text, side: side && side in OPPOSITE ? side : 'top' };
}

/**
 * Yerel `title` ipuçlarını (Windows'un sarı/beyaz kutusu) temalı olana çevirir: fareyle üstüne
 * gelinen öğenin `title`'ı `data-tooltip`'e taşınır. Böylece gözden kaçan ya da sonradan eklenen
 * `title`'lar da uygulamanın ipucuyla görünür.
 */
function adoptTitle(el: HTMLElement): void {
  const title = el.getAttribute('title');
  if (title === null) return;
  el.removeAttribute('title');
  if (!title.trim()) return;
  el.dataset.tooltip = title;
  // Yalnızca simgeden oluşan düğmeler erişilebilir adını title'dan alıyordu
  if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
}

function targetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>('[data-tooltip],[title]');
  if (!el || el.closest('[data-tooltip-off]')) return null;
  return el;
}

/** Uygulamanın kökünde bir kez bulunur; tüm `data-tooltip` / `title` öğelerinin ipucunu çizer. */
export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const { value: shown, closing } = usePresence(tip, 100);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer = 0;
    let lastHidden = 0;
    let visible = false;
    // Tıklanan öğenin ipucu, fare öğeden çıkana kadar yeniden açılmaz
    let suppressed: HTMLElement | null = null;

    const show = (el: HTMLElement): void => {
      const next = readTip(el);
      if (!next) return;
      visible = true;
      setTip(next);
    };
    const hide = (): void => {
      window.clearTimeout(timer);
      if (visible) lastHidden = Date.now();
      visible = false;
      current = null;
      setTip(null);
    };
    const schedule = (el: HTMLElement, delay: number): void => {
      window.clearTimeout(timer);
      current = el;
      const warm = visible || Date.now() - lastHidden < WARM_MS;
      if (warm || delay === 0) show(el);
      else timer = window.setTimeout(() => current === el && show(el), delay);
    };

    const onOver = (e: PointerEvent): void => {
      const el = targetOf(e.target);
      if (el === current) return;
      if (current) hide();
      if (!el || el === suppressed) return;
      suppressed = null;
      adoptTitle(el);
      schedule(el, SHOW_DELAY_MS);
    };
    const onOut = (e: PointerEvent): void => {
      const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (suppressed && !(related && suppressed.contains(related))) suppressed = null;
      if (current && !(related && current.contains(related))) hide();
    };
    const onDown = (): void => {
      suppressed = current;
      if (current) hide();
    };
    const onFocus = (e: FocusEvent): void => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !target.matches(':focus-visible')) return;
      const el = targetOf(target);
      if (!el || el === current) return;
      adoptTitle(el);
      schedule(el, 0);
    };
    const onBlur = (e: FocusEvent): void => {
      if (current && e.target instanceof Node && current.contains(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && current) hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    // Tam ekrana girip çıkınca ipucu yeni kökte (tam ekran öğesi ya da body) yeniden açılır
    document.addEventListener('fullscreenchange', hide);
    return () => {
      document.removeEventListener('fullscreenchange', hide);
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('wheel', hide, { capture: true });
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Açıkken öğe kaldırılırsa kapan; metni değişirse (ör. "Sustur" → "Sesi Aç") güncelle
  useEffect(() => {
    if (!tip) return;
    const timer = window.setInterval(() => {
      if (!tip.el.isConnected) {
        setTip(null);
        return;
      }
      if (tip.el.hasAttribute('title')) adoptTitle(tip.el);
      const next = readTip(tip.el);
      if (!next) setTip(null);
      else if (next.text !== tip.text) setTip(next);
    }, 200);
    return () => window.clearInterval(timer);
  }, [tip]);

  if (!shown) return null;
  // Tam ekranda yalnız tam ekran öğesinin içi çizilir: ipucu da onun içine konur
  return createPortal(<Bubble tip={shown} closing={closing} />, document.fullscreenElement ?? document.body);
}

interface Placement {
  x: number;
  y: number;
  side: TooltipSide;
  /** Okun baloncuk kenarındaki konumu (px) */
  arrow: number;
}

function place(tip: Tip, width: number, height: number): Placement {
  const r = tip.el.getBoundingClientRect();
  const top = MARGIN + (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<TooltipSide, boolean> = {
    top: r.top - height - GAP >= top,
    bottom: r.bottom + height + GAP <= vh - MARGIN,
    left: r.left - width - GAP >= MARGIN,
    right: r.right + width + GAP <= vw - MARGIN,
  };
  let side = tip.side;
  if (!fits[side]) side = fits[OPPOSITE[side]] ? OPPOSITE[side] : ((['top', 'bottom', 'right', 'left'] as const).find((s) => fits[s]) ?? side);

  const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
  if (side === 'top' || side === 'bottom') {
    const x = clamp(r.left + r.width / 2 - width / 2, MARGIN, vw - width - MARGIN);
    const y = side === 'top' ? r.top - height - GAP : r.bottom + GAP;
    return { x, y, side, arrow: clamp(r.left + r.width / 2 - x, 10, width - 10) };
  }
  const y = clamp(r.top + r.height / 2 - height / 2, top, vh - height - MARGIN);
  const x = side === 'left' ? r.left - width - GAP : r.right + GAP;
  return { x, y, side, arrow: clamp(r.top + r.height / 2 - y, 8, height - 8) };
}

const ORIGIN: Record<TooltipSide, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** 45° döndürülmüş karenin dışarı bakan iki kenarı */
const ARROW_BORDER: Record<TooltipSide, string> = {
  top: 'border-r border-b',
  bottom: 'border-l border-t',
  left: 'border-t border-r',
  right: 'border-b border-l',
};

function Bubble({ tip, closing }: { tip: Tip; closing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Boyut dönüşümden (scale) etkilenmesin diye offset* ile ölçülür
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlacement(place(tip, el.offsetWidth, el.offsetHeight));
  }, [tip]);

  const side = placement?.side ?? tip.side;
  const vertical = side === 'top' || side === 'bottom';
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        // İnce kenar: ipucu, sahne gibi aynı koyulukta zeminlerde de seçilsin
        'pointer-events-none fixed z-[100] max-w-[260px] rounded-md border border-float-edge bg-bg-float px-2.5 py-1.5 text-sm font-semibold break-words text-text-normal shadow-[0_4px_16px_rgb(0_0_0/0.35)]',
        closing ? 'anim-pop-out' : 'anim-pop-in',
      )}
      style={{
        // transform animasyona kalsın diye konum left/top ile verilir
        left: placement?.x ?? 0,
        top: placement?.y ?? 0,
        visibility: placement ? 'visible' : 'hidden',
        transformOrigin: placement
          ? vertical
            ? `${placement.arrow}px ${ORIGIN[side]}`
            : `${ORIGIN[side]} ${placement.arrow}px`
          : undefined,
      }}
    >
      {tip.text}
      <span
        className={cn('absolute h-3 w-3 rotate-45 rounded-[2px] border-float-edge bg-bg-float', ARROW_BORDER[side])}
        style={
          vertical
            ? { left: (placement?.arrow ?? 0) - 6, [side === 'top' ? 'bottom' : 'top']: -5 }
            : { top: (placement?.arrow ?? 0) - 6, [side === 'left' ? 'right' : 'left']: -5 }
        }
      />
    </div>
  );
}
