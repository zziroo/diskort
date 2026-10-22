import { describe, expect, it } from 'vitest';
import { unreadBadgeTotal } from '../src';

describe('unreadBadgeTotal', () => {
  const channelGuild = { c1: 'g1', c2: 'g1', c3: 'g2' };
  const dms = { d1: {}, d2: {} };

  it('tüm sunuculardaki bahsetmeleri ve okunmamış DM mesajlarını toplar', () => {
    expect(unreadBadgeTotal({ c1: 2, c3: 1, d1: 4, d2: 1 }, channelGuild, dms)).toBe(8);
  });

  it('okunmamış yoksa 0', () => {
    expect(unreadBadgeTotal({}, channelGuild, dms)).toBe(0);
    expect(unreadBadgeTotal({ c1: 0, d1: 0 }, channelGuild, dms)).toBe(0);
  });

  it('bilinmeyen (ayrılınan sunucu, kapanan konuşma) kimlikleri saymaz', () => {
    expect(unreadBadgeTotal({ gone: 5, c2: 1 }, channelGuild, dms)).toBe(1);
  });
});
