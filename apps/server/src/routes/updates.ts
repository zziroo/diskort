import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { latestMobile, parsePlatform } from '../clientVersion.js';
import { sendError, type AppContext } from '../context.js';

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** electron-updater'ın kanal dosyaları: latest.yml (Windows), latest-linux.yml, latest-mac.yml */
const CHANNEL_FILE = /^latest(?:-linux(?:-arm64)?|-mac)?\.yml$/;
/** Kurulum dosyaları ve blockmap'ler adlarında sürümü taşır: Diskort-Setup-1.2.3.exe(.blockmap) */
const VERSIONED_FILE = /(?:^|[-_])v?(\d+\.\d+\.\d+)(?=[-_.])/;

/**
 * Masaüstü uygulamasının güncelleme kaynağı: https://<alan-adı>/updates/
 * 0.14.0 ve öncesi masaüstü uygulamaları yalnızca bu adresi bilir; dosyalar GitHub Releases'te durur ve buradan oraya
 * yönlendirilir. 0.14.1 ve sonrası GitHub'a doğrudan gider; bu yönlendirme eski kurulumlar içindir, yönetim panelindeki masaüstü güncelleme sayaçları da yalnız onları sayar.
 */
export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, releases, clientVersions, ota, counters } = ctx;
  const base = `https://github.com/${config.githubRepo}/releases`;

  app.get<{ Params: { file: string } }>('/updates/:file', async (req, reply) => {
    const { file } = req.params;
    if (!SAFE_FILE.test(file)) return sendError(reply, 404, 'not_found', 'Dosya bulunamadı.');

    if (CHANNEL_FILE.test(file)) {
      // Masaüstü uygulamasının güncelleme denetimi (yönetim paneli sayacı)
      counters.inc('update.desktop.check');
      // Her zaman en son yayınlanan sürümün kanal dosyası (taslak sürümler görünmez)
      void reply.header('Cache-Control', 'no-store');
      return reply.redirect(`${base}/latest/download/${file}`, 302);
    }

    const version = VERSIONED_FILE.exec(file)?.[1];
    if (!version) return sendError(reply, 404, 'not_found', 'Dosya bulunamadı.');
    // Kurulum dosyasının kendisi (fark indirmesinin blockmap'i sayılmaz)
    if (/\.(exe|appimage|deb|dmg|zip)$/i.test(file)) counters.inc('update.desktop.download');
    // Sürümlü dosyalar değişmez; eski sürümün blockmap'i de (fark indirme) buradan bulunur
    void reply.header('Cache-Control', 'public, max-age=3600');
    return reply.redirect(`${base}/download/v${version}/${file}`, 302);
  });

  // Telefonların kablosuz (OTA) güncelleme adresi: Expo Updates protokolü, sürüm 1
  // (https://docs.expo.dev/technical-specs/expo-updates-1/). Uygulama açılırken burayı sorar; yerel kısmı
  // (runtimeVersion) aynı olan en son güncelleme varsa imzalı bildirimini alır, dosyaları /updates/'ten indirir.
  app.get<{ Params: { platform: string } }>('/updates/expo/:platform', async (req, reply) => {
    void reply
      .header('expo-protocol-version', '1')
      .header('expo-sfv-version', '0')
      .header('Cache-Control', 'private, max-age=0');
    const { platform } = req.params;
    const headerPlatform = req.headers['expo-platform'];
    if ((platform !== 'android' && platform !== 'ios') || (headerPlatform && headerPlatform !== platform)) {
      return sendError(reply, 404, 'not_found', 'Bu platform için güncelleme yok.');
    }
    counters.inc(`ota.${platform}.check`);
    const update = await ota.latest(platform);
    // 204: güncelleme yok (yerel kısmı farklı olan telefon önce yeni APK'yı / IPA'yı kurmalı)
    if (
      !update ||
      update.runtimeVersion !== req.headers['expo-runtime-version'] ||
      update.id === req.headers['expo-current-update-id']
    ) {
      return reply.code(204).send();
    }
    counters.inc(`ota.${platform}.served`);
    const boundary = `diskort-${randomUUID()}`;
    const part = (name: string, body: string, headers: Record<string, string> = {}): string =>
      [
        `--${boundary}`,
        'content-type: application/json; charset=utf-8',
        `content-disposition: form-data; name="${name}"`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        body,
        '',
      ].join('\r\n');
    const body =
      part('manifest', update.manifest, { 'expo-signature': `sig="${update.signature}", keyid="main"` }) +
      part('extensions', JSON.stringify({ assetRequestHeaders: {} })) +
      `--${boundary}--\r\n`;
    return reply.type(`multipart/mixed; boundary=${boundary}`).send(body);
  });

  // İstemcinin "güncel miyim?" sorusu (?platform=desktop|android|ios; varsayılan masaüstü)
  app.get<{ Querystring: { platform?: string } }>('/api/client/version', async (req, reply) => {
    const platform = parsePlatform(req.query.platform);
    counters.inc(`version.${platform}`);
    const [release, required] = await Promise.all([releases.latest(), clientVersions.required(platform)]);
    // Telefonda "en son": indirilecek APK'nın / IPA'nın sürümü (arayüz güncellemeleri OTA ile gelir)
    const latest =
      platform === 'desktop' ? release?.version : release ? latestMobile(release, platform).native : null;
    void reply.header('Cache-Control', 'no-store');
    return { platform, latest: latest ?? required, required };
  });
}
