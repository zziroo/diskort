import React from 'react';
import { Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from 'remotion';

// Renkler: apps/desktop/src/renderer/src/styles.css
export const C = {
  bg: '#000000',
  card: '#111113',
  raised: '#161616',
  line: '#2e2e2e',
  text: '#f2f3f5',
  normal: '#dbdee1',
  muted: '#949ba4',
  brand: '#5865f2',
  brandSoft: '#c9cdfb',
  ok: '#2dc770',
  warn: '#f0b232',
  link: '#00a8fc',
  danger: '#f23f43',
};
export const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
export const MONO = 'Consolas, "Courier New", monospace';

export const Sfx: React.FC<{ at: number; name: string; vol?: number }> = ({ at, name, vol = 0.5 }) => (
  <Sequence from={at} durationInFrames={70} layout="none">
    <Audio src={staticFile(`sfx/${name}.wav`)} volume={vol} />
  </Sequence>
);

const useAppear = (delay: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 15, stiffness: 140 } });
  return { s, opacity: interpolate(frame - delay, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) };
};

export const Node: React.FC<{
  x: number; y: number; w?: number; h?: number; delay: number;
  title: string; sub?: string; color?: string; sfx?: boolean; mono?: boolean; small?: boolean;
}> = ({ x, y, w = 360, h = 130, delay, title, sub, color = C.brand, sfx = true, mono, small }) => {
  const { s, opacity } = useAppear(delay);
  return (
    <>
      {sfx && <Sfx at={delay} name="pop" vol={0.3} />}
      <div
        style={{
          position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, opacity,
          transform: `scale(${0.6 + 0.4 * s})`, background: C.card, border: `3px solid ${color}`, borderRadius: 22,
          boxShadow: `0 0 40px ${color}33`, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', textAlign: 'center', padding: '0 16px', boxSizing: 'border-box',
        }}
      >
        <div style={{ fontFamily: mono ? MONO : FONT, fontSize: small ? 30 : 38, fontWeight: 700, color: C.text, lineHeight: 1.15 }}>{title}</div>
        {sub && <div style={{ fontFamily: FONT, fontSize: small ? 24 : 27, color: C.muted, marginTop: 8, lineHeight: 1.25 }}>{sub}</div>}
      </div>
    </>
  );
};

export const Pill: React.FC<{ x: number; y: number; delay: number; text: string; color?: string; w?: number }> = ({ x, y, delay, text, color = C.ok, w = 330 }) => {
  const { s, opacity } = useAppear(delay);
  return (
    <div
      style={{
        position: 'absolute', left: x - w / 2, top: y - 24, width: w, height: 48, opacity, transform: `scale(${0.7 + 0.3 * s})`,
        background: `${color}22`, border: `2px solid ${color}`, borderRadius: 24, color, fontFamily: FONT, fontSize: 26,
        fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      }}
    >
      {text}
    </div>
  );
};

export const Caption: React.FC<{ delay: number; until?: number; children: React.ReactNode; y?: number; color?: string }> = ({ delay, until, children, y = 990, color = C.normal }) => {
  const { opacity } = useAppear(delay);
  const frame = useCurrentFrame();
  const out = until === undefined ? 1 : interpolate(frame, [until, until + 10], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: y, textAlign: 'center', opacity: opacity * out, fontFamily: FONT, fontSize: 34, color, fontWeight: 500 }}>
      {children}
    </div>
  );
};

type P = [number, number];
/** Çizilerek beliren, üzerinde paket akan bağlantı çizgisi. Tüm çizgiler tek SVG katmanında (Lines) çizilir. */
export type LineDef = { from: P; to: P; delay: number; color?: string; dashed?: boolean; dur?: number; both?: boolean; sfx?: boolean; label?: string };

export const Lines: React.FC<{ lines: LineDef[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        {lines.map((l, i) => {
          const dur = l.dur ?? 22;
          const color = l.color ?? C.brand;
          const p = interpolate(frame - l.delay, [0, dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
          if (p <= 0) return null;
          const [x1, y1] = l.from, [x2, y2] = l.to;
          const len = Math.hypot(x2 - x1, y2 - y1);
          const ex = x1 + (x2 - x1) * p, ey = y1 + (y2 - y1) * p;
          const t0 = frame - l.delay - dur;
          const pk = (o: number) => {
            const u = (((t0 + o) % 50) + 50) % 50 / 50;
            return [x1 + (x2 - x1) * u, y1 + (y2 - y1) * u] as P;
          };
          const pk1 = pk(0), pk2 = pk(25);
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={color} strokeWidth={4} strokeLinecap="round" strokeDasharray={l.dashed ? '4 14' : undefined} opacity={0.9} />
              {t0 > 0 && len > 0 && (
                <>
                  <circle cx={pk1[0]} cy={pk1[1]} r={9} fill={color} />
                  {l.both && <circle cx={pk2[0]} cy={pk2[1]} r={9} fill={color} opacity={0.7} />}
                </>
              )}
            </g>
          );
        })}
      </svg>
      {lines.map((l, i) => {
        const dur = l.dur ?? 22;
        const show = frame >= l.delay + dur;
        return (
          <React.Fragment key={i}>
            {l.sfx !== false && <Sfx at={l.delay + dur - 2} name="blip" vol={0.25} />}
            {l.label && (
              <div style={{ position: 'absolute', left: (l.from[0] + l.to[0]) / 2 - 170, top: (l.from[1] + l.to[1]) / 2 - 42, width: 340, textAlign: 'center', fontFamily: FONT, fontSize: 25, color: l.color ?? C.brand, fontWeight: 600, opacity: show ? 1 : 0, textShadow: '0 0 8px #000, 0 0 8px #000' }}>
                {l.label}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};

export const Scene: React.FC<{ n: string; title: string; dur: number; children: React.ReactNode }> = ({ n, title, dur, children }) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 10, dur - 10, dur], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const { opacity, s } = useAppear(4);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade, background: C.bg }}>
      <Sfx at={0} name="whoosh" vol={0.4} />
      <div style={{ position: 'absolute', left: 90, top: 60, opacity, transform: `translateX(${(1 - s) * -40}px)`, display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <span style={{ fontFamily: MONO, fontSize: 40, color: C.brand, fontWeight: 700 }}>{n}</span>
        <span style={{ fontFamily: FONT, fontSize: 64, color: C.text, fontWeight: 800 }}>{title}</span>
      </div>
      <div style={{ position: 'absolute', left: 90, top: 150, width: 220, height: 5, borderRadius: 3, background: C.brand, opacity }} />
      {children}
    </div>
  );
};
