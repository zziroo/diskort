import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { STATUS_LABELS } from '@diskort/shared';
import { useCustomStatus, useFeedback, useOnMobile, useSession, useStatus } from '@diskort/client-core';
import { useSettings } from '../stores/settings';
import { colors, createStyles, font, space, tint } from '../theme';
import { toggleDeafen, toggleMute } from '../voice/actions';
import { useVoice } from '../voice/voice';
import { Avatar } from './Avatar';
import { CountBadge } from './Badge';
import { PressableScale } from './PressableScale';
import { openStatusPicker } from './StatusPicker';
import { SwapIcon, type SwapMotion } from './SwapIcon';
import { VoiceBar } from './VoiceBar';

/**
 * Kanal listesinin altındaki kullanıcı paneli (masaüstündeki gibi): avatar ve ad, sustur,
 * sağırlaştır ve ayarlar. Susturma seste değilken de hatırlanır; sonraki katılışta uygulanır.
 * Sesteyken yerini tek satırlık ses çubuğu alır (aynı düğmeler iki satırda tekrarlanmasın).
 */
export function UserPanel({ onSettings }: { onSettings: () => void }) {
  const user = useSession((s) => s.user);
  const selfMute = useSettings((s) => s.selfMute);
  const selfDeaf = useSettings((s) => s.selfDeaf);
  const micAllowed = useVoice((s) => s.micAllowed || s.status === 'idle');
  const muted = selfMute || selfDeaf || !micAllowed;
  // Ekranın en altında: gezinme çubuğunun arkası da panel renginde olsun
  const insets = useSafeAreaInsets();
  const inVoice = useVoice((s) => s.status !== 'idle');
  const status = useStatus(user?.id);
  const mobile = useOnMobile(user?.id);
  const custom = useCustomStatus(user?.id);
  // Hesap yöneticisine yeni geri bildirim sayısı (Ayarlar > Geri bildirimler (yönetim))
  const newFeedback = useFeedback((s) => (user?.isAdmin ? s.newCount : 0));
  if (inVoice) return <VoiceBar bottomInset={insets.bottom} onSettings={onSettings} />;
  if (!user) return null;
  return (
    <View style={[styles.panel, { paddingBottom: styles.panel.paddingVertical + insets.bottom }]}>
      <PressableScale
        scaleTo={0.97}
        onPress={onSettings}
        containerStyle={{ flex: 1 }}
        style={styles.who}
        accessibilityRole="button"
        accessibilityLabel={`${user.displayName}, ayarları aç`}
      >
        {/* Kendi avatarına dokununca durum sayfası (çevrim içi, boşta, rahatsız etmeyin, görünmez, özel durum) */}
        <PressableScale
          scaleTo={0.9}
          onPress={openStatusPicker}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Durumun: ${STATUS_LABELS[status]}. Değiştir`}
        >
          <Avatar user={user} size={34} status={status} mobile={mobile} surface={colors.panel} decoration={user.avatarDecoration} />
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            {custom ? `${custom.emoji ? `${custom.emoji} ` : ''}${custom.text ?? ''}` : `@${user.username}`}
          </Text>
        </View>
      </PressableScale>
      <PanelButton
        icon={muted ? 'mic-off' : 'mic'}
        off={muted}
        label={muted ? 'Mikrofonu aç' : 'Sustur'}
        onPress={toggleMute}
      />
      <PanelButton
        icon={selfDeaf ? 'volume-mute' : 'headset'}
        off={selfDeaf}
        label={selfDeaf ? 'Sağırlaştırmayı kaldır' : 'Sağırlaştır'}
        onPress={toggleDeafen}
        motion="tilt"
      />
      <PanelButton
        icon="settings-sharp"
        label={newFeedback > 0 ? `Ayarlar, ${newFeedback} yeni geri bildirim` : 'Ayarlar'}
        onPress={onSettings}
        badge={newFeedback}
      />
    </View>
  );
}

function PanelButton({
  icon,
  label,
  off,
  onPress,
  badge = 0,
  motion = 'pop',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  off?: boolean;
  onPress: () => void;
  /** Sağ üst köşede kırmızı sayı */
  badge?: number;
  /** Simge değişince (sustur ↔ aç) yenisine geçerken oynayan hareket */
  motion?: SwapMotion;
}) {
  return (
    <PressableScale
      scaleTo={0.84}
      ripple={{ color: tint(0.12), borderless: true, radius: 20 }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(off) }}
      style={[styles.button, off && { backgroundColor: colors.dangerSoft }]}
    >
      <SwapIcon name={icon} size={21} color={off ? colors.danger : colors.text} motion={motion} />
      {badge > 0 && (
        <View pointerEvents="none" style={styles.badge}>
          <CountBadge count={badge} ring={colors.panel} />
        </View>
      )}
    </PressableScale>
  );
}

const styles = createStyles(() => ({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.panel,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm - 2,
  },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 8 },
  name: { color: colors.head, fontSize: font.body - 1, fontWeight: '700' },
  username: { color: colors.muted, fontSize: font.caption },
  button: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -4, right: -6 },
}));
