// App Store Connect API ile iOS Ad Hoc dağıtım profilinin otomatik yenilenmesi (bkz. docs/ios.md).
// Bağımlılık yok: JWT (ES256) node:crypto ile imzalanır, istekler fetch ile gider. Komut satırı:
// scripts/ios-provisioning.mjs. Testler: apps/server/test/iosProvisioning.test.ts
import { createHash, createPrivateKey, sign, X509Certificate } from 'node:crypto';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com';
export const DEFAULT_BUNDLE_ID = 'com.diskort.app';
/** Ekran yayını eklentisinin App ID'si; uygulamayla aynı imzayı, ayrı profili kullanır */
export const BROADCAST_BUNDLE_ID = 'com.diskort.app.broadcast';
/** Betiğin oluşturduğu profillerin adı bununla başlar; yalnızca bunlar yeniden kullanılır ya da silinir */
export const AUTO_PROFILE_PREFIX = 'Diskort Ad Hoc otomatik';
const BROADCAST_PROFILE_PREFIX = 'Diskort Yayin Ad Hoc otomatik';
/** Ad Hoc profile girebilecek cihaz sınıfları (saat, TV, Mac dışarıda) */
const PROFILE_DEVICE_CLASSES = new Set(['IPHONE', 'IPAD', 'IPOD']);
/** Bundan kısa süre sonra bitecek profil yeniden kullanılmaz */
const MIN_VALID_MS = 30 * 86_400_000;
/** Yeni kaydedilen cihazın Apple listesinde açık görünmesi için bekleme: en çok 12 × 15 sn */
const SETTLE_TRIES = 12;
const SETTLE_DELAY_MS = 15_000;
/** Apple, JWT'nin en çok 20 dakika geçerli olmasına izin veriyor */
const JWT_LIFETIME_SEC = 15 * 60;

const UDID_RE = /^([0-9A-F]{40}|[0-9A-F]{8}-[0-9A-F]{16})$/;

export const base64url = (input) => Buffer.from(input).toString('base64url');

export function jwtHeader(keyId) {
  return { alg: 'ES256', kid: keyId, typ: 'JWT' };
}

export function jwtClaims(issuerId, nowSec) {
  return { iss: issuerId, iat: nowSec, exp: nowSec + JWT_LIFETIME_SEC, aud: 'appstoreconnect-v1' };
}

/** App Store Connect belirteci: ES256 imza, JOSE biçiminde (r||s, 64 bayt) */
export function makeJwt({ keyId, issuerId, privateKey, now = Date.now() }) {
  const head = base64url(JSON.stringify(jwtHeader(keyId)));
  const body = base64url(JSON.stringify(jwtClaims(issuerId, Math.floor(now / 1000))));
  const key = createPrivateKey(privateKey);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${base64url(signature)}`;
}

export const normalizeUdid = (udid) => String(udid).trim().toUpperCase();

/** Günlüklerde (depo herkese açık) UDID'nin yalnızca son 4 karakteri */
export const maskUdid = (udid) => `…${udid.slice(-4)}`;

/** Apple'daki cihaz adı: en çok 50 karakter, denetim karakteri yok */
export function deviceName(name) {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 50);
  return clean || 'iPhone';
}

/** Ad verilmemiş cihazın Apple'daki adı: kimliği ele vermeyen, UDID'den türeyen sabit ad */
export const neutralDeviceName = (udid) => `Diskort-${createHash('sha256').update(normalizeUdid(udid)).digest('hex').slice(0, 6)}`;

/**
 * `--devices` değeri: JSON dizisi ([{"udid":"…","name":"…"}] ya da ["UDID", …]) veya virgülle ayrılmış
 * "UDID" / "UDID=Ad" listesi. Geçersiz UDID hata verir; aynı UDID bir kez alınır.
 */
export function parseDevices(input) {
  const text = String(input ?? '').trim();
  if (!text) return [];
  let items;
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('--devices bir JSON dizisi olmalı');
    items = parsed.map((d) => (typeof d === 'string' ? { udid: d, name: null } : { udid: d?.udid, name: d?.name ?? null }));
  } else {
    items = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('=');
        return i < 0 ? { udid: s, name: null } : { udid: s.slice(0, i), name: s.slice(i + 1) };
      });
  }
  const seen = new Map();
  for (const item of items) {
    const udid = normalizeUdid(item.udid ?? '');
    if (!UDID_RE.test(udid)) throw new Error(`Geçersiz UDID: ${String(item.udid).slice(0, 60)}`);
    if (!seen.has(udid)) seen.set(udid, { udid, name: item.name ? deviceName(item.name) : neutralDeviceName(udid) });
  }
  return [...seen.values()];
}

/**
 * İstenen cihazlar ile Apple'da kayıtlı olanların farkı: kaydedilecekler, yeniden açılacaklar
 * (DISABLED) ve zaten açık olanlar.
 */
export function diffDevices(requested, existing) {
  const byUdid = new Map(existing.map((d) => [normalizeUdid(d.attributes.udid), d]));
  const toRegister = [];
  const toEnable = [];
  const present = [];
  for (const r of requested) {
    const found = byUdid.get(r.udid);
    if (!found) toRegister.push(r);
    else if (found.attributes.status !== 'ENABLED') toEnable.push(found);
    else present.push(found);
  }
  return { toRegister, toEnable, present };
}

/** Profile girecek cihazlar: açık (ENABLED) iPhone/iPad/iPod'lar, kimliğe göre sıralı */
export function profileDevices(devices) {
  return devices
    .filter((d) => d.attributes.status === 'ENABLED' && (!d.attributes.deviceClass || PROFILE_DEVICE_CLASSES.has(d.attributes.deviceClass)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const sameIds = (a, b) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const stripSerial = (s) => String(s ?? '').replace(/[^0-9a-fA-F]/g, '').replace(/^0+/, '').toUpperCase();

/**
 * p12'deki sertifikanın Apple'daki kaydı: önce DER baytları (certificateContent), yoksa seri numarası.
 * `certPem` birden çok sertifika içerebilir (anahtar zincirinden çıkan); herhangi biri eşleşirse yeter.
 */
export function matchCertificate(certificates, certPem) {
  const blocks = String(certPem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new Error('Sertifika (PEM) okunamadı');
  const local = blocks.map((pem) => new X509Certificate(pem));
  for (const cert of certificates) {
    const content = cert.attributes.certificateContent;
    if (content && local.some((l) => l.raw.equals(Buffer.from(content, 'base64')))) return cert;
  }
  for (const cert of certificates) {
    const serial = stripSerial(cert.attributes.serialNumber);
    if (serial && local.some((l) => stripSerial(l.serialNumber) === serial)) return cert;
  }
  return null;
}

/** Her App ID'nin otomatik profilleri ayrı adla tutulur: biri yenilenirken ötekinin profili silinmesin */
export const autoProfilePrefix = (bundleIdentifier = DEFAULT_BUNDLE_ID) =>
  bundleIdentifier === BROADCAST_BUNDLE_ID ? BROADCAST_PROFILE_PREFIX : AUTO_PROFILE_PREFIX;

/** Yeni profilin adı: dakikasına kadar tarih (Apple aynı adı iki profile vermiyor) */
export function autoProfileName(now = new Date(), bundleIdentifier = DEFAULT_BUNDLE_ID) {
  const p = (n) => String(n).padStart(2, '0');
  return `${autoProfilePrefix(bundleIdentifier)} ${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

// ---------- İstek gövdeleri ----------

export function registerDeviceBody({ udid, name }) {
  return { data: { type: 'devices', attributes: { name: deviceName(name), platform: 'IOS', udid } } };
}

export function enableDeviceBody(id) {
  return { data: { type: 'devices', id, attributes: { status: 'ENABLED' } } };
}

export function createProfileBody({ name, bundleIdId, certificateId, deviceIds }) {
  return {
    data: {
      type: 'profiles',
      attributes: { name, profileType: 'IOS_APP_ADHOC' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleIdId } },
        certificates: { data: [{ type: 'certificates', id: certificateId }] },
        devices: { data: deviceIds.map((id) => ({ type: 'devices', id })) },
      },
    },
  };
}

// ---------- API istemcisi ----------

export class AscError extends Error {
  constructor(status, method, path, body) {
    const detail = body?.errors?.map((e) => e.detail || e.title).filter(Boolean).join('; ');
    super(`App Store Connect ${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export class AscClient {
  /**
   * @param {{ token: () => string, fetch?: typeof fetch, base?: string, dryRun?: boolean }} opts
   * dryRun: değiştiren istekler (POST/PATCH/DELETE) gönderilmez, hata verir.
   */
  constructor({ token, fetch: fetchImpl = globalThis.fetch, base = ASC_BASE, dryRun = false }) {
    this.token = token;
    this.fetch = fetchImpl;
    this.base = base;
    this.dryRun = dryRun;
  }

  async request(method, path, body) {
    if (this.dryRun && method !== 'GET') throw new Error(`Deneme kipinde değiştiren istek gönderilmez: ${method} ${path}`);
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new AscError(res.status, method, path.replace(this.base, ''), json);
    return json;
  }

  /** Sayfalı liste: links.next izlenir */
  async all(path) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < 50; page++) {
      const res = await this.request('GET', next);
      out.push(...(res?.data ?? []));
      next = res?.links?.next ?? null;
    }
    return out;
  }
}

// ---------- Akış ----------

/**
 * Cihazları kaydeder ve tüm açık iOS cihazlarını içeren bir Ad Hoc profili hazırlar.
 * Önceki otomatik profil hâlâ geçerliyse ve cihaz listesi aynıysa o kullanılır; yoksa yenisi oluşturulur,
 * eski otomatik profiller silinir (elle oluşturulanlara dokunulmaz). `requiredAppGroup` verilirse o App Group'u
 * içermeyen profil yeniden kullanılmaz (App ID'ye sonradan eklendiyse eski profilde yoktur).
 *
 * @returns {Promise<{ profileContent: string | null, profileName: string | null, reused: boolean,
 *   registered: string[], enabled: string[], deviceCount: number, deleted: string[], plan: string[] }>}
 */
export async function syncProfile({
  client,
  bundleIdentifier = DEFAULT_BUNDLE_ID,
  requiredAppGroup,
  certPem,
  devices = [],
  dryRun = false,
  now = new Date(),
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const plan = [];
  const note = (msg) => {
    plan.push(msg);
    log(msg);
  };

  // Paket kimliği
  const bundles = await client.all(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&limit=200`);
  const bundle = bundles.find((b) => b.attributes.identifier === bundleIdentifier && b.attributes.platform !== 'MAC_OS');
  if (!bundle) throw new Error(`App ID bulunamadı: ${bundleIdentifier} (Apple Developer'da oluşturulmalı; bkz. docs/ios.md, "Ekran yayını")`);

  // Sertifika
  const certificates = await client.all('/v1/certificates?limit=200');
  const cert = matchCertificate(certificates, certPem);
  if (!cert) throw new Error("p12'deki sertifika App Store Connect'te bulunamadı (iptal edilmiş ya da başka hesaba ait olabilir)");
  note(`Sertifika: ${cert.attributes.name ?? cert.id} (${cert.attributes.certificateType ?? '?'}, bitiş ${cert.attributes.expirationDate ?? '?'})`);

  // Cihazlar
  let existing = await client.all('/v1/devices?filter[platform]=IOS&limit=200');
  const diff = diffDevices(devices, existing);
  const registered = [];
  const enabled = [];
  for (const d of diff.present) note(`Zaten kayıtlı: ${maskUdid(normalizeUdid(d.attributes.udid))}`);
  for (const d of diff.toRegister) {
    note(`Kaydedilecek: ${maskUdid(d.udid)}`);
    if (dryRun) continue;
    try {
      const res = await client.request('POST', '/v1/devices', registerDeviceBody(d));
      existing.push(res.data);
      registered.push(d.udid);
    } catch (err) {
      // 409: ör. aynı anda başka bir çalıştırma kaydetti; listede varsa sorun yok
      if (!(err instanceof AscError) || err.status !== 409) throw err;
      existing = await client.all('/v1/devices?filter[platform]=IOS&limit=200');
      if (!existing.some((e) => normalizeUdid(e.attributes.udid) === d.udid)) throw err;
      registered.push(d.udid);
    }
  }
  for (const d of diff.toEnable) {
    note(`Yeniden açılacak (kapalıydı): ${maskUdid(normalizeUdid(d.attributes.udid))}`);
    if (dryRun) continue;
    const res = await client.request('PATCH', `/v1/devices/${d.id}`, enableDeviceBody(d.id));
    existing = existing.map((e) => (e.id === d.id ? res.data : e));
    enabled.push(normalizeUdid(d.attributes.udid));
  }

  // Yeni kaydedilen cihaz Apple'da hemen "açık iPhone" görünmeyebiliyor (POST yanıtı ya da ilk liste süzgeçten
  // geçmiyor); o zaman eski profil yeniden kullanılıp derleme "cihaz profilde yok" diye düşüyordu. Listeyi yeniden
  // okuyup kısa bir süre bekle; yine de görünmezse istenen (kapalı olmayan) cihazları profile zorla koy.
  const requested = new Set(devices.map((d) => d.udid));
  const isRequested = (e) => requested.has(normalizeUdid(e.attributes.udid));
  const settled = (list) => {
    const ok = new Set(profileDevices(list).map((e) => normalizeUdid(e.attributes.udid)));
    return [...registered, ...enabled].every((u) => ok.has(u));
  };
  if (!dryRun && registered.length + enabled.length > 0) {
    // Kayıt/açma yanıtlarındaki kayıtlar: yeniden okunan liste yeni cihazı henüz hiç içermeyebilir
    const touched = existing.filter((e) => [...registered, ...enabled].includes(normalizeUdid(e.attributes.udid)));
    for (let i = 0; i < SETTLE_TRIES; i++) {
      try {
        const fresh = await client.all('/v1/devices?filter[platform]=IOS&limit=200');
        existing = [...fresh, ...touched.filter((t) => !fresh.some((f) => f.id === t.id))];
        if (settled(fresh)) break;
      } catch (err) {
        note(`Cihaz listesi okunamadı, yeniden denenecek: ${err instanceof Error ? err.message : err}`);
      }
      if (i === SETTLE_TRIES - 1) note('Yeni cihazlar Apple listesinde henüz açık görünmüyor; profile yine de eklenecek');
      else await sleep(SETTLE_DELAY_MS);
    }
  }
  const forceable = (e) =>
    isRequested(e) &&
    e.attributes.status !== 'DISABLED' &&
    (!e.attributes.deviceClass || e.attributes.deviceClass === 'UNKNOWN' || PROFILE_DEVICE_CLASSES.has(e.attributes.deviceClass));
  const wanted = profileDevices(existing);
  for (const e of existing) {
    if (forceable(e) && !wanted.some((w) => w.id === e.id)) wanted.push(e);
  }
  wanted.sort((a, b) => a.id.localeCompare(b.id));
  const wantedIds = wanted.map((d) => d.id);
  if (wantedIds.length === 0) throw new Error('Apple hesabında açık iOS cihazı yok');
  note(`Profile girecek cihaz sayısı: ${wantedIds.length}${dryRun && diff.toRegister.length ? ` (+${diff.toRegister.length} kaydedilince)` : ''}`);

  // Önceki otomatik profiller
  const prefix = autoProfilePrefix(bundleIdentifier);
  const profiles = (await client.all('/v1/profiles?filter[profileType]=IOS_APP_ADHOC&limit=200')).filter((p) =>
    String(p.attributes.name ?? '').startsWith(`${prefix} `),
  );
  const hasAppGroup = (p) =>
    !requiredAppGroup || Buffer.from(p.attributes.profileContent ?? '', 'base64').includes(requiredAppGroup);
  let reuse = null;
  for (const p of profiles.sort((a, b) => String(b.attributes.name).localeCompare(String(a.attributes.name)))) {
    const valid =
      p.attributes.profileState === 'ACTIVE' && Date.parse(p.attributes.expirationDate ?? '') - now.getTime() > MIN_VALID_MS;
    if (!valid || !hasAppGroup(p)) continue;
    const [pBundle, pCerts, pDevices] = await Promise.all([
      client.request('GET', `/v1/profiles/${p.id}/bundleId`),
      client.all(`/v1/profiles/${p.id}/certificates?limit=200`),
      client.all(`/v1/profiles/${p.id}/devices?limit=200`),
    ]);
    if (
      pBundle?.data?.id === bundle.id &&
      pCerts.some((c) => c.id === cert.id) &&
      sameIds(pDevices.map((d) => d.id), wantedIds)
    ) {
      reuse = p;
      break;
    }
  }

  const base = { registered, enabled, deviceCount: wantedIds.length, plan };
  if (reuse && !(dryRun && diff.toRegister.length > 0)) {
    note(`Mevcut profil kullanılacak: ${reuse.attributes.name} (bitiş ${reuse.attributes.expirationDate})`);
    return { ...base, profileContent: reuse.attributes.profileContent ?? null, profileName: reuse.attributes.name, reused: true, deleted: [] };
  }

  const name = autoProfileName(now, bundleIdentifier);
  note(`Yeni profil oluşturulacak: ${name}`);
  const stale = profiles.map((p) => p.attributes.name);
  if (stale.length) note(`Silinecek eski otomatik profiller: ${stale.join(', ')}`);
  if (dryRun) return { ...base, profileContent: null, profileName: name, reused: false, deleted: [] };

  const created = await client.request(
    'POST',
    '/v1/profiles',
    createProfileBody({ name, bundleIdId: bundle.id, certificateId: cert.id, deviceIds: wantedIds }),
  );
  const deleted = [];
  for (const p of profiles) {
    try {
      await client.request('DELETE', `/v1/profiles/${p.id}`);
      deleted.push(p.attributes.name);
    } catch (err) {
      // Silinemeyen eski profil derlemeyi durdurmaz
      log(`Uyarı: ${p.attributes.name} silinemedi (${err.message})`);
    }
  }
  return { ...base, profileContent: created.data.attributes.profileContent, profileName: name, reused: false, deleted };
}
