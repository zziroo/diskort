import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STATUS_LABELS } from '@diskort/shared';
import {
  normalizeServerUrl,
  searchSettings,
  settingsGroupsFor,
  useCustomStatus,
  useFeedback,
  useSession,
  useStatus,
  type SettingsSectionInfo,
} from '@diskort/client-core';
import { PresenceAvatar } from '../components/Avatar';
import { confirmLogout } from '../components/settings/AccountSettings';
import { PressableScale } from '../components/PressableScale';
import { Card, NavRow, SectionTitle } from '../components/ui';
import { APP_VERSION, NATIVE_VERSION } from '../version';
import { DEFAULT_SERVER_URL, useSettings } from '../stores/settings';
import { colors, createStyles, font, radius, space, THEME_LABELS, useTheme } from '../theme';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Kullanıcı Ayarları (Discord mobildeki gibi): üstte profil ve arama, altında başlıklı gruplar (Hesap
 * Ayarları, Uygulama Ayarları, Yönetim, Destek); satırlar alt sayfaları açar. Gruplar ve sıraları
 * masaüstüyle ortaktır (client-core/settingsSections). En altta Çıkış Yap ve sürüm bilgisi.
 */
export default function SettingsScreen() {
  const user = useSession((s) => s.user);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  // Hesap yöneticiliği hiçbir sunucuya bağlı değildir: yönetim buradan
  const isAdmin = user?.isAdmin === true;
  const isAccountHelper = user?.isAccountHelper === true;
  const groups = useMemo(() => settingsGroupsFor('mobile', { isAdmin, isAccountHelper }), [isAdmin, isAccountHelper]);
  const shown = useMemo(() => searchSettings(groups, query), [groups, query]);
  const values = useRowValues();
  const serverUrl = useSettings((s) => s.serverUrl);

  const open = (section: SettingsSectionInfo): void => {
    switch (section.id) {
      case 'feedback':
        router.push('/feedback');
        return;
      case 'feedbackAdmin':
        router.push('/feedback-admin');
        return;
      case 'whatsNew':
        router.push('/whats-new');
        return;
      case 'privacy':
        // Gizlilik sayfası resmî sitede
        void Linking.openURL(`${DEFAULT_SERVER_URL}${section.path ?? ''}`);
        return;
      case 'webAdmin':
        void Linking.openURL(`${normalizeServerUrl(serverUrl)}${section.path ?? ''}`);
        return;
      default:
        router.push({ pathname: '/ayarlar/[bolum]', params: { bolum: section.id } });
    }
  };

  if (!user) return null;

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      keyboardShouldPersistTaps="handled"
    >
      <PressableScale
        scaleTo={0.98}
        onPress={() => router.push({ pathname: '/ayarlar/[bolum]', params: { bolum: 'profile' } })}
        style={styles.profile}
        accessibilityRole="button"
        accessibilityLabel={`${user.displayName}, profili düzenle`}
      >
        <PresenceAvatar userId={user.id} user={user} size={56} surface={colors.side} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            @{user.username}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.faint} />
      </PressableScale>

      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Ayarlarda ara"
          placeholderTextColor={colors.faint}
          selectionColor={colors.brand}
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          accessibilityLabel="Ayarlarda ara"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Aramayı temizle">
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      {shown.length === 0 && <Text style={styles.noResult}>“{query.trim()}” için bir ayar bulunamadı.</Text>}
      {shown.map((group) => (
        <View key={group.id}>
          <SectionTitle>{group.title}</SectionTitle>
          <Card>
            {group.sections.map((section, i) => (
              <NavRow
                key={section.id}
                first={i === 0}
                icon={section.icon.mobile as IconName}
                iconColor={section.color}
                label={section.label}
                value={values[section.id]?.value}
                badge={values[section.id]?.badge}
                onPress={() => open(section)}
              />
            ))}
          </Card>
        </View>
      ))}

      {!query.trim() && (
        <>
          <Card style={{ marginTop: space.xxl }}>
            <NavRow first icon="log-out-outline" danger label="Çıkış Yap" onPress={() => void confirmLogout()} />
          </Card>
          <AppInfo />
        </>
      )}
    </ScrollView>
  );
}

/** Satırların sağındaki değerler (Discord'daki gibi: Görünüm — Siyah (OLED)) ve rozetler */
function useRowValues(): Partial<Record<SettingsSectionInfo['id'], { value?: string; badge?: number }>> {
  const user = useSession((s) => s.user);
  const theme = useTheme((s) => s.name);
  const voiceActivity = useSettings((s) => s.voiceActivity);
  const sounds = useSettings((s) => s.sounds);
  const notificationSound = useSettings((s) => s.notificationSound);
  const status = useStatus(user?.id);
  const custom = useCustomStatus(user?.id);
  const newFeedback = useFeedback((s) => (user?.isAdmin ? s.newCount : 0));
  return {
    profile: { value: custom?.text ? custom.text : STATUS_LABELS[status] },
    appearance: { value: THEME_LABELS[theme] },
    voice: { value: voiceActivity ? 'Ses algılama' : 'Mikrofon hep açık' },
    notifications: { value: sounds || notificationSound ? 'Açık' : 'Kapalı' },
    feedbackAdmin: { badge: newFeedback },
  };
}

/** En alttaki sürüm bilgisi: uygulama ve APK sürümü, arayüz paketi, telefon, sunucu */
function AppInfo() {
  const serverUrl = useSettings((s) => s.serverUrl);
  const release = (Platform.constants as { Release?: string }).Release;
  const device = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ');
  // Kablosuz (OTA) gelen arayüz paketi: APK'nın içindekinden farklıysa kimliğinin başı ve tarihi
  const ota =
    Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId
      ? `${Updates.updateId.slice(0, 8)}${Updates.createdAt ? ` · ${Updates.createdAt.toLocaleDateString('tr-TR')}` : ''}`
      : null;
  return (
    <View style={styles.info}>
      <Text style={styles.infoText}>
        Diskort {APP_VERSION}
        {APP_VERSION !== NATIVE_VERSION ? ` (APK ${NATIVE_VERSION})` : ''}
      </Text>
      {ota ? <Text style={styles.infoText}>Arayüz paketi {ota}</Text> : null}
      <Text style={styles.infoText}>
        {Platform.OS === 'ios' ? 'iOS' : 'Android'} {release ?? Platform.Version}
        {device ? ` · ${device}` : ''}
      </Text>
      {serverUrl !== DEFAULT_SERVER_URL ? <Text style={styles.infoText}>Sunucu: {serverUrl}</Text> : null}
    </View>
  );
}

const styles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.main },
  content: { padding: space.lg },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    backgroundColor: colors.side,
    borderRadius: radius.lg - 4,
    padding: space.md + 2,
    overflow: 'hidden',
  },
  name: { color: colors.head, fontSize: font.title + 1, fontWeight: '800' },
  username: { color: colors.muted, fontSize: font.small, marginTop: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.input,
    marginTop: space.lg,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  noResult: { color: colors.muted, fontSize: font.body, textAlign: 'center', marginTop: space.xxxl },
  info: { alignItems: 'center', gap: 3, marginTop: space.xl },
  infoText: { color: colors.faint, fontSize: font.caption, textAlign: 'center' },
}));
