import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityTracker, RingLog } from '../src/activity.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { firstMessageIdSince, startOfDay, type AdminDashboard } from '../src/dashboard.js';
import type { LiveRoom } from '../src/livekit.js';
import {
  cpuUsage,
  parseCpu,
  parseMeminfo,
  parseNetDev,
  pickInterfaces,
  SystemMonitor,
  updateTraffic,
  type SystemMonitorOptions,
  type TrafficState,
} from '../src/systemStats.js';
import { auth, config, connectGateway, FakeLiveKit, startServer, type TestServer } from './helpers.js';

// Yönetim paneli (GET /api/admin/dashboard): yalnızca hesap yöneticilerine; makine ölçümü sahte bir /proc
// klasöründen okunur (testler Windows'ta da çalışsın).

const DAY = 86_400_000;

/** LiveKit'e gitmeden oda bilgisi döner */
class RoomsLiveKit extends FakeLiveKit {
  roomList: LiveRoom[] = [];
  fail = false;

  override async liveRooms(): Promise<LiveRoom[]> {
    if (this.fail) throw new Error('bağlantı reddedildi');
    return this.roomList;
  }
}

interface ProcValues {
  /** user nice system idle iowait irq softirq steal */
  cpu: number[];
  rx: number;
  tx: number;
  bootId: string;
  availableKb?: number;
}

/** Sahte /proc klasörü (yalnızca panelin okuduğu dosyalar) */
function writeProc(root: string, v: ProcValues): void {
  fs.mkdirSync(path.join(root, 'net'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sys/kernel/random'), { recursive: true });
  const cpu = v.cpu.join(' ');
  fs.writeFileSync(path.join(root, 'stat'), `cpu  ${cpu} 0 0\ncpu0 ${cpu} 0 0\ncpu1 ${cpu} 0 0\nintr 12345\n`);
  fs.writeFileSync(
    path.join(root, 'meminfo'),
    `MemTotal:        4000000 kB\nMemFree:          500000 kB\nMemAvailable:    ${v.availableKb ?? 3000000} kB\n`,
  );
  fs.writeFileSync(path.join(root, 'loadavg'), '0.50 0.40 0.30 1/300 1234\n');
  fs.writeFileSync(path.join(root, 'uptime'), '3600.25 7000.00\n');
  fs.writeFileSync(
    path.join(root, 'net/dev'),
    [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0',
      `ens192: ${v.rx} 100 0 0 0 0 0 0 ${v.tx} 100 0 0 0 0 0 0`,
      'docker0: 5000 10 0 0 0 0 0 0 7000 10 0 0 0 0 0 0',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'net/route'),
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' +
      'ens192\t00000000\t015C00B9\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
      'ens192\t005C00B9\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n' +
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n',
  );
  fs.writeFileSync(path.join(root, 'sys/kernel/random/boot_id'), `${v.bootId}\n`);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-panel-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const monitorAt = (procRoot: string, stateFile: string | null = null, extra: Partial<SystemMonitorOptions> = {}): SystemMonitor =>
  new SystemMonitor({ procRoot, diskPath: tmp, stateFile, quotaBytes: 5e12, ...extra });

describe('yönetim paneli erişimi', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer({ livekit: new RoomsLiveKit(), systemMonitor: monitorAt(path.join(tmp, 'yok')) });
  });
  afterEach(async () => {
    await s.close();
  });

  it('oturumsuz 401, hesap yöneticisi olmayan 403, hesap yöneticisi 200', async () => {
    const anon = await s.app.inject({ method: 'GET', url: '/api/admin/dashboard' });
    expect(anon.statusCode).toBe(401);
    const member = await s.member('uye');
    expect((await s.req(member.token, 'GET', '/api/admin/dashboard')).statusCode).toBe(403);
    const ok = await s.app.inject({ method: 'GET', url: '/api/admin/dashboard?tz=-180', headers: auth(s.owner.token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const d = ok.json() as AdminDashboard;
    expect(d.overview.users).toBe(2);
    expect(d.overview.admins).toBe(1);
    // /proc yok (Windows ya da test): makine bilgisi "yok" olarak gelir, süreç bilgisi yine vardır
    expect(d.system.available).toBe(false);
    expect(d.system.process.rss).toBeGreaterThan(0);
    expect((await s.req(s.owner.token, 'GET', '/api/admin/dashboard?tz=abc')).statusCode).toBe(400);
  });
});

describe('yönetim paneli verisi', () => {
  let s: TestServer;
  let livekit: RoomsLiveKit;
  const proc = (): string => path.join(tmp, 'proc');

  beforeEach(async () => {
    writeProc(proc(), { cpu: [100, 0, 100, 800, 0, 0, 0, 0], rx: 1000, tx: 2000, bootId: 'acilis-1' });
    livekit = new RoomsLiveKit();
    s = await startServer({ livekit, systemMonitor: monitorAt(proc()) });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    await s.close();
  });

  it('kullanım, ses, istemciler, hatalar ve geri bildirimler', async () => {
    const member = await s.member('uye');
    const text = s.channel('text');
    const voiceChannel = s.channel('voice');
    for (const content of ['merhaba', 'nasılsın']) {
      expect((await s.req(member.token, 'POST', `/api/channels/${text.id}/messages`, { content })).statusCode).toBe(201);
    }
    expect((await s.req(s.owner.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'selam' })).statusCode).toBe(201);

    // Telefon ve masaüstünden bağlantılar
    const phone = await connectGateway(s.app, member.token, [], { platform: 'android', version: '0.6.10' });
    const desktop = await connectGateway(s.app, s.owner.token, [], { platform: 'desktop', version: '0.6.11' });

    // Seste iki kişi, biri yayında; LiveKit izleri
    s.ctx.voice.join(s.owner.user.id, voiceChannel.id);
    s.ctx.voice.join(member.user.id, voiceChannel.id, true);
    s.ctx.voice.setSelf(member.user.id, { selfMute: true, selfDeaf: false });
    livekit.roomList = [
      {
        channelId: voiceChannel.id,
        participants: [
          {
            userId: member.user.id,
            joinedAt: Date.now(),
            tracks: [
              { kind: 'audio', source: 'microphone', muted: true, mimeType: 'audio/opus', width: 0, height: 0 },
              { kind: 'video', source: 'screen', muted: false, mimeType: 'video/VP8', width: 1920, height: 1080 },
            ],
          },
          { userId: s.owner.user.id, joinedAt: Date.now(), tracks: [] },
        ],
      },
    ];

    // İstemci hatası ve geri bildirim
    const err = { platform: 'android', version: '0.6.10', where: 'render', message: 'Beklenmeyen hata', stack: 'at X' };
    expect(
      (await s.app.inject({ method: 'POST', url: '/api/client-errors', headers: auth(member.token), payload: err })).statusCode,
    ).toBe(204);
    expect(
      (await s.req(member.token, 'POST', '/api/feedback', { type: 'hata', title: 'Ses gitti', body: 'Kanaldan düştüm' })).statusCode,
    ).toBe(201);

    const d = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard?tz=-180')).json() as AdminDashboard;

    // Genel bakış
    expect(d.overview).toMatchObject({ users: 2, online: 2, sessions: 2, active24h: 2, active7d: 2, guilds: 1 });
    const channels = s.ctx.store.listChannels(s.guildId);
    expect(d.overview.channels).toEqual({
      text: channels.filter((c) => c.type === 'text').length,
      voice: channels.filter((c) => c.type === 'voice').length,
      dm: 0,
    });
    expect(d.overview.messages).toMatchObject({ total: 3, today: 3, last24h: 3, last7d: 3 });
    expect(d.overview.messages.perDay).toHaveLength(14);
    expect(d.overview.messages.perDay.at(-1)).toEqual({ day: startOfDay(d.generatedAt, -180), count: 3 });
    expect(d.overview.storage.database).toBeGreaterThan(0);

    // Ses
    expect(d.voice).toMatchObject({ participants: 2, streams: 1 });
    expect(d.voice.livekit).toMatchObject({ ok: true, rooms: 1, participants: 2, tracks: 2, error: null });
    const [channel] = d.voice.channels;
    expect(channel).toMatchObject({ channelId: voiceChannel.id, name: voiceChannel.name, guildId: s.guildId });
    const streamer = channel!.participants.find((p) => p.userId === member.user.id)!;
    expect(streamer).toMatchObject({ selfMute: true, streaming: true, platforms: ['android'] });
    expect(streamer.user?.username).toBe('uye');
    expect(streamer.tracks?.map((t) => `${t.source} ${t.width}x${t.height}`)).toEqual(['microphone 0x0', 'screen 1920x1080']);

    // İstemciler
    expect(d.clients.platforms).toEqual({ desktop: 1, android: 1, ios: 0 });
    expect(d.clients.versions.map((v) => `${v.platform} ${v.version} ${v.sessions}`)).toEqual([
      'android 0.6.10 1',
      'desktop 0.6.11 1',
    ]);
    const uye = d.clients.users.find((u) => u.user.username === 'uye')!;
    expect(uye.online).toBe(true);
    expect(uye.devices).toMatchObject([{ platform: 'android', version: '0.6.10', idle: false }]);
    expect(uye.lastSeen).toBe(d.generatedAt);

    // Hatalar ve geri bildirimler
    expect(d.errors.client).toMatchObject({ total: 1, last24h: 1, capped: false });
    expect(d.errors.client.recent[0]).toMatchObject({ ...err, user: 'uye' });
    expect(d.feedback.total).toBe(1);
    expect(d.feedback.counts.yeni).toBe(1);

    // Makine (sahte /proc); anlık ağ hızı burada yok (tek ağ örnekleyicisi: netSeconds.ts)
    expect(d.system).toMatchObject({ available: true, hostUptimeSec: 3600.25 });
    expect(d.system.cpu).toMatchObject({ cores: 2, usage: null, load: [0.5, 0.4, 0.3] });
    expect(d.system.memory).toEqual({ total: 4000000 * 1024, available: 3000000 * 1024 });
    expect(d.system.network).toEqual({ interfaces: ['ens192'] });
    expect(d.system.history).toHaveLength(1);
    expect(d.system.history[0]).toMatchObject({ online: 2, voice: 2 });

    phone.ws.close();
    desktop.ws.close();
  });

  it("LiveKit'e ulaşılamazsa ses listesi yine gelir, izler bilinmez", async () => {
    livekit.fail = true;
    s.ctx.voice.join(s.owner.user.id, s.channel('voice').id);
    const d = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard')).json() as AdminDashboard;
    expect(d.voice.livekit).toMatchObject({ ok: false, latencyMs: null, error: 'bağlantı reddedildi' });
    expect(d.voice.participants).toBe(1);
    expect(d.voice.channels[0]!.participants[0]!.tracks).toBeNull();
  });

  it('bağlantısı kesilen hesabın son görülme anı ve platformu kalır', async () => {
    const member = await s.member('uye');
    const phone = await connectGateway(s.app, member.token, [], { platform: 'ios', version: '0.6.9' });
    const first = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard')).json() as AdminDashboard;
    expect(first.clients.users.find((u) => u.user.id === member.user.id)?.online).toBe(true);
    phone.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const d = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard')).json() as AdminDashboard;
    const uye = d.clients.users.find((u) => u.user.id === member.user.id)!;
    expect(uye).toMatchObject({ online: false, devices: [], lastPlatform: 'ios', lastVersion: '0.6.9' });
    expect(uye.lastSeen).toBe(first.generatedAt);
    expect(d.overview.active24h).toBe(1);
  });
});

describe('sunucu hataları', () => {
  it('5xx ile biten istekler iletisi ve yol kalıbıyla panele düşer', async () => {
    const { app, ctx } = await buildApp(config, {
      dbFile: ':memory:',
      logger: false,
      livekit: new RoomsLiveKit(),
      systemMonitor: monitorAt(path.join(tmp, 'yok')),
    });
    try {
      app.get('/api/test/:id/patla', async () => {
        throw new Error('beklenmeyen durum');
      });
      const owner = (
        await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { inviteCode: ctx.store.ensureBootstrapInvite()!.code, username: 'sahip', password: 'sifre12345' },
        })
      ).json() as { token: string };
      expect((await app.inject({ method: 'GET', url: '/api/test/42/patla?gizli=1' })).statusCode).toBe(500);
      expect((await app.inject({ method: 'GET', url: '/api/yok' })).statusCode).toBe(404);
      const d = (await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: auth(owner.token) })).json() as AdminDashboard;
      expect(d.errors.server.total).toBe(1);
      expect(d.errors.server.recent[0]).toMatchObject({
        method: 'GET',
        route: '/api/test/:id/patla',
        status: 500,
        message: 'beklenmeyen durum',
      });
    } finally {
      await app.close();
    }
  });
});

describe('makine ölçümü (sahte /proc)', () => {
  it('CPU kullanımı ve aylık trafik; sayaç dosyası yeniden başlatmada ve makine açılışında sürer', async () => {
    const proc = path.join(tmp, 'proc');
    const stateFile = path.join(tmp, 'data', 'traffic.json');
    const t0 = Date.UTC(2026, 8, 28, 12, 0, 0);
    writeProc(proc, { cpu: [100, 0, 100, 800, 0, 0, 0, 0], rx: 1_000_000, tx: 2_000_000, bootId: 'a' });
    const monitor = monitorAt(proc, stateFile);
    await monitor.sample({ online: 1, voice: 0 }, t0);
    // İlk takip: makine bu ay (1 saat önce) açıldığından sayaçların tamamı bu ayın trafiği
    const bootedAt = t0 - 3_600_250;
    expect(monitor.snapshot().system.traffic).toMatchObject({
      month: '2026-09',
      rx: 1_000_000,
      tx: 2_000_000,
      since: bootedAt,
      quota: 5e12,
    });

    // 5 sn sonra: 1000 jiffy'nin 250'si boşta değil (%25); 500 KB gelen, 1 MB giden
    writeProc(proc, { cpu: [300, 0, 150, 1550, 0, 0, 0, 0], rx: 1_500_000, tx: 3_000_000, bootId: 'a', availableKb: 2000000 });
    await monitor.sample({ online: 2, voice: 1 }, t0 + 5_000);
    const { system, history } = monitor.snapshot();
    expect(system.cpu?.usage).toBeCloseTo(0.25, 5);
    expect(system.network).toEqual({ interfaces: ['ens192'] });
    expect(system.traffic).toMatchObject({ rx: 1_500_000, tx: 3_000_000 });
    expect(system.disk?.total).toBeGreaterThan(0);
    expect(history.map((h) => h.cpu)).toEqual([null, 0.25]);
    expect(history[1]).toMatchObject({ memUsed: 2000000 * 1024, online: 2, voice: 1 });

    // Kalıcı dosya: yeni süreç kaldığı yerden sayar
    await monitor.persist(t0 + 5_000);
    writeProc(proc, { cpu: [300, 0, 150, 1550, 0, 0, 0, 0], rx: 1_600_000, tx: 3_000_000, bootId: 'a' });
    const restarted = monitorAt(proc, stateFile);
    await restarted.sample({ online: 0, voice: 0 }, t0 + 60_000);
    expect(restarted.snapshot().system.traffic).toMatchObject({ rx: 1_600_000, tx: 3_000_000, since: bootedAt });

    // Makine yeniden açıldı: sayaçlar sıfırdan başladı, açılıştan bu yana olan trafik eklenir
    writeProc(proc, { cpu: [10, 0, 10, 80, 0, 0, 0, 0], rx: 50_000, tx: 70_000, bootId: 'b' });
    await restarted.sample({ online: 0, voice: 0 }, t0 + 120_000);
    const after = restarted.snapshot().system;
    expect(after.traffic).toMatchObject({ rx: 1_650_000, tx: 3_070_000 });
    // Açılış değiştiğinde CPU kullanımı hesaplanmaz (sayaçlar geriye gitti)
    expect(after.cpu?.usage).toBeNull();
  });
});

describe('aylık trafik sayacı', () => {
  const sep = Date.UTC(2026, 8, 30, 23, 59, 0);
  const oct = Date.UTC(2026, 9, 1, 0, 1, 0);
  const base = (): TrafficState => updateTraffic(null, 'a', { eth0: { rx: 100, tx: 100 } }, sep - 60_000);

  it('artışları toplar; geriye giden sayaç ve yeni arayüz baştan sayılır', () => {
    let state = updateTraffic(base(), 'a', { eth0: { rx: 150, tx: 130 } }, sep);
    expect(state).toMatchObject({ rx: 50, tx: 30 });
    state = updateTraffic(state, 'a', { eth0: { rx: 20, tx: 140 }, eth1: { rx: 5, tx: 5 } }, sep);
    expect(state).toMatchObject({ rx: 50 + 20 + 5, tx: 30 + 10 + 5 });
  });

  it('ay değişince biten ay geçmişe yazılır', () => {
    const state = updateTraffic(updateTraffic(base(), 'a', { eth0: { rx: 150, tx: 130 } }, sep), 'a', { eth0: { rx: 160, tx: 150 } }, oct);
    expect(state).toMatchObject({ month: '2026-10', rx: 10, tx: 20, since: Date.UTC(2026, 9, 1) });
    expect(state.history).toEqual([{ month: '2026-09', rx: 50, tx: 30 }]);
  });

  it('ilk takipte makine bu ay açıldıysa açılıştan beri olan trafik sayılır, önceki ay açıldıysa sıfırdan', () => {
    const counters = { eth0: { rx: 700, tx: 900 } };
    expect(updateTraffic(null, 'a', counters, oct, Date.UTC(2026, 9, 1, 0, 0, 30))).toMatchObject({
      rx: 700,
      tx: 900,
      since: Date.UTC(2026, 9, 1, 0, 0, 30),
    });
    expect(updateTraffic(null, 'a', counters, oct, sep)).toMatchObject({ rx: 0, tx: 0, since: oct });
    expect(updateTraffic(null, 'a', counters, oct)).toMatchObject({ rx: 0, tx: 0, since: oct });
  });

  it('açılış kimliği okunamazsa yeniden başlatma sayacın geriye gitmesinden anlaşılır', () => {
    const state = updateTraffic(updateTraffic(base(), null, { eth0: { rx: 300, tx: 300 } }, sep), null, { eth0: { rx: 40, tx: 60 } }, sep);
    expect(state).toMatchObject({ rx: 200 + 40, tx: 200 + 60 });
  });
});

describe('ayrıştırıcılar', () => {
  it('/proc dosyaları', () => {
    const cpu = parseCpu('cpu  218617 652 412834 20927021 5016 0 35915 0 0 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n')!;
    expect(cpu.cores).toBe(2);
    expect(cpu.times.idle).toBe(20927021 + 5016);
    expect(cpuUsage({ total: 100, idle: 80 }, { total: 200, idle: 120 })).toBeCloseTo(0.6);
    expect(cpuUsage({ total: 100, idle: 80 }, { total: 100, idle: 80 })).toBeNull();
    expect(parseCpu('bozuk')).toBeNull();
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n')).toEqual({
      total: 1000 * 1024,
      available: 400 * 1024,
    });
    const dev = parseNetDev(' face |bytes\n  eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0\nveth1a: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n');
    expect(dev).toEqual({ eth0: { rx: 10, tx: 20 }, veth1a: { rx: 1, tx: 1 } });
    // Yol tablosu yoksa sanal arayüzler (veth, docker…) sayılmaz
    expect(pickInterfaces(dev, null)).toEqual(['eth0']);
  });
});

describe('mesaj penceresi (ikili arama)', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer({ livekit: new RoomsLiveKit(), systemMonitor: monitorAt(path.join(tmp, 'yok')) });
  });
  afterEach(async () => {
    await s.close();
  });

  it('created_at dizini olmadan verilen andan sonraki ilk mesajı bulur (silinmiş kimlik boşluklarıyla)', () => {
    const db = s.ctx.store.db;
    const channelId = s.channel('text').id;
    expect(firstMessageIdSince(db, 0)).toBeNull();
    const insert = db.prepare('INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 40; i++) insert.run(channelId, s.owner.user.id, `m${i}`, i * 1000);
    db.prepare('DELETE FROM messages WHERE id BETWEEN 10 AND 25').run();
    expect(firstMessageIdSince(db, 0)).toBe(1);
    expect(firstMessageIdSince(db, 9_000)).toBe(9);
    expect(firstMessageIdSince(db, 9_500)).toBe(26);
    expect(firstMessageIdSince(db, 30_000)).toBe(30);
    expect(firstMessageIdSince(db, 40_001)).toBeNull();
  });

  it('günün başı istemcinin saat dilimine göre', () => {
    const now = Date.UTC(2026, 8, 28, 22, 30); // İstanbul'da 29 Eylül 01:30
    expect(startOfDay(now, -180)).toBe(Date.UTC(2026, 8, 28, 21, 0));
    expect(startOfDay(now, 0)).toBe(Date.UTC(2026, 8, 28));
    expect(startOfDay(now, 0) - startOfDay(now - DAY, 0)).toBe(DAY);
  });
});

describe('etkinlik ve hata kayıtları', () => {
  it('son görülme dosyası yeniden başlatmada okunur', async () => {
    const file = path.join(tmp, 'activity.json');
    const tracker = new ActivityTracker(file, 1_000);
    tracker.touch(
      [
        { userId: 'u1', platform: 'desktop', version: '0.6.0', connectedAt: 1 },
        { userId: 'u1', platform: 'android', version: '0.6.1', connectedAt: 2 },
      ],
      5_000,
    );
    await tracker.persist(5_000, true);
    const again = new ActivityTracker(file, 9_000);
    expect(again.since).toBe(1_000);
    expect(again.get('u1')).toEqual({ at: 5_000, platform: 'android', version: '0.6.1' });
    expect(again.idsSince(4_000)).toEqual(['u1']);
    expect(again.idsSince(6_000)).toEqual([]);
  });

  it('halka tampon en yenileri tutar', () => {
    const log = new RingLog<{ at: number }>(3);
    for (let i = 1; i <= 5; i++) log.push({ at: i });
    expect(log.total).toBe(5);
    expect(log.recent(2)).toEqual([{ at: 5 }, { at: 4 }]);
    expect(log.countSince(4)).toEqual({ count: 2, capped: false });
    expect(log.countSince(0)).toEqual({ count: 3, capped: true });
  });
});

describe('aylık trafik kotası', () => {
  it('varsayılan 1000 GB (yalnızca giden sayılır); TRAFFIC_QUOTA_GB ile değişir', () => {
    expect(loadConfig({ NODE_ENV: 'test', DATA_DIR: '.' }).trafficQuotaBytes).toBe(1000e9);
    expect(loadConfig({ NODE_ENV: 'test', DATA_DIR: '.', TRAFFIC_QUOTA_GB: '250' }).trafficQuotaBytes).toBe(250e9);
    expect(() => loadConfig({ NODE_ENV: 'test', DATA_DIR: '.', TRAFFIC_QUOTA_GB: '-1' })).toThrow(/TRAFFIC_QUOTA_GB/);
  });
});
