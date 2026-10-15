import { compareVersions } from '@diskort/shared';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Updates from 'expo-updates';
import { Linking, Platform } from 'react-native';
import { create } from 'zustand';
import { APP_VERSION, NATIVE_VERSION } from '../version';
import { DEFAULT_SERVER_URL } from '../stores/settings';
import { colors } from '../theme';

/**
 * Android güncellemeleri, masaüstündeki gibi zorunlu ve iki katmanlı:
 * 1. Kablosuz (OTA): yalnızca arayüz (JavaScript) değiştiyse birkaç MB'lık imzalı paket kendi
 *    sunucumuzdan iner ve uygulama kendini yeniden başlatır. Kullanıcı bir şey yapmaz.
 * 2. APK: yerel kısım (Android kodu, kütüphaneler) değiştiyse telefona uygun APK (arm64 / armv7) iner
 *    ve Android'in kurulum ekranı açılır. Android sessiz kuruluma izin vermez; son onay kullanıcıdadır.
 *
 * iOS'ta 1. aynıdır (kendi OTA adresi: /updates/expo/ios). 2. yerine yeni IPA (Ad Hoc) kendi sitemizden
 * "itms-services" bağlantısıyla kurulur: iOS "Diskort yüklensin mi?" diye sorar, uygulama kapanıp güncellenir.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; received: number; total: number }
  | { kind: 'ready'; version: string; uri: string }
  | { kind: 'error'; version: string; message: string };

export type OtaStatus =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string }
  /** İndirildi; uygulama yeniden başlayınca devreye girer */
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; version: string; message: string };

interface UpdateStore {
  /** APK güncellemesi */
  status: UpdateStatus;
  ota: OtaStatus;
  /** Zorunlu güncelleme arandı ama bu telefon için bulunamadı */
  notFound: boolean;
}

export const useAppUpdate = create<UpdateStore>()(() => ({
  status: { kind: 'idle' },
  ota: { kind: 'idle' },
  notFound: false,
}));

const CHECK_THROTTLE_MS = 10 * 60_000;
/** Açılışta sunucu bu kadar sürede yanıt vermezse beklemeden açılır (ör. internet yok) */
const LAUNCH_CHECK_TIMEOUT_MS = 4000;
let lastCheck = 0;
let checking: Promise<boolean> | null = null;

const otaEnabled = (): boolean => !__DEV__ && Updates.isEnabled;

// ——— Kablosuz (OTA) güncelleme ———

/** Sunucuda bu telefona uygun, çalışandan yeni bir arayüz varsa sürümünü döner. */
async function findOta(): Promise<string | null> {
  if (!otaEnabled()) return null;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable || !result.manifest) return null;
    const version = (result.manifest as { extra?: { expoClient?: { version?: string } } }).extra?.expoClient?.version;
    // Test APK'ları kendi içindeki daha yeni arayüzü eski bir sürümle değiştirmesin
    return version && compareVersions(version, APP_VERSION) > 0 ? version : null;
  } catch {
    return null;
  }
}

/** Arayüz paketini indirir. `apply`: indirince hemen yeniden başlat. */
async function downloadOta(version: string, apply: boolean): Promise<boolean> {
  useAppUpdate.setState({ ota: { kind: 'downloading', version } });
  try {
    const result = await Updates.fetchUpdateAsync();
    if (!result.isNew) throw new Error('Güncelleme paketi alınamadı.');
    useAppUpdate.setState({ ota: { kind: 'downloaded', version } });
    if (apply) await applyOta();
    return true;
  } catch (err) {
    useAppUpdate.setState({
      ota: { kind: 'error', version, message: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

let beforeReload: (() => Promise<void>) | null = null;
/** Yeniden yüklemeden önce bu kadar beklenir; sesten çıkış takılırsa güncelleme yine uygulanır (ms) */
const BEFORE_RELOAD_MAX_MS = 4000;

/**
 * Yeniden yüklemeden hemen önce çalışacak işlev (uygulama kurulumunda verilir: sesten çıkma). JS yeniden
 * yüklenince eski LiveKit odası ve ön plan servisi kendiliğinden kapanmıyor: sunucu aynı kimlikle ikinci bir
 * katılımcı görüyor (DUPLICATE_IDENTITY), telefonun sesi herkese kesik gidiyor ve uygulama silinip
 * kurulana dek düzelmiyordu (0.11.2 OTA, 2026-10-15).
 */
export function setBeforeReload(fn: (() => Promise<void>) | null): void {
  beforeReload = fn;
}

/** İndirilmiş arayüzle uygulamayı yeniden başlatır (bir iki saniye sürer). Önce sesten çıkılır. */
export async function applyOta(): Promise<void> {
  if (useAppUpdate.getState().ota.kind !== 'downloaded') return;
  if (beforeReload) {
    await Promise.race([
      beforeReload().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, BEFORE_RELOAD_MAX_MS)),
    ]);
  }
  await Updates.reloadAsync({
    reloadScreenOptions: { backgroundColor: colors.rail, spinner: { color: colors.head }, fade: true },
  });
}

/**
 * Açılış güncelleyicisi (masaüstündeki gibi): yeni arayüz varsa uygulama açılmadan indirip yeniden
 * başlatır; yoksa ya da sunucuya ulaşılamazsa beklemeden devam eder.
 */
export async function updateOnLaunch(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), LAUNCH_CHECK_TIMEOUT_MS);
  });
  const version = await Promise.race([findOta(), timedOut]);
  clearTimeout(timer);
  // Sunucu yavaşsa uygulama açılsın; uygulama öne geldiğinde yeniden denenir
  if (version === 'timeout') return;
  lastCheck = Date.now();
  if (version) await downloadOta(version, true);
  else void checkApk();
}

// ——— Denetim ———

/**
 * Yeni sürüm var mı? Önce kablosuz güncelleme (arka planda indirilir, üstteki şeritten ya da
 * bir sonraki açılışta uygulanır), yoksa yeni APK. Bir şey bulunursa true döner.
 */
export function checkForUpdate(force = false): Promise<boolean> {
  if (!force && Date.now() - lastCheck < CHECK_THROTTLE_MS) return Promise.resolve(false);
  const { status, ota } = useAppUpdate.getState();
  if (ota.kind === 'downloading' || ota.kind === 'downloaded') return Promise.resolve(true);
  if (status.kind === 'downloading' || status.kind === 'ready') return Promise.resolve(true);
  checking ??= (async () => {
    try {
      const otaVersion = await findOta();
      if (otaVersion) return await downloadOta(otaVersion, false);
      return await checkApk();
    } finally {
      lastCheck = Date.now();
      checking = null;
    }
  })();
  return checking;
}

/** Zorunlu güncelleme ekranı: ne bulunursa hemen uygular; bulunamazsa ekranda nedenini gösterir. */
export async function resolveRequiredUpdate(): Promise<void> {
  useAppUpdate.setState({ notFound: false });
  const found = await checkForUpdate(true);
  const { ota } = useAppUpdate.getState();
  if (ota.kind === 'downloaded') await applyOta();
  else if (!found) useAppUpdate.setState({ notFound: true });
}

// ——— APK güncellemesi ———

const IOS = Platform.OS === 'ios';

/** iOS'ta yeni IPA'yı kuran bağlantı (sunucu imzalı IPA'nın kurulum bildirimini üretir) */
const iosInstallUrl = (): string =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(`${DEFAULT_SERVER_URL}/download/ios/manifest.plist`)}`;

/** Telefona uygun APK: günümüz telefonları arm64, eskiler armv7; bilinmiyorsa hepsini içeren APK. */
function apkName(version: string): string {
  const abis = Device.supportedCpuArchitectures ?? [];
  const abi = abis.includes('arm64-v8a') ? 'arm64-v8a' : abis.includes('armeabi-v7a') ? 'armeabi-v7a' : null;
  return abi ? `Diskort-${version}-android-${abi}.apk` : `Diskort-${version}-android.apk`;
}

/** Sunucuya en son APK (iOS'ta IPA) sürümünü sorar; yüklü olandan yeniyse durumu "available" yapar. */
async function checkApk(): Promise<boolean> {
  try {
    const res = await fetch(`${DEFAULT_SERVER_URL}/api/client/version?platform=${IOS ? 'ios' : 'android'}`, {
      headers: { 'Cache-Control': 'no-store' },
    });
    if (!res.ok) return false;
    const { latest } = (await res.json()) as { latest: string | null };
    if (latest && compareVersions(latest, NATIVE_VERSION) > 0) {
      useAppUpdate.setState({ status: { kind: 'available', version: latest } });
      return true;
    }
  } catch {
    // internet yoksa sessizce geç; bir sonraki açılışta tekrar denenir
  }
  return false;
}

let download: FileSystem.DownloadResumable | null = null;

/** Kurulmuş (ya da artık eski) sürümlerin indirilen APK'larını siler. */
export async function cleanupDownloads(): Promise<void> {
  if (IOS) return;
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    for (const name of await FileSystem.readDirectoryAsync(dir)) {
      const version = /^Diskort-(\d+\.\d+\.\d+)-android.*\.apk$/.exec(name)?.[1];
      if (version && compareVersions(version, NATIVE_VERSION) <= 0) {
        await FileSystem.deleteAsync(dir + name, { idempotent: true });
      }
    }
  } catch {
    // önemli değil
  }
}

/** APK'yı indirir ve kurulum ekranını açar. */
export async function installUpdate(): Promise<void> {
  const status = useAppUpdate.getState().status;
  if (status.kind === 'idle' || status.kind === 'downloading') return;
  const version = status.version;
  if (IOS) {
    // Kurulumu iOS yapar; indirme ilerlemesi uygulamaya gelmez. Bağlantı yeniden açılabilsin diye "ready".
    useAppUpdate.setState({ status: { kind: 'ready', version, uri: iosInstallUrl() } });
    try {
      await Linking.openURL(iosInstallUrl());
    } catch (err) {
      useAppUpdate.setState({
        status: { kind: 'error', version, message: err instanceof Error ? err.message : String(err) },
      });
    }
    return;
  }
  if (status.kind === 'ready') {
    await openInstaller(version, status.uri);
    return;
  }

  const file = `${FileSystem.cacheDirectory}${apkName(version)}`;
  useAppUpdate.setState({ status: { kind: 'downloading', version, received: 0, total: 0 } });
  try {
    // Önceki denemelerden kalan eski APK'ları temizle
    await FileSystem.deleteAsync(file, { idempotent: true });
    download = FileSystem.createDownloadResumable(
      `${DEFAULT_SERVER_URL}/updates/${apkName(version)}`,
      file,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) =>
        useAppUpdate.setState({
          status: { kind: 'downloading', version, received: totalBytesWritten, total: totalBytesExpectedToWrite },
        }),
    );
    const result = await download.downloadAsync();
    download = null;
    if (!result || result.status !== 200) throw new Error(`İndirme başarısız (${result?.status ?? 'yanıt yok'}).`);
    useAppUpdate.setState({ status: { kind: 'ready', version, uri: result.uri } });
    await openInstaller(version, result.uri);
  } catch (err) {
    download = null;
    const message = err instanceof Error ? err.message : String(err);
    useAppUpdate.setState({
      status: {
        kind: 'error',
        version,
        message: /network|timeout|unable to resolve|failed to connect/i.test(message)
          ? 'İnternet bağlantısı yok ya da sunucuya ulaşılamıyor.'
          : message,
      },
    });
  }
}

async function openInstaller(version: string, uri: string): Promise<void> {
  try {
    const contentUri = await FileSystem.getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      // FLAG_GRANT_READ_URI_PERMISSION: kurulum ekranı dosyayı okuyabilsin
      flags: 1,
    });
  } catch (err) {
    useAppUpdate.setState({
      status: { kind: 'error', version, message: err instanceof Error ? err.message : String(err) },
    });
  }
}
