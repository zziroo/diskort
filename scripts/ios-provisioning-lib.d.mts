// scripts/ios-provisioning-lib.mjs için türler (sunucu testleri TypeScript'ten içe aktarır)

export interface AscResource {
  type?: string;
  id: string;
  attributes: Record<string, any>;
}

export interface RequestedDevice {
  udid: string;
  name: string;
}

export declare const ASC_BASE: string;
export declare const DEFAULT_BUNDLE_ID: string;
export declare const BROADCAST_BUNDLE_ID: string;
export declare const AUTO_PROFILE_PREFIX: string;
export declare function autoProfilePrefix(bundleIdentifier?: string): string;
export declare function base64url(input: string | Buffer): string;
export declare function jwtHeader(keyId: string): { alg: 'ES256'; kid: string; typ: 'JWT' };
export declare function jwtClaims(issuerId: string, nowSec: number): { iss: string; iat: number; exp: number; aud: string };
export declare function makeJwt(opts: { keyId: string; issuerId: string; privateKey: string; now?: number }): string;
export declare function normalizeUdid(udid: string): string;
export declare function maskUdid(udid: string): string;
export declare function deviceName(name: unknown): string;
export declare function neutralDeviceName(udid: string): string;
export declare function parseDevices(input: string | null | undefined): RequestedDevice[];
export declare function diffDevices(
  requested: RequestedDevice[],
  existing: AscResource[],
): { toRegister: RequestedDevice[]; toEnable: AscResource[]; present: AscResource[] };
export declare function profileDevices(devices: AscResource[]): AscResource[];
export declare function sameIds(a: string[], b: string[]): boolean;
export declare function matchCertificate(certificates: AscResource[], certPem: string): AscResource | null;
export declare function autoProfileName(now?: Date, bundleIdentifier?: string): string;
export declare function registerDeviceBody(d: { udid: string; name: string | null }): unknown;
export declare function enableDeviceBody(id: string): unknown;
export declare function createProfileBody(opts: { name: string; bundleIdId: string; certificateId: string; deviceIds: string[] }): unknown;

export declare class AscError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, method: string, path: string, body: unknown);
}

export declare class AscClient {
  constructor(opts: { token: () => string; fetch?: typeof fetch; base?: string; dryRun?: boolean });
  request(method: string, path: string, body?: unknown): Promise<any>;
  all(path: string): Promise<AscResource[]>;
}

export interface SyncResult {
  profileContent: string | null;
  profileName: string | null;
  reused: boolean;
  registered: string[];
  enabled: string[];
  deviceCount: number;
  deleted: string[];
  plan: string[];
}

export declare function syncProfile(opts: {
  client: AscClient;
  bundleIdentifier?: string;
  /** Bu App Group'u içermeyen eski profil yeniden kullanılmaz */
  requiredAppGroup?: string;
  certPem: string;
  devices?: RequestedDevice[];
  dryRun?: boolean;
  now?: Date;
  log?: (msg: string) => void;
  /** Yeni cihazın Apple listesinde açık görünmesini beklerken (testlerde anında) */
  sleep?: (ms: number) => Promise<void>;
}): Promise<SyncResult>;
