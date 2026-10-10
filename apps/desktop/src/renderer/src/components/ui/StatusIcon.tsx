import { useId } from 'react';
import type { DisplayStatus } from '@diskort/client-core';

/** Durum renkleri tema değişkenlerinden (Discord'un yeşil / sarı / kırmızı / gri tonları) */
const COLORS: Record<DisplayStatus, string> = {
  online: 'var(--color-ok)',
  idle: 'var(--color-warn)',
  dnd: 'var(--color-danger)',
  invisible: 'var(--color-text-faint)',
  offline: 'var(--color-text-faint)',
};

/** Telefon biçimli simgenin yüksekliği (genişlik `size`): en/boy 2:3 */
export const phoneHeight = (size: number): number => Math.round(size * 1.5);

/** Telefon biçimi yalnızca görünen durumlarda (çevrimdışı/görünmez hep normal halka) */
export const showsPhone = (status: DisplayStatus, mobile: boolean | undefined): boolean =>
  mobile === true && (status === 'online' || status === 'idle' || status === 'dnd');

/**
 * Discord biçimli durum simgesi: çevrim içi dolu yeşil daire, boşta sarı ay, rahatsız etmeyin ortası
 * çizgili kırmızı daire, çevrimdışı/görünmez gri halka. Oyuklar saydamdır (arkadaki zemin görünür).
 * `mobile`: kişi yalnızca telefondan bağlı; daire yerine durum renginde küçük telefon (ekranı ve ana tuşu oyuk).
 */
export function StatusIcon({
  status,
  size = 10,
  mobile,
  className,
}: {
  status: DisplayStatus;
  size?: number;
  mobile?: boolean;
  className?: string;
}) {
  // useId iki nokta / köşeli tırnak içerir; url(#…) içinde güvenli olsun
  const id = `durum-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const color = COLORS[status];
  if (showsPhone(status, mobile)) {
    return (
      <svg width={size} height={phoneHeight(size)} viewBox="0 0 10 15" className={className} aria-hidden>
        <mask id={id}>
          <rect x="0" y="0" width="10" height="15" rx="2" fill="white" />
          <rect x="1.5" y="1.75" width="7" height="9" rx="0.75" fill="black" />
          <circle cx="5" cy="13" r="0.9" fill="black" />
        </mask>
        <rect x="0" y="0" width="10" height="15" rx="2" fill={color} mask={`url(#${id})`} />
      </svg>
    );
  }
  if (status === 'online') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" className={className} aria-hidden>
        <circle cx="5" cy="5" r="5" fill={color} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" className={className} aria-hidden>
      <mask id={id}>
        <circle cx="5" cy="5" r="5" fill="white" />
        {status === 'idle' && <circle cx="2.5" cy="2.5" r="3.75" fill="black" />}
        {status === 'dnd' && <rect x="1.25" y="3.75" width="7.5" height="2.5" rx="1.25" fill="black" />}
        {(status === 'offline' || status === 'invisible') && <circle cx="5" cy="5" r="2.5" fill="black" />}
      </mask>
      <circle cx="5" cy="5" r="5" fill={color} mask={`url(#${id})`} />
    </svg>
  );
}
