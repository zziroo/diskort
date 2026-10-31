// iOS Ad Hoc dağıtım profilini App Store Connect API ile hazırlar (bkz. docs/ios.md, "Otomatik cihaz ekleme").
//
//   node scripts/ios-provisioning.mjs list
//       Apple'daki iOS cihazlarını, sertifikaları ve Ad Hoc profilleri listeler (hiçbir şey değiştirmez).
//   node scripts/ios-provisioning.mjs sync --cert dagitim.pem [--devices '<JSON ya da UDID=Ad,…>' | --devices-file cihazlar.json]
//        [--out profil.mobileprovision] [--base64-out profil.b64] [--bundle-id com.diskort.app]
//        [--app-group group.com.diskort.app] [--dry-run]
//       Verilen cihazları kaydeder, tüm açık iOS cihazlarını içeren Ad Hoc profilini hazırlar ve dosyaya yazar.
//       --app-group: bu App Group'u içermeyen eski profil yeniden kullanılmaz.
//       --dry-run: yalnızca okur ve ne yapılacağını yazar (kayıt, profil oluşturma, silme yok).
//
// Anahtar ortam değişkenlerinden: ASC_KEY_ID, ASC_ISSUER_ID ve ASC_KEY_P8 (.p8 içeriği) ya da ASC_KEY_FILE
// (.p8 dosyasının yolu). Anahtar "Team Key" ve Admin rolünde olmalı (bireysel anahtarlar profil uçlarını
// kullanamaz).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AscClient, DEFAULT_BUNDLE_ID, makeJwt, normalizeUdid, parseDevices, syncProfile } from './ios-provisioning-lib.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cert: { type: 'string' },
    devices: { type: 'string', default: '' },
    'devices-file': { type: 'string' },
    out: { type: 'string' },
    'base64-out': { type: 'string' },
    'bundle-id': { type: 'string', default: DEFAULT_BUNDLE_ID },
    'app-group': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? '';
if (values.help || !['list', 'sync'].includes(command)) {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const end = lines.findIndex((l) => !l.startsWith('//'));
  console.log(lines.slice(0, end).map((l) => l.slice(3)).join('\n'));
  process.exit(values.help ? 0 : 2);
}

function fail(message) {
  console.error(`Hata: ${message}`);
  process.exit(1);
}

const keyId = process.env.ASC_KEY_ID?.trim();
const issuerId = process.env.ASC_ISSUER_ID?.trim();
let privateKey = process.env.ASC_KEY_P8?.trim();
if (!privateKey && process.env.ASC_KEY_FILE) privateKey = readFileSync(process.env.ASC_KEY_FILE, 'utf8');
if (!keyId || !issuerId || !privateKey) fail('ASC_KEY_ID, ASC_ISSUER_ID ve ASC_KEY_P8 (ya da ASC_KEY_FILE) gerekli');
// GitHub gizli değişkenine yapıştırırken satır sonları "\n" olarak kalmış olabilir
if (!privateKey.includes('\n') && privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

// Belirteç her istekte yeniden üretilir (ucuz; uzun işlemde süresi dolmaz)
const token = () => makeJwt({ keyId, issuerId, privateKey });
const dryRun = values['dry-run'] || command === 'list';
const client = new AscClient({ token, dryRun });

try {
  if (command === 'list') {
    const devices = await client.all('/v1/devices?filter[platform]=IOS&limit=200');
    console.log(`iOS cihazları (${devices.length}):`);
    for (const d of devices) {
      const a = d.attributes;
      console.log(`  ${normalizeUdid(a.udid)}  ${a.status.padEnd(8)} ${String(a.deviceClass ?? '').padEnd(8)} ${a.model ?? ''}  ${a.name}`);
    }
    const certs = await client.all('/v1/certificates?limit=200');
    console.log(`\nSertifikalar (${certs.length}):`);
    for (const c of certs) {
      const a = c.attributes;
      console.log(`  ${c.id}  ${a.certificateType}  seri ${a.serialNumber}  bitiş ${a.expirationDate}  ${a.name ?? a.displayName ?? ''}`);
    }
    const profiles = await client.all('/v1/profiles?filter[profileType]=IOS_APP_ADHOC&limit=200');
    console.log(`\nAd Hoc profilleri (${profiles.length}):`);
    for (const p of profiles) {
      const a = p.attributes;
      console.log(`  ${a.uuid}  ${a.profileState}  bitiş ${a.expirationDate}  ${a.name}`);
    }
  } else {
    if (!values.cert) fail('--cert (dağıtım sertifikası, PEM) gerekli');
    let devices;
    try {
      devices = parseDevices(values['devices-file'] ? readFileSync(values['devices-file'], 'utf8') : values.devices);
    } catch (err) {
      fail(err.message);
    }
    const certPem = readFileSync(values.cert, 'utf8');
    const result = await syncProfile({
      client,
      bundleIdentifier: values['bundle-id'],
      requiredAppGroup: values['app-group'],
      certPem,
      devices,
      dryRun,
      log: (msg) => console.log(msg),
    });
    if (dryRun) {
      console.log('\nDeneme kipi: hiçbir şey değiştirilmedi, profil yazılmadı.');
    } else {
      if (!result.profileContent) fail('Profil içeriği alınamadı');
      if (values.out) writeFileSync(values.out, Buffer.from(result.profileContent, 'base64'));
      if (values['base64-out']) writeFileSync(values['base64-out'], result.profileContent);
      console.log(
        `Profil hazır: ${result.profileName} · ${result.deviceCount} cihaz · ${result.reused ? 'yeniden kullanıldı' : 'yeni oluşturuldu'}` +
          (result.registered.length ? ` · ${result.registered.length} cihaz kaydedildi` : '') +
          (result.deleted.length ? ` · ${result.deleted.length} eski profil silindi` : ''),
      );
    }
  }
} catch (err) {
  fail(err.message);
}
