import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';

export interface ApnsConfig {
  /** Apple'dan indirilen .p8 anahtar dosyası */
  keyFile: string;
  keyId: string;
  teamId: string;
  /** Uygulamanın paket kimliği (apns-topic) */
  bundleId: string;
  /** Geliştirme (Xcode'dan kurulan) derlemeler için sandbox; Ad Hoc ve App Store üretim ortamındadır */
  sandbox: boolean;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

/** Tek bir HTTP/2 isteği: testlerde sahtesi verilir */
export type ApnsTransport = (
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResponse>;

interface Logger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface ApnsAlert {
  title: string;
  body: string;
  /** Bildirimde uygulamaya iletilen veri (ör. channelId) */
  data: Record<string, string>;
  /**
   * Aynı konudaki (konuşmadaki) bildirimler kilit ekranında gruplanır (thread-id); her mesaj ayrı bildirim
   * olarak kalır, yenisi eskisinin yerini almaz (apns-collapse-id kullanılmaz).
   */
  threadId?: string;
  /**
   * Aynı kimlikli yeni bildirim öncekinin yerini alır (apns-collapse-id, en çok 64 bayt). Aramalarda
   * "cevapsız arama" gelen arama bildiriminin yerine geçer; arkadaşlık isteğinde aynı kişinin yeni isteği
   * eskisinin yerine.
   */
  collapseId?: string;
}

/** Sunucu ayarında APNs anahtarı varsa istemciyi kurar; yoksa ya da okunamazsa null (iOS bildirimi kapalı). */
export function createApns(
  config: { apns: Omit<ApnsConfig, 'bundleId'> | null; iosBundleId: string },
  log: Logger,
): ApnsClient | null {
  if (!config.apns) return null;
  try {
    return new ApnsClient({ ...config.apns, bundleId: config.iosBundleId }, log);
  } catch (err) {
    log.warn({ err: String(err) }, 'APNs anahtarı okunamadı; iOS bildirimleri kapalı');
    return null;
  }
}

/**
 * iOS bildirimleri: Apple'ın APNs HTTP/2 arayüzüne doğrudan istek (Firebase gerekmez). Kimlik doğrulama
 * Apple Developer hesabındaki .p8 anahtarıyla imzalanan kısa ömürlü JWT ile yapılır.
 */
export class ApnsClient {
  private jwt: { value: string; at: number } | null = null;
  private session: http2.ClientHttp2Session | null = null;
  private readonly key: string;

  constructor(
    private readonly config: ApnsConfig,
    private readonly log: Logger,
    private readonly transport: ApnsTransport | null = null,
  ) {
    this.key = readFileSync(config.keyFile, 'utf8');
    log.info({ keyId: config.keyId, sandbox: config.sandbox }, 'iOS bildirimleri açık (APNs)');
  }

  private get origin(): string {
    return this.config.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  }

  /** Gönderir. Cihaz jetonu artık geçersizse (uygulama silinmiş) "unregistered" döner. */
  async send(token: string, alert: ApnsAlert): Promise<'ok' | 'unregistered' | 'failed'> {
    const payload = JSON.stringify({
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: 'default',
        ...(alert.threadId ? { 'thread-id': alert.threadId } : {}),
      },
      // expo-notifications veriyi "body" anahtarından okur; üst düzeyde de dursun
      body: alert.data,
      ...alert.data,
    });
    const headers: Record<string, string> = {
      authorization: `bearer ${await this.token()}`,
      'apns-topic': this.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    };
    if (alert.collapseId && Buffer.byteLength(alert.collapseId) <= 64) headers['apns-collapse-id'] = alert.collapseId;
    try {
      const res = await (this.transport ?? this.request)(this.origin, `/3/device/${token}`, headers, payload);
      if (res.status === 200) return 'ok';
      if (res.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(res.body)) {
        return 'unregistered';
      }
      // Süresi dolmuş/geçersiz JWT: bir sonrakinde yenisi imzalanır
      if (res.status === 403) this.jwt = null;
      this.log.warn({ status: res.status, body: res.body.slice(0, 300) }, 'APNs bildirimi gönderilemedi');
      return 'failed';
    } catch (err) {
      this.log.warn({ err: String(err) }, 'APNs bildirimi gönderilemedi');
      return 'failed';
    }
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  /** Apple JWT'yi 20-60 dakikada bir yenilemeyi ister; 40 dakikada bir imzalanır. */
  private async token(): Promise<string> {
    if (this.jwt && Date.now() - this.jwt.at < 40 * 60_000) return this.jwt.value;
    const key = await importPKCS8(this.key, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(key);
    this.jwt = { value, at: Date.now() };
    return value;
  }

  private readonly request: ApnsTransport = (origin, path, headers, body) =>
    new Promise((resolve, reject) => {
      if (!this.session || this.session.closed || this.session.destroyed) {
        const session = http2.connect(origin);
        session.on('error', () => undefined);
        session.on('close', () => {
          if (this.session === session) this.session = null;
        });
        // Boşta kalan bağlantı süreci açık tutmasın
        session.unref();
        this.session = session;
      }
      const req = this.session.request({ ':method': 'POST', ':path': path, ...headers });
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.on('response', (h) => {
        status = Number(h[':status']);
      });
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('end', () => resolve({ status, body: data }));
      req.on('error', reject);
      // Zaman aşımı ya da bağlantı koptu ("end" gelmeden kapandı); yanıt geldiyse etkisiz
      req.on('close', () => reject(new Error('APNs isteği yanıtsız kapandı')));
      req.end(body);
    });
}
