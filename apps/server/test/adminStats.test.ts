import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceTelemetryReport } from '@diskort/shared';
import { routeGroup } from '../src/apiStats.js';
import { AuthLog, clientOf } from '../src/authLog.js';
import { buildApp } from '../src/app.js';
import { DailyCounters, dayKey } from '../src/counters.js';
import type { AdminDashboard } from '../src/dashboard.js';
import { InfraMonitor, LiveKitMetrics, liveKitSample } from '../src/infraStats.js';
import { counterRate, parsePromText, PromSnapshot } from '../src/promText.js';
import { assessReport, VoiceTelemetryStore, type TelemetryEntry } from '../src/telemetry.js';
import { auth, config, startServer, type TestServer } from './helpers.js';

// Yönetim panelinin ek verileri: ses kalitesi ölçümleri ve olaylar, ses geçmişi, LiveKit/Caddy ölçümleri,
// yedekler, API sağlığı, giriş kayıtları, davetler ve sunucu ayrıntıları.

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-yonetim-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ENDPOINTS = [
  '/api/admin/telemetry?user=x',
  '/api/admin/telemetry/incidents',
  '/api/admin/voice-history',
  '/api/admin/infra',
  '/api/admin/api-stats',
  '/api/admin/security',
  '/api/admin/guilds',
];

function report(over: Partial<VoiceTelemetryReport> = {}): VoiceTelemetryReport {
  return {
    v: 1,
    platform: 'desktop',
    version: '0.7.0',
    channelId: 'kanal',
    windowSec: 30,
    samples: 15,
    quality: 'good',
    poorSec: 0,
    serverQuality: 'excellent',
    rttMs: { avg: 25, max: 40 },
    jitterInMs: 5,
    jitterOutMs: 3,
    lossOutPct: 0,
    lossInPct: 0.2,
    concealedPct: 0.1,
    bitrateOut: 40_000,
    bitrateIn: 90_000,
    availableOut: 5_000_000,
    candidate: 'host',
    protocol: 'udp',
    reconnects: 0,
    mic: { noise: 'dpdfnet', model: 'DPDFNet-2 48k', load: 0.3, avgFrameMs: 1.2, p99FrameMs: 2.5, maxFrameMs: 4, underruns: 0, droppedSamples: 0, muted: false },
    screen: null,
    ...over,
  };
}

/** Sahte Prometheus ucu: her istekte sıradaki metni verir */
function promFetch(bodies: Record<string, string[]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const list = bodies[url];
    if (!list) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const body = list.length > 1 ? list.shift()! : list[0]!;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const lkText = (n: number): string =>
  [
    '# HELP livekit_room_total rooms',
    '# TYPE livekit_room_total gauge',
    'livekit_room_total{node_id="N1",node_type="SERVER"} 1',
    'livekit_participant_total{node_id="N1",node_type="SERVER"} 3',
    'livekit_track_published_total{kind="audio",node_id="N1"} 3',
    'livekit_track_published_total{kind="video",node_id="N1"} 1',
    'livekit_track_subscribed_total{kind="audio",node_id="N1"} 6',
    `livekit_packet_bytes{direction="incoming",transmission="transmission",country=""} ${1_000_000 * n}`,
    `livekit_packet_bytes{direction="outgoing",transmission="transmission",country=""} ${2_000_000 * n}`,
    `livekit_packet_bytes{direction="outgoing",transmission="retransmission",country=""} ${10_000 * n}`,
    `livekit_packet_total{direction="incoming",transmission="transmission",country=""} ${1_000 * n}`,
    `livekit_packet_total{direction="outgoing",transmission="transmission",country=""} ${2_000 * n}`,
    `livekit_packet_loss_total{direction="incoming",source="microphone",type="audio",country=""} ${10 * n}`,
    `livekit_nack_total{direction="incoming",country=""} ${5 * n}`,
    `livekit_pli_total{direction="incoming",country=""} ${2 * n}`,
    `livekit_rtt_ms_sum{direction="incoming",source="microphone",type="audio",country=""} ${300 * n}`,
    `livekit_rtt_ms_count{direction="incoming",source="microphone",type="audio",country=""} ${10 * n}`,
    'livekit_rtt_ms_bucket{le="+Inf"} 5',
    `process_cpu_seconds_total ${2.5 * n}`,
    'process_resident_memory_bytes 1.2e+08',
    'go_goroutines 321',
  ].join('\n');

describe('yönetim paneli ek uçları: erişim', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(async () => {
    await s.close();
  });

  it('oturumsuz 401, hesap yöneticisi olmayan 403, hesap yöneticisi 200', async () => {
    const member = await s.member('uye');
    for (const url of ENDPOINTS) {
      expect((await s.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect((await s.req(member.token, 'GET', url)).statusCode, url).toBe(403);
      const ok = await s.req(s.owner.token, 'GET', url);
      expect(ok.statusCode, url).toBe(200);
    }
    expect((await s.req(s.owner.token, 'GET', '/api/admin/voice-history?days=500')).statusCode).toBe(400);
    expect((await s.req(s.owner.token, 'GET', '/api/admin/telemetry')).statusCode).toBe(400);
    expect((await s.req(s.owner.token, 'GET', '/api/admin/telemetry/freezes/yok')).statusCode).toBe(404);
    expect((await s.req(member.token, 'GET', '/api/admin/telemetry/freezes/yok')).statusCode).toBe(403);
    expect((await s.req(s.owner.token, 'GET', '/api/admin/telemetry?user=x&date=dun')).statusCode).toBe(400);
    // Ölçüm gönderimi oturum ister
    expect((await s.app.inject({ method: 'POST', url: '/api/telemetry/voice', payload: report() })).statusCode).toBe(401);
  });
});

describe('ses kalitesi ölçümleri', () => {
  let s: TestServer;
  const dir = (): string => path.join(tmp, 'telemetry');
  beforeEach(async () => {
    s = await startServer({ telemetryDir: dir() });
  });
  afterEach(async () => {
    await s.close();
  });

  it('özetler canlı tabloya, kullanıcı geçmişine ve günlük dosyaya; kötü dönemler olay olur', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    const send = (r: VoiceTelemetryReport) => s.req(member.token, 'POST', '/api/telemetry/voice', r);

    expect((await send(report({ channelId: voice.id }))).statusCode).toBe(204);
    // Geçersiz gövde
    expect((await send({ ...report(), v: 2 } as unknown as VoiceTelemetryReport)).statusCode).toBe(400);

    const d = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard')).json() as AdminDashboard;
    expect(d.voice.quality).toHaveLength(1);
    expect(d.voice.quality[0]).toMatchObject({
      userId: member.user.id,
      channelId: voice.id,
      guildId: s.guildId,
      severity: 'ok',
      rttAvg: 25,
      mic: { noise: 'dpdfnet', load: 0.3 },
    });
    // LiveKit ölçümleri yapılandırılmamış (testler)
    expect(d.voice.metrics).toMatchObject({ configured: false, ok: false });
    expect(d.health.openSockets).toBe(0);

    // Kötü kalite: yüksek gecikme ve gelen kayıp, TURN üzerinden
    await send(report({ quality: 'poor', poorSec: 12, rttMs: { avg: 320, max: 600 }, lossInPct: 14, candidate: 'relay', protocol: 'tls' }));
    await send(report({ quality: 'poor', poorSec: 30, reconnects: 1, rttMs: { avg: 280, max: 400 } }));
    let incidents = (await s.req(s.owner.token, 'GET', '/api/admin/telemetry/incidents')).json();
    expect(incidents.incidents).toHaveLength(1);
    expect(incidents.incidents[0]).toMatchObject({
      userId: member.user.id,
      channelId: voice.id,
      open: true,
      reports: 2,
      poorSec: 42,
      candidate: 'relay',
      worst: { rttMs: 600, lossInPct: 14 },
    });
    expect(incidents.incidents[0].causes[0]).toEqual({ cause: 'Yüksek gecikme (ping)', count: 2 });
    // Yayın donması bölümü: tek kullanıcının kaybı orada olay açmaz; örnekleyici durumu gelir
    expect(incidents.freezes).toEqual([]);
    expect(incidents.netSampler.readable).toMatchObject({ net: false });
    expect(incidents.users[member.user.id].username).toBe('uye');
    expect(incidents.channels[voice.id].name).toBe(voice.name);

    // Kalite düzelince olay kapanır
    await send(report());
    incidents = (await s.req(s.owner.token, 'GET', '/api/admin/telemetry/incidents?days=1')).json();
    expect(incidents.incidents[0].open).toBe(false);
    expect(incidents.storage.received).toBe(4);

    // Kullanıcının son saati
    const hist = (await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${member.user.id}`)).json();
    expect(hist.user.username).toBe('uye');
    expect(hist.entries.map((e: TelemetryEntry) => e.severity)).toEqual(['ok', 'poor', 'poor', 'ok']);
    expect(hist.incidents).toHaveLength(1);

    // Günlük dosya: geçmiş gün okuması aynı kayıtları verir
    const day = dayKey(Date.now(), config.statsUtcOffsetMin);
    const past = (await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${member.user.id}&date=${day}`)).json();
    expect(past.entries).toHaveLength(4);
    expect(past.days).toContain(day);
    expect(fs.readFileSync(path.join(dir(), `${day}.jsonl`), 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
    expect(fs.readFileSync(path.join(dir(), 'incidents.jsonl'), 'utf8')).toContain(member.user.id);
    // Başka kullanıcının kaydı yok
    const other = (await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${s.owner.user.id}&date=${day}`)).json();
    expect(other.entries).toEqual([]);
  });

  it('izlenen yayın, cihaz ve yeni mikrofon/yayın alanları kaydedilir; eski ve bilinmeyen alanlı özetler de kabul', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    const send = (r: unknown) => s.req(member.token, 'POST', '/api/telemetry/voice', r as VoiceTelemetryReport);
    const watch = {
      codec: 'video/VP9',
      decoder: 'libvpx',
      hardware: false,
      powerEfficient: false,
      width: 2560,
      height: 1440,
      fps: 58.44,
      decodeMs: 6.9123,
      decodeMsMax: 11.2,
      bitrate: 11_800_000.4,
      framesDropped: 12,
      freezes: 1,
      freezeSec: 0.42,
      jitterBufferMs: 48.26,
      view: { mode: 'inline', width: 1080, height: 608 },
    };
    const res = await send({
      ...report({ channelId: voice.id, platform: 'android' }),
      mic: {
        ...report().mic!,
        modelFrameMs: 5.123,
        core: '7 (4320 MHz)',
        noiseFallback: 'yavaş: kare başına 6,3 ms',
        // Masaüstü: gerçekte çalışan engelleme ve düşüş ayrıntısı
        effectiveNoise: 'deepfilter',
        fallback: { from: 'dpdfnet', to: 'deepfilter', reason: 'underrun', transient: true, at: 1_790_000_000_000, retryAt: 1_790_000_300_000 },
        // Konuşma seviyesi (dBFS) ve gerçekte çalışan otomatik kazanç
        speechRmsDb: -36.25,
        speechRmsDbP90: -30.75,
        speechRmsDbOut: -20.25,
        speechRmsDbOutP90: -15.75,
        effectiveAgc: false,
        digitalAgc: true,
      },
      screen: { width: 1920, height: 1080, fps: 60, bitrate: 8e6, encoder: 'libvpx', codec: 'video/VP9', limitation: 'cpu', limitedRatio: 0.4, encodeMs: 9.5, hardware: false },
      watch,
      device: { appState: 'active', soc: 'QTI SM8850', thermal: 'moderate', thermalHeadroom: 0.82 },
      // Sunucunun bilmediği alan yok sayılır
      gelecek: { x: 1 },
    });
    expect(res.statusCode).toBe(204);
    // Eski istemci (yeni alanlar yok) ve boş izleme
    expect((await send(report({ channelId: voice.id }))).statusCode).toBe(204);
    expect((await send({ ...report(), watch: null, device: null })).statusCode).toBe(204);
    // Aralık dışı sayılar sıkıştırılır, uzun metin kısaltılır (özet düşmez); geçersiz tür/değer reddedilir
    const long = 'x'.repeat(500);
    expect(
      (
        await send({
          ...report(),
          lossInPct: 900,
          watch: { ...watch, decodeMs: -1, width: 99_999, decoder: long },
          mic: { ...report().mic!, speechRmsDb: 12, speechRmsDbOut: -500 },
        })
      ).statusCode,
    ).toBe(204);
    expect((await send({ ...report(), mic: { ...report().mic!, speechRmsDb: 'kısık' } })).statusCode).toBe(400);
    expect((await send({ ...report(), watch: { ...watch, view: { mode: 'yan', width: 1, height: 1 } } })).statusCode).toBe(400);
    expect((await send({ ...report(), watch: { ...watch, decodeMs: 'yavaş' } })).statusCode).toBe(400);
    expect(
      (await send({ ...report(), mic: { ...report().mic!, fallback: { from: 'dpdfnet', to: 'standard', reason: 'x', transient: 'evet', at: 1, retryAt: null } } }))
        .statusCode,
    ).toBe(400);

    const hist = (await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${member.user.id}`)).json();
    const first = hist.entries[0] as TelemetryEntry;
    expect(first.watch).toMatchObject({ decoder: 'libvpx', hardware: false, fps: 58.4, decodeMs: 6.91, bitrate: 11_800_000, freezeSec: 0.4, jitterBufferMs: 48.3, view: { mode: 'inline' } });
    expect(first.device).toEqual({ appState: 'active', soc: 'QTI SM8850', thermal: 'moderate', thermalHeadroom: 0.82 });
    expect(first.mic).toMatchObject({
      modelFrameMs: 5.123,
      core: '7 (4320 MHz)',
      noiseFallback: 'yavaş: kare başına 6,3 ms',
      effectiveNoise: 'deepfilter',
      fallback: { from: 'dpdfnet', to: 'deepfilter', reason: 'underrun', transient: true, retryAt: 1_790_000_300_000 },
      speechRmsDb: -36.25,
      speechRmsDbP90: -30.75,
      speechRmsDbOut: -20.25,
      speechRmsDbOutP90: -15.75,
      effectiveAgc: false,
      digitalAgc: true,
    });
    expect(first.screen).toMatchObject({ encodeMs: 9.5, hardware: false });
    expect(JSON.stringify(first)).not.toContain('gelecek');
    expect(hist.entries[1].watch).toBeNull();
    const clamped = hist.entries[3] as TelemetryEntry;
    expect(clamped.lossIn).toBe(100);
    expect(clamped.watch).toMatchObject({ decodeMs: 0, width: 20_000 });
    expect(clamped.watch!.decoder).toHaveLength(80);
    expect(clamped.mic).toMatchObject({ speechRmsDb: 0, speechRmsDbOut: -200 });

    // Günlük JSONL dosyasında da
    await s.ctx.telemetry.flush();
    const day = dayKey(Date.now(), config.statsUtcOffsetMin);
    const line = JSON.parse(fs.readFileSync(path.join(dir(), `${day}.jsonl`), 'utf8').split('\n')[0]!) as TelemetryEntry;
    expect(line.watch?.decoder).toBe('libvpx');
    expect(line.device?.soc).toBe('QTI SM8850');
  });

  it('gelen sesler, JS takılması ve ses ayarları kaydedilir (eski özetlerde null); sayılar sıkıştırılır', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    const send = (r: unknown) => s.req(member.token, 'POST', '/api/telemetry/voice', r as VoiceTelemetryReport);
    const audioIn = { streams: 3, jitterMaxMs: 41.26, lossPct: 4.567, concealEvents: 12, jitterBufferMs: 62.34, bitrate: 96_000.4 };
    const settings = {
      echoCancellation: false,
      autoGainControl: true,
      voiceActivity: true,
      vadAuto: false,
      vadThresholdDb: -42,
      noiseMode: 'dpdfnet',
      noiseStrengthDb: 24,
      speaker: true,
      userVolumesChanged: 2,
      userVolumeMax: 1.8,
    };
    expect((await send({ ...report({ channelId: voice.id, platform: 'android' }), audioIn, jsLag: { maxMs: 1_450.4, p95Ms: 12, stalls: 2 }, settings })).statusCode).toBe(204);
    // Eski istemci (yeni alanlar yok)
    expect((await send(report({ channelId: voice.id }))).statusCode).toBe(204);
    // Aralık dışı: sıkıştırılır; yanlış tür reddedilir
    expect((await send({ ...report(), audioIn: { ...audioIn, lossPct: 500, streams: -2 }, settings: { vadThresholdDb: -900, userVolumeMax: 1e9 } })).statusCode).toBe(204);
    expect((await send({ ...report(), settings: { echoCancellation: 'evet' } })).statusCode).toBe(400);
    expect((await send({ ...report(), jsLag: { maxMs: 10, p95Ms: 5, stalls: 1.5 } })).statusCode).toBe(400);

    const hist = (await s.req(s.owner.token, 'GET', `/api/admin/telemetry?user=${member.user.id}`)).json();
    const [first, old, clamped] = hist.entries as TelemetryEntry[];
    expect(first!.audioIn).toEqual({ streams: 3, jitterMaxMs: 41.3, lossPct: 4.57, concealEvents: 12, jitterBufferMs: 62.3, bitrate: 96_000 });
    expect(first!.jsLag).toEqual({ maxMs: 1_450, p95Ms: 12, stalls: 2 });
    expect(first!.settings).toEqual(settings);
    // Ses kaybı var ama duyulur bozulma yok: kaynağı belirsiz uyarı; takılma da uyarı
    expect(first!.severity).toBe('warn');
    expect(first!.causes).toEqual(['Gelen paket kaybı (kaynağı belirsiz: konuşanın bağlantısı olabilir)', 'Uygulama takıldı (JS iş parçacığı)']);
    expect(old).toMatchObject({ audioIn: null, jsLag: null, settings: null, severity: 'ok' });
    expect(clamped!.audioIn).toMatchObject({ lossPct: 100, streams: 0 });
    expect(clamped!.settings).toEqual({ vadThresholdDb: -200, userVolumeMax: 100 });
    expect(clamped!.severity).toBe('warn');
  });

  it('kullanıcı başına dakikada en fazla 8 özet', async () => {
    const member = await s.member('uye');
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await s.req(member.token, 'POST', '/api/telemetry/voice', report())).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(8);
    expect(codes.at(-1)).toBe(429);
    // Seste değilse kanal bilinmez (istemcinin bildirdiği kanal kaydedilmez)
    const d = (await s.req(s.owner.token, 'GET', '/api/admin/dashboard')).json() as AdminDashboard;
    expect(d.voice.quality[0]).toMatchObject({ channelId: null, guildId: null });
  });
});

describe('ses kalitesi değerlendirmesi', () => {
  const base = (): Omit<TelemetryEntry, 'severity' | 'causes'> => {
    const store = new VoiceTelemetryStore({ dir: null });
    const e = store.ingest('u', report(), { channelId: null, guildId: null });
    const { severity: _s, causes: _c, ...rest } = e;
    return rest;
  };

  it('eşikler ve olası nedenler', () => {
    expect(assessReport(base())).toEqual({ severity: 'ok', causes: [] });
    expect(assessReport({ ...base(), lossOut: 4 })).toEqual({ severity: 'warn', causes: ['Giden paket kaybı (yükleme hattı)'] });
    expect(assessReport({ ...base(), quality: 'fair' })).toEqual({ severity: 'warn', causes: ['Bağlantı idare eder'] });
    expect(
      assessReport({
        ...base(),
        screen: { width: 1920, height: 1080, fps: 20, bitrate: 3e6, encoder: 'libvpx', codec: 'video/VP8', limitation: 'cpu', limitedRatio: 0.8 },
      }).causes,
    ).toEqual(['Yayın kodlayıcısına işlemci yetmiyor']);
    expect(assessReport({ ...base(), concealed: 12, candidate: 'relay', protocol: 'tcp' })).toEqual({
      severity: 'poor',
      causes: ['Gelen seste kesilme (kayıp ses sentezlendi)', 'TURN aktarıcısı üzerinden (tcp)'],
    });
    // Mikrofon işlemede takılma: önceki özete göre artan boşluk sayısı
    const prev = { mic: { ...base().mic!, underruns: 2 } };
    expect(assessReport({ ...base(), mic: { ...base().mic!, underruns: 5 } }, prev).causes).toEqual(['Mikrofon işlemede takılma']);
    expect(assessReport({ ...base(), quality: 'poor', poorSec: 6 })).toEqual({ severity: 'poor', causes: ['Bağlantı kalitesi kötü'] });
    // JS takılması: tek başına uyarı, kötü dönemde ek neden; kısa takılma sayılmaz
    const lag = (maxMs: number) => ({ maxMs, p95Ms: 5, stalls: 1 });
    expect(assessReport({ ...base(), jsLag: lag(300) })).toEqual({ severity: 'ok', causes: [] });
    expect(assessReport({ ...base(), jsLag: lag(2_000), reconnects: 1 })).toEqual({
      severity: 'poor',
      causes: ['Bağlantı koptu, yeniden bağlandı', 'Uygulama takıldı (JS iş parçacığı)'],
    });
    // Yalnızca ses kaybı: duyulur bozulmayla (kesilme ya da titreşim) kötü, yoksa en fazla uyarı
    const audioIn = { streams: 2, jitterMaxMs: 10, lossPct: 12, concealEvents: 3, jitterBufferMs: 40, bitrate: 60_000 };
    expect(assessReport({ ...base(), lossIn: 0.5, concealed: 4, audioIn })).toEqual({
      severity: 'poor',
      causes: ['Gelen paket kaybı (indirme hattı)'],
    });
    expect(assessReport({ ...base(), lossIn: 0.5, jitterIn: 35, audioIn }).severity).toBe('poor');
    expect(assessReport({ ...base(), lossIn: 0.5, concealed: 0.2, audioIn })).toEqual({
      severity: 'warn',
      causes: ['Gelen paket kaybı (kaynağı belirsiz: konuşanın bağlantısı olabilir)'],
    });
    // Eski yol (yalnızca lossIn) değişmedi
    expect(assessReport({ ...base(), lossIn: 12 }).causes).toEqual(['Gelen paket kaybı (indirme hattı)']);
    expect(assessReport({ ...base(), lossIn: 12, audioIn }).severity).toBe('poor');
  });

  it('boyut sınırını aşan gün dosyaya yazılmaz; eski günler silinir', async () => {
    const dir = path.join(tmp, 't');
    const store = new VoiceTelemetryStore({ dir, maxDayBytes: 1_500, retentionDays: 14 });
    for (let i = 0; i < 5; i++) store.ingest('u', report(), { channelId: null, guildId: null });
    await store.flush();
    const day = dayKey(Date.now(), 180);
    expect(fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).length).toBeLessThan(5);
    expect(store.dropped).toBeGreaterThan(0);
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
    await store.removeOldFiles();
    expect(fs.existsSync(path.join(dir, '2020-01-01.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${day}.jsonl`))).toBe(true);
    await store.stop();
  });
});

describe('ses geçmişi', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(async () => {
    await s.close();
  });

  it('ses ve yayın süreleri, kanallar, kişiler ve son oturumlar', async () => {
    const member = await s.member('uye');
    const voice = s.channel('voice');
    s.ctx.voice.join(member.user.id, voice.id);
    s.ctx.voice.setStreaming(member.user.id, voice.id, true);
    s.ctx.voice.join(s.owner.user.id, voice.id);
    s.ctx.voice.setStreaming(member.user.id, voice.id, false);
    s.ctx.voice.leave(s.owner.user.id, voice.id);
    const db = s.ctx.store.db;
    const rows = db.prepare('SELECT id, user_id, kind, end_reason, ended_at IS NULL AS open FROM voice_sessions ORDER BY id').all() as {
      id: number;
    }[];
    expect(rows.map(({ id: _id, ...r }) => r)).toEqual([
      { user_id: member.user.id, kind: 'voice', end_reason: null, open: 1 },
      { user_id: member.user.id, kind: 'stream', end_reason: 'end', open: 0 },
      { user_id: s.owner.user.id, kind: 'voice', end_reason: 'leave', open: 0 },
    ]);
    // Süreler anlamlı olsun diye zamanlar geriye çekilir; bir de birkaç saat öncesinden oturum (saatlere bölünür)
    const now = Date.now();
    const min = 60_000;
    const set = db.prepare('UPDATE voice_sessions SET started_at = ?, ended_at = ? WHERE id = ?');
    set.run(now - 30 * min, null, rows[0]!.id);
    set.run(now - 20 * min, now - 10 * min, rows[1]!.id);
    set.run(now - 50 * min, now - 40 * min, rows[2]!.id);
    db.prepare(`INSERT INTO voice_sessions (user_id, guild_id, channel_id, kind, started_at, ended_at, end_reason) VALUES (?, ?, ?, 'voice', ?, ?, 'leave')`).run(
      s.owner.user.id,
      s.guildId,
      voice.id,
      now - 3 * 3_600_000,
      now - 3_600_000,
    );
    const h = (await s.req(s.owner.token, 'GET', '/api/admin/voice-history?days=7&tz=-180')).json();
    expect(h.perDay).toHaveLength(7);
    expect(h.totals).toMatchObject({ users: 2, sessions: 3, streams: 1, streamers: 1 });
    expect(h.totals.voiceMin).toBeCloseTo(160, 0);
    expect(h.totals.streamMin).toBeCloseTo(10, 0);
    const owner = h.userStats.find((u: { userId: string }) => u.userId === s.owner.user.id);
    expect(owner.voiceMin).toBeGreaterThanOrEqual(120);
    expect(h.userStats.find((u: { userId: string }) => u.userId === member.user.id).online).toBe(true);
    expect(h.heatmap).toHaveLength(7);
    expect(h.heatmap.flat().reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(h.totals.voiceMin, 0);
    expect(h.channels[0]).toMatchObject({ channelId: voice.id, users: 2 });
    expect(h.channelNames[voice.id].name).toBe(voice.name);
    expect(h.users[member.user.id].username).toBe('uye');
    expect(h.recent.length).toBe(4);
    expect(h.trackingSince).toBeLessThanOrEqual(now - 3 * 3_600_000);
    expect(h.perDay.at(-1).peak).toBeGreaterThanOrEqual(1);
  });

  it('sunucu yeniden başlayınca açık oturumlar kapanır; kişi hâlâ seste ise aynı oturum sürer', async () => {
    const file = path.join(tmp, 'diskort.db');
    const first = await buildApp(config, { dbFile: file, logger: false, livekit: s.livekit });
    const reg = await first.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: first.ctx.store.ensureBootstrapInvite()!.code, username: 'sahip', password: 'sifre12345' },
    });
    const userId = reg.json().user.id as string;
    const voice = first.ctx.store.listChannels(first.ctx.guild.id).find((c) => c.type === 'voice')!;
    first.ctx.voice.join(userId, voice.id);
    await first.app.close();

    const second = await buildApp(config, { dbFile: file, logger: false, livekit: s.livekit });
    try {
      const db = second.ctx.store.db;
      expect(db.prepare('SELECT end_reason, ended_at IS NULL AS open FROM voice_sessions').all()).toEqual([
        { end_reason: 'restart', open: 0 },
      ]);
      // LiveKit eşitlemesi kişiyi yeniden ekler: aynı oturum sürer
      second.ctx.voice.reconcile(new Map([[userId, { channelId: voice.id, streaming: false }]]));
      expect(db.prepare('SELECT COUNT(*) AS n, MAX(ended_at IS NULL) AS open FROM voice_sessions').get()).toEqual({ n: 1, open: 1 });
      // Normal çıkış sürdürülemez
      second.ctx.voice.leave(userId, voice.id);
      second.ctx.voice.join(userId, voice.id);
      expect(db.prepare('SELECT COUNT(*) AS n FROM voice_sessions').get()).toEqual({ n: 2 });
    } finally {
      await second.app.close();
    }
  });
});

describe('güvenlik: girişler ve davetler', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(async () => {
    await s.close();
  });

  it('başarılı/başarısız girişler, davet kullanımları; şifre ve hesabı olmayan ad yazılmaz', async () => {
    const member = await s.member('uye');
    const login = (username: string, password: string, ua: string) =>
      s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: { 'user-agent': ua } });
    expect((await login('uye', 'yanlis-sifre', 'okhttp/4.12.0')).statusCode).toBe(401);
    expect((await login('gizli-sifrem-123', 'x', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36')).statusCode).toBe(401);
    expect((await login('uye', 'sifre12345', 'Mozilla/5.0 diskort/0.6.13 Chrome/140 Electron/44.0.0')).statusCode).toBe(200);

    const sec = (await s.req(s.owner.token, 'GET', '/api/admin/security')).json();
    expect(sec.counts).toMatchObject({ login24h: 1, failed24h: 2 });
    const [ok, unknown, wrong] = sec.events;
    expect(ok).toMatchObject({ kind: 'login', username: 'uye', userId: member.user.id, client: 'Masaüstü uygulaması' });
    expect(unknown).toMatchObject({ kind: 'login_failed', username: null, userId: null, detail: 'böyle bir hesap yok', client: 'Tarayıcı · Chrome · Windows' });
    expect(wrong).toMatchObject({ kind: 'login_failed', username: 'uye', detail: 'şifre hatalı', client: 'Android uygulaması' });
    expect(JSON.stringify(sec)).not.toContain('gizli-sifrem');
    expect(JSON.stringify(sec)).not.toContain('yanlis-sifre');
    expect(sec.failuresByIp[0]).toMatchObject({ count: 2, usernames: ['uye'] });
    // Kayıtlar: sahip ve üye (davetle)
    expect(sec.events.filter((e: { kind: string }) => e.kind === 'register')).toHaveLength(2);

    // Davet kullanımları: üye sahibin hesap davetiyle hesap açtı, sunucu davetiyle katıldı; kodlar maskelenir
    const uses = sec.inviteUses.filter((u: { userId: string }) => u.userId === member.user.id);
    const use = uses.find((u: { kind: string }) => u.kind === 'register');
    expect(use).toMatchObject({ inviterId: s.owner.user.id, guildId: null, kind: 'register' });
    expect(uses.find((u: { kind: string }) => u.kind !== 'register')).toMatchObject({ inviterId: s.owner.user.id, guildId: s.guildId });
    expect(use.code).toMatch(/^[A-Z0-9]{3}•+$/);
    expect(sec.invites.every((i: { code: string }) => i.code.includes('•'))).toBe(true);
    expect(sec.users[s.owner.user.id].username).toBe('sahip');
    expect(sec.admins).toEqual([s.owner.user.id]);
    expect(sec.recentAccounts).toHaveLength(2);
  });

  it('istemci adları ve dosyaya yazılan kayıtların saklama süresi', async () => {
    expect(clientOf(null)).toBe('bilinmiyor');
    expect(clientOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1')).toBe('Tarayıcı · Safari · iOS');
    const file = path.join(tmp, 'auth-log.jsonl');
    const old = { at: Date.now() - 40 * 86_400_000, kind: 'login', userId: 'a', username: 'a', ip: '1.1.1.1', ua: null, client: 'x' };
    fs.writeFileSync(file, `${JSON.stringify(old)}\nbozuk\n`);
    const log = new AuthLog(file);
    expect(log.recent(10)).toEqual([]);
    log.record({ kind: 'login', userId: 'b', username: 'b', ip: '2.2.2.2', ua: 'okhttp/4' });
    await log.flush();
    const again = new AuthLog(file);
    expect(again.recent(10).map((e) => e.userId)).toEqual(['b']);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('1.1.1.1');
  });
});

describe('API sağlığı ve sunucu günlüğü', () => {
  it('istek sayıları, gecikmeler, 429 kayıtları ve günlükteki hatalar', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const s = await startServer({ logStream });
    try {
      for (let i = 0; i < 21; i++) {
        await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'yok', password: 'x' } });
      }
      s.app.log.error({ err: new Error('disk dolu') }, 'yedek yazılamadı');
      s.app.log.warn('yalnızca uyarı');
      const a = (await s.req(s.owner.token, 'GET', '/api/admin/api-stats')).json();
      expect(a.lastHour.total).toBeGreaterThanOrEqual(22);
      expect(a.lastHour.limited).toBeGreaterThanOrEqual(1);
      expect(a.perMinute.length).toBeGreaterThanOrEqual(60);
      const loginRoute = a.routes.find((r: { route: string }) => r.route === 'POST /api/auth/login');
      expect(loginRoute.count).toBe(21);
      expect(loginRoute.p95).toBeGreaterThanOrEqual(loginRoute.p50);
      expect(a.groups.find((g: { group: string }) => g.group === '/api/auth').count).toBeGreaterThanOrEqual(21);
      expect(a.rateLimited.recent[0]).toMatchObject({ method: 'POST', route: '/api/auth/login' });
      expect(a.logs.recent[0]).toMatchObject({ level: 50, msg: 'yedek yazılamadı', err: 'disk dolu' });
      expect(a.logs.total).toBe(1);
      expect(a.gateway).toMatchObject({ openSockets: 0, messagesIn: 0 });
      // Günlüğün kendisi değişmedi
      expect(lines.some((l) => l.includes('yedek yazılamadı'))).toBe(true);
      // Giriş kayıtlarında sınır aşımı
      const sec = (await s.req(s.owner.token, 'GET', '/api/admin/security')).json();
      expect(sec.counts.limited24h).toBeGreaterThanOrEqual(1);
    } finally {
      await s.close();
    }
  });

  it('yol grupları', () => {
    expect(routeGroup('/api/channels/:channelId/messages')).toBe('/api/channels');
    expect(routeGroup('/download/:platform')).toBe('/download');
    expect(routeGroup('(eşleşmeyen)')).toBe('/');
  });
});

describe('LiveKit ve altyapı ölçümleri', () => {
  it('Prometheus metni okunur', () => {
    const samples = parsePromText('# c\nfoo{a="1",b="x\\"y"} 3\nbar 1e3 1700000000\nbaz +Inf\nbozuk satır\n');
    expect(samples).toEqual([
      { name: 'foo', labels: { a: '1', b: 'x"y' }, value: 3 },
      { name: 'bar', labels: {}, value: 1000 },
      { name: 'baz', labels: {}, value: Number.POSITIVE_INFINITY },
    ]);
    expect(counterRate(10, 5, 5)).toBe(1);
    expect(counterRate(1, 5, 5)).toBeNull();
    const snap = new PromSnapshot(samples, 0);
    expect(snap.sum('foo', (l) => l.a === '2')).toBe(0);
    expect(snap.sum('yok')).toBeNull();
  });

  it('iki ölçümden hızlar: bayt, paket, kayıp, NACK, gecikme, süreç', () => {
    const a = PromSnapshot.parse(lkText(1), 0);
    const b = PromSnapshot.parse(lkText(2), 10_000);
    const x = liveKitSample(b, a);
    expect(x).toMatchObject({
      rooms: 1,
      participants: 3,
      tracksPublished: { audio: 3, video: 1 },
      bytesIn: 100_000,
      bytesOut: 201_000,
      packetsIn: 100,
      packetsOut: 200,
      nack: 0.5,
      pli: 0.2,
      rttMs: 30,
      cpu: 0.25,
      rss: 1.2e8,
      goroutines: 321,
    });
    expect(x.lossInPct).toBeCloseTo((1 / 101) * 100, 5);
    expect(liveKitSample(b, null).bytesIn).toBeNull();
  });

  it('uç kapalıysa "metrikler kapalı"; açılınca geçmiş, kapsayıcılar, Caddy ve yedekler', async () => {
    const lkUrl = 'http://lk.test/metrics';
    const caddyUrl = 'http://caddy.test/metrics';
    const closed = new LiveKitMetrics({ url: lkUrl, fetchImpl: promFetch({}) });
    expect(await closed.status()).toMatchObject({ configured: true, ok: false, error: 'bağlantı reddedildi (ölçüm ucu kapalı)', latest: null });
    expect(await new LiveKitMetrics({ url: null }).status()).toMatchObject({ configured: false, ok: false });

    const fetchImpl = promFetch({
      [lkUrl]: [lkText(1), lkText(2)],
      [caddyUrl]: [
        'process_cpu_seconds_total 100\nprocess_resident_memory_bytes 5e7\ncaddy_layer4_proxy_connections_total{upstream="tcp/127.0.0.1:5349"} 400\ncaddy_layer4_proxy_active_connections{upstream="tcp/127.0.0.1:5349"} 2\ncaddy_reverse_proxy_upstreams_healthy{upstream="127.0.0.1:3000"} 1\ncaddy_reverse_proxy_upstreams_healthy{upstream="127.0.0.1:7880"} 0',
        'process_cpu_seconds_total 101\nprocess_resident_memory_bytes 5e7\ncaddy_layer4_proxy_connections_total{upstream="tcp/127.0.0.1:5349"} 406\n',
      ],
    });
    const lk = new LiveKitMetrics({ url: lkUrl, fetchImpl });
    await lk.scrape(1_000_000);
    await lk.scrape(1_010_000);
    const status = await lk.status(1_010_000);
    expect(status).toMatchObject({ configured: true, ok: true, error: null });
    expect(status.latest?.bytesIn).toBe(100_000);
    expect(status.raw.map((r) => r.name)).toContain('livekit_packet_bytes');
    expect(status.raw.some((r) => r.name.endsWith('_bucket'))).toBe(false);
    expect(lk.historySince(0)).toHaveLength(1);

    // Yedek klasörü ve sahte cgroup
    const backups = path.join(tmp, 'yedek');
    fs.mkdirSync(path.join(backups, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(backups, 'diskort-2026-09-27_0400.db.gz'), 'x'.repeat(100));
    fs.writeFileSync(path.join(backups, 'diskort-2026-09-28_0400.db.gz'), 'x'.repeat(200));
    fs.writeFileSync(path.join(backups, 'baska.txt'), 'y');
    const old = new Date('2026-09-27T01:00:00Z');
    fs.utimesSync(path.join(backups, 'diskort-2026-09-27_0400.db.gz'), old, old);
    const cgroup = path.join(tmp, 'cgroup');
    fs.mkdirSync(cgroup);
    fs.writeFileSync(path.join(cgroup, 'memory.current'), '104857600\n');
    fs.writeFileSync(path.join(cgroup, 'memory.max'), 'max\n');
    fs.writeFileSync(path.join(cgroup, 'cpu.stat'), 'usage_usec 1000000\nuser_usec 800000\n');
    const infra = new InfraMonitor(
      { cgroupRoot: cgroup, caddyMetricsUrl: caddyUrl, backupDir: backups, tlsDomains: [], tlsHost: '127.0.0.1', fetchImpl },
      lk,
    );
    await infra.sample(1_000_000);
    fs.writeFileSync(path.join(cgroup, 'cpu.stat'), 'usage_usec 3000000\n');
    await infra.sample(1_010_000);
    const snap = await infra.snapshot(1_010_000);
    expect(snap.containers).toMatchObject([
      { name: 'api', cpu: 0.2, memory: 104857600, memoryLimit: null, source: 'cgroup', ok: true },
      { name: 'livekit', cpu: 0.25, memory: 1.2e8, ok: true },
      { name: 'caddy', cpu: 0.1, memory: 5e7, ok: true },
    ]);
    expect(snap.caddy).toMatchObject({ ok: true, turnPerMin: 36, turnTotal: 406 });
    expect(snap.backups).toMatchObject({ configured: true, count: 2, totalBytes: 300, latest: { name: 'diskort-2026-09-28_0400.db.gz', size: 200 } });
    expect(snap.backups!.attachmentsAt).not.toBeNull();
    expect(snap.history).toHaveLength(2);
  });

  it('altyapı ucu: ölçümler kapalıyken de yanıt verir; sayaçlar (bildirim, indirme) görünür', async () => {
    const s = await startServer();
    try {
      s.ctx.counters.inc('push.android.sent', 3);
      s.ctx.counters.inc('push.ios.failed');
      s.ctx.counters.inc('download.windows', 2);
      const d = (await s.req(s.owner.token, 'GET', '/api/admin/infra')).json();
      expect(d.livekit).toMatchObject({ configured: false, ok: false, history: [] });
      expect(d.containers.map((c: { name: string }) => c.name)).toEqual(['api', 'livekit', 'caddy']);
      expect(d.backups).toMatchObject({ configured: false });
      expect(d.tls).toEqual([]);
      expect(d.push.counts.day).toMatchObject({ 'android.sent': 3, 'ios.failed': 1 });
      expect(d.push.daily.sent.at(-1).count).toBe(3);
      expect(d.downloads.counts.week).toMatchObject({ windows: 2 });
    } finally {
      await s.close();
    }
  });
});

describe('gün sayaçları', () => {
  it('toplamlar, günlük seri, dosyaya yazma ve yeniden okuma', async () => {
    const file = path.join(tmp, 'counters.json');
    const day = 86_400_000;
    const now = Date.UTC(2026, 8, 28, 12);
    const c = new DailyCounters(file, 180, now);
    c.inc('a', 2, now - 2 * day);
    c.inc('a', 1, now);
    c.inc('b.x', 5, now);
    c.inc('b.y', 1, now - day);
    expect(c.sum('a', 1, now)).toBe(1);
    expect(c.sum('a', 7, now)).toBe(3);
    expect(c.sumsByPrefix('b.', 7, now)).toEqual({ x: 5, y: 1 });
    expect(c.series('a', 3, now).map((d) => d.count)).toEqual([2, 0, 1]);
    await c.persist(now, true);
    const again = new DailyCounters(file, 180, now);
    expect(again.sum('a', 7, now)).toBe(3);
    // Gün sınırı UTC+3'e göre: 21:30 UTC ertesi gün sayılır
    expect(dayKey(Date.UTC(2026, 8, 28, 21, 30), 180)).toBe('2026-09-29');
  });
});

describe('sunucular', () => {
  it('üyeler, kanallar, mesajlar, en çok yazanlar (yalnızca sayılar), ses dakikaları', async () => {
    const s = await startServer();
    try {
      const member = await s.member('uye');
      const text = s.channel('text');
      for (const content of ['bir', 'iki', 'üç']) await s.req(member.token, 'POST', `/api/channels/${text.id}/messages`, { content });
      await s.req(s.owner.token, 'POST', `/api/channels/${text.id}/messages`, { content: 'selam' });
      s.ctx.voice.join(member.user.id, s.channel('voice').id);
      const g = (await s.req(s.owner.token, 'GET', '/api/admin/guilds')).json();
      const main = g.guilds.find((x: { id: string }) => x.id === s.guildId);
      expect(main).toMatchObject({ members: 2, messages: { total: 4, last7d: 4 }, ownerId: s.owner.user.id });
      expect(main.topPosters).toEqual([
        { userId: member.user.id, count: 3 },
        { userId: s.owner.user.id, count: 1 },
      ]);
      expect(main.channels.text).toBeGreaterThanOrEqual(1);
      expect(main.voice7d.voiceMin).toBeGreaterThanOrEqual(0);
      expect(g.users[member.user.id].username).toBe('uye');
      expect(JSON.stringify(g)).not.toContain('selam');
      expect(g.dms).toMatchObject({ conversations: 0, messages: 0 });
    } finally {
      await s.close();
    }
  });
});

describe('ölçüm gönderimi', () => {
  it('geçersiz oturumla ölçüm gönderilemez', async () => {
    const { app } = await buildApp(config, { dbFile: ':memory:', logger: false });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/telemetry/voice', headers: auth('gecersiz'), payload: report() });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
