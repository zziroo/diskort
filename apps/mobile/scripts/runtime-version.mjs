// Uygulamanın yerel (Java/Kotlin/C++) kısmının parmak izi: expo-updates "runtimeVersion".
// Yalnızca yerel bağımlılıklar, yapılandırma eklentileri ve modules/ değişince değişir; sürüm numarası ya da
// JavaScript değişiklikleri değiştirmez. Aynı parmak izli APK'lar kablosuz (OTA) güncelleme alabilir;
// parmak izi değişince yeni APK gerekir (CI bunu kendiliğinden algılar).
//
//   node scripts/runtime-version.mjs [--platform android|ios] [--debug]
// Her platformun parmak izi ayrıdır (iOS: Pod'lar ve iOS yerel modülleri; Android: Gradle tarafı).
import { createFingerprintAsync, SourceSkips } from '@expo/fingerprint';

const platformIndex = process.argv.indexOf('--platform');
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : 'android';
if (platform !== 'android' && platform !== 'ios') throw new Error(`Geçersiz --platform: ${platform}`);

/**
 * Yalnızca Android'in derlemesini etkileyen ayarlar iOS parmak izine girmez. @expo/fingerprint uygulama
 * yapılandırmasının tamamını (eklentilerin ayarlarıyla birlikte) iki platformun parmak izine de katar; Android'in
 * en düşük sürümü (expo-build-properties → android.minSdkVersion, yalnızca gradle.properties'e yazılır)
 * değişince iOS'un yerel kısmı değişmediği halde iOS parmak izi de değişir ve bütün iPhone'lara yeni IPA
 * gerekirdi. Buraya yalnızca iOS derlemesine hiçbir etkisi olmayan ayarlar eklenir.
 */
const ANDROID_ONLY_BUILD_PROPERTIES = ['minSdkVersion'];

/** iOS parmak izi için yapılandırmadan Android'e özgü derleme ayarlarını çıkarır (çözülemezse dokunmaz) */
function withoutAndroidOnlySettings(contents) {
  try {
    const config = JSON.parse(String(contents));
    const entry = config.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties');
    const android = entry?.[1]?.android;
    if (!android) return contents;
    for (const key of ANDROID_ONLY_BUILD_PROPERTIES) delete android[key];
    return JSON.stringify(config);
  } catch {
    return contents;
  }
}

function transform(source, chunk) {
  if (platform !== 'ios' || source.type !== 'contents') return chunk;
  if (source.id === 'expoConfig') return withoutAndroidOnlySettings(chunk);
  return chunk;
}

const fingerprint = await createFingerprintAsync(process.cwd(), {
  platforms: [platform],
  sourceSkips:
    SourceSkips.ExpoConfigVersions |
    SourceSkips.ExpoConfigRuntimeVersionIfString |
    SourceSkips.PackageJsonScriptsAll,
  fileHookTransform: transform,
  silent: true,
});

if (process.argv.includes('--debug')) {
  for (const source of fingerprint.sources) console.error(source.type, 'id' in source ? source.id : '', source.hash);
}
process.stdout.write(`native-${fingerprint.hash.slice(0, 16)}`);
