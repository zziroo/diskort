import { useCallback, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFeedback, useGuild, useSession } from '@diskort/client-core';
import { useAppear } from '../motion';
import { useSettings } from '../stores/settings';
import { colors, createStyles, font, radius, ripple, space, tint } from '../theme';
import { leaveVoice, toggleDeafen, toggleMute } from '../voice/actions';
import { useVoiceRoomName } from '../voice/roomName';
import { useVoice } from '../voice/voice';
import { CountBadge } from './Badge';
import { PressableScale } from './PressableScale';
import { ConnectionSheet } from './ConnectionSheet';
import { SwapIcon, type SwapMotion } from './SwapIcon';
import { SignalBars, useVoiceLevel } from './VoiceQuality';

/** Alt çubuktaki düğme boyu (tek satırda kalsın diye ses ekranındakilerden küçük) */
const BUTTON = 38;

const STATUS = { connecting: 'Bağlanıyor…', reconnecting: 'Yeniden bağlanıyor…', connected: 'Ses bağlı', idle: '' };

/**
 * Ekranın altında tek satır (Discord mobil gibi): solda bağlantı kalitesi (dokununca bağlantı paneli),
 * kanal adı ve durum (dokununca ses ekranı açılır; durum yazısı da bağlantı panelini açar), sağda sustur / sağırlaştır / ayrıl. Sese katılınca aşağıdan
 * yükselerek belirir. `onSettings` verilirse (ana ekranda kullanıcı panelinin yerini alınca) ayarlar
 * düğmesi de olur; böylece aynı düğmeler iki satırda tekrarlanmaz.
 */
export function VoiceBar({ bottomInset = 0, onSettings }: { bottomInset?: number; onSettings?: () => void }) {
  const status = useVoice((s) => s.status);
  if (status === 'idle') return null;
  return <VoiceBarInner bottomInset={bottomInset} onSettings={onSettings} />;
}

/** `bottomInset`: ekranın en altındaysa gezinme çubuğunun arkası da panel renginde olsun diye boşluk */
function VoiceBarInner({ bottomInset, onSettings }: { bottomInset: number; onSettings?: () => void }) {
  const router = useRouter();
  const status = useVoice((s) => s.status);
  const channelId = useVoice((s) => s.channelId);
  // Ses kanalının adı ya da DM aramasında konuşmanın adı (bire bir konuşmada karşı taraf)
  const roomName = useVoiceRoomName(channelId);
  const count = useGuild((s) => {
    let n = 0;
    for (const id in s.voiceStates) if (s.voiceStates[id]!.channelId === channelId) n++;
    return n;
  });
  const selfMute = useSettings((s) => s.selfMute);
  const selfDeaf = useSettings((s) => s.selfDeaf);
  // Hesap yöneticisine yeni geri bildirim sayısı (ayarlar düğmesinde)
  const isAdmin = useSession((s) => s.user?.isAdmin === true);
  const newFeedback = useFeedback((s) => (isAdmin ? s.newCount : 0));
  // Konuşma izni yoksa (yetki ya da sunucuda susturma) mikrofon kapalı görünür
  const micAllowed = useVoice((s) => s.micAllowed);
  const appear = useAppear(true, 220);
  // Render içinde interpolate() her çizimde yeni Animated düğümü yaratıp Android'de OOM'a yol
  // açıyordu; düğüm yalnız appear değişince oluşturulur.
  const translateY = useMemo(() => appear.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }), [appear]);
  const connected = status === 'connected';
  const muted = selfMute || selfDeaf || !micAllowed;
  const level = useVoiceLevel();
  const [infoOpen, setInfoOpen] = useState(false);
  const openInfo = useCallback(() => setInfoOpen(true), []);
  const closeInfo = useCallback(() => setInfoOpen(false), []);

  return (
    <Animated.View
      style={[
        styles.wrap,
        { paddingBottom: bottomInset },
        { opacity: appear, transform: [{ translateY }] },
      ]}
    >
      <View style={styles.bar}>
        {/* Bağlantı göstergesi ve durum yazısı bağlantı panelini, satırın geri kalanı ses ekranını açar */}
        <Pressable
          style={styles.signal}
          android_ripple={{ color: 'rgba(255,255,255,0.1)', borderless: true, radius: 22 }}
          onPress={openInfo}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={`Bağlantı bilgisi${level.ping !== null ? `, gecikme ${level.ping} milisaniye` : ''}`}
        >
          <SignalBars bars={level.bars} color={level.color} size={15} />
        </Pressable>
        <Pressable
          style={styles.info}
          android_ripple={ripple.row}
          onPress={() => router.push('/voice')}
          accessibilityRole="button"
          accessibilityLabel={`${roomName}, ${STATUS[status]}${count > 0 ? `, ${count} kişi` : ''}. Ses ekranını aç`}
        >
          <View style={styles.texts}>
            <Text style={styles.channel} numberOfLines={1}>
              {roomName}
            </Text>
            <Text style={[styles.status, { color: level.color }]} numberOfLines={1}>
              <Text onPress={openInfo} suppressHighlighting>
                {STATUS[status]}
                {connected && level.ping !== null ? <Text style={styles.ping}>{` ${level.ping} ms`}</Text> : null}
              </Text>
              {count > 0 ? <Text style={styles.count}>{` · ${count} kişi`}</Text> : null}
            </Text>
          </View>
        </Pressable>
        <ConnectionSheet visible={infoOpen} onClose={closeInfo} />
        {onSettings ? (
          <VoiceControl icon="settings-sharp" size={BUTTON} label="Ayarlar" onPress={onSettings} badge={newFeedback} />
        ) : null}
        <VoiceControl
          icon={muted ? 'mic-off' : 'mic'}
          off={muted}
          size={BUTTON}
          label={muted ? 'Mikrofonu aç' : 'Sustur'}
          onPress={toggleMute}
        />
        <VoiceControl
          icon={selfDeaf ? 'volume-mute' : 'headset'}
          off={selfDeaf}
          size={BUTTON}
          label={selfDeaf ? 'Sağırlaştırmayı kaldır' : 'Sağırlaştır'}
          onPress={toggleDeafen}
          motion="tilt"
        />
        <VoiceControl icon="call" danger size={BUTTON} label="Bağlantıyı kes" onPress={leaveVoice} />
      </View>
    </Animated.View>
  );
}

/**
 * Ses denetim düğmesi (alt çubukta ve ses ekranında). Kapalı olan (susturuldu) kırmızı, açık olan
 * (yayında) yeşil, ayrıl kırmızı dolgu. Simge değişince `motion`'a göre canlı geçer (SwapIcon).
 */
export function VoiceControl({
  icon,
  label,
  onPress,
  off,
  on,
  danger,
  size = 40,
  caption,
  badge = 0,
  motion = 'pop',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** Kırmızı: kapalı olan bir şey (susturuldu) */
  off?: boolean;
  /** Yeşil: açık olan bir şey (yayında) */
  on?: boolean;
  danger?: boolean;
  size?: number;
  /** Düğmenin altındaki kısa ad (ses ekranında) */
  caption?: string;
  /** Sağ üst köşede kırmızı sayı (ör. yeni geri bildirimler) */
  badge?: number;
  /** Simge değişirken oynayan hareket */
  motion?: SwapMotion;
}) {
  const bg = danger ? colors.danger : off ? colors.dangerSoft : on ? colors.okSoft : caption ? colors.active : 'transparent';
  const fg = danger ? '#fff' : off ? colors.danger : on ? colors.ok : colors.text;
  return (
    <View style={styles.control}>
      <PressableScale
        scaleTo={0.86}
        onPress={onPress}
        hitSlop={4}
        ripple={{ color: tint(0.16), borderless: true, radius: size / 2 }}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: Boolean(off || on) }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}
      >
        <SwapIcon
          name={icon}
          size={Math.round(size * 0.5)}
          color={fg}
          motion={motion}
          style={danger && icon === 'call' ? { transform: [{ rotate: '135deg' }] } : undefined}
        />
        {badge > 0 && (
          <View pointerEvents="none" style={{ position: 'absolute', top: -4, right: -6 }}>
            <CountBadge count={badge} ring={colors.panel} />
          </View>
        )}
      </PressableScale>
      {caption ? (
        <Text style={[styles.caption, (off || danger) && { color: colors.dangerText }, on && { color: colors.ok }]} numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

const styles = createStyles(() => ({
  wrap: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs,
    minHeight: 54,
    paddingLeft: space.xs,
    paddingRight: space.sm,
  },
  signal: { alignSelf: 'stretch', justifyContent: 'center', paddingLeft: space.sm + 2, paddingRight: space.xxs },
  // Dokunma alanı satır boyu; dalga efekti yuvarlatılmış kutuda kalır
  info: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    alignSelf: 'stretch',
    marginVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  ping: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  texts: { flex: 1 },
  channel: { color: colors.head, fontSize: font.body - 0.5, fontWeight: '700' },
  status: { fontSize: font.caption, fontWeight: '700' },
  count: { color: colors.muted, fontWeight: '600' },
  control: { alignItems: 'center', gap: 6 },
  caption: { color: colors.muted, fontSize: 11.5, fontWeight: '600' },
}));
