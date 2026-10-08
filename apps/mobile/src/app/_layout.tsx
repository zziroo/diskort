import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { AppState, Text, View } from 'react-native';
import { router, Stack, useGlobalSearchParams, useSegments, type ErrorBoundaryProps } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { flushAcks, gateway, reportClientError, useSession } from '@diskort/client-core';
import { UpdateBanner } from '../components/UpdateBanner';
import { DialogHost } from '../components/Dialog';
import { initSkia } from '../components/cosmetics/skia';
import { GuildMenuHost } from '../components/GuildMenu';
import { CallSounds, IncomingCallHost } from '../components/IncomingCall';
import { StatusPickerHost } from '../components/StatusPicker';
import { Toast } from '../components/Toast';
import { Button } from '../components/ui';
import { UpdateScreen } from '../components/UpdateScreen';
import { describeRoute, noteCrashContext, reportPendingNativeCrashes } from '../crashReports';
import { channelFromResponse, isFriendRequestResponse, registerForPush } from '../notifications';
import { clientReady } from '../setup';
import { checkForUpdate, cleanupDownloads, updateOnLaunch, useAppUpdate } from '../update/updater';
import { showChat } from '../stores/nav';
import { useUi } from '../stores/ui';
import { colors, createStyles, useTheme } from '../theme';
import { useVoice, voice } from '../voice/voice';

void SplashScreen.preventAutoHideAsync();

/** İşlenmiş bildirim dokunuşları (bileşenden uzun yaşar: Android ekranı yeniden kurunca da hatırlanır) */
const handledNotificationResponses = new Set<string>();

/**
 * Ekran çizilirken bir hata olursa (ör. bir ekranın kodunda hata) uygulama kapanmak yerine bunu gösterir
 * ve hatayı sunucu kayıtlarına bildirir.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => reportClientError(error, 'ekran'), [error]);
  return (
    <View style={errorStyles.page}>
      <Text style={errorStyles.title}>Bir şeyler ters gitti</Text>
      <Text style={errorStyles.text}>Hata bildirildi, en kısa sürede düzeltilecek.</Text>
      <Text style={errorStyles.detail} selectable numberOfLines={4}>
        {error.message}
      </Text>
      <View style={{ alignSelf: 'stretch', marginTop: 24 }}>
        <Button title="Tekrar dene" onPress={() => void retry()} />
      </View>
    </View>
  );
}

const errorStyles = createStyles(() => ({
  page: { flex: 1, backgroundColor: colors.rail, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { color: colors.head, fontSize: 21, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.muted, fontSize: 15, textAlign: 'center', marginTop: 10 },
  detail: { color: colors.faint, fontSize: 12.5, textAlign: 'center', marginTop: 14 },
}));

/**
 * Tema değişince ekranın içeriği baştan kurulur: stiller ve renkler yeni temayla okunur. Gezinme yığını
 * (açık ekranlar, geri geçmişi) olduğu gibi kalır; ana ekranın durumu (açık sohbet, panel) stores/nav.ts'te.
 */
function ThemedScreen({ children }: { children: ReactNode }) {
  const version = useTheme((s) => s.version);
  return <Fragment key={version}>{children}</Fragment>;
}

/**
 * Açık ekranı ve ses durumunu yerel çökme raporlarının bağlamına yazar (bkz. crashReports.ts). Ayrı bileşen:
 * ekran değiştikçe kök yerleşim değil yalnızca bu yeniden çizilir.
 */
function CrashContext() {
  const route = describeRoute(useSegments(), useGlobalSearchParams());
  const inVoice = useVoice((s) => s.status !== 'idle');
  useEffect(() => noteCrashContext(route, inVoice), [route, inVoice]);
  return null;
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const themeVersion = useTheme((s) => s.version);
  const token = useSession((s) => s.token);
  const updateRequired = useUi((s) => s.updateRequired);
  const apkPending = useAppUpdate((s) => s.status.kind !== 'idle');
  const launchUpdating = useAppUpdate((s) => s.ota.kind === 'downloading' || s.ota.kind === 'downloaded');
  const inVoice = useVoice((s) => s.status !== 'idle');
  // Yeni sürüm zorunludur; ama süren sesli sohbet bölünmez, sesten çıkınca gösterilir
  const showUpdate = Boolean(updateRequired) || (apkPending && !inVoice);

  useEffect(() => {
    // Açılış güncelleyicisi: yeni arayüz varsa uygulama açılmadan iner ve uygulama yeniden başlar.
    // Sesli sohbet sürüyorsa bu gerçek bir açılış değil, Android ekranı yeniden kurmuştur: yeniden
    // başlatmak sesi keser; güncelleme sesten çıkınca uygulanır.
    void clientReady
      .catch(() => undefined)
      .then(() => (useVoice.getState().status === 'idle' ? updateOnLaunch() : undefined))
      .finally(() => setReady(true));
    void cleanupDownloads();
    const sub = AppState.addEventListener('change', (state) => {
      // Arka planda inen arayüz güncellemesi kendiliğinden uygulanmaz: üstteki şeritten (UpdateBanner)
      // kullanıcı ne zaman isterse yeniden başlatır; yoksa bir sonraki açılışta uygulanır.
      if (state === 'active') void checkForUpdate();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (ready || launchUpdating) void SplashScreen.hideAsync();
  }, [ready, launchUpdating]);

  // Önceki çalıştırmaların yerel çökmeleri (JavaScript'in göremediği) sunucuya bildirilir: açılış bittikten
  // sonra (oturum yüklü: bildirim kullanıcıyla eşleşir), çizimin dışında. Yerel modülü olmayan APK'da bir şey yapmaz.
  useEffect(() => {
    if (ready) reportPendingNativeCrashes();
  }, [ready]);

  // Skia (hareketli kozmetikler) açılış ekranını geciktirmesin: uygulama çizildikten sonra, çizimin dışında
  // bir kez kurulur; kurulamazsa ölümcül değil (bkz. skia.ts). Hazır olunca kozmetikler kendiliğinden belirir.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(initSkia, 0);
    return () => clearTimeout(timer);
  }, [ready]);

  // Oturum açılınca bu telefonu bildirimler için kaydet
  useEffect(() => {
    if (ready && token) void registerForPush();
  }, [ready, token]);

  // Bildirime dokunulunca o kanalı aç (uygulama kapalıyken açıldıysa da): ana ekranın sohbeti olur,
  // kanal başka bir sunucudaysa o sunucuya geçilir (üyeler, başlık o sunucunun olsun)
  useEffect(() => {
    if (!ready || !token) return;
    const open = (response: Notifications.NotificationResponse | null): void => {
      if (!response) return;
      // Aynı dokunuş bir kez işlenir: bileşen yeniden kurulunca ya da yeniden girişte son yanıt tekrar
      // okunur ve kullanıcı eski kanala geri atılmamalı
      const key = `${response.notification.request.identifier}:${response.notification.date}`;
      if (handledNotificationResponses.has(key)) return;
      handledNotificationResponses.add(key);
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        // eski yerel modülde yok: yukarıdaki kayıt yeter
      }
      // Arkadaşlık isteği: arkadaşlar ekranının Bekleyen sekmesi
      if (isFriendRequestResponse(response)) {
        router.navigate({ pathname: '/friends', params: { tab: 'pending', t: String(Date.now()) } });
        return;
      }
      const channelId = channelFromResponse(response);
      if (channelId) showChat(channelId);
    };
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [ready, token]);

  // Oturum açıkken gateway'e bağlan; uygulama öne gelince beklemeden yeniden bağlan.
  // Ses ve gateway bu bileşenden uzun yaşar: Android ekranı (Activity) kapatıp yeniden kurunca
  // (geri tuşu, arka planda bellek için kapatma) bu bileşen kaldırılıp baştan çizilir ama JavaScript
  // ve ön plan servisi çalışmaya devam eder. Bu yüzden sesten çıkma ve bağlantıyı kapatma bileşen
  // kaldırılırken değil, yalnızca oturum kapanınca ya da zorunlu güncellemede yapılır.
  useEffect(() => {
    if (!ready) return;
    if (!token || updateRequired) {
      if (useVoice.getState().status !== 'idle') void voice.leave();
      gateway.disconnect();
      return;
    }
    gateway.connect(); // zaten bağlıysa bir şey yapmaz
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') gateway.resume();
      // Okunanlar arka plana geçmeden sunucuya gitsin (diğer cihazlarda okunmamış kalmasın)
      else flushAcks();
      // Uygulama arka plandayken (seste değilsen) otomatik "Boşta"; elle seçilen durum değişmez
      gateway.setIdle(state === 'background' && useVoice.getState().status === 'idle');
    });
    return () => sub.remove();
  }, [ready, token, updateRequired]);

  if (!ready) {
    return launchUpdating ? (
      <SafeAreaProvider>
        <StatusBar style={colors.statusBar} />
        <UpdateScreen />
      </SafeAreaProvider>
    ) : null;
  }

  return (
    // Kaydırma hareketleri (sol panel, kaydırarak yanıtlama) için kök görünüm
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={colors.statusBar} />
        <CrashContext />
        {showUpdate ? (
          <UpdateScreen key={themeVersion} requiredVersion={updateRequired} />
        ) : (
          <>
            <Stack
              screenLayout={({ children }) => <ThemedScreen>{children}</ThemedScreen>}
              screenOptions={{
                // Başlık çubuğu içerikle aynı renkte, altında ince gölge (masaüstündeki kanal başlığı gibi)
                headerStyle: { backgroundColor: colors.main },
                headerTintColor: colors.head,
                headerTitleStyle: { fontWeight: '700', fontSize: 18 },
                headerShadowVisible: true,
                contentStyle: { backgroundColor: colors.main },
                // Önceki ekranın hafifçe geride kaldığı yumuşak kayma (react-native-screens'in kendi geçişi,
                // yerel iş parçacığında oynar). Android'in geri hareketi de aynı animasyonla geri döner.
                animation: 'ios_from_right',
                // Arkada kalan ekranlar (ör. sohbet açıkken kanal listesi) donar: ses/okunmamış
                // güncellemeleri görünmeyen ekranı yeniden çizmez, geri dönünce güncel hâliyle açılır.
                freezeOnBlur: true,
              }}
            >
              <Stack.Protected guard={Boolean(token)}>
                {/* Ana ekran: sohbet ve soldan açılan sunucu/kanal paneli */}
                <Stack.Screen name="index" options={{ headerShown: false, contentStyle: { backgroundColor: colors.main } }} />
                {/* Eski kanal bağlantıları: sohbeti seçip ana ekrana döner */}
                <Stack.Screen name="channel/[id]" options={{ headerShown: false, animation: 'none' }} />
                {/* Ses ekranı alttan yükselir; yeni mesaj seçimi alttan belirir */}
                <Stack.Screen
                  name="voice"
                  options={{
                    title: 'Ses',
                    animation: 'slide_from_bottom',
                    headerStyle: { backgroundColor: colors.deep },
                    contentStyle: { backgroundColor: colors.deep },
                  }}
                />
                <Stack.Screen name="members" options={{ title: 'Üyeler' }} />
                <Stack.Screen name="channel-panel" options={{ headerShown: false }} />
                <Stack.Screen name="search" options={{ headerShown: false, animation: 'fade_from_bottom' }} />
                <Stack.Screen name="dms" options={{ title: 'Direkt Mesajlar' }} />
                <Stack.Screen name="dm-new" options={{ title: 'Yeni mesaj', animation: 'fade_from_bottom' }} />
                <Stack.Screen name="friends" options={{ title: 'Arkadaşlar' }} />
                <Stack.Screen name="dm-rename" options={{ title: 'Grubun adı', animation: 'fade_from_bottom' }} />
                <Stack.Screen name="settings" options={{ title: 'Ayarlar' }} />
                <Stack.Screen name="ayarlar/[bolum]" options={{ title: 'Ayarlar' }} />
                <Stack.Screen name="feedback" options={{ title: 'Geri bildirim' }} />
                <Stack.Screen name="feedback-admin" options={{ title: 'Geri bildirimler (yönetim)' }} />
                <Stack.Screen name="whats-new" options={{ title: 'Yenilikler' }} />
                <Stack.Screen name="sunucu-ekle" options={{ title: 'Sunucu ekle', animation: 'fade_from_bottom' }} />
                {/* Sunucu ayarları (sunucu menüsünden): bölümler, rol ve kanal düzenleme, kanal oluşturma */}
                <Stack.Screen name="sunucu-ayarlari/index" options={{ title: 'Sunucu ayarları' }} />
                <Stack.Screen name="sunucu-ayarlari/[bolum]" options={{ title: '' }} />
                <Stack.Screen name="sunucu-ayarlari/rol/[id]" options={{ title: 'Rol' }} />
                <Stack.Screen name="sunucu-ayarlari/kanal/[id]" options={{ title: 'Kanal' }} />
                <Stack.Screen
                  name="sunucu-ayarlari/kanal-olustur"
                  options={{ title: 'Kanal oluştur', animation: 'fade_from_bottom' }}
                />
              </Stack.Protected>
              <Stack.Protected guard={!token}>
                <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: colors.rail } }} />
              </Stack.Protected>
            </Stack>
            <UpdateBanner key={`u${themeVersion}`} />
            {/* Gelen DM araması: her ekranın üstünde kart; zil ve bekleme sesi */}
            {token ? <IncomingCallHost key={`c${themeVersion}`} /> : null}
            {token ? <CallSounds /> : null}
            <Toast key={themeVersion} />
            <StatusPickerHost />
            <GuildMenuHost />
            <DialogHost />
          </>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
