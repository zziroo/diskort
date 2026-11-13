import { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';
import { spring } from '../motion';
import { MAX_ZOOM, clamp, clampPan, fitSize, zoomAround, type Point, type Size } from './viewerZoom';

/** İki dokunuş arasında bu kadar süre varsa çift dokunuş sayılır (tek dokunuş bu kadar bekler) */
const DOUBLE_TAP_MS = 260;
/** Bu kadar aşağı sürükleyince (ya da hızla fırlatınca) görüntüleyiciden çıkılır */
const DISMISS_DISTANCE = 110;

/**
 * Tam ekran görüntüleyici dokunma hareketleri (yalnızca React Native'in PanResponder'ı): tek/çift dokunuş,
 * iki parmakla yakınlaştırma (parmakların altındaki nokta sabit kalır), yakınken kaydırma, aşağı sürükleyip
 * çıkma. Dönüşümler native sürücüde çalışır; RTCView (SurfaceView) ölçeklemeyi ve kaydırmayı destekler.
 * Yayın (StreamViewer) ve resim (ImageViewer) görüntüleyicisi kullanır.
 */
export function useViewerGestures(options: {
  zoomable: boolean;
  /** Kabın boyutu (dönüşüm kabın ortasına göre) */
  size: Size;
  /** Kabın sayfadaki sol üst köşesi; verilmezse kap ekranın tamamı sayılır */
  offset?: Point;
  /** İçeriğin özgün boyutu: kaydırma sınırı sığdırılmış içeriğe göre olur (verilmezse kap) */
  content?: Size | null;
  /** Verilirse 1× iken çift dokunuş dokunulan noktaya bu ölçekte yakınlaştırır (onDoubleTap yerine) */
  doubleTapZoom?: number;
  /** Tek dokunuş; `zoomed`: o an yakınlaştırılmış mı */
  onTap: (zoomed: boolean) => void;
  onDoubleTap?: () => void;
  onSwipeDown: () => void;
}) {
  const live = useRef(options);
  live.current = options;
  const scale = useRef(new Animated.Value(1)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const dismissY = useRef(new Animated.Value(0)).current;
  const translateY = useRef(Animated.add(panY, dismissY)).current;
  const st = useRef({
    s: 1,
    x: 0,
    y: 0,
    s0: 1,
    x0: 0,
    y0: 0,
    pinchDist: 1,
    fx: 0,
    fy: 0,
    baseDx: 0,
    baseDy: 0,
    touches: 0,
    moved: false,
    multi: false,
    dismissing: false,
    startAt: 0,
    tapX: 0,
    tapY: 0,
    lastTapAt: 0,
    tapTimer: null as ReturnType<typeof setTimeout> | null,
  }).current;

  const { panHandlers, resetZoom } = useMemo(() => {
    const setZoom = (s: number, x: number, y: number): void => {
      st.s = s;
      st.x = x;
      st.y = y;
      scale.setValue(s);
      panX.setValue(x);
      panY.setValue(y);
    };
    const animateZoom = (s: number, x: number, y: number): void => {
      st.s = s;
      st.x = x;
      st.y = y;
      spring(scale, s, 0).start();
      spring(panX, x, 0).start();
      spring(panY, y, 0).start();
    };
    const reset = (animated: boolean): void => {
      if (!animated) {
        setZoom(1, 0, 0);
        dismissY.setValue(0);
        return;
      }
      animateZoom(1, 0, 0);
    };
    // Sayfa koordinatını kabın ortasına göre çevirir
    const local = (pageX: number, pageY: number): Point => {
      const { size, offset } = live.current;
      return { x: pageX - (offset?.x ?? 0) - size.width / 2, y: pageY - (offset?.y ?? 0) - size.height / 2 };
    };
    const bounded = (s: number, x: number, y: number) => {
      const { size, content } = live.current;
      return clampPan({ s, x, y }, size, fitSize(size, content));
    };
    // Parmak sayısı değişince hareket o andan yeniden ölçülür (sıçrama olmasın)
    const segment = (e: GestureResponderEvent, g: PanResponderGestureState): void => {
      const touches = e.nativeEvent.touches;
      st.touches = touches.length;
      st.s0 = st.s;
      st.x0 = st.x;
      st.y0 = st.y;
      st.baseDx = g.dx;
      st.baseDy = g.dy;
      const [a, b] = touches;
      if (a && b) {
        st.pinchDist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1;
        const f = local((a.pageX + b.pageX) / 2, (a.pageY + b.pageY) / 2);
        st.fx = f.x;
        st.fy = f.y;
      }
    };
    const finish = (g: PanResponderGestureState, allowTap: boolean): void => {
      if (st.dismissing) {
        st.dismissing = false;
        if (g.dy > DISMISS_DISTANCE || g.vy > 1) {
          dismissY.setValue(0);
          live.current.onSwipeDown();
        } else {
          spring(dismissY, 0, 4).start();
        }
        return;
      }
      if (st.multi) {
        if (st.s < 1.05) reset(true);
        return;
      }
      if (!allowTap || st.moved || Date.now() - st.startAt > 350) return;
      const now = Date.now();
      if (st.tapTimer && now - st.lastTapAt < DOUBLE_TAP_MS) {
        clearTimeout(st.tapTimer);
        st.tapTimer = null;
        const target = live.current.doubleTapZoom;
        if (st.s > 1.01) reset(true);
        else if (target) {
          const p = local(st.tapX, st.tapY);
          const z = zoomAround({ s: 1, x: 0, y: 0 }, target, p, p);
          const b = bounded(z.s, z.x, z.y);
          animateZoom(b.s, b.x, b.y);
        } else live.current.onDoubleTap?.();
        return;
      }
      st.lastTapAt = now;
      st.tapTimer = setTimeout(() => {
        st.tapTimer = null;
        live.current.onTap(st.s > 1.01);
      }, DOUBLE_TAP_MS);
    };

    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e, g) => {
        st.moved = false;
        st.multi = false;
        st.dismissing = false;
        st.startAt = Date.now();
        st.tapX = e.nativeEvent.pageX;
        st.tapY = e.nativeEvent.pageY;
        segment(e, g);
      },
      onPanResponderMove: (e, g) => {
        const touches = e.nativeEvent.touches;
        if (touches.length !== st.touches) segment(e, g);
        if (!st.moved && Math.hypot(g.dx, g.dy) > 10) st.moved = true;
        const { zoomable } = live.current;
        const [a, b] = touches;
        if (a && b) {
          st.multi = true;
          if (st.dismissing) {
            // İkinci parmak geldi: aşağı sürükleme yakınlaştırmaya döner
            st.dismissing = false;
            dismissY.setValue(0);
          }
          if (!zoomable) return;
          const s = clamp(st.s0 * (Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) / st.pinchDist), 1, MAX_ZOOM);
          const m = local((a.pageX + b.pageX) / 2, (a.pageY + b.pageY) / 2);
          const z = zoomAround({ s: st.s0, x: st.x0, y: st.y0 }, s, { x: st.fx, y: st.fy }, m);
          const c = bounded(z.s, z.x, z.y);
          setZoom(c.s, c.x, c.y);
          return;
        }
        if (!zoomable) return;
        const dx = g.dx - st.baseDx;
        const dy = g.dy - st.baseDy;
        if (st.s > 1.01) {
          const c = bounded(st.s, st.x0 + dx, st.y0 + dy);
          setZoom(c.s, c.x, c.y);
        } else if (!st.multi && (st.dismissing || (dy > 12 && dy > Math.abs(dx) * 1.3))) {
          st.dismissing = true;
          dismissY.setValue(Math.max(0, dy));
        }
      },
      onPanResponderRelease: (_, g) => finish(g, true),
      onPanResponderTerminate: (_, g) => finish(g, false),
    });
    return { panHandlers: responder.panHandlers, resetZoom: reset };
  }, [st, scale, panX, panY, dismissY]);

  // Yakınlaştırma kapanınca (küçük görünüme dönüş) sıfırlanır
  useEffect(() => {
    if (!options.zoomable) resetZoom(false);
  }, [options.zoomable, resetZoom]);

  useEffect(
    () => () => {
      if (st.tapTimer) clearTimeout(st.tapTimer);
    },
    [st],
  );

  return {
    panHandlers,
    transform: [{ translateX: panX }, { translateY }, { scale }],
    /** Yakınlaştırmayı sıfırlar (ör. başka bir içerik açılınca anında: `reset(false)`) */
    reset: resetZoom,
  };
}
