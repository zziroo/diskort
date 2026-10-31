import { useEffect, type ReactNode } from 'react';
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import type { Guild } from '@diskort/shared';
import { useGuild, type GuildSettingsSection } from '@diskort/client-core';
import { selectGuildInPanel } from '../../stores/nav';
import { colors, createStyles, font, radius, space } from '../../theme';

// Telefonda sunucu ayarları (masaüstündeki Sunucu Ayarları'nın karşılığı). Ekranlar seçili sunucuyla
// çalışır (üyeler, roller, yönetim işleri client-core'da seçili sunucuya göre); ayarlar açılırken sunucu
// seçilir ve hangi sunucu için açıldığı burada tutulur.

type IconName = keyof typeof Ionicons.glyphMap;

/** Bölümlerin telefondaki adı, simgesi ve kısa açıklaması (masaüstündeki Sunucu Ayarları'yla aynı sıra) */
export const SECTION_INFO: Record<GuildSettingsSection, { label: string; icon: IconName; color: string; detail: string }> = {
  overview: { label: 'Genel', icon: 'information-circle', color: '#5865f2', detail: 'Ad, simge, sahiplik' },
  channels: { label: 'Kanallar', icon: 'chatbubbles', color: '#3ba55d', detail: 'Sırala, yeniden adlandır, izinler, sil' },
  roles: { label: 'Roller', icon: 'shield-half', color: '#eb459e', detail: 'Oluştur, renk, yetkiler, sıralama' },
  members: { label: 'Üyeler', icon: 'people', color: '#00a8fc', detail: 'Roller, atma, yasaklama' },
  sounds: { label: 'Sesler', icon: 'musical-notes', color: '#9b59b6', detail: 'Ses panelinin sesleri' },
  invites: { label: 'Davetler', icon: 'link', color: '#faa61a', detail: 'Oluştur, paylaş, sil' },
  bans: { label: 'Yasaklar', icon: 'ban', color: '#f23f43', detail: 'Yasaklı kişiler, yasağı kaldır' },
};

const useTarget = create<{ guildId: string | null }>(() => ({ guildId: null }));

type SettingsPath = '/sunucu-ayarlari' | '/sunucu-ayarlari/kanal-olustur';

/** Sunucuyu seçip ayarlar ekranını (ya da kanal oluşturmayı) açar */
export function openServerSettings(guildId: string, path: SettingsPath = '/sunucu-ayarlari', params?: Record<string, string>): void {
  selectGuildInPanel(guildId);
  useTarget.setState({ guildId });
  router.push(params ? { pathname: path, params } : path);
}

/** Seçili sunucunun bir kanalının düzenleme ekranını açar (kanala uzun basınca) */
export function openChannelSettings(channelId: string): void {
  const guildId = useGuild.getState().channelGuild[channelId];
  if (!guildId) return;
  selectGuildInPanel(guildId);
  useTarget.setState({ guildId });
  router.push({ pathname: '/sunucu-ayarlari/kanal/[id]', params: { id: channelId } });
}

/**
 * Ayarları açılan sunucu. Sunucu silinir, ayrılınır ya da başka sunucu seçilirse null döner ve ayar
 * ekranları kapanıp ana ekrana dönülür (başka sunucunun ayarları yanlışlıkla görünmesin).
 */
export function useSettingsGuild(): Guild | null {
  const target = useTarget((s) => s.guildId);
  const guild = useGuild((s) => (s.guild && s.guild.id === target ? s.guild : null));
  const ready = useGuild((s) => s.status === 'ready');
  const gone = ready && guild === null;
  useEffect(() => {
    if (gone && router.canDismiss()) router.dismissTo('/');
  }, [gone]);
  return guild;
}

/** Ayar ekranının kaydırılan gövdesi: kenar boşlukları ve alttaki gezinme çubuğu payı */
export function SettingsPage({
  children,
  footerSpace = 0,
  contentStyle,
}: {
  children: ReactNode;
  /** Altta yüzen çubuk (kaydet) için ayrılan boşluk */
  footerSpace?: number;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxxl + footerSpace }, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

/** Bölümün üstündeki kısa açıklama */
export function Intro({ children }: { children: ReactNode }) {
  return <Text style={styles.intro}>{children}</Text>;
}

/** Sarı uyarı kutusu (ör. "Bu rolü düzenleyemezsin") */
export function Warning({ children, icon = 'alert-circle' }: { children: ReactNode; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.warning}>
      <Ionicons name={icon} size={17} color={colors.warn} style={{ marginTop: 1 }} />
      <Text style={styles.warningText}>{children}</Text>
    </View>
  );
}

/** Rolün renk noktası (renksiz rol gri) */
export function RoleDot({ color, size = 12 }: { color: string | null; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? '#99aab5' }} />;
}

/** Yetki olmadığında bölümün yerinde */
export function NoAccess({ text = 'Bu bölümü yönetme yetkin yok.' }: { text?: string }) {
  return (
    <View style={styles.noAccess}>
      <Ionicons name="lock-closed-outline" size={28} color={colors.muted} />
      <Text style={styles.noAccessText}>{text}</Text>
    </View>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  content: { padding: space.lg },
  intro: { color: colors.muted, fontSize: font.small, lineHeight: 20, marginBottom: space.md },
  warning: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    marginBottom: space.md,
  },
  warningText: { flex: 1, color: colors.warn, fontSize: font.small, lineHeight: 19 },
  noAccess: { alignItems: 'center', gap: space.md, paddingVertical: space.xxxl },
  noAccessText: { color: colors.muted, fontSize: font.body, textAlign: 'center' },
}));
