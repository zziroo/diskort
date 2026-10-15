import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { prefersReducedMotion, timing } from '../motion';
import { colors } from '../theme';

/**
 * Konuşan kişinin avatarını saran yeşil halka: yumuşakça belirir, konuşma sürdükçe dışa doğru
 * nabız atar, susunca yavaşça söner. Avatar bileşenine dokunmadan dışarıdan sarar.
 * `intro`: kişinin giriş sesi çalıyor; halka sarı yanar (konuşmanın önüne geçer). Kenar kalınlığı hep
 * aynı, yalnızca rengi değişir.
 */
export function SpeakingRing({
  speaking: talking,
  intro = false,
  size,
  children,
}: {
  speaking: boolean;
  intro?: boolean;
  size: number;
  children: ReactNode;
}) {
  const speaking = talking || intro;
  // Sönüş animasyonu (280 ms) sırasında intro false olsa da renk son haliyle kalsın (yeşile dönmesin)
  const lastIntro = useRef(false);
  if (speaking) lastIntro.current = intro;
  const shown = useRef(new Animated.Value(speaking ? 1 : 0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const width = size >= 48 ? 3 : 2;
  const gap = size >= 48 ? 3 : 2;

  useEffect(() => {
    // Açılış hızlı, sönüş biraz daha yavaş: konuşma arasındaki kısa sessizliklerde titremez
    timing(shown, speaking ? 1 : 0, speaking ? 90 : 280).start();
    if (!speaking || prefersReducedMotion()) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [speaking, shown, pulse]);

  // Her çizimde yeni Animated düğümü yaratmak Android'de yerel düğüm yöneticisini şişirip OOM'a
  // yol açıyordu; türetilmiş düğümler yalnız shown/pulse değişince bir kez oluşturulur.
  const waveStyle = useMemo(
    () => ({
      opacity: Animated.multiply(shown, pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] })),
      transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.22] }) }],
    }),
    [shown, pulse],
  );

  const ring = {
    position: 'absolute' as const,
    top: -(width + gap),
    left: -(width + gap),
    right: -(width + gap),
    bottom: -(width + gap),
    borderRadius: size,
    borderWidth: width,
    borderColor: lastIntro.current ? colors.warn : colors.ok,
  };

  return (
    <View style={{ width: size, height: size }}>
      {/* Dışa yayılıp kaybolan dalga */}
      <Animated.View
        pointerEvents="none"
        style={[
          ring,
          waveStyle,
        ]}
      />
      <Animated.View pointerEvents="none" style={[ring, { opacity: shown }]} />
      {children}
    </View>
  );
}
