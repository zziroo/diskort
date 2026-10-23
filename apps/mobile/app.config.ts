import { existsSync } from 'node:fs';
import type { ExpoConfig } from 'expo/config';
import { version } from './package.json';

/** Android sürüm kodu her sürümde artmalı: 1.2.3 → 10203 */
function versionCode(v: string): number {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major * 10000 + minor * 100 + patch;
}

/** iOS izin metinleri (Ayarlar'da ve izin sorulurken görünür) */
const IOS_MICROPHONE = 'Diskort sesli sohbette seni karşı tarafa duyurmak için mikrofonunu kullanır.';
const IOS_CAMERA = 'Diskort kamerayı yalnızca sen bir fotoğraf ya da görüntü göndermek istediğinde kullanır.';
const IOS_PHOTOS = 'Diskort galerinden seçtiğin fotoğraf ve videoları mesaja eklemek için fotoğraflarına erişir.';

const config: ExpoConfig = {
  name: 'Diskort',
  slug: 'diskort',
  version,
  scheme: 'diskort',
  // Yayın izlerken yatay ekran için döndürmeye izin verilir
  orientation: 'default',
  icon: './assets/icon.png',
  // Sistem pencereleri (izin soruları, klavye) telefonun açık/koyu ayarını izler; uygulama kendi temasını çizer
  userInterfaceStyle: 'automatic',
  backgroundColor: '#313338',
  // iOS: Apple Developer hesabıyla "Ad Hoc" imzalanıp kendi sitemizden kurulur (bkz. docs/ios.md).
  // Paket kimliği Android'deki ile aynı.
  ios: {
    bundleIdentifier: 'com.diskort.app',
    buildNumber: String(versionCode(version)),
    supportsTablet: true,
    infoPlist: {
      NSMicrophoneUsageDescription: IOS_MICROPHONE,
      NSCameraUsageDescription: IOS_CAMERA,
      NSPhotoLibraryUsageDescription: IOS_PHOTOS,
      // Sesli sohbet uygulama arka plandayken ve ekran kilitliyken sürer (AVAudioSession, LiveKit yönetir)
      UIBackgroundModes: ['audio', 'voip'],
      // Yalnızca standart şifreleme (HTTPS, WebRTC): ihracat beyanı gerekmez
      ITSAppUsesNonExemptEncryption: false,
      CFBundleDevelopmentRegion: 'tr',
    },
  },
  android: {
    package: 'com.diskort.app',
    versionCode: versionCode(version),
    // Firebase (yalnızca bildirim teslimatı). Dosya depoda değil; CI gizli değişkenden yazar.
    googleServicesFile: existsSync('./google-services.json') ? './google-services.json' : undefined,
    adaptiveIcon: {
      backgroundColor: '#5865f2',
      foregroundImage: './assets/android-icon-foreground.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      // Uygulama içi güncelleme: indirilen yeni APK'nın kurulumunu başlatmak için
      'android.permission.REQUEST_INSTALL_PACKAGES',
      // Telefondan ekran paylaşımı (WebRTC'nin MediaProjection servisi)
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
      // Ses düğmelerinde dokunma titreşimi (src/haptics.ts). Bazı kütüphaneler de ekliyor ama açıkça
      // istenmezse hangi APK'da olduğu belirsiz kalıyor; yoksa titreşim sessizce atlanıyordu.
      'android.permission.VIBRATE',
    ],
    // Kamera henüz kullanılmıyor (WebRTC eklentisi ve resim seçici varsayılan olarak ister).
    // Dosya ve resim seçimi Android'in kendi seçicileriyle yapılır; depolama/medya izni gerekmez.
    blockedPermissions: [
      'android.permission.CAMERA',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
    ],
    predictiveBackGestureEnabled: false,
  },
  // Kablosuz (OTA) güncellemeler: JavaScript paketi kendi sunucumuzdan gelir ve imzası doğrulanır.
  // runtimeVersion = yerel kısmın parmak izi (scripts/runtime-version.mjs); CI derlemede verir.
  // Parmak izi aynı olan uygulamalar OTA alır; yerel kısım değişince yeni APK gerekir.
  runtimeVersion: process.env.DISKORT_RUNTIME_VERSION ?? 'gelistirme',
  updates: {
    url: 'https://diskort.ziroo.net/updates/expo/android',
    enabled: true,
    // Denetimi uygulama kendisi yapar (açılışta, "yeni sürüm" bildiriminde); bkz. src/update
    checkAutomatically: 'NEVER',
    fallbackToCacheTimeout: 0,
    codeSigningCertificate: './certs/certificate.pem',
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
  },
  plugins: [
    // iOS: OTA adresi ve arka plan kipleri. En başta kalmalı (bkz. eklentinin açıklaması)
    './plugins/withIos',
    'expo-router',
    ['expo-secure-store', { faceIDPermission: 'Diskort oturum bilgilerini korumak için Face ID kullanabilir.' }],
    [
      'expo-build-properties',
      {
        android: {
          // Yalnızca arm64 ve armv7: APK boyutu küçülür (x86 yalnızca emülatörlerde gerekir)
          buildArchs: ['arm64-v8a', 'armeabi-v7a'],
          // En az Android 8 (API 26): ürün kararı (desteklenen en eski telefon sürümü)
          minSdkVersion: 26,
        },
      },
    ],
    // iOS'ta ekran paylaşımı yok (Broadcast Upload Extension gerekir; bkz. docs/ios.md)
    // enableScreenShareService: telefondan ekran paylaşımı için MediaProjection ön plan servisi
    ['@livekit/react-native-expo-plugin', { android: { audioType: 'communication', enableScreenShareService: true } }],
    ['@config-plugins/react-native-webrtc', { cameraPermission: IOS_CAMERA, microphonePermission: IOS_MICROPHONE }],
    // Galeriden seçim (fotoğraf seçicisi). microphonePermission false VERİLMEMELİ: RECORD_AUDIO'yu
    // engeller ve sesli sohbet çalışmaz.
    // Buradaki metinler yalnızca iOS içindir; Android'de CAMERA izni android.blockedPermissions ile engelli kalır.
    [
      'expo-image-picker',
      { cameraPermission: IOS_CAMERA, microphonePermission: IOS_MICROPHONE, photosPermission: IOS_PHOTOS },
    ],
    // Mesajdaki videoları oynatmak için. Arka planda oynatma ve resim içinde resim kapalı: ön plan
    // servisi (FOREGROUND_SERVICE_MEDIA_PLAYBACK) izni eklenmez. Yerel modül: yeni APK gerekir; eski
    // APK'larda JavaScript modülün varlığını denetler (src/video.ts).
    ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    // expo-audio (sesli sohbet sesleri, src/sounds.ts) bilerek eklentisiz: eklentisi kilit ekranı
    // oynatıcısı için ayrı bir ön plan servisi ekliyor; kısa sesler için gerekmez.
    [
      'expo-splash-screen',
      { image: './assets/splash-icon.png', imageWidth: 120, backgroundColor: '#1e1f22', resizeMode: 'contain' },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/android-icon-monochrome.png',
        color: '#5865f2',
        defaultChannel: 'diskort-mentions',
        // iOS: Ad Hoc imzalı uygulama APNs'in üretim ortamını kullanır (aps-environment)
        mode: 'production',
      },
    ],
    './plugins/withReleaseSigning',
    './plugins/withAbiSplits',
    './plugins/withScreenShareNotification',
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
