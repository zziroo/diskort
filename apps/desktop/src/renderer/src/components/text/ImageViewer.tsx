import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import type { Attachment } from '@diskort/shared';
import { attachmentUrl, formatBytes } from '@diskort/client-core';
import { downloadAttachment } from '../../features/messages/files';
import { bridge } from '../../lib/bridge';
import { useEscapeLayer } from '../../lib/escape';
import { usePresenceClosing } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { NO_ZOOM, panByRect, wheelFactor, zoomAtRect, type Rect, type Size, type Zoom } from '../stage/zoom';

const DOUBLE_CLICK_ZOOM = 2.5;
const DRAG_SLOP = 4;

/**
 * Resmin tam boyutu: pencereye sığdırılmış, altında ad, boyut ve indirme. Tekerlek imlecin altına
 * yakınlaştırır (1×–4×), yakınken sürükleyince kayar, çift tık yakınlaştırır ya da sıfırlar.
 */
export function ImageViewer({ attachment, source }: { attachment: Attachment; source?: string }) {
  const close = useUi((s) => s.closeModal);
  const closing = usePresenceClosing();
  const url = attachmentUrl(attachment);
  // Bağlantı önizlemesindeki resim: tarayıcıda asıl sayfa açılır; boyutu bilinmez
  const external = source ?? url;

  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Yakınlaştırma alanı pencerenin tamamı; dönüşüm merkezi pencerenin sol üst köşesi olsun diye
  // resmin yerleşimdeki köşesi (`origin`) de tutulur
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // Çift tık ve sıfırlama animasyonlu; tekerlek ve sürükleme anında
  const [smooth, setSmooth] = useState(false);
  // Açılış animasyonu bir kez oynar (sınıf kalırsa dönüşümü ezer)
  const [intro, setIntro] = useState(true);
  const zoomed = zoom.s > 1;
  // Resmin yakınlaştırılmamış yerleşimi, kesirli (offset* tam sayıya yuvarlar: kenarda 1-2 px kayardı)
  const layout = useRef<Rect | null>(null);

  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: Zoom;
    box: Size;
    rect: Rect;
    moving: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = (animated: boolean): void => {
    // Süren sürükleme eski ölçeği geri getirmesin
    drag.current = null;
    setDragging(false);
    setSmooth(animated);
    setZoom(NO_ZOOM);
  };
  // Başka resim ya da pencere boyutu: yerleşim değişir, eski dönüşüm ve ölçü geçersiz
  const relayout = (): void => {
    layout.current = null;
    reset(false);
  };
  useEffect(relayout, [attachment.id]);
  useEffect(() => {
    const onResize = (): void => relayout();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEscapeLayer(close, !closing);
  // Yakınken Esc önce yakınlaştırmayı sıfırlar
  useEscapeLayer(() => reset(true), zoomed && !closing);

  /** Pencere alanı ve resmin yakınlaştırılmamış yerleşimi. */
  const measure = (): { box: Size; rect: Rect; left: number; top: number } | null => {
    const overlay = overlayRef.current;
    const img = imgRef.current;
    if (!overlay || !img || img.offsetWidth === 0 || img.offsetHeight === 0) return null;
    const bounds = overlay.getBoundingClientRect();
    // Kesirli ölçü yalnız resim dönüşümsüzken alınabilir (açılış animasyonu ve geçiş bittiğinde)
    if (!layout.current && !intro && !smooth && zoom.s === 1) {
      const r = img.getBoundingClientRect();
      layout.current = { x: r.left - bounds.left, y: r.top - bounds.top, w: r.width, h: r.height };
    }
    return {
      box: { w: overlay.clientWidth, h: overlay.clientHeight },
      // offset*: dönüşümden etkilenmez ama tam sayıya yuvarlar
      rect: layout.current ?? { x: img.offsetLeft, y: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight },
      left: bounds.left,
      top: bounds.top,
    };
  };

  const zoomAround = (scale: (s: number) => number, clientX: number, clientY: number, animated: boolean): void => {
    const m = measure();
    if (!m) return;
    setIntro(false);
    setSmooth(animated);
    setOrigin({ x: m.rect.x, y: m.rect.y });
    setZoom((z) => zoomAtRect(z, scale(z.s), clientX - m.left, clientY - m.top, m.box, m.rect));
  };

  const onWheel = (e: React.WheelEvent): void => {
    // Sürüklerken ölçek değişirse pan başlangıcı eskir
    if (closing || e.deltaY === 0 || drag.current?.moving) return;
    zoomAround((s) => s * wheelFactor(e.deltaY), e.clientX, e.clientY, false);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !zoomed) return;
    const m = measure();
    if (!m) return;
    // Bırakma resmin dışında olsa da buraya gelsin (yoksa sürükleme askıda kalır)
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: zoom, box: m.box, rect: m.rect, moving: false };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) <= DRAG_SLOP) return;
      d.moving = true;
      setDragging(true);
      setSmooth(false);
    }
    setZoom(panByRect(d.start, dx, dy, d.box, d.rect));
  };
  const endDrag = (e: React.PointerEvent): void => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={overlayRef}
      className={cn(
        'fixed inset-0 z-40 flex flex-col items-center justify-center overflow-hidden bg-black/85 p-6',
        closing ? 'anim-fade-out pointer-events-none' : 'anim-fade-in',
      )}
      onMouseDown={close}
      onWheel={onWheel}
    >
      {/* Düğme ve alt satır yakınlaştırılmış resmin üstünde kalır */}
      <button
        className={cn(
          'press-icon absolute top-10 right-6 z-10 rounded-full p-1 text-white/70 transition-colors hover:text-white',
          zoomed && 'bg-black/60',
        )}
        onClick={close}
        aria-label="Kapat"
      >
        <X size={28} className="ico-rotate" />
      </button>
      {/* Resim yakınlaşarak açılır, uzaklaşarak kapanır */}
      <img
        ref={imgRef}
        src={url}
        alt={attachment.name}
        draggable={false}
        className={cn(
          'max-h-[calc(100vh-150px)] max-w-full rounded object-contain shadow-2xl select-none',
          zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
          closing ? !zoomed && 'anim-modal-out' : intro && 'anim-modal-in',
        )}
        style={
          origin
            ? {
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
                transformOrigin: `${-origin.x}px ${-origin.y}px`,
                transition: smooth ? 'transform var(--dur-base) var(--ease-out)' : undefined,
              }
            : undefined
        }
        onAnimationEnd={() => setIntro(false)}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          if (zoomed) reset(true);
          else zoomAround(() => DOUBLE_CLICK_ZOOM, e.clientX, e.clientY, true);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div
        className={cn(
          'relative z-10 mt-3 flex items-center gap-4 rounded-full px-3 py-1 text-sm text-white/80 transition-colors',
          zoomed && 'bg-black/60',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="max-w-[40vw] truncate" data-tooltip={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-white/50">
          {attachment.width && attachment.height ? `${attachment.width}×${attachment.height}` : ''}
          {attachment.size > 0 ? `${attachment.width && attachment.height ? ' · ' : ''}${formatBytes(attachment.size)}` : ''}
        </span>
        {zoomed && (
          <button
            className="tabular-nums hover:text-white hover:underline"
            onClick={() => reset(true)}
            data-tooltip="Yakınlaştırmayı sıfırla"
          >
            %{Math.round(zoom.s * 100)}
          </button>
        )}
        <button className="flex items-center gap-1 hover:text-white hover:underline" onClick={() => downloadAttachment(attachment)}>
          <Download size={16} className="ico-drop" /> İndir
        </button>
        <button
          className="flex items-center gap-1 hover:text-white hover:underline"
          onClick={() => (bridge ? void bridge.openExternal(external) : window.open(external, '_blank'))}
        >
          <ExternalLink size={16} className="ico-nudge-out" /> Tarayıcıda aç
        </button>
      </div>
    </div>
  );
}
