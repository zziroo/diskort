import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUsers,
  diagnose,
  FreezeCorrelator,
  isRelevantEntry,
  simultaneous,
  summarizeLiveKit,
  type FreezeUser,
} from '../src/freezeDiagnosis.js';
import type { LkRow } from '../src/infraStats.js';
import type { Outage } from '../src/netOutages.js';
import { SecondSampler, summarizeRows, type ProcFiles, type SecondRow } from '../src/netSeconds.js';
import type { TelemetryEntry } from '../src/telemetry.js';

// Bağlantı teşhisi: sınıflandırıcı ve olay toplayıcı. Fikstürler gerçek olaylardan:
//  - 2026-10-01 01:18 / 01:23:47: sunucu sağlıklı (livekit ~%22, UDP hatası 0), 4 kullanıcının hepsinde %12-20
//    giden kayıp, ping normal, izleyicilerde 2-7 donma, yayıncı 1080p ~8-9 Mbps, AMD H.264, 17-25 fps.
//  - Boştayken bile 1-4 sn boyunca sunucuya paket gelmemesi (gelen 40-250 → 0-8 pk/sn, dış UDP ve TCP sondaları
//    aynı anda yanıtsız, NIC düşüşü 0): kayıp sunucunun dışında (sağlayıcı).
//  - Yayında donmadan hemen önce yayıncının gelen akışı 3 → 10-12 Mbps, sunucu çıkışı ~39 Mbps / 4300 pk/sn.
//  - 211 saniyede 27 NIC düşüşü yüzünden yanlışlıkla "sunucu kaynağı" denen olay.

const T0 = Date.parse('2026-10-01T01:18:00+03:00');

function entry(userId: string, over: Partial<TelemetryEntry> = {}, at = T0 + 30_000): TelemetryEntry {
  return {
    at,
    userId,
    channelId: 'kanal',
    guildId: 'sunucu',
    platform: 'desktop',
    version: '0.9.3',
    windowSec: 30,
    quality: 'good',
    poorSec: 0,
    serverQuality: 'excellent',
    rttAvg: 30,
    rttMax: 45,
    jitterIn: 4,
    jitterOut: 3,
    lossOut: 0,
    lossIn: 0,
    concealed: 0,
    bitrateOut: 40_000,
    bitrateIn: 40_000,
    availableOut: null,
    candidate: 'host',
    protocol: 'udp',
    reconnects: 0,
    mic: null,
    screen: null,
    severity: 'ok',
    causes: [],
    ...over,
  };
}

const streamerScreen = (over: object = {}) => ({
  width: 1920,
  height: 1080,
  fps: 21,
  bitrate: 8_500_000,
  encoder: 'AMD H.264 HW',
  codec: 'video/H264',
  limitation: 'none' as const,
  limitedRatio: 0,
  hardware: true,
  ...over,
});
const watching = (freezes: number, over: object = {}) => ({
  codec: 'video/H264',
  decoder: 'x',
  hardware: true,
  powerEfficient: true,
  width: 1920,
  height: 1080,
  fps: 18,
  decodeMs: 3,
  decodeMsMax: 6,
  bitrate: 6_000_000,
  framesDropped: 10,
  freezes,
  freezeSec: freezes * 0.8,
  jitterBufferMs: 80,
  view: null,
  ...over,
});

/** Olaydaki 4 kullanıcı: yayıncı + 3 izleyici, hepsinde giden kayıp (aynı 30 sn'lik pencerede) */
function incidentEntries(): TelemetryEntry[] {
  return [
    entry('yayinci', { lossOut: 15, lossIn: 0, screen: streamerScreen() }),
    entry('i1', { lossOut: 12, lossIn: 14, watch: watching(7) }),
    entry('i2', { lossOut: 20, lossIn: 16, watch: watching(2) }),
    entry('i3', { lossOut: 17, lossIn: 13, watch: watching(4) }),
  ];
}

/** Sağlıklı sunucu satırları (livekit %22, NIC düşüşü yok) */
function healthyRows(n = 60, over: Partial<SecondRow> = {}, probe: 'temiz' | 'kayip' | 'tek' | 'yok' = 'temiz'): SecondRow[] {
  const p = (i: number): Record<string, number> | undefined => {
    if (probe === 'yok') return undefined;
    // 'tek': yalnızca bir hedefte (8.8.8.8) kayıp: o çözücünün hız sınırı olabilir
    if (i % 2 === 0) return { 'udp 1.1.1.1': probe === 'kayip' && i % 4 === 0 ? -1 : 9 };
    return { 'udp 8.8.8.8': probe === 'temiz' ? 14 : probe === 'tek' && i % 10 !== 1 ? 14 : -1 };
  };
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * 1000,
    rx: 12,
    tx: 28,
    rxp: 2500,
    txp: 3200,
    nd: 0,
    ue: 0,
    ur: 0,
    us: 0,
    sd: 0,
    psi: 1,
    lk: 0.22,
    ...(p(i) ? { p: p(i)! } : {}),
    ...over,
  }));
}
const summary = (rows: SecondRow[], outages: Outage[] = []) => summarizeRows(rows, T0, T0 + rows.length * 1000, 4, { outages });

function outage(kind: Outage['kind'], atSec: number, durationMs: number): Outage {
  const at = T0 + atSec * 1000;
  return {
    id: `k${atSec}`,
    at,
    durationMs,
    t: `2026-10-01 01:18:${String(atSec).padStart(2, '0')}.000 +03:00`,
    kind,
    probe: kind === 'aday' ? null : { at, durationMs, lost: 12, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8', 'udp 8.8.8.8'], udp: true, tcp: true },
    nic: kind === 'sonda' ? null : { at, durationMs, rxpMin: 4, baseline: 70, participants: 0, probesLost: kind === 'tam' ? 12 : 0, probeTargets: kind === 'tam' ? ['udp 1.1.1.1', 'tcp 8.8.8.8'] : [], txCollapsed: true },
  };
}

describe('sınıflandırıcı: sağlayıcı yolu', () => {
  it('4 kullanıcıda aynı anda giden kayıp, ping normal, sunucu sağlıklı, sondalar temiz: sunucuya gelen yol', () => {
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows()));
    expect(d.cause).toBe('saglayici_gelen');
    expect(d.segment).toBe('saglayici_gelen');
    expect(d.label).toBe('Sunucuya gelen yol (sağlayıcı)');
    expect(d.summary).toBe('Sorun: sunucuya gelen yol (barındırma sağlayıcısı) — 4 kullanıcının gönderdiği paketler aynı anda kayboldu');
    expect(d.probe).toBe('temiz');
    expect(d.confidence).toBe('yüksek');
    expect(d.evidence.join(' ')).toContain('4 kullanıcıda aynı anda giden kayıp %12–20');
    expect(d.evidence.join(' ')).toContain('ping normal');
    expect(d.evidence.join(' ')).toContain('toplam 13 donma');
    expect(d.evidence.join(' ')).toContain('NIC düşüşü 0');
    // Yayıncı 21 fps: ikincil etken olarak not edilir (ana neden kayıp)
    expect(d.factors.join(' ')).toContain('21–21 fps');
    expect(d.factors.join(' ')).toContain('AMD H.264 HW');
    // Eksik kanıt açıkça yazılır
    expect(d.missing.join(' ')).toContain('servis sağlayıcı bilgisi telemetride yok');
    expect(d.missing.join(' ')).toContain('LiveKit ölçümleri yok');
    expect(d.missing.join(' ')).toContain('patlama profilli hat testi');
  });

  it('iki kullanıcıda aynı anda giden kayıp: orta güven; NIC sessizliği adayı da varsa yüksek', () => {
    const two = [entry('a', { lossOut: 14 }), entry('b', { lossOut: 9 }), entry('c', {})];
    expect(diagnose(buildUsers(two), summary(healthyRows()))).toMatchObject({ cause: 'saglayici_gelen', confidence: 'orta' });
    const d = diagnose(buildUsers(two), summary(healthyRows(), [outage('aday', 12, 2_600)]));
    expect(d).toMatchObject({ cause: 'saglayici_gelen', confidence: 'yüksek' });
    expect(d.summary).toBe('Sorun: sunucuya gelen yol (barındırma sağlayıcısı) — sunucuya gelen paketler 2,6 sn kesildi');
    expect(d.evidence[0]).toContain('NIC sessizliği: 01:18:12 anında 2,6 sn');
  });

  it('doğrulanmamış NIC sessizliği (aday) tek başına sağlayıcıyı seçmez: tek etkilenen kullanıcıda yayıncı/izleyici adımlarına düşer', () => {
    const aday = [outage('aday', 12, 2_000)];
    // Yalnızca yayıncıda giden kayıp: yayıncının hattı (aday etken olarak yazılır)
    const streamer = diagnose(
      buildUsers([entry('yayinci', { lossOut: 18, screen: streamerScreen({ fps: 28 }) }), entry('i1', { lossIn: 15, watch: watching(5) }), entry('i2', { lossIn: 12, watch: watching(3) })]),
      summary(healthyRows(), aday),
    );
    expect(streamer.cause).toBe('yayinci_yukleme');
    expect(streamer.factors.join(' ')).toContain('NIC sessizliği adayı: 01:18:12 anında 2,0 sn');
    expect(streamer.factors.join(' ')).toContain('tek başına sağlayıcıyı göstermez');
    // Tek izleyicide gelen kayıp: tek kullanıcı
    const viewer = diagnose(buildUsers([entry('yayinci', { screen: streamerScreen({ fps: 30 }) }), entry('i1', { lossIn: 14, watch: watching(5) })]), summary(healthyRows(), aday));
    expect(viewer.cause).toBe('tek_kullanici');
    // Kimsede kayıp yok, kodlayıcı düşük: kodlayıcı
    const enc = diagnose(
      buildUsers([entry('yayinci', { screen: streamerScreen({ fps: 17, limitation: 'cpu', limitedRatio: 0.6 }) }), entry('i1', { watch: watching(6) }), entry('i2', { watch: watching(3) })]),
      summary(healthyRows(), aday),
    );
    expect(enc.cause).toBe('kodlayici');
    expect(enc.probe).toBe('temiz');
    // Sondalarla doğrulanmış sessizlik (kayıtlı sonda kesintisi olmadan da) tam kesintidir
    const confirmed: ReturnType<typeof outage> = { ...outage('tam', 12, 1_000), probe: null };
    confirmed.nic!.probesLost = 2;
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows(), [confirmed]));
    expect(d.cause).toBe('saglayici_kesinti');
    expect(d.evidence[0]).toContain('aynı saniyelerde 2 dış sonda yanıtsız kaldı');
    expect(d.evidence[0]).toContain('giden paketler de durdu');
    expect(d.probe).toBe('kayıp');
  });

  it('birden çok dış hedefte kayıp: sağlayıcı yolu etkeni; tek hedefteki kayıp sağlayıcıyı suçlamaz', () => {
    const two = diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, {}, 'kayip')));
    expect(two.cause).toBe('saglayici_gelen');
    expect(two.probe).toBe('kayıp');
    expect(two.factors).toContain('sağlayıcı/VPS ağ yolu: dış sondalarda da kayıp');
    // Yalnızca 8.8.8.8'de yanıtsız sondalar (eski kural: toplam ≥ %5 → "sağlayıcı")
    const s = summary(healthyRows(60, {}, 'tek'));
    expect(s.probes['udp 8.8.8.8']).toMatchObject({ sent: 30, lost: 6 });
    expect(s.probes['udp 1.1.1.1']).toMatchObject({ sent: 30, lost: 0 });
    expect(s.probeLossPct).toBeGreaterThanOrEqual(5);
    expect(s.probeLossyTargets).toEqual(['udp 8.8.8.8']);
    const one = diagnose(buildUsers(incidentEntries()), s);
    expect(one.probe).toBe('temiz');
    expect(one.evidence.join(' ')).toContain('tek hedef');
    expect(one.factors.join(' ')).not.toContain('dış sondalarda da kayıp');
  });

  it('sonda verisi yoksa sonda "yok" ve eksik kanıt olarak yazılır', () => {
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, {}, 'yok')));
    expect(d.cause).toBe('saglayici_gelen');
    expect(d.probe).toBe('yok');
    expect(d.missing).toContain('Dış sonda verisi yok.');
  });

  it('tam kesinti (dış sondalar yanıtsız + NIC sessiz): sağlayıcı ağı, yüksek güven, süre özet cümlesinde', () => {
    // Boşta taban çizgisi ~70 pk/sn; 4 sn boyunca 0-8 pk/sn
    const rows = healthyRows(60, { rx: 0.1, tx: 0.1, rxp: 70, txp: 60 });
    for (let i = 20; i < 24; i++) rows[i] = { ...rows[i]!, rxp: i % 2 === 0 ? 0 : 8, o: 3, p: { 'udp 1.1.1.1': -1, 'tcp 8.8.8.8': -1 } };
    const s = summary(rows, [outage('tam', 20, 3_800)]);
    expect(s.rxDip).toMatchObject({ pps: 0, baseline: 70, pct: 0 });
    expect(s.rxPpsMin).toBe(0);
    const d = diagnose(buildUsers(incidentEntries()), s);
    expect(d.cause).toBe('saglayici_kesinti');
    expect(d.segment).toBe('saglayici');
    expect(d.confidence).toBe('yüksek');
    expect(d.summary).toBe('Sorun: barındırma sağlayıcısının ağı — sunucuya 3,8 sn hiç paket ulaşmadı');
    expect(d.probe).toBe('kayıp');
    expect(d.evidence[0]).toContain('Tam kesinti: 01:18:20 anında 3,8 sn');
    expect(d.evidence[0]).toContain('UDP ve TCP birlikte');
    expect(d.evidence.join(' ')).toContain('NIC düşüşü 0');
  });

  it('yalnızca dış sondalar kesildiyse yine sağlayıcı ağı; NIC sessizliği eksik kanıt', () => {
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows(), [outage('sonda', 10, 1_500)]));
    expect(d.cause).toBe('saglayici_kesinti');
    expect(d.confidence).toBe('yüksek'); // 4 kullanıcıda aynı anda giden kayıp
    expect(d.summary).toContain('dış bağlantısı 1,5 sn kesildi');
    expect(d.missing.join(' ')).toContain('NIC sessizliği saptanmadı');
    const one = diagnose(buildUsers([entry('yayinci', { screen: streamerScreen({ fps: 30 }) }), entry('i1', { lossIn: 14, watch: watching(5) })]), summary(healthyRows(), [outage('sonda', 10, 1_500)]));
    expect(one).toMatchObject({ cause: 'saglayici_kesinti', confidence: 'orta' });
  });

  it('yalnız UDP sondalarının kesintisi (TCP yanıt verdi) sağlayıcı kesintisi yargısını seçmez; ayrı ve zayıf bir işaret olarak anılır', () => {
    const o = outage('sonda', 10, 1_500);
    const udpOnly: Outage = { ...o, probe: { ...o.probe!, targets: ['udp 1.1.1.1', 'udp 8.8.8.8'], tcp: false, proto: 'udp' } };
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows(), [udpOnly]));
    expect(d.cause).not.toBe('saglayici_kesinti');
    expect(d.cause).toBe('saglayici_gelen');
    expect(d.probe).toBe('temiz');
    expect(d.evidence.join(' ')).toContain('Yalnız UDP sondaları 01:18:10 anında 1,5 sn art arda yanıtsız kaldı');
    expect(d.evidence.join(' ')).toContain('TCP sondaları yanıt verdi');
    expect(d.evidence.join(' ')).not.toContain('sunucunun dış yolu kesildi');
    // Tek izleyicide kayıp: sağlayıcı kesintisine düşmez
    const one = diagnose(buildUsers([entry('yayinci', { screen: streamerScreen({ fps: 30 }) }), entry('i1', { lossIn: 14, watch: watching(5) })]), summary(healthyRows(), [udpOnly]));
    expect(one.cause).not.toBe('saglayici_kesinti');
  });

  it('kayıptan hemen önceki patlama etken olarak yazılır (39 Mbps / 4300 pk/sn, 2 sn önce)', () => {
    const rows = healthyRows(60, { rx: 3, tx: 12, rxp: 900, txp: 1400 });
    for (const i of [18, 19]) rows[i] = { ...rows[i]!, rx: 11, tx: 39, txp: 4300 };
    for (let i = 21; i < 24; i++) rows[i] = { ...rows[i]!, rxp: 80, rx: 0.1 };
    const s = summary(rows, [outage('tam', 20, 3_000)]);
    expect(s.burst).toMatchObject({ at: T0 + 18_000, txMbps: 39, txPps: 4300, rxMbps: 11, baseTxMbps: 12, baseRxMbps: 3, secBeforeLoss: 2 });
    expect(s.txPeak).toMatchObject({ mbps: 39, pps: 4300 });
    const d = diagnose(buildUsers(incidentEntries()), s);
    expect(d.cause).toBe('saglayici_kesinti');
    const f = d.factors.find((x) => x.startsWith('patlama_sonrasi'))!;
    expect(f).toContain('kayıptan 2 sn önce giden 39,0 Mbps / 4300 pk/sn');
    expect(f).toContain('olağanı 12,0 Mbps');
    expect(f).toContain('gelen 3,0 → 11,0 Mbps');
    // Patlama yoksa etken de yok
    expect(diagnose(buildUsers(incidentEntries()), summary(healthyRows())).factors.join(' ')).not.toContain('patlama_sonrasi');
  });

  it('izleyici ikisinde aynı anda gelen kayıp, yayıncı temiz: sunucudan giden yol', () => {
    const entries = [
      entry('yayinci', { screen: streamerScreen({ fps: 30 }) }),
      entry('i1', { lossIn: 15, watch: watching(5) }),
      entry('i2', { lossIn: 12, watch: watching(3) }),
    ];
    const d = diagnose(buildUsers(entries), summary(healthyRows()));
    expect(d.cause).toBe('saglayici_giden');
    expect(d.segment).toBe('saglayici_giden');
    expect(d.evidence.join(' ')).toContain('2 kullanıcıda aynı anda gelen kayıp');
    expect(d.summary).toContain('sunucudan giden yol');
  });
});

describe('sınıflandırıcı: eşzamanlılık', () => {
  it('dakikalar arayla kayıp gören kullanıcılar "ortak" sayılmaz', () => {
    const entries = [
      entry('a', { lossOut: 15 }, T0 + 30_000),
      entry('b', {}, T0 + 30_000),
      entry('a', {}, T0 + 240_000),
      entry('b', { lossOut: 12 }, T0 + 240_000),
    ];
    const users = buildUsers(entries);
    expect(simultaneous(users, (r) => (r.o ?? 0) >= 3).users).toHaveLength(1);
    const d = diagnose(users, summary(healthyRows(240)));
    expect(d.cause).toBe('ayri_kullanicilar');
    expect(d.summary).toBe('Sorun: kullanıcıların kendi hatları — kayıplar aynı anda değil');
    expect(d.evidence.join(' ')).toContain('zamanda çakışmıyor');
    // Pencereleri çakışınca (20 sn arayla 30 sn'lik pencereler) aynı anda sayılır
    const overlapping = buildUsers([entry('a', { lossOut: 15 }, T0 + 30_000), entry('b', { lossOut: 12 }, T0 + 50_000)]);
    const sim = simultaneous(overlapping, (r) => (r.o ?? 0) >= 3);
    expect(sim.users.map((u) => u.userId).sort()).toEqual(['a', 'b']);
    expect([sim.from, sim.to]).toEqual([T0 + 20_000, T0 + 30_000]);
    expect(diagnose(overlapping, null).cause).toBe('saglayici_gelen');
  });

  it('buildUsers: roller, en kötü değerler, donma toplamları, pencereler ve bağlantı yolu', () => {
    const users = buildUsers([...incidentEntries(), entry('i1', { lossOut: 4, candidate: 'relay', protocol: 'tcp', watch: watching(1) }, T0 + 60_000)]);
    const byId = Object.fromEntries(users.map((u) => [u.userId, u])) as Record<string, FreezeUser>;
    expect(byId.yayinci!.role).toBe('yayıncı');
    expect(byId.i1!.role).toBe('izleyici');
    expect(byId.i1!.lossOut).toBe(12);
    expect(byId.i1!.freezes).toBe(8);
    expect(byId.i1!.route).toBe('relay·tcp');
    expect(byId.i1!.w).toEqual([
      { a: T0 + 30_000, s: 30, o: 12, i: 14, f: 7, r: 30 },
      { a: T0 + 60_000, s: 30, o: 4, i: 0, f: 1, r: 30 },
    ]);
    expect(byId.yayinci!.screen?.encoder).toBe('AMD H.264 HW');
  });

  it('isRelevantEntry: kayıp eşiği ve donma eşiği', () => {
    expect(isRelevantEntry(entry('a', { lossOut: 2.9 }))).toBe(false);
    expect(isRelevantEntry(entry('a', { lossOut: 3 }))).toBe(true);
    expect(isRelevantEntry(entry('a', { watch: watching(1, { freezeSec: 0.4 }) }))).toBe(false);
    expect(isRelevantEntry(entry('a', { watch: watching(2) }))).toBe(true);
  });
});

describe('sınıflandırıcı: sunucu, yayıncı, tek kullanıcı', () => {
  it('211 saniyede 27 NIC düşüşü (her şey temizken) sunucu kaynağı SAYILMAZ; trafiğe oranla önemli düşüş sayılır', () => {
    const rows = healthyRows(211);
    rows[100] = { ...rows[100]!, nd: 27 };
    const s = summarizeRows(rows, T0, T0 + 211_000, 4);
    expect(s.nicDrops).toBe(27);
    const d = diagnose(buildUsers(incidentEntries()), s);
    expect(d.cause).toBe('saglayici_gelen');
    expect(d.evidence.join(' ')).toContain("NIC'te 27 paket düştü/hatalı");
    expect(d.evidence.join(' ')).toContain('önemsiz');
    // Eski eşikler (≥10 NIC düşüşü, ≥5 UDP tampon hatası) artık tek başına yetmez
    const few = healthyRows(60);
    few[30] = { ...few[30]!, nd: 25, ur: 12 };
    expect(diagnose(buildUsers(incidentEntries()), summary(few)).cause).toBe('saglayici_gelen');
    // Paketlerin %1'inden fazlası düşüyorsa sunucu
    const heavy = diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, { nd: 100, ur: 40 })));
    expect(heavy.cause).toBe('sunucu_kaynak');
    expect(heavy.segment).toBe('sunucu');
    expect(heavy.evidence.join(' ')).toContain('NIC');
    expect(heavy.evidence.join(' ')).toContain('UDP tampon');
    expect(heavy.summary).toContain('Sorun: sunucu makinesi');
  });

  it('LiveKit işlemcisi ya da CPU baskısı doluyken: sunucu kaynağı; %22 yük sorun sayılmaz; conntrack dolu', () => {
    const full = diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, { lk: 3.6 })));
    expect(full).toMatchObject({ cause: 'sunucu_kaynak', segment: 'sfu' });
    expect(full.summary).toContain('ses sunucusu (LiveKit)');
    const psi = diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, { psi: 70 })));
    expect(psi).toMatchObject({ cause: 'sunucu_kaynak', segment: 'sunucu' });
    expect(diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, { lk: 0.22 }))).cause).toBe('saglayici_gelen');
    const ct = summary(healthyRows(60, { ct: 259_000, ctm: 262_144 }));
    expect(ct.conntrack).toEqual({ max: 259_000, limit: 262_144, usedPct: 98.8 });
    expect(diagnose(buildUsers(incidentEntries()), ct).cause).toBe('sunucu_kaynak');
    // Tam kesinti varken sunucu kaynağı değil sağlayıcı (kesinti sunucunun dışında)
    expect(diagnose(buildUsers(incidentEntries()), summary(healthyRows(60, { psi: 70 }), [outage('tam', 20, 2_000)])).cause).toBe('saglayici_kesinti');
  });

  it('yalnızca yayıncıda giden kayıp, izleyicilerde gelen kayıp: yayıncının yükleme hattı (ikinci yayıncı da olabilir)', () => {
    const entries = [
      entry('yayinci', { lossOut: 18, screen: streamerScreen({ fps: 28 }) }),
      entry('i1', { lossIn: 15, watch: watching(5) }),
      entry('i2', { lossIn: 12, watch: watching(3) }),
    ];
    const d = diagnose(buildUsers(entries), summary(healthyRows()));
    expect(d).toMatchObject({ cause: 'yayinci_yukleme', segment: 'yayinci', confidence: 'yüksek' });
    // İki yayıncı: kaybeden ikinci yayıncı (eski kod yalnızca ilkine bakardı)
    const twoStreamers = [
      entry('y1', { screen: streamerScreen({ fps: 30 }) }),
      entry('y2', { lossOut: 18, screen: streamerScreen({ fps: 29 }) }),
      entry('i1', { lossIn: 15, watch: watching(5) }),
    ];
    expect(diagnose(buildUsers(twoStreamers), summary(healthyRows())).cause).toBe('yayinci_yukleme');
  });

  it('kimsede kayıp yok, yayıncı 17 fps, izleyiciler donuyor: kodlayıcı (ikinci yayıncının kodlayıcısı da görülür)', () => {
    const entries = [
      entry('yayinci', { screen: streamerScreen({ fps: 17, limitation: 'cpu', limitedRatio: 0.6 }) }),
      entry('i1', { watch: watching(6) }),
      entry('i2', { watch: watching(3) }),
    ];
    const d = diagnose(buildUsers(entries), summary(healthyRows()));
    expect(d.cause).toBe('kodlayici');
    expect(d.evidence.join(' ')).toContain('Kimsede paket kaybı yok');
    const second = [
      entry('y1', { screen: streamerScreen({ fps: 30 }) }),
      entry('y2', { screen: streamerScreen({ fps: 14, limitation: 'cpu', limitedRatio: 0.8 }) }),
      entry('i1', { watch: watching(6) }),
      entry('i2', { watch: watching(3) }),
    ];
    expect(diagnose(buildUsers(second), summary(healthyRows())).cause).toBe('kodlayici');
  });

  it('düşük fps ama sınırlama "bant genişliği": kodlayıcı değil (ağ kaynaklı)', () => {
    const entries = [
      entry('yayinci', { screen: streamerScreen({ fps: 15, limitation: 'bandwidth', limitedRatio: 0.9 }) }),
      entry('i1', { watch: watching(6) }),
      entry('i2', { watch: watching(4) }),
    ];
    expect(diagnose(buildUsers(entries), summary(healthyRows())).cause).not.toBe('kodlayici');
  });

  it('tek izleyicide gelen kayıp, diğerleri temiz: tek kullanıcı hattı', () => {
    const entries = [entry('yayinci', { screen: streamerScreen({ fps: 30 }) }), entry('i1', { lossIn: 14, watch: watching(5) }), entry('i2', { watch: watching(0) })];
    const d = diagnose(buildUsers(entries), summary(healthyRows()));
    expect(d).toMatchObject({ cause: 'tek_kullanici', segment: 'kullanici' });
    expect(d.summary).toContain('tek izleyicinin indirme hattı');
  });

  it('yayıncı olmayan tek kullanıcının yükleme kaybı: tek kullanıcı hattı', () => {
    const entries = [entry('a', { lossOut: 12 }), entry('b', { lossIn: 8 }), entry('c', {})];
    expect(diagnose(buildUsers(entries), null).cause).toBe('tek_kullanici');
  });

  it('hiçbir işaret yoksa belirsiz; sunucu özeti yoksa da çalışır ve eksik kanıt olarak yazar', () => {
    const entries = [entry('yayinci', { screen: streamerScreen({ fps: 30 }) }), entry('i1', { watch: watching(3) }), entry('i2', { watch: watching(2) })];
    const d = diagnose(buildUsers(entries), null);
    expect(d.cause).toBe('belirsiz');
    expect(d.probe).toBe('yok');
    expect(d.missing.join(' ')).toContain('Sunucu saniyelik ağ kaydı yok');
  });

  it('LiveKit ölçümleri kanıt olur: anahtar kare isteği dalgası ve gelen paket hızının düşmesi', () => {
    const lk: LkRow[] = [
      { t: T0, pin: 900, pout: 2800, nack: 2, pli: 0, fir: 0, lin: 0.1, lout: 0, parts: 4, cpu: 0.2 },
      { t: T0 + 2_000, pin: 120, pout: 300, nack: 85, pli: 6.5, fir: 0, lin: 14, lout: 2, parts: 4, cpu: 0.2 },
      { t: T0 + 4_000, pin: 880, pout: 2700, nack: 30, pli: 3, fir: 0, lin: 4, lout: 0, parts: 4, cpu: 0.2 },
    ];
    const s = summarizeLiveKit(lk)!;
    expect(s).toMatchObject({ samples: 3, nackMax: 85, pliMax: 6.5, lossInPctMax: 14, packetsInMin: 120, packetsInMax: 900 });
    expect(summarizeLiveKit([])).toBeNull();
    const d = diagnose(buildUsers(incidentEntries()), summary(healthyRows()), s);
    const text = d.evidence.join(' ');
    expect(text).toContain('anahtar kare isteği dalgası (PLI en çok 6,5/sn)');
    expect(text).toContain('NACK en çok 85,0/sn');
    expect(text).toContain("LiveKit'e gelen paket hızı 900 → 120/sn");
    expect(d.missing.join(' ')).not.toContain('LiveKit ölçümleri yok');
  });
});

// ---------- Olay toplayıcı ----------

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
`;
const devText = (rxBytes: number, txBytes: number): string =>
  `Inter-|   Receive |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
  eth0: ${rxBytes} ${Math.round(rxBytes / 1000)} 0 0 0 0 0 0 ${txBytes} ${Math.round(txBytes / 1000)} 0 0 0 0 0 0
`;
const files = (over: Partial<ProcFiles> = {}): ProcFiles => ({ dev: devText(0, 0), route: ROUTE, snmp: null, softnet: null, psi: null, ...over });

describe('FreezeCorrelator', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-freeze-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Saniyede 3000 paket; `silent` verilen saniyelerde (T0'a göre) neredeyse hiç paket gelmez ve sondalar yanıtsız kalır */
  function feedSampler(rowsN: number, silent: (sec: number) => boolean = () => false): SecondSampler {
    const s = new SecondSampler({ procRoot: '/yok', dir: null, livekitCpu: () => 0.22, participants: () => 4 });
    let b = 0;
    for (let i = 0; i <= rowsN; i++) {
      const at = T0 - 60_000 + i * 1000;
      b += silent(i - 60) ? 4_000 : 3_000_000;
      s.tick(at, files({ dev: devText(b, b) }));
      s.addProbe('udp 1.1.1.1', at - 400, silent(i - 60) ? null : 10);
      s.addProbe('udp 8.8.8.8', at - 300, silent(i - 60) ? null : 14);
    }
    return s;
  }

  it('olaydaki 4 kullanıcı bir olay olur: sunucuya gelen yol; kanıt, saniyelik satırlar ve LiveKit ölçümleri kaydedilir', async () => {
    const sampler = feedSampler(200);
    const events: string[] = [];
    const boosts: number[] = [];
    const lkRows: LkRow[] = [{ t: T0 + 10_000, pin: 900, pout: 2800, nack: 40, pli: 5, fir: 0, lin: 9, lout: 0, parts: 4, cpu: 0.22 }];
    const livekit = { window: (from: number, to: number) => lkRows.filter((r) => r.t >= from && r.t <= to), boost: (until: number) => void boosts.push(until) };
    const c = new FreezeCorrelator({ dir, sampler, livekit, onEvent: (e) => events.push(e.cause) });
    for (const e of incidentEntries()) c.observe(e);
    // Olay henüz açık: kapanmamış; LiveKit ölçümü sıklaştırıldı
    expect(c.list(0)).toHaveLength(0);
    expect(boosts.length).toBe(4);
    expect(boosts[0]).toBeGreaterThan(T0 + 60_000);
    c.sweep(T0 + 30_000 + 80_000);
    expect(events).toEqual(['saglayici_gelen']);
    const [ev] = c.list(0);
    expect(ev!.affected).toBe(4);
    expect(ev!.freezes).toBe(13);
    expect(ev!.streaming).toBe(true);
    expect(ev!.channelId).toBe('kanal');
    expect(ev!.server?.probeLossPct).toBe(0);
    expect(ev!.server?.rxPpsMax).toBe(3000);
    expect(ev!.probe).toBe('temiz');
    expect(ev!.livekit).toMatchObject({ samples: 1, pliMax: 5 });
    expect(ev!.evidence.join(' ')).toContain('anahtar kare isteği dalgası');
    await c.flushed();
    const detail = await c.detailOf(ev!.id);
    expect(detail.rows.length).toBeGreaterThan(30);
    expect(detail.lk).toEqual(lkRows);
    expect(await c.rowsOf('yok-boyle-bir-id')).toEqual([]);
    // Yeniden açılışta olay dosyadan yüklenir
    const again = new FreezeCorrelator({ dir, sampler: null });
    expect(again.list(0).map((e) => e.id)).toEqual([ev!.id]);
  });

  it('olay penceresindeki tam kesinti (NIC sessizliği + sonda kesintisi) olayı "sağlayıcı ağı" yapar', async () => {
    // T0+10..T0+13: sunucuya paket gelmiyor; dış sondalar da yanıtsız
    const sampler = feedSampler(200, (sec) => sec >= 10 && sec <= 13);
    sampler.addProbeOutage({ at: T0 + 9_700, durationMs: 3_800, lost: 15, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8', 'udp 8.8.8.8'], udp: true, tcp: true });
    const [o] = sampler.outages.list(0);
    expect(o).toMatchObject({ kind: 'tam' });
    expect(o!.nic).toMatchObject({ baseline: 3000, rxpMin: 4, participants: 4, txCollapsed: true });
    expect(o!.nic!.probesLost).toBeGreaterThan(0);
    const c = new FreezeCorrelator({ dir, sampler });
    for (const e of incidentEntries()) c.observe(e);
    c.sweep(T0 + 200_000);
    const [ev] = c.list(0);
    expect(ev!.cause).toBe('saglayici_kesinti');
    expect(ev!.confidence).toBe('yüksek');
    expect(ev!.server?.outages).toHaveLength(1);
    expect(ev!.summary).toMatch(/^Sorun: barındırma sağlayıcısının ağı — sunucuya \d,\d sn hiç paket ulaşmadı$/);
    await c.flushed();
    // Saklanan satırlarda kesinti saniyeleri işaretli (1: sonda, 2: NIC)
    const rows = await c.rowsOf(ev!.id);
    expect(rows.filter((r) => (r.o ?? 0) === 3).length).toBeGreaterThanOrEqual(3);
  });

  it('tek sesli kullanıcının kaybı (yayın yok, tek kişi) olay açmaz; temiz özetler olay açmaz', () => {
    const c = new FreezeCorrelator({ dir: null, sampler: null });
    c.observe(entry('a', { lossOut: 15 }));
    c.observe(entry('b', {}));
    c.sweep(T0 + 200_000);
    expect(c.list(0)).toHaveLength(0);
    c.observe(entry('b', {}, T0 + 300_000));
    c.sweep(T0 + 500_000);
    expect(c.list(0)).toHaveLength(0);
  });

  it('yayın varken tek izleyicide kayıp olay açar (tek kullanıcı hattı); kanalsız özet yok sayılır', () => {
    const c = new FreezeCorrelator({ dir: null, sampler: null });
    c.observe(entry('yayinci', { screen: streamerScreen({ fps: 30 }) }));
    c.observe(entry('i1', { lossIn: 14, watch: watching(5) }));
    c.observe(entry('x', { channelId: null, lossOut: 50 }));
    c.sweep(T0 + 200_000);
    const list = c.list(0);
    expect(list).toHaveLength(1);
    expect(list[0]!.cause).toBe('tek_kullanici');
  });

  it('farklı kanallar ayrı olaylar; olay uzun sürerse 10 dk sonra bölünür', () => {
    const c = new FreezeCorrelator({ dir: null, sampler: null });
    c.observe(entry('a', { lossOut: 15, channelId: 'k1' }));
    c.observe(entry('b', { lossOut: 15, channelId: 'k1' }));
    c.observe(entry('c', { lossOut: 15, channelId: 'k2' }));
    c.observe(entry('d', { lossOut: 15, channelId: 'k2' }));
    c.sweep(T0 + 300_000);
    expect(c.list(0).map((e) => e.channelId).sort()).toEqual(['k1', 'k2']);
    const long = new FreezeCorrelator({ dir: null, sampler: null });
    for (let i = 0; i < 40; i++) {
      long.observe(entry('a', { lossOut: 15 }, T0 + i * 20_000));
      long.observe(entry('b', { lossOut: 15 }, T0 + i * 20_000));
    }
    long.sweep(T0 + 2_000_000);
    expect(long.list(0).length).toBeGreaterThanOrEqual(2);
  });

  it('olay dosyası çalışırken kırpılır (yalnızca açılışta değil)', async () => {
    const now = Date.now();
    // Dosyada süresi geçmiş (30 günden eski) 9 olay: açılışta sınırın (10) altında olduğundan dokunulmaz
    const stale = Array.from({ length: 9 }, (_, i) => JSON.stringify({ id: `eski-${i}`, channelId: 'k', start: 1, end: 2, cause: 'belirsiz' }));
    const file = path.join(dir, 'freeze-events.jsonl');
    fs.writeFileSync(file, stale.join('\n') + '\n');
    const c = new FreezeCorrelator({ dir, sampler: null, maxFileLines: 10 });
    expect(c.list(0)).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(9);
    for (let i = 0; i < 2; i++) {
      const at = now - 600_000 + i * 100_000;
      c.observe(entry('a', { lossOut: 15, channelId: `k${i}` }, at));
      c.observe(entry('b', { lossOut: 15, channelId: `k${i}` }, at));
    }
    c.sweep(now + 200_000);
    await c.flushed();
    // 11. satırda sınır aşıldı: dosya bellekteki (güncel) olaylarla yeniden yazıldı
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; channelId: string });
    expect(lines.map((l) => l.channelId)).toEqual(['k0', 'k1']);
  });
});
