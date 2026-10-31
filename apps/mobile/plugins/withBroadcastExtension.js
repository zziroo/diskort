// iOS ekran yayını için Broadcast Upload Extension hedefi (bkz. docs/ios.md, "Ekran yayını"). Hedef her
// `expo prebuild`de yeniden oluşur; ios/ klasörü depoda değil, elle Xcode değişikliği kalıcı olmaz.
//
// - Eklenti kaynakları: modules/screen-broadcast/ios/extension/ (parmak izine yalnızca modülün ios/ klasörü girer;
//   Pod'un source_files'ı alt klasörü almaz), prebuild ios/DiskortBroadcast/ içine kopyalar. Info.plist ve yetki dosyası App Group'u DISKORT_APP_GROUP derleme
//   ayarından okur.
// - Info.plist: RTCAppGroupIdentifier (WebRTC soketi bu kapsayıcıda açar), RTCScreenSharingExtension (seçicide
//   önceden seçili eklenti).
// - Ana uygulama da aynı App Group'ta olmalı. CI imzayı ayrıca kurar (.github/workflows/ios.yml) ve sonucu
//   denetler (scripts/check-ios-project.sh).
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'DiskortBroadcast';
const SWIFT_FILE = 'SampleHandler.swift';
const INFO_FILE = 'Info.plist';
const ENTITLEMENTS_FILE = `${TARGET}.entitlements`;
const SOURCE_DIR = join(__dirname, '..', 'modules', 'screen-broadcast', 'ios', 'extension');

const extensionId = (bundleId) => `${bundleId}.broadcast`;
const appGroup = (bundleId) => `group.${bundleId}`;

function copySources(iosRoot) {
  const dir = join(iosRoot, TARGET);
  mkdirSync(dir, { recursive: true });
  for (const file of [SWIFT_FILE, INFO_FILE, ENTITLEMENTS_FILE]) copyFileSync(join(SOURCE_DIR, file), join(dir, file));
}

function addTarget(project, { bundleId, version, buildNumber }) {
  const mainTarget = project.getFirstTarget();
  const mainConfigs = project.pbxXCConfigurationList()[mainTarget.firstTarget.buildConfigurationList];
  const mainSettings = project.pbxXCBuildConfigurationSection()[mainConfigs.buildConfigurations[0].value].buildSettings;

  // xcode paketi bu bölümleri kendisi oluşturmuyor; Expo'nun şablonunda yoklar
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};

  const target = project.addTarget(TARGET, 'app_extension', TARGET, extensionId(bundleId));
  const files = [SWIFT_FILE, INFO_FILE, ENTITLEMENTS_FILE];
  const group = project.addPbxGroup(files, TARGET, TARGET);
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase([SWIFT_FILE], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);

  const configs = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const settings = configs[key].buildSettings;
    if (settings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
    Object.assign(settings, {
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${ENTITLEMENTS_FILE}"`,
      CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
      DISKORT_APP_GROUP: `"${appGroup(bundleId)}"`,
      ENABLE_BITCODE: 'NO',
      INFOPLIST_FILE: `"${TARGET}/${INFO_FILE}"`,
      IPHONEOS_DEPLOYMENT_TARGET: mainSettings.IPHONEOS_DEPLOYMENT_TARGET,
      MARKETING_VERSION: `"${version}"`,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: mainSettings.TARGETED_DEVICE_FAMILY,
    });
  }
}

module.exports = function withBroadcastExtension(config) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error('withBroadcastExtension: ios.bundleIdentifier gerekli');

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.RTCAppGroupIdentifier = appGroup(bundleId);
    cfg.modResults.RTCScreenSharingExtension = extensionId(bundleId);
    return cfg;
  });
  config = withEntitlementsPlist(config, (cfg) => {
    const groups = new Set(cfg.modResults['com.apple.security.application-groups'] ?? []);
    groups.add(appGroup(bundleId));
    cfg.modResults['com.apple.security.application-groups'] = [...groups];
    return cfg;
  });
  return withXcodeProject(config, (cfg) => {
    const iosRoot = cfg.modRequest.platformProjectRoot;
    if (!existsSync(join(SOURCE_DIR, SWIFT_FILE))) throw new Error(`withBroadcastExtension: ${SOURCE_DIR} eksik`);
    copySources(iosRoot);
    // prebuild var olan ios/ klasörüyle yeniden çalışırsa hedef ikinci kez eklenmez
    const targets = Object.values(cfg.modResults.pbxNativeTargetSection());
    if (!targets.some((t) => String(t.name).replace(/"/g, '') === TARGET)) {
      addTarget(cfg.modResults, { bundleId, version: cfg.version, buildNumber: cfg.ios?.buildNumber ?? '1' });
    }
    return cfg;
  });
};
