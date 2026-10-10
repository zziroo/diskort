import { View } from 'react-native';
import type { DisplayStatus } from '@diskort/client-core';
import { colors } from '../theme';

/** Durum renkleri tema renklerinden (Discord'un yeşil / sarı / kırmızı / gri tonları) */
const colorOf = (status: DisplayStatus): string =>
  status === 'online' ? colors.ok : status === 'idle' ? colors.warn : status === 'dnd' ? colors.danger : colors.faint;

/** Telefon biçimli simgenin yüksekliği (genişlik `size`): en/boy 2:3 */
export const phoneHeight = (size: number): number => Math.round(size * 1.5);

/** Telefon biçimi yalnızca görünen durumlarda (çevrimdışı/görünmez hep normal halka) */
export const showsPhone = (status: DisplayStatus, mobile: boolean | undefined): boolean =>
  mobile === true && (status === 'online' || status === 'idle' || status === 'dnd');

/**
 * Yalnızca telefondan bağlı kişinin simgesi: durum renginde köşeleri yuvarlak küçük telefon; ekranı ve ana
 * tuşu `surface` renginde oyuk (yuvarlak noktadaki oyuklarla aynı yaklaşım).
 */
function PhoneDot({ color, size, surface }: { color: string; size: number; surface: string }) {
  const height = phoneHeight(size);
  const u = size / 10;
  return (
    <View style={{ width: size, height, borderRadius: 2 * u, backgroundColor: color, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          left: 1.5 * u,
          top: 1.75 * u,
          width: 7 * u,
          height: 9 * u,
          borderRadius: 0.75 * u,
          backgroundColor: surface,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 4.1 * u,
          top: (13 - 0.9) * u,
          width: 1.8 * u,
          height: 1.8 * u,
          borderRadius: u,
          backgroundColor: surface,
        }}
      />
    </View>
  );
}

/**
 * Discord biçimli durum simgesi (SVG'siz, yalnızca View): çevrim içi dolu yeşil daire, boşta sarı ay,
 * rahatsız etmeyin ortası çizgili kırmızı daire, çevrimdışı/görünmez gri halka. Oyuklar `surface`
 * renginde çizilir (simgenin durduğu zemin). `mobile`: aynı renkte telefon biçimi.
 */
export function StatusDot({
  status,
  size,
  surface,
  mobile,
}: {
  status: DisplayStatus;
  size: number;
  surface: string;
  /** Kişi yalnızca telefondan bağlı: daire yerine telefon (çevrimdışı/görünmezken yok sayılır) */
  mobile?: boolean;
}) {
  const color = colorOf(status);
  if (showsPhone(status, mobile)) return <PhoneDot color={color} size={size} surface={surface} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, overflow: 'hidden' }}>
      {status === 'idle' && (
        <View
          style={{
            position: 'absolute',
            left: -size * 0.125,
            top: -size * 0.125,
            width: size * 0.75,
            height: size * 0.75,
            borderRadius: size,
            backgroundColor: surface,
          }}
        />
      )}
      {status === 'dnd' && (
        <View
          style={{
            position: 'absolute',
            left: size * 0.125,
            top: size * 0.375,
            width: size * 0.75,
            height: size * 0.25,
            borderRadius: size,
            backgroundColor: surface,
          }}
        />
      )}
      {(status === 'offline' || status === 'invisible') && (
        <View
          style={{
            position: 'absolute',
            left: size * 0.25,
            top: size * 0.25,
            width: size * 0.5,
            height: size * 0.5,
            borderRadius: size,
            backgroundColor: surface,
          }}
        />
      )}
    </View>
  );
}
