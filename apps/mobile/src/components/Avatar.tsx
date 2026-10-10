import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { animatedDecorationId, type User } from '@diskort/shared';
import { avatarInk, avatarUrl, useOnMobile, useStatus, type DisplayStatus } from '@diskort/client-core';
import { colors, createStyles } from '../theme';
import { AnimatedDecoration } from './cosmetics/Cosmetics';
import { showsPhone, StatusDot } from './StatusDot';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toLocaleUpperCase('tr');
  return (parts[0]![0]! + parts[1]![0]!).toLocaleUpperCase('tr');
}

interface Props {
  user: Pick<User, 'displayName' | 'avatarColor' | 'avatarUrl'> | undefined;
  size?: number;
  speaking?: boolean;
  /** Eski biçim: çevrimiçi / çevrimdışı. `status` verilirse o kullanılır */
  online?: boolean;
  /** Durum noktası (Discord biçimli: ay, eksi, halka) */
  status?: DisplayStatus;
  /** Kişi yalnızca telefondan bağlı: nokta telefon biçiminde (çevrimdışı/görünmezken yok sayılır) */
  mobile?: boolean;
  /** Çevrimiçi noktasının çevresindeki halka: avatarın durduğu yüzeyin rengi */
  surface?: string;
  /** Avatar dekorasyonunun kimliği (user.avatarDecoration): avatarın üstüne, yerleşimi değiştirmeden çizilir */
  decoration?: string | null;
  /**
   * Hareketli dekorasyon oynasın: YALNIZCA açık profil kartı (ProfileHeader). Başka her yerde (listeler, mesajlar,
   * ses kutucukları, seçici) dekorasyon sabittir ve oynatıcı kurulmaz.
   */
  animateDecoration?: boolean;
  /** Küçük avatarda da halka yerine dekorasyonun sabit resmi (ayarlardaki seçicinin kutuları) */
  decorationPoster?: boolean;
}

export function Avatar({
  user,
  size = 40,
  speaking,
  online,
  status,
  mobile,
  surface = colors.side,
  decoration,
  animateDecoration,
  decorationPoster,
}: Props) {
  const shown: DisplayStatus | undefined = status ?? (online === undefined ? undefined : online ? 'online' : 'offline');
  const phone = shown !== undefined && showsPhone(shown, mobile);
  const border = size >= 32 ? 3 : 2;
  const dot = Math.round(size * 0.36) - 2 * border;
  const ring = speaking ? 3 : 0;
  const src = avatarUrl(user);
  // Yüklenemeyen fotoğrafın yerine baş harfler (adres değişince yeniden denenir)
  const [failed, setFailed] = useState<string | null>(null);
  // Hareketli dekorasyon (anim:<set>): setin paketi oynatılır; bildirimde olmayan set gösterilmez
  const animated = animatedDecorationId(decoration);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: user?.avatarColor ?? '#747f8d',
            borderWidth: ring,
            borderColor: colors.ok,
          },
        ]}
      >
        {src && failed !== src ? (
          <Image
            source={{ uri: src }}
            style={[styles.photo, { borderRadius: size / 2 }]}
            onError={() => setFailed(src)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={[styles.text, { fontSize: Math.max(10, size * 0.38), color: avatarInk(user?.avatarColor) }]}>{initials(user?.displayName ?? '?')}</Text>
        )}
      </View>
      {animated && <AnimatedDecoration set={animated} size={size} animate={animateDecoration} poster={decorationPoster} />}
      {shown !== undefined && (
        <View
          style={[
            styles.dot,
            // Telefonun halkası da köşeleri yuvarlak dikdörtgen (simgenin köşesiyle eş merkezli)
            { padding: border, borderRadius: phone ? border + dot * 0.2 : size, backgroundColor: surface },
          ]}
        >
          <StatusDot status={shown} size={dot} surface={surface} mobile={phone} />
        </View>
      )}
    </View>
  );
}

const styles = createStyles(() => ({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photo: { width: '100%', height: '100%' },
  text: { color: '#fff', fontWeight: '600' },
  dot: { position: 'absolute', right: -1, bottom: -1 },
}));

/** Kişinin güncel durum noktasıyla avatar (kendin için görünmezlik de görünür) */
export function PresenceAvatar({ userId, ...props }: Omit<Props, 'status' | 'online'> & { userId: string }) {
  const status = useStatus(userId);
  const mobile = useOnMobile(userId);
  return <Avatar {...props} status={status} mobile={mobile} />;
}
