import { useState, type ReactNode } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { userEffectId, type CustomStatus, type User } from '@diskort/shared';
import { bannerUrl, profileGradient, type DisplayStatus } from '@diskort/client-core';
import { colors, createStyles, font, radius, space } from '../theme';
import { Avatar } from './Avatar';
import { CardEffect, useCardEffectShown } from './cosmetics/Cosmetics';

type ProfileUser = Pick<
  User,
  'displayName' | 'username' | 'avatarColor' | 'avatarUrl' | 'bannerUrl' | 'profileTheme' | 'animatedEffect' | 'avatarDecoration'
>;

/** "#rrggbb" iki rengin karışımı (a'dan t kadar); çözülemezse a */
function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const x = parseInt(pa[1]!, 16);
  const y = parseInt(pb[1]!, 16);
  const channel = (shift: number): string =>
    Math.round(((x >> shift) & 255) * t + ((y >> shift) & 255) * (1 - t))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** Temanın üstüne serilen tülün saydamlığı (masaüstündeki profil kartıyla aynı) */
const VEIL = 0.55;
/** Avatarın çevresindeki halkanın kalınlığı */
const RING = 4;

/**
 * Profil kartının üst kısmı (masaüstündeki profil kartı gibi): üstte afiş (resim, yoksa tema rengi, o da
 * yoksa avatarın rengi), afişe taşan avatar (halkası kartın renginde), ad, kullanıcı adı ve satırlar. Tema
 * varsa zemin iki renkli degradedir, üstüne yazılar okunsun diye sayfanın renginde yarı saydam bir tül
 * serilir. Hareketli set efekti kartın içeriğinin üstünde, avatarın altındadır: efekt avatarın yerini bilmez
 * (kartın genişliğine göre hazır bir resimdir), avatar bu yüzden efekt varken efektin üstündeki ayrı bir katmanda
 * çizilir; efekt yokken yerindedir.
 * Üye menüsü ve Ayarlar → Profil'deki önizleme kullanır. Açık profil kozmetiklerin telefonda oynadığı tek yerdir
 * (kart efekti ve dekorasyon); kart kapanınca oynatıcılar bırakılır.
 */
export function ProfileHeader({
  user,
  status,
  mobile,
  nameColor,
  badge,
  lines,
  custom,
  avatar,
  centered = false,
  surface = colors.side,
  children,
  style,
}: {
  user: ProfileUser;
  status?: DisplayStatus;
  /** Kişi yalnızca telefondan bağlı (nokta telefon biçiminde) */
  mobile?: boolean;
  /** Adın rengi (en üstteki rolün rengi) */
  nameColor?: string | null;
  /** Adın yanında (ör. sunucu sahibinin tacı) */
  badge?: ReactNode;
  /** Kullanıcı adının yanına eklenecek bilgi (ör. "Sesli sohbette") */
  lines?: string;
  custom?: CustomStatus | null;
  /**
   * Avatarın yerine (ör. ayarlarda dokununca fotoğraf seçtiren avatar); `ring` halkanın rengidir. Açık profil
   * olduğundan dekorasyonu oynamalıdır (`animateDecoration`).
   */
  avatar?: (ring: string) => ReactNode;
  /** Avatar ve yazılar ortada (ayarlar) */
  centered?: boolean;
  /** Kartın zemini: durduğu sayfanın rengi */
  surface?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = user.profileTheme ?? null;
  const src = bannerUrl(user);
  // Yüklenemeyen afişin yerine renk (adres değişince yeniden denenir)
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = Boolean(src && failed !== src);
  // Halka kartın o hizadaki rengindedir: degradenin üçte biri kadar aşağısı, tüle karışmış
  const ring = theme ? mix(surface, mix(theme.primary, theme.accent, 0.7), VEIL) : surface;
  const size = centered ? 88 : 72;
  const effect = userEffectId(user);
  const effectShown = useCardEffectShown(effect);
  // Efekt, genişliğin 6/17'si yüksekliğinde bir afiş varsayar: efekt varken afiş, resimli afişin yüksekliğindedir
  const bannerStyle = effectShown || src ? styles.bannerTall : styles.banner;
  // Avatarın halkasıyla kapladığı kare ve afişe taşması
  const avatarBox = size + 2 * RING;
  const avatarLift = -(avatarBox / 2);
  const avatarNode = (
    <View style={[styles.avatarRing, centered && styles.avatarCentered, { backgroundColor: ring, borderRadius: size, marginTop: avatarLift }]}>
      {avatar ? (
        avatar(ring)
      ) : (
        <Avatar user={user} size={size} status={status} mobile={mobile} surface={ring} decoration={user.avatarDecoration} animateDecoration />
      )}
    </View>
  );

  return (
    <View style={[styles.card, { backgroundColor: surface }, style]}>
      {theme && (
        <>
          {/* Tema değişince degrade yerinde güncellenmesin, görünüm yeniden kurulsun (Android'de deneysel özellik; #28).
              Degradeli görünüme kenarlık verilmemeli: kaldırılınca Android çöker (bkz. ProfileSettings, #29) */}
          <View key={profileGradient(theme)} style={[StyleSheet.absoluteFill, { experimental_backgroundImage: profileGradient(theme) }]} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: surface, opacity: VEIL }]} />
        </>
      )}
      <View style={[bannerStyle, { backgroundColor: theme?.primary ?? user.avatarColor }]}>
        {src && showImage && (
          <Image
            source={{ uri: src }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={() => setFailed(src)}
            accessibilityIgnoresInvertColors
          />
        )}
      </View>
      <View style={[styles.body, centered && styles.bodyCentered]}>
        {effectShown ? (
          // Avatarın yeri (kendisi aşağıda, efektin üstündeki katmanda)
          <View style={[styles.avatarRing, centered && styles.avatarCentered, { width: avatarBox, height: avatarBox, marginTop: avatarLift }]} />
        ) : (
          // Efekt yokken avatar yerinde durur (ekran okuyucunun sırası da doğal kalır)
          avatarNode
        )}
        <View style={[styles.nameRow, centered && styles.nameRowCentered]}>
          <Text style={[styles.name, nameColor ? { color: nameColor } : null]} numberOfLines={1}>
            {user.displayName}
          </Text>
          {badge}
        </View>
        <Text style={[styles.sub, centered && styles.textCentered]} numberOfLines={1}>
          @{user.username}
          {lines ? ` · ${lines}` : ''}
        </Text>
        {custom ? (
          <Text style={[styles.sub, centered && styles.textCentered]} numberOfLines={2}>
            {custom.emoji ? `${custom.emoji} ` : ''}
            {custom.text}
          </Text>
        ) : null}
        {children}
      </View>
      {/* Açık profil: kozmetiklerin telefonda oynadığı tek yer (efekt ve büyük avatarın dekorasyonu) */}
      {effect && <CardEffect set={effect} animate />}
      {/* Efekt varken avatar katmanı: kartın yerleşimini (afiş, gövdenin kenar boşluğu) yineler, böylece avatar ölçüm
          gerekmeden yerine düşer. Yalnızca avatar dokunma alır; gerisi alttaki içeriğe geçer. (Ekran okuyucu avatara
          bu durumda en son gelir: öne almak, efektin üstünde çizilmesini ve dokunmayı bozmadan mümkün değil.) */}
      {effectShown && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={bannerStyle} pointerEvents="none" />
          <View style={[styles.body, centered && styles.bodyCentered]} pointerEvents="box-none">
            {avatarNode}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = createStyles(() => ({
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.edge,
  },
  banner: { height: 64 },
  // Afiş 17:6 (sunucu 1020×360'a kırpar); set efektinin varsaydığı afiş de bu yüksekliktedir
  bannerTall: { aspectRatio: 17 / 6 },
  body: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  bodyCentered: { alignItems: 'center' },
  avatarRing: { alignSelf: 'flex-start', padding: RING, marginBottom: space.xs },
  avatarCentered: { alignSelf: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nameRowCentered: { justifyContent: 'center' },
  name: { color: colors.head, fontSize: font.heading, fontWeight: '800', flexShrink: 1 },
  sub: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  textCentered: { textAlign: 'center' },
}));
