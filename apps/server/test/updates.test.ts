import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { compareVersions, GATEWAY_CLOSE_UPDATE_REQUIRED, type GatewayServerMessage } from '@diskort/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { ReleaseService } from '../src/releases.js';

const release = (version: string) => ({
  tag_name: `v${version}`,
  published_at: '2026-09-27T10:00:00Z',
  assets: [],
});

/** Sırayla verilen GitHub yanıtlarını döndüren sahte fetch (son yanıt tekrarlanır). */
function fakeGithub(...versions: string[]) {
  let calls = 0;
  return (async () => {
    const version = versions[Math.min(calls++, versions.length - 1)]!;
    return { ok: true, status: 200, json: async () => release(version) } as Response;
  }) as typeof fetch;
}

let app: FastifyInstance | undefined;
let ctx: AppContext;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(latest: string, enforce = true, extraEnv: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: '.',
    GITHUB_REPO: 'sahip/depo',
    CLIENT_UPDATE_ENFORCE: enforce ? '1' : '0',
    ...extraEnv,
  });
  const releases = new ReleaseService('sahip/depo', fakeGithub(latest));
  ({ app, ctx } = await buildApp(config, { dbFile: ':memory:', logger: false, releases }));
  return app;
}

describe('sürüm karşılaştırma', () => {
  it('sayısal karşılaştırır, "v" ön ekini ve ekleri yok sayar', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0);
    expect(compareVersions('0.2', '0.2.1')).toBe(-1);
  });
});

describe('güncelleme adresleri', () => {
  it('kanal dosyasını en son sürüme, sürümlü dosyayı kendi sürümüne yönlendirir', async () => {
    const server = await start('0.2.0');
    const get = (file: string) => server.inject({ method: 'GET', url: `/updates/${file}` });

    const channel = await get('latest.yml?noCache=abc');
    expect(channel.statusCode).toBe(302);
    expect(channel.headers.location).toBe('https://github.com/sahip/depo/releases/latest/download/latest.yml');
    expect(channel.headers['cache-control']).toBe('no-store');
    expect((await get('latest-linux.yml')).headers.location).toContain('/latest/download/latest-linux.yml');
    expect((await get('latest-mac.yml')).headers.location).toContain('/latest/download/latest-mac.yml');

    // Fark indirme eski sürümün blockmap'ini ister: kendi sürüm etiketine gitmeli
    expect((await get('Diskort-Setup-0.1.2.exe.blockmap')).headers.location).toBe(
      'https://github.com/sahip/depo/releases/download/v0.1.2/Diskort-Setup-0.1.2.exe.blockmap',
    );
    expect((await get('Diskort-0.2.0-x86_64.AppImage')).headers.location).toBe(
      'https://github.com/sahip/depo/releases/download/v0.2.0/Diskort-0.2.0-x86_64.AppImage',
    );
    expect((await get('Diskort-0.2.0-amd64.deb')).headers.location).toContain('/download/v0.2.0/');
    // macOS otomatik güncellemesi (Squirrel.Mac) zip'i ve fark indirmesi için eski zip'in blockmap'ini ister
    expect((await get('Diskort-0.2.0-arm64.zip')).headers.location).toBe(
      'https://github.com/sahip/depo/releases/download/v0.2.0/Diskort-0.2.0-arm64.zip',
    );
    expect((await get('Diskort-0.1.2-x64.zip.blockmap')).headers.location).toBe(
      'https://github.com/sahip/depo/releases/download/v0.1.2/Diskort-0.1.2-x64.zip.blockmap',
    );

    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'readme.txt', 'latest.yaml', '.latest.yml']) {
      expect((await get(bad)).statusCode, bad).toBe(404);
    }
  });

  it('istemciye en son ve gereken sürümü söyler', async () => {
    const server = await start('0.2.0');
    expect((await server.inject({ method: 'GET', url: '/api/client/version' })).json()).toEqual({
      platform: 'desktop',
      latest: '0.2.0',
      required: '0.2.0',
    });
    await app!.close();
    const relaxed = await start('0.2.0', false);
    expect((await relaxed.inject({ method: 'GET', url: '/api/client/version' })).json().required).toBeNull();
  });
});

describe('zorunlu güncelleme', () => {
  async function identify(version: string | undefined, platform?: string) {
    const bootstrap = ctx.store.ensureBootstrapInvite()!;
    const reg = await app!.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: bootstrap.code, username: 'admin', password: 'sifre12345' },
    });
    const token = reg.json().token as string;
    await app!.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app!.server.address() as { port: number };

    return new Promise<{ messages: GatewayServerMessage[]; closeCode: number | null }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
      const messages: GatewayServerMessage[] = [];
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayServerMessage;
        messages.push(msg);
        if (msg.t === 'HELLO') ws.send(JSON.stringify({ t: 'IDENTIFY', d: { token, version, platform } }));
        if (msg.t === 'READY') {
          ws.close();
          resolve({ messages, closeCode: null });
        }
      });
      ws.on('close', (code) => resolve({ messages, closeCode: code }));
    });
  }

  it('eski istemci UPDATE_REQUIRED alır ve bağlantısı kapanır', async () => {
    await start('0.2.0');
    const { messages, closeCode } = await identify('0.1.9');
    expect(messages.at(-1)).toEqual({ t: 'UPDATE_REQUIRED', d: { version: '0.2.0' } });
    expect(closeCode).toBe(GATEWAY_CLOSE_UPDATE_REQUIRED);
  });

  it('güncel istemci bağlanır', async () => {
    await start('0.2.0');
    const { messages } = await identify('0.2.0');
    expect(messages.some((m) => m.t === 'READY')).toBe(true);
  });

  it('sürüm bildirmeyen istemci 0.1.2 sayılır', async () => {
    await start('0.1.2');
    expect((await identify(undefined)).messages.some((m) => m.t === 'READY')).toBe(true);
    await app!.close();
    await start('0.1.3');
    expect((await identify(undefined)).closeCode).toBe(GATEWAY_CLOSE_UPDATE_REQUIRED);
  });

  it('mobil uygulamalar masaüstü sürümüyle değil kendi en düşük sürümüyle karşılaştırılır', async () => {
    await start('0.5.0', true, { MIN_ANDROID_VERSION: '1.2.0' });
    expect((await identify('1.2.0', 'android')).messages.some((m) => m.t === 'READY')).toBe(true);
    await app!.close();
    await start('0.5.0', true, { MIN_ANDROID_VERSION: '1.2.0' });
    expect((await identify('1.1.9', 'android')).closeCode).toBe(GATEWAY_CLOSE_UPDATE_REQUIRED);
    await app!.close();
    // iOS için en düşük sürüm tanımlı değil: engellenmez
    await start('0.5.0', true, { MIN_ANDROID_VERSION: '1.2.0' });
    expect((await identify('0.0.1', 'ios')).messages.some((m) => m.t === 'READY')).toBe(true);
    const version = await app!.inject({ method: 'GET', url: '/api/client/version?platform=android' });
    expect(version.json()).toEqual({ platform: 'android', latest: '1.2.0', required: '1.2.0' });
  });

  it('kural kapalıysa kimse engellenmez', async () => {
    await start('9.9.9', false);
    expect((await identify('0.0.1')).messages.some((m) => m.t === 'READY')).toBe(true);
  });
});

describe('yeni sürüm bildirimi', () => {
  it('sürüm değişince dinleyiciler bir kez çağrılır', async () => {
    const service = new ReleaseService('x/y', fakeGithub('0.2.0', '0.2.0', '0.2.1'));
    const seen: string[] = [];
    service.onNewRelease((r) => seen.push(r.version));
    const refresh = () => (service as unknown as { refresh: () => Promise<unknown> }).refresh();
    await refresh();
    await refresh();
    await refresh();
    expect(seen).toEqual(['0.2.1']);
  });
});
