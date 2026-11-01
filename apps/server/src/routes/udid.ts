import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createRateLimiter } from './messages.js';

/**
 * iPhone'ların UDID'sini toplama (Ad Hoc dağıtım için cihazlar Apple'a kaydedilmeli, bkz. docs/ios.md).
 *
 * Akış (Apple'ın "Profile Service" yöntemi): kullanıcı Safari'de /udid sayfasından profili indirir
 * (GET /api/udid/profile) → Ayarlar'dan yükler → iOS cihaz bilgilerini imzalı (PKCS#7) bir plist olarak
 * POST /api/udid/receive'e gönderir → sunucu kaydeder ve Safari'yi 301 ile /udid?udid=… sayfasına yönlendirir.
 * Profil hiçbir şey kurmaz; iOS onu bilgiler gönderildikten sonra kendisi atar.
 *
 * Kayıtlar veritabanına değil `<dataDir>/udids.jsonl` dosyasına yazılır:
 * `docker compose exec api cat /data/udids.jsonl`. Onay durumları (yönetim paneli → iPhone cihazları) ayrı
 * dosyadadır: `udid-status.json`, bkz. iosDevices.ts.
 */

/** Dosyaya en çok bu kadar kayıt yazılır (herkese açık uç; kötüye kullanım sınırı) */
export const MAX_RECORDS = 500;
const MAX_BODY_BYTES = 64 * 1024;

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Kurulacak profil: bilgileri `receiveUrl`'e gönderen "Profile Service" yükü */
export function udidProfile(receiveUrl: string, challenge: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${xmlEscape(receiveUrl)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
      <string>DEVICE_NAME</string>
    </array>
    <key>Challenge</key>
    <string>${xmlEscape(challenge)}</string>
  </dict>
  <key>PayloadOrganization</key>
  <string>Diskort</string>
  <key>PayloadDisplayName</key>
  <string>Diskort cihaz kimliği (UDID)</string>
  <key>PayloadDescription</key>
  <string>iPhone'unun UDID'sini Diskort'a gönderir; böylece Diskort uygulaması bu cihaza kurulabilir. Hiçbir ayar değiştirmez, yüklendikten sonra kendiliğinden silinir.</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>${randomUUID().toUpperCase()}</string>
  <key>PayloadIdentifier</key>
  <string>net.ziroo.diskort.udid</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
}

export interface UdidRecord {
  udid: string;
  product: string | null;
  version: string | null;
  deviceName: string | null;
  /** Sayfada girilen ad (profilin Challenge alanıyla geri gelir) */
  name: string | null;
  at: string;
}

/**
 * iOS'un gönderdiği gövdeden bilgileri çıkarır. Gövde PKCS#7 imzalı veridir ama içindeki plist düz metin
 * olarak durur; imza doğrulanmaz (UDID gizli bir bilgi değil, en kötü ihtimalle sahte bir kayıt düşer).
 */
export function parseDeviceAttributes(body: Buffer): Omit<UdidRecord, 'at'> | null {
  const text = body.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>', start);
  if (start < 0 || end < 0) return null;
  const xml = Buffer.from(text.slice(start, end + '</plist>'.length), 'latin1').toString('utf8');
  const field = (key: string): string | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]{0,200})</string>`).exec(xml);
    if (!m) return null;
    return m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim();
  };
  const udid = field('UDID');
  // 40 onaltılık (eski cihazlar) ya da 8-16 onaltılık (iPhone XS ve sonrası)
  if (!udid || !/^([0-9a-fA-F]{40}|[0-9a-fA-F]{8}-[0-9a-fA-F]{16})$/.test(udid)) return null;
  return {
    udid: udid.toUpperCase(),
    product: field('PRODUCT'),
    version: field('VERSION'),
    deviceName: field('DEVICE_NAME'),
    name: field('CHALLENGE') || null,
  };
}

export function registerUdidRoutes(app: FastifyInstance, ctx: AppContext): void {
  const file = path.join(ctx.config.dataDir, 'udids.jsonl');
  const allowProfile = createRateLimiter(20, 10 * 60_000);
  const allowReceive = createRateLimiter(10, 10 * 60_000);

  app.get('/api/udid/profile', async (req, reply) => {
    if (!allowProfile(req.ip)) return reply.code(429).type('text/plain; charset=utf-8').send('Çok fazla istek.');
    const raw = (req.query as { ad?: unknown }).ad;
    const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
    const receiveUrl = `${req.protocol}://${req.host}/api/udid/receive`;
    void reply
      .header('Content-Type', 'application/x-apple-aspen-config')
      .header('Content-Disposition', 'attachment; filename="diskort-udid.mobileconfig"')
      .header('Cache-Control', 'no-store');
    return udidProfile(receiveUrl, name);
  });

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/api/udid/receive', async (req, reply) => {
      if (!allowReceive(req.ip)) return reply.code(429).type('text/plain; charset=utf-8').send('Çok fazla istek.');
      const device = Buffer.isBuffer(req.body) ? parseDeviceAttributes(req.body) : null;
      if (!device) return reply.redirect('/udid?hata=1', 301);
      const existing = await readFile(file, 'utf8').catch(() => '');
      const lines = existing.split('\n').filter(Boolean);
      const known = lines.some((line) => line.includes(`"udid":"${device.udid}"`));
      // Liste dolu: kayıt yapılmadan "Kaydedildi" denmesin
      if (!known && lines.length >= MAX_RECORDS) {
        req.log.warn({ udid: device.udid }, 'iPhone UDID listesi dolu, kayıt yapılmadı');
        return reply.redirect('/udid?hata=dolu', 301);
      }
      if (!known) {
        const record: UdidRecord = { ...device, at: new Date().toISOString() };
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`);
        req.log.info({ udid: device.udid, product: device.product, name: device.name }, 'iPhone UDID kaydedildi');
      }
      const params = new URLSearchParams({ udid: device.udid });
      if (device.product) params.set('model', device.product);
      // Apple, profil hizmetinin yanıtında 301 bekler; Safari bu adresi açar
      return reply.redirect(`/udid?${params.toString()}`, 301);
    });
  });
}
