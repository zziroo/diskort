import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDefaultGateway } from '../src/hostNetwork.js';
import { LiveKitMetrics } from '../src/infraStats.js';
import { isConfirmedOutage, isCorroborated, localStamp, NicSilenceDetector, OutageLog, silenceThreshold, type NicSilence, type Outage } from '../src/netOutages.js';
import { DEFAULT_PROBE_TARGETS, dnsQuery, OutageDetector, parseProbeTargets, ProbeEngine, type ProbeOutage, type ProbeTarget } from '../src/netProbe.js';
import {
  bucketRows,
  findBurst,
  isAbnormalRow,
  minuteOf,
  parseCount,
  parsePsiCpu,
  parseSoftnetStat,
  rowBetween,
  SecondSampler,
  SilenceScanner,
  summarizeRows,
  type MinuteRow,
  type ProcFiles,
  type RawSecond,
  type SecondRow,
} from '../src/netSeconds.js';
import { auth, startServer, type TestServer } from './helpers.js';

// Bağlantı teşhisinin sunucu ucu: tek ağ örnekleyicisi (saniyelik satırlar, dakikalık özet, 15 sn'lik geçmiş),
// dış sonda motoru (gönderim sırasıyla sayım, kesinti), NIC sessizliği dedektörü, kesinti kaydı ve yönetim uçları.

const T0 = Date.parse('2026-10-01T01:18:00+03:00');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- /proc ayrıştırma ve saniyelik satırlar ----------

const SOFTNET = `0000ab12 00000002 00000001 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000
000000ff 00000003 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000
`;
const PSI = `some avg10=1.20 avg60=0.50 avg300=0.10 total=5000000
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`;
const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
`;
const devText = (rxBytes: number, txBytes: number, rxDrop = 0, txDrop = 0): string =>
  `Inter-|   Receive |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
  eth0: ${rxBytes} ${Math.round(rxBytes / 1000)} 0 ${rxDrop} 0 0 0 0 ${txBytes} ${Math.round(txBytes / 1000)} 0 ${txDrop} 0 0 0 0
`;
const snmpText = (rcvbuf: number, noPorts = 0, csum = 0) => `Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors
Udp: 100 ${noPorts} ${rcvbuf} 200 ${rcvbuf} 0 ${csum}
`;
const files = (over: Partial<ProcFiles> = {}): ProcFiles => ({ dev: devText(0, 0), route: ROUTE, snmp: snmpText(0), softnet: SOFTNET, psi: PSI, ...over });

const row = (i: number, over: Partial<SecondRow> = {}): SecondRow => ({
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
  ...over,
});

describe('saniyelik ağ satırları', () => {
  it('softnet_stat, PSI, sayaç dosyası ve ağ geçidi ayrıştırılır', () => {
    expect(parseSoftnetStat(SOFTNET)).toEqual({ processed: 0xab12 + 0xff, dropped: 5, squeezed: 1 });
    expect(parseSoftnetStat('')).toBeNull();
    expect(parsePsiCpu(PSI)).toBe(5_000_000);
    expect(parsePsiCpu('')).toBeNull();
    expect(parseCount('1234\n')).toBe(1234);
    expect(parseCount('')).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount('abc')).toBeNull();
    expect(parseDefaultGateway(ROUTE)).toBe('192.168.0.1');
    expect(parseDefaultGateway('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF')).toBeNull();
  });

  it('iki okumadan Mbps, paket hızı, düşüşler, UDP hataları, softnet (düşüş + time_squeeze), PSI ve conntrack', () => {
    const s = new SecondSampler({ procRoot: '/yok', dir: null, participants: () => 3 });
    expect(s.tick(1000, files())).toBeNull(); // ilk okuma satır vermez
    const r = s.tick(
      2000,
      files({
        dev: devText(3_125_000, 7_000_000, 4, 6),
        snmp: snmpText(9, 5, 2),
        softnet: SOFTNET.replace('00000002 00000001', '00000005 00000008'),
        psi: PSI.replace('5000000', '5250000'),
        ctCount: '4200\n',
        ctMax: '262144\n',
      }),
    )!;
    expect(r.rx).toBe(25);
    expect(r.tx).toBe(56);
    expect(r.rxp).toBe(3125);
    expect(r.txp).toBe(7000);
    expect(r.nd).toBe(10); // 4 rx drop + 6 tx drop
    expect(r.ue).toBe(9);
    expect(r.ur).toBe(9);
    expect(r.un).toBe(5);
    expect(r.uc).toBe(2);
    expect(r.sd).toBe(3);
    expect(r.sq).toBe(7);
    expect(r.psi).toBe(25);
    expect(r.ct).toBe(4200);
    expect(r.ctm).toBe(262144);
    expect(r.vp).toBe(3);
    expect(s.readable).toEqual({ net: true, snmp: true, softnet: true, psi: true, conntrack: true });
    expect(s.gateway).toBe('192.168.0.1');
    expect(s.iface).toBe('eth0');
  });

  it('okunamayan dosyalarda zarifçe düşer (Windows geliştirme, eksik conntrack/softnet/PSI)', () => {
    const s = new SecondSampler({ procRoot: '/yok', dir: null });
    s.tick(1000, files({ softnet: null, psi: null }));
    const r = s.tick(2000, files({ dev: devText(1_250_000, 0), softnet: null, psi: null }))!;
    expect(r.rx).toBe(10);
    expect(r.sd).toBeNull();
    expect(r.psi).toBeNull();
    expect('sq' in r).toBe(false);
    expect('ct' in r).toBe(false);
    expect(s.readable).toMatchObject({ softnet: false, psi: false, conntrack: false });
    // /proc hiç yoksa (gerçek dosya okuması, olmayan kök) satır yine üretilir, alanlar boştur; hiçbir şey fırlatmaz
    const none = new SecondSampler({ procRoot: path.join(os.tmpdir(), 'diskort-yok-proc'), dir: null });
    none.tick(1000);
    const empty = none.tick(2000)!;
    expect(empty).toMatchObject({ rx: null, tx: null, rxp: null, nd: 0, sd: null, psi: null });
    expect(none.readable).toEqual({ net: false, snmp: false, softnet: false, psi: false, conntrack: false });
    expect(none.serverIp()).toBeNull();
  });

  it('sayaç geri giderse (sıfırlanma) düşüş sayılmaz', () => {
    const a: RawSecond = { at: 1000, net: null, softnet: { processed: 10, dropped: 50, squeezed: 9 }, psiUs: 100 };
    const b: RawSecond = { at: 2000, net: null, softnet: { processed: 5, dropped: 2, squeezed: 1 }, psiUs: 50 };
    const r = rowBetween(b, a, null)!;
    expect(r.sd).toBeNull();
    expect(r.sq).toBeNull();
    expect(r.psi).toBeNull();
  });

  it('sondalar gönderildikleri saniyeyi kapsayan satıra işlenir (satır henüz yoksa bekletilir)', () => {
    const s = new SecondSampler({ procRoot: '/yok', dir: null });
    s.tick(T0, files());
    for (let i = 1; i <= 10; i++) {
      // Bu saniyede gönderilen, satır oluşmadan sonuçlanan sonda
      if (i === 3) s.addProbe('udp 1.1.1.1', T0 + 2500, 12);
      s.tick(T0 + i * 1000, files({ dev: devText(i * 1_000_000, i * 1_000_000) }));
      // Satır oluştuktan sonra (zaman aşımıyla) sonuçlanan sondalar
      if (i === 4) {
        s.addProbe('udp 1.1.1.1', T0 + 3500, null);
        s.addProbe('ağ geçidi', T0 + 3600, null);
      }
    }
    const rows = s.window(T0, T0 + 10_000);
    // Satır t anına kadarki saniyeyi kapsar: 2,5. saniyede gönderilen sonda T0+3 sn satırındadır
    expect(rows.find((r) => r.t === T0 + 3000)?.p).toEqual({ 'udp 1.1.1.1': 12 });
    expect(rows.find((r) => r.t === T0 + 4000)?.p).toEqual({ 'udp 1.1.1.1': -1, 'ağ geçidi': -1 });
    expect(rows.find((r) => r.t === T0 + 2000)?.p).toBeUndefined();
    const sum = summarizeRows(rows, T0, T0 + 10_000, 2);
    expect(sum.probes['udp 1.1.1.1']).toMatchObject({ sent: 2, lost: 1, lossPct: 50, rttMed: 12 });
    expect(sum.probeLossPct).toBeNull(); // 5'ten az sonda: yargı yok
  });

  it('isAbnormalRow: drop, UDP hatası, PSI, kesinti işareti, dolu conntrack, sonda kaybı; tek tük kayıp normal', () => {
    const ok = row(0, { p: { 'udp 1.1.1.1': 9 } });
    expect(isAbnormalRow(ok, [ok])).toBe(false);
    expect(isAbnormalRow({ ...ok, nd: 1 }, [ok])).toBe(false);
    expect(isAbnormalRow({ ...ok, nd: 5 }, [ok])).toBe(true);
    expect(isAbnormalRow({ ...ok, ur: 1 }, [ok])).toBe(true);
    expect(isAbnormalRow({ ...ok, psi: 35 }, [ok])).toBe(true);
    expect(isAbnormalRow({ ...ok, o: 2 }, [ok])).toBe(true);
    expect(isAbnormalRow({ ...ok, ct: 95, ctm: 100 }, [ok])).toBe(true);
    expect(isAbnormalRow({ ...ok, ct: 50, ctm: 100 }, [ok])).toBe(false);
    const healthy = Array.from({ length: 9 }, (_, i) => row(i, { p: { 'udp 1.1.1.1': 9, 'tcp 8.8.8.8': 11 } }));
    const oneLost = [...healthy, { ...ok, p: { 'udp 1.1.1.1': -1 } }];
    expect(isAbnormalRow(oneLost[9]!, oneLost)).toBe(false);
    // Aynı saniyede iki farklı hedef yanıtsız
    expect(isAbnormalRow({ ...ok, p: { 'udp 1.1.1.1': -1, 'tcp 8.8.8.8': -1 } }, healthy)).toBe(true);
    const wave = healthy.map((r) => ({ ...r, p: { 'udp 1.1.1.1': -1 } }));
    expect(isAbnormalRow(wave[8]!, wave)).toBe(true);
    expect(isAbnormalRow({ ...ok, p: { 'ağ geçidi': -1 } }, [{ ...ok, p: { 'ağ geçidi': -1 } }])).toBe(false);
  });

  it('özet: paket hızı en düşük/en yüksek, en derin çöküş, tepe, patlama, toplam paket', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i, { rxp: 900, txp: 1400, rx: 3, tx: 12, sq: 1, un: 2 }));
    for (const i of [30, 31]) rows[i] = { ...rows[i]!, tx: 39, txp: 4300, rx: 11 };
    for (const i of [33, 34]) rows[i] = { ...rows[i]!, rxp: 80, rx: 0.2 };
    const s = summarizeRows(rows, T0, T0 + 60_000, 4);
    expect(s).toMatchObject({ rxPpsMin: 80, rxPpsMax: 900, txPpsMin: 1400, txPpsMax: 4300, softnetSqueezed: 60, udpNoPorts: 120, conntrack: null });
    expect(s.rxPackets).toBe(58 * 900 + 2 * 80);
    expect(s.rxDip).toEqual({ at: T0 + 33_000, pps: 80, baseline: 900, pct: 8.9 });
    expect(s.txPeak).toEqual({ at: T0 + 30_000, mbps: 39, pps: 4300 });
    // Çöküş anı bilindiği için patlama ona göre tarihlenir (çöküş satırı T0+33: kaybın başı T0+32)
    expect(s.burst).toMatchObject({ at: T0 + 30_000, txMbps: 39, secBeforeLoss: 2 });
    expect(findBurst(rows, null)).toMatchObject({ at: T0 + 30_000, secBeforeLoss: null });
    // Patlama kayıptan çok önceyse (10 sn'den eski) ilişkilendirilmez
    expect(findBurst(rows, T0 + 55_000)).toBeNull();
    expect(findBurst(rows.map((r) => ({ ...r, tx: 12, rx: 3 })), null)).toBeNull();
  });
});

describe('dakikalık özet ve 15 sn\'lik geçmiş (tek örnekleyiciden)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-netmin-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('minuteOf ve bucketRows', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(i + 1, { rx: i < 30 ? 10 : 20, rxp: i === 10 ? 5 : 1000, nd: i === 5 ? 3 : 0, o: i === 10 ? 2 : undefined, vp: 2, p: i % 2 ? { 'udp 1.1.1.1': i === 11 ? -1 : 8 + (i % 5) } : undefined }),
    );
    const m = minuteOf(T0, rows);
    expect(m).toMatchObject({ at: T0, n: 60, rx: [15, 20], nd: 3, o: 1, vp: 2, psi: 1, lk: 0.22, ct: null });
    expect(m.rxp).toEqual([5, Math.round((59 * 1000 + 5) / 60), 1000]);
    expect(m.p).toEqual({ 'udp 1.1.1.1': [30, 1, 12] });
    const buckets = bucketRows(rows);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toMatchObject({ at: T0 + 15_000, rxMbps: 10, txMbps: 28 });
    expect(buckets[3]).toMatchObject({ at: T0 + 60_000, rxMbps: 20 });
  });

  it('her dakika netmin-<gün>.jsonl dosyasına bir satır; anormal saniyenin ±30 sn çevresi netsec-<gün>.jsonl dosyasına; diskten okunur', async () => {
    const s = new SecondSampler({ procRoot: '/yok', dir, offsetMin: 180 });
    let rx = 0;
    for (let i = 0; i <= 200; i++) {
      rx += 1_000_000;
      // 100. saniyede NIC düşüşü (tek sefer)
      s.tick(T0 + i * 1000, files({ dev: devText(rx, rx, i >= 100 ? 40 : 0, 0) }));
      s.addProbe('udp 1.1.1.1', T0 + i * 1000 - 500, 9);
    }
    // Test verisi sabit tarihli: flush'a "şimdi" olarak o günü ver, yoksa 7 günlük saklama netsec dosyasını hemen siler
    await s.flush(T0 + 201_000);
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(['netmin-2026-10-01.jsonl', 'netsec-2026-10-01.jsonl']);
    const secs = fs.readFileSync(path.join(dir, 'netsec-2026-10-01.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SecondRow);
    // düşüşün görüldüğü satır = 100. saniye; öncesi 30, sonrası 30 sn (+ kendisi)
    expect(secs[0]!.t).toBe(T0 + 70_000);
    expect(secs[secs.length - 1]!.t).toBe(T0 + 130_000);
    expect(secs.length).toBe(61);
    expect(secs.find((r) => r.nd === 40)).toBeTruthy();
    const mins = await s.minutes('2026-10-01');
    expect(mins.map((m) => m.at)).toEqual([T0, T0 + 60_000, T0 + 120_000]);
    expect(mins[0]).toMatchObject({ n: 60, rx: [8, 8], rxp: [1000, 1000, 1000], nd: 0 } satisfies Partial<MinuteRow>);
    expect(mins[0]!.p?.['udp 1.1.1.1']).toEqual([60, 0, 9]);
    expect(mins[1]!.nd).toBe(40);
    expect(await s.minuteDays()).toEqual(['2026-10-01']);
    expect(await s.minutes('../../etc/passwd')).toEqual([]);
    expect(s.history15().length).toBeGreaterThan(10);

    // Halkası boş yeni bir örnekleyici (yeniden başlatma): aralık diskten gelir
    const again = new SecondSampler({ procRoot: '/yok', dir, offsetMin: 180 });
    const fromDisk = await again.seconds(T0 + 90_000, T0 + 110_000);
    expect(fromDisk).toHaveLength(21);
    expect(fromDisk[0]!.t).toBe(T0 + 90_000);
    expect(await again.seconds(T0 + 150_000, T0 + 160_000)).toEqual([]); // çevrenin dışı yazılmadı
    // Halkadaki aralık bellekten
    expect((await s.seconds(T0 + 150_000, T0 + 160_000)).length).toBe(11);
  });

  it('sağlıklı sunucuda saniyelik dosya oluşmaz; eski dosyalar (eski biçimler dahil) süreleri dolunca silinir', async () => {
    const h = new SecondSampler({ procRoot: '/yok', dir });
    let b = 0;
    for (let i = 0; i <= 50; i++) h.tick(T0 + i * 1000, files({ dev: devText((b += 500_000), b) }));
    await h.flush();
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('netsec-'))).toEqual([]);
    for (const name of ['netsec-2026-01-01.jsonl', 'netmin-2026-01-01.jsonl', 'network-2026-01-01.jsonl', 'micro-2026-01-01.jsonl', '2026-01-01.jsonl', 'outages.jsonl', 'netmin-2026-09-25.jsonl']) {
      fs.writeFileSync(path.join(dir, name), 'x\n');
    }
    await h.removeOldFiles(T0);
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-01-01.jsonl', 'netmin-2026-09-25.jsonl', 'outages.jsonl']);
  });
});

// ---------- Sonda motoru ----------

const target = (label: string, kind: 'udp' | 'tcp' = 'udp'): ProbeTarget => ({ label, kind, host: '192.0.2.1', port: 53 });

describe('dış sondalar', () => {
  it('hedef ayarı ayrıştırılır; geçersiz parçalar atılır, "0" kapatır; varsayılanlar yükü düşük tutar', () => {
    expect(parseProbeTargets(undefined)).toBeNull();
    expect(parseProbeTargets('0')).toEqual([]);
    expect(parseProbeTargets('udp:1.1.1.1:53, tcp:8.8.8.8:443, bozuk, udp:9.9.9.9:99999')).toEqual([
      { label: 'udp 1.1.1.1', kind: 'udp', host: '1.1.1.1', port: 53 },
      { label: 'tcp 8.8.8.8', kind: 'tcp', host: '8.8.8.8', port: 443 },
    ]);
    // En az iki farklı hedef (kesinti yargısı için), UDP ve TCP birlikte; sıradaki üç sonda hep iki türü içerir
    expect(new Set(DEFAULT_PROBE_TARGETS.map((t) => t.label)).size).toBe(DEFAULT_PROBE_TARGETS.length);
    expect(DEFAULT_PROBE_TARGETS.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < DEFAULT_PROBE_TARGETS.length; i++) {
      const three = [0, 1, 2].map((k) => DEFAULT_PROBE_TARGETS[(i + k) % DEFAULT_PROBE_TARGETS.length]!.kind);
      expect(new Set(three).size).toBe(2);
    }
    const engine = new ProbeEngine({ targets: DEFAULT_PROBE_TARGETS, onResult: () => undefined });
    const st = engine.status();
    // Saniyede 4 sonda, 5 hedef: her hedefe 1,25 sn'de bir
    expect(1000 / st.intervalMs).toBe(4);
    expect(st.timeoutMs).toBeLessThanOrEqual(500);
  });

  it('DNS sorgusu: 17 bayt, kök adı NS/IN', () => {
    const q = dnsQuery(0x1234);
    expect(q.length).toBe(17);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(13)).toBe(2);
    expect(q.readUInt16BE(15)).toBe(1);
  });

  it('kesinti dedektörü: art arda ≥3 kayıp ve ≥2 farklı hedef; tek hedefin kaybı hiçbir zaman kesinti değil', () => {
    const out: ProbeOutage[] = [];
    const d = new OutageDetector({ onOutage: (o) => out.push(o) });
    let seq = 0;
    const push = (label: string, at: number, rtt: number | null, kind: 'udp' | 'tcp' = 'udp'): void => d.push({ seq: seq++, label, kind, sentAt: at, rtt });
    // İki kayıp: yetmez
    push('a', 0, 5);
    push('b', 250, null);
    push('c', 500, null);
    push('a', 750, 5);
    expect(out).toEqual([]);
    // Aynı hedef art arda üç kez yanıtsız (ör. tek hedefli kurulum): kesinti değil
    for (let i = 0; i < 3; i++) push('a', 1000 + i * 250, null);
    expect(d.open(2000)).toBeNull();
    push('a', 1750, 4);
    expect(out).toEqual([]);
    // Üç farklı hedef art arda yanıtsız, biri TCP: kesinti; süre ilk kayıp gönderimden ilk başarılı gönderime
    push('a', 2000, null);
    push('b', 2250, null, 'tcp');
    push('c', 2500, null);
    expect(d.open(2600)).toMatchObject({ at: 2000, durationMs: 600, lost: 3 });
    push('a', 2750, null);
    push('b', 3000, 7, 'tcp');
    expect(out).toEqual([{ at: 2000, durationMs: 1000, lost: 4, targets: ['a', 'b', 'c'], udp: true, tcp: true }]);
    expect(d.open(3100)).toBeNull();
  });

  it('motor sonuçları GÖNDERİM sırasıyla sayar: yanıtsız sonda geç sonuçlansa da kısa kesinti yakalanır', async () => {
    const results: [string, number, number | null][] = [];
    const outages: ProbeOutage[] = [];
    // Yanıtsız sonda 40 ms sonra (zaman aşımı), yanıt alan 1 ms sonra sonuçlanır: sonuçlanma sırası gönderim
    // sırasından farklıdır (eski dedektör bu yüzden ≤3 sondalık kesintileri hiç göremiyordu)
    const script: (number | null)[] = [5, 5, 5, 5, 5, null, null, null, 6, 6];
    const order: number[] = [];
    let n = 0;
    const engine = new ProbeEngine({
      targets: ['a', 'b', 'c', 'd', 'e'].map((l, i) => target(l, i % 2 ? 'tcp' : 'udp')),
      onResult: (l, at, rtt) => results.push([l, at, rtt]),
      onOutage: (o) => outages.push(o),
      run: () => {
        const i = n++;
        const v = script[i]!;
        return new Promise((resolve) =>
          setTimeout(
            () => {
              order.push(i);
              resolve(v);
            },
            v === null ? 40 : 1,
          ),
        );
      },
    });
    await Promise.all(script.map((_, i) => engine.tick(10_000 + i * 250)));
    // Sonuçlanma sırası gönderim sırası değil: 8. ve 9. sondalar 5-7'den önce bitti
    expect(order.indexOf(8)).toBeLessThan(order.indexOf(5));
    expect(results).toHaveLength(10);
    expect(outages).toEqual([{ at: 11_250, durationMs: 750, lost: 3, targets: ['a', 'b', 'c'], udp: true, tcp: true }]);
    const st = engine.status(13_000);
    expect(st.targets.find((t) => t.label === 'a')).toMatchObject({ sent: 2, lost: 1 });
    expect(st.open).toBeNull();
  });

  it('tek bir çözücü hep yanıtsızsa (hız sınırı) kesinti sayılmaz; hiç yanıt vermeyen hedef sıradan çıkar', async () => {
    const outages: ProbeOutage[] = [];
    const engine = new ProbeEngine({
      targets: [target('a'), target('b'), target('c')],
      onResult: () => undefined,
      onOutage: (o) => outages.push(o),
      run: async (t) => (t.label === 'b' ? null : 7),
    });
    for (let i = 0; i < 60; i++) await engine.tick(i * 250);
    expect(outages).toEqual([]);
    const b = engine.status(60 * 250).targets.find((t) => t.label === 'b')!;
    expect(b.disabled).toBe(true);
    expect(b.sent).toBe(15);
    // Kapatma kalıcı değil: dakikada bir yeniden denenir, yanıt verince sıraya döner
    let bWorks = false;
    const sent: string[] = [];
    const e3 = new ProbeEngine({
      targets: [target('a'), target('b'), target('c')],
      onResult: (l) => sent.push(l),
      onOutage: (o) => outages.push(o),
      run: async (t) => (t.label === 'b' && !bWorks ? null : 7),
    });
    for (let i = 0; i < 60; i++) await e3.tick(i * 250);
    expect(e3.status(15_000).targets.find((t) => t.label === 'b')!.disabled).toBe(true);
    // Hiç yanıt vermemiş hedefin kayıpları satırlara yazılmadı (yanıtsız sonda gibi görünüp sessizliği doğrulamasın)
    expect(sent.filter((l) => l === 'b')).toEqual([]);
    sent.length = 0;
    const before = e3.status(15_000).targets.find((t) => t.label === 'b')!.sent;
    for (let i = 60; i < 300; i++) await e3.tick(i * 250); // 15. – 75. saniyeler: bir kez yeniden denenir (yanıtsız)
    expect(e3.status(75_000).targets.find((t) => t.label === 'b')!.disabled).toBe(true);
    // Yeniden deneme gönderildi ama yanıtsız kaldığı için satırlara YAZILMADI
    expect(sent.filter((l) => l === 'b')).toEqual([]);
    expect(before).toBe(15);
    expect(outages).toEqual([]);
    bWorks = true;
    sent.length = 0;
    for (let i = 300; i < 600; i++) await e3.tick(i * 250);
    expect(e3.status(150_000).targets.find((t) => t.label === 'b')!.disabled).toBe(false);
    expect(sent.filter((l) => l === 'b').length).toBeGreaterThan(30);
    // Kesinti sırasında başlayan motor: hiçbir hedef yanıt vermiyorken HİÇBİRİ kapatılmaz; yol gelince hepsi çalışır
    let up = false;
    const e4 = new ProbeEngine({ targets: [target('a'), target('b', 'tcp'), target('c')], onResult: () => undefined, onOutage: (o) => outages.push(o), run: async () => (up ? 5 : null) });
    for (let i = 0; i < 120; i++) await e4.tick(i * 250);
    expect(e4.status(30_000).targets.map((t) => t.disabled)).toEqual([false, false, false]);
    up = true;
    for (let i = 120; i < 126; i++) await e4.tick(i * 250);
    expect(e4.status(31_500).targets.every((t) => t.lastRtt === 5)).toBe(true);
    expect(outages).toEqual([]); // hiç yanıt alınmadan önceki kayıplar yargıya katılmaz
    up = false;
    for (let i = 126; i < 132; i++) await e4.tick(i * 250);
    up = true;
    await e4.tick(132 * 250);
    expect(outages).toMatchObject([{ lost: 6, udp: true, tcp: true }]);
    outages.length = 0;
    // Kalan iki hedef de kesilirse (hiç yanıt vermemiş hedef yargıya katılmadan) kesinti yakalanır
    let down = true;
    const e2 = new ProbeEngine({ targets: [target('a'), target('c', 'tcp')], onResult: () => undefined, onOutage: (o) => outages.push(o), run: async () => (down ? null : 5) });
    down = false;
    await e2.tick(0);
    await e2.tick(250);
    down = true;
    for (let i = 2; i < 6; i++) await e2.tick(i * 250);
    expect(e2.status(1500).open).toMatchObject({ at: 500, lost: 4 });
    down = false;
    await e2.tick(1500);
    expect(outages).toEqual([{ at: 500, durationMs: 1000, lost: 4, targets: ['a', 'c'], udp: true, tcp: true }]);
  });

  it('ağ geçidi hiç yanıt vermezse kapanır ve artık bildirmez; ağ geçidi kesinti yargısına katılmaz', async () => {
    const results: [string, number | null][] = [];
    const outages: ProbeOutage[] = [];
    const engine = new ProbeEngine({
      targets: [target('udp 1.1.1.1')],
      gateway: () => '192.168.0.1',
      onResult: (l, _t, rtt) => results.push([l, rtt]),
      onOutage: (o) => outages.push(o),
      run: async (t) => (t.label === 'ağ geçidi' ? null : 11),
    });
    await engine.tick();
    expect(results).toEqual([['udp 1.1.1.1', 11]]);
    for (let i = 0; i < 20; i++) await engine.gatewayOnce();
    expect(engine.gatewayDisabled).toBe(true);
    const gw = results.filter(([l]) => l === 'ağ geçidi').length;
    expect(gw).toBe(14);
    await engine.gatewayOnce();
    expect(results.filter(([l]) => l === 'ağ geçidi').length).toBe(gw);
    expect(outages).toEqual([]);
    expect(engine.status().gateway).toEqual({ host: '192.168.0.1', disabled: true });
    // start/stop: zamanlayıcılar kurulur ve temizlenir
    engine.start();
    expect(engine.status().running).toBe(true);
    engine.stop();
    expect(engine.status().running).toBe(false);
  });
});

// ---------- NIC sessizliği ----------

function feed(
  d: NicSilenceDetector,
  values: number[],
  opts: { participants?: number | ((i: number) => number); streams?: (i: number) => number; lost?: (i: number) => number; txp?: (i: number, rxp: number) => number } = {},
): boolean[] {
  return values.map((v, i) =>
    d.push({
      t: T0 + (i + 1) * 1000,
      rxp: v,
      txp: opts.txp ? opts.txp(i, v) : v * 2,
      participants: typeof opts.participants === 'function' ? opts.participants(i) : (opts.participants ?? null),
      streams: opts.streams?.(i) ?? null,
      probesLost: opts.lost?.(i) ?? 0,
    }),
  );
}
/** Konuşmayla oynayan ses trafiği: sessizlik tabanı ~30 pk/sn, konuşurken 80-250 */
const VOICE = [98, 84, 36, 31, 151, 118, 38, 121, 28, 96, 40, 142, 192, 34, 47, 36, 31];

describe('NIC sessizliği dedektörü', () => {
  it('ölçüt mutlak "neredeyse sıfır"dır: konuşma durunca 250 → 30 pk/sn ya da yayın durağanlaşınca 1100 → 80 pk/sn sessizlik DEĞİL', () => {
    const out: NicSilence[] = [];
    const voice = new NicSilenceDetector((s) => out.push(s));
    // 250 pk/sn konuşma, sonra herkes susar (taban 28-40), sonra yeniden konuşma
    expect(feed(voice, [...Array.from({ length: 15 }, () => 250), 30, 28, 34, 31, 40, 29, 250, 240]).some(Boolean)).toBe(false);
    const stream = new NicSilenceDetector((s) => out.push(s));
    expect(feed(stream, [...Array.from({ length: 20 }, (_, i) => 1000 + (i % 5) * 40), 78, 168, 186, 90, 80, 1100, 1200]).some(Boolean)).toBe(false);
    expect(out).toEqual([]);
    // Eşik: mutlak 8 pk/sn; taban çok yüksekse %5'i, en çok 40
    expect([silenceThreshold(28), silenceThreshold(100), silenceThreshold(400), silenceThreshold(4000)]).toEqual([8, 8, 20, 40]);
  });

  it('gerçek kesinti: gelen tek haneye iner, giden de durur; sondalarla doğrulanınca probesLost > 0', () => {
    const out: NicSilence[] = [];
    const d = new NicSilenceDetector((s) => out.push(s));
    // Gerçek şekil: 32 → 8 → 4 → 3 → 0 → 42 (giden 59 → 19 → 9 → 22 → 12)
    const tx = [19, 9, 22, 12];
    const flags = feed(d, [...VOICE, 32, 8, 4, 3, 0, 42, 92], { lost: (i) => (i >= 18 && i <= 21 ? 3 : 0), txp: (i, v) => (i >= 18 && i <= 21 ? tx[i - 18]! : v * 2) });
    expect(flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0)).toEqual([18, 19, 20, 21]);
    expect(out).toEqual([{ at: T0 + 18_000, durationMs: 4_000, rxpMin: 0, baseline: 31, participants: null, probesLost: 3, probeTargets: [], txCollapsed: true }]);
    expect(d.open()).toBeNull();
    // Tek saniyelik kesinti (gelen 0) de yakalanır
    const one = new NicSilenceDetector((s) => out.push(s));
    feed(one, [...VOICE, 21, 0, 49, 34], { lost: (i) => (i === 18 ? 2 : 0) });
    expect(out[1]).toMatchObject({ at: T0 + 18_000, durationMs: 1_000, rxpMin: 0, probesLost: 2 });
    // Sondalar yanıt alıyorsa aynı şekil yalnızca adaydır (probesLost 0); giden sürüyorsa txCollapsed da false
    const cand = new NicSilenceDetector((s) => out.push(s));
    feed(cand, [...VOICE, 3, 2, 60, 70], { txp: (_i, v) => (v < 10 ? 300 : v * 2) });
    expect(out[2]).toMatchObject({ probesLost: 0, txCollapsed: false, durationMs: 2_000 });
  });

  it('süren sessizlik "aday" olarak görünür; geri gelmezse (herkes çıktı) kesinti sayılmaz', () => {
    const out: NicSilence[] = [];
    const d = new NicSilenceDetector((s) => out.push(s));
    feed(d, [...VOICE, 2, 1], { participants: 3 });
    expect(d.open()).toMatchObject({ at: T0 + 17_000, seconds: 2, baseline: 31, rxpMin: 1 });
    // Trafik sıfırda kalır: 60 sn sonra aday düşer
    feed(d, Array.from({ length: 70 }, () => 1), { participants: 3 });
    expect(out).toEqual([]);
    expect(d.open()).toBeNull();
    // Sessizlikten sonra tabanın yarısına bile dönmeyen trafik (5 sn içinde): kesinti değil, seviye değişimi
    const d2 = new NicSilenceDetector((s) => out.push(s));
    feed(d2, [...VOICE, 2, 1, 10, 11, 12, 10, 11, 12, 10]);
    expect(out).toEqual([]);
  });

  it('biri sesten çıktıktan / yayını kapattıktan hemen sonraki çöküş kesinti değildir', () => {
    const out: NicSilence[] = [];
    const d = new NicSilenceDetector((s) => out.push(s));
    // 17. saniyede son kişi de çıkar (trafik sıfırlanır), 22. saniyede yeniden girer
    const flags = feed(d, [...VOICE, 2, 1, 0, 2, 1, 60, 70], { participants: (i) => (i >= 17 && i < 22 ? 0 : 3) });
    expect(flags.every((f) => !f)).toBe(true);
    expect(out).toEqual([]);
    // Aynı trafik, ses durumu değişmeden: sessizlik
    const d2 = new NicSilenceDetector((s) => out.push(s));
    feed(d2, [...VOICE, 2, 1, 0, 2, 1, 60, 70], { participants: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ durationMs: 5_000, participants: 3 });
  });

  it('taban düşükse (kimse bağlı değil) dedektör çalışmaz; okunamayan saniye ve kayıt boşluğu tabanı sıfırlar', () => {
    const out: NicSilence[] = [];
    const idle = new NicSilenceDetector((s) => out.push(s));
    feed(idle, [15, 12, 18, 14, 16, 15, 13, 17, 12, 15, 14, 0, 0, 0, 15, 16]); // taban < 20
    expect(out).toEqual([]);
    const d = new NicSilenceDetector((s) => out.push(s));
    feed(d, VOICE);
    expect(d.push({ t: T0 + 18_000, rxp: null })).toBe(false);
    expect(d.push({ t: T0 + 19_000, rxp: 0 })).toBe(false); // taban yeniden kurulmalı
    const gap = new NicSilenceDetector((s) => out.push(s));
    feed(gap, VOICE);
    expect(gap.push({ t: T0 + 600_000, rxp: 0 })).toBe(false); // kayıtta 10 dk boşluk
    expect(out).toEqual([]);
  });

  it('SilenceScanner: satırlar iki satır gecikmeyle değerlendirilir; sonradan işlenen yanıtsız sondalar sessizliği doğrular', () => {
    const out: NicSilence[] = [];
    const sc = new SilenceScanner((s) => out.push(s));
    const rows = [...VOICE, 0, 45, 50, 48].map((rxp, i) => row(i + 1, { rxp, txp: rxp * 2 }));
    rows.slice(0, 18).forEach((r) => sc.push(r));
    // 18. satır (gelen 0) henüz değerlendirilmedi; o saniyenin sondası 450 ms sonra zaman aşımına uğrayıp satıra işlenir
    expect(sc.open()).toBeNull();
    rows[17]!.p = { 'udp 1.1.1.1': -1 };
    rows[16]!.p = { 'tcp 8.8.8.8': -1, 'ağ geçidi': -1 };
    rows.slice(18).forEach((r) => sc.push(r));
    sc.drain();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ at: T0 + 17_000, durationMs: 1_000, probesLost: 2, probeTargets: ['tcp 8.8.8.8', 'udp 1.1.1.1'] }); // ağ geçidi sayılmaz
    expect(isCorroborated(out[0]!)).toBe(true);
    expect(rows.map((r) => r.o ?? 0).filter(Boolean)).toEqual([2]);
    expect(rows[17]!.o).toBe(2);
  });

  it('doğrulama: en az iki farklı hedeften en az iki yanıtsız sonda; tek hedefin (ör. yoklanamayan çözücü) kayıpları adayı "tam" yapmaz', () => {
    const run = (probes: (i: number) => Record<string, number> | undefined): Outage => {
      const log = new OutageLog({ dir: null, now: () => T0 + 100_000 });
      const sc = new SilenceScanner((s) => void log.addNic(s));
      [...VOICE, 0, 0, 45, 50, 48].forEach((rxp, i) => {
        const p = probes(i);
        sc.push(row(i + 1, { rxp, txp: rxp * 2, ...(p ? { p } : {}) }));
      });
      sc.drain();
      return log.list(0)[0]!;
    };
    // Aynı hedef iki kez yanıtsız (hız sınırı / erişilemeyen çözücü): aday
    const single = run((i): Record<string, number> => (i === 17 || i === 18 ? { 'udp 9.9.9.9': -1, 'udp 1.1.1.1': 5 } : { 'udp 1.1.1.1': 5 }));
    expect(single.kind).toBe('aday');
    expect(single.nic).toMatchObject({ probesLost: 2, probeTargets: ['udp 9.9.9.9'] });
    // Tek yanıtsız sonda: aday
    expect(run((i) => (i === 17 ? { 'udp 1.1.1.1': -1 } : undefined)).kind).toBe('aday');
    // İki farklı hedef: tam
    expect(run((i): Record<string, number> | undefined => (i === 17 ? { 'udp 1.1.1.1': -1 } : i === 18 ? { 'tcp 8.8.8.8': -1 } : undefined)).kind).toBe('tam');
  });

  it('kapatılmış sonda hedefinin yeniden denemeleri NIC sessizliğini doğrulamaz (uçtan uca: motor → örnekleyici → kayıt)', async () => {
    const s = new SecondSampler({ procRoot: '/yok', dir: null, participants: () => 2 });
    // b ve c hiç yanıt vermez (ör. sağlayıcı o hedefleri süzüyor); a çalışır
    const engine = new ProbeEngine({
      targets: [target('a'), target('b'), target('c', 'tcp')],
      onResult: (l, at, rtt) => s.addProbe(l, at, rtt),
      onOutage: (o) => void s.addProbeOutage(o),
      run: async (t) => (t.label === 'a' ? 6 : null),
    });
    let b = 0;
    let i = 0;
    const second = async (pps: number): Promise<void> => {
      s.tick(T0 + i * 1000, files({ dev: devText((b += pps * 1000), b) }));
      for (let k = 0; k < 4; k++) await engine.tick(T0 + i * 1000 + k * 250 + 10);
      i++;
    };
    for (let k = 0; k < 20; k++) await second(1000);
    expect(engine.status(T0 + 20_000).targets.filter((t) => t.disabled).map((t) => t.label)).toEqual(['b', 'c']);
    // 60 sn sonra iki kapalı hedef yeniden denenir (yanıtsız); tam o saniyelerde yalnızca-NIC bir sessizlik olur
    for (let k = 0; k < 43; k++) await second(1000);
    for (let k = 0; k < 4; k++) await second(3);
    for (let k = 0; k < 6; k++) await second(1000);
    const rows = s.window(T0, T0 + 100_000);
    // Yeniden denemeler satırlara yanıtsız sonda olarak yazılmadı
    expect(rows.flatMap((r) => Object.entries(r.p ?? {})).filter(([, v]) => v < 0)).toEqual([]);
    expect(rows.some((r) => r.p?.a === 6)).toBe(true);
    expect(s.outages.list(0)).toMatchObject([{ kind: 'aday', nic: { probesLost: 0, probeTargets: [] } }]);
    // Özet de şişmedi
    expect(summarizeRows(rows, T0, T0 + 100_000, 2).probeLossyTargets).toEqual([]);
  });
});

// ---------- Kesinti kaydı ----------

describe('kesinti kaydı', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-kesinti-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const probe = (at: number, durationMs: number): ProbeOutage => ({ at, durationMs, lost: 6, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8'], udp: true, tcp: true });
  const nic = (at: number, durationMs: number, probesLost = 0): NicSilence => ({ at, durationMs, rxpMin: 3, baseline: 70, participants: 0, probesLost, txCollapsed: true });

  it('yerel saat damgası istatistik saat dilimiyle yazılır', () => {
    expect(localStamp(T0 + 47_250, 180)).toBe('2026-10-01 01:18:47.250 +03:00');
    expect(localStamp(T0, 0)).toBe('2026-09-30 22:18:00.000 +00:00');
    expect(localStamp(T0, -330)).toBe('2026-09-30 16:48:00.000 -05:30');
  });

  it('NIC sessizliği tek başına adaydır; sonda kesintisiyle ya da yanıtsız sondalarla doğrulanınca tam kesinti', () => {
    const log = new OutageLog({ dir: null, offsetMin: 180, now: () => T0 + 600_000 });
    // NIC sessizliği saniye çözünürlüğünde, sonda kesintisi milisaniye: yakınsa aynı kesinti
    expect(log.addNic(nic(T0 + 10_000, 4_000)).kind).toBe('aday');
    const o = log.addProbe(probe(T0 + 9_700, 3_800));
    expect(log.list(0)).toHaveLength(1);
    expect(o).toMatchObject({ kind: 'tam', at: T0 + 9_700, durationMs: 4_300, t: '2026-10-01 01:18:09.700 +03:00' });
    expect(isConfirmedOutage(o)).toBe(true);
    // Sırası fark etmez
    log.addProbe(probe(T0 + 100_000, 1_200));
    expect(log.addNic(nic(T0 + 100_000, 2_000)).kind).toBe('tam');
    // Yalnız sonda / yalnız NIC (aday) / iki farklı hedeften yanıtsız sondalarla doğrulanmış NIC (kayıtlı sonda kesintisi olmadan)
    expect(log.addProbe(probe(T0 + 200_000, 900)).kind).toBe('sonda');
    const cand = log.addNic(nic(T0 + 300_000, 3_000));
    expect(cand.kind).toBe('aday');
    expect(isConfirmedOutage(cand)).toBe(false);
    expect(log.addNic({ ...nic(T0 + 400_000, 1_000, 2), probeTargets: ['udp 1.1.1.1', 'tcp 8.8.8.8'] })).toMatchObject({ kind: 'tam', probe: null });
    // Hedef bilgisi yoksa ya da tek hedefse doğrulanmış sayılmaz
    expect(log.addNic(nic(T0 + 450_000, 1_000, 2)).kind).toBe('aday');
    expect(log.addNic({ ...nic(T0 + 470_000, 1_000, 3), probeTargets: ['udp 9.9.9.9'] }).kind).toBe('aday');
    // Aynı türden ikinci işaret birleşmez
    expect(log.addProbe(probe(T0 + 200_500, 900)).kind).toBe('sonda');
    expect(log.list(0).map((x) => x.kind)).toEqual(['aday', 'aday', 'tam', 'aday', 'sonda', 'sonda', 'tam', 'tam']);
    expect(log.between(T0 + 9_000, T0 + 11_000).map((x) => x.kind)).toEqual(['tam']);
    expect(log.between(T0 + 500_000, T0 + 550_000)).toEqual([]);
  });

  it('durulan kayıtlar outages.jsonl dosyasına yazılır, yeniden açılışta okunur (aynı kimlik bir kez), çalışırken kırpılır', async () => {
    let now = T0 + 20_000;
    const log = new OutageLog({ dir, offsetMin: 180, now: () => now, settleMs: 8_000, maxFileLines: 6 });
    log.addProbe(probe(T0 + 10_000, 1_000));
    await log.flush();
    // Henüz durulmadı (öbür işaret gelip birleşebilir): dosya yok
    expect(fs.existsSync(path.join(dir, 'outages.jsonl'))).toBe(false);
    now += 9_000;
    await log.flush();
    const read = (): Outage[] => fs.readFileSync(path.join(dir, 'outages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Outage);
    expect(read()).toMatchObject([{ kind: 'sonda' }]);
    // Dosyaya yazıldıktan SONRA öbür işaret gelip birleşti: aynı kimlik ikinci kez eklenir
    log.addNic(nic(T0 + 10_000, 2_000));
    now += 9_000;
    await log.flush();
    expect(read().map((o) => [o.id, o.kind])).toEqual([
      [read()[0]!.id, 'sonda'],
      [read()[0]!.id, 'tam'],
    ]);
    // Yeniden açılışta aynı kimlik bir kez sayılır ve son hali geçerlidir
    const again = new OutageLog({ dir, offsetMin: 180, now: () => now });
    expect(again.list(0)).toHaveLength(1);
    expect(again.list(0)[0]).toMatchObject({ kind: 'tam', t: '2026-10-01 01:18:10.000 +03:00' });
    // Yeni kimlikler dosyadakilerle çakışmaz
    expect(again.addProbe(probe(T0 + 10_000 + 3_600_000, 500)).id).not.toBe(read()[0]!.id);
    // Çalışırken kırpma: sınır aşılınca dosya bellekteki listeyle (her kimlik bir kez) yeniden yazılır
    for (let i = 0; i < 5; i++) log.addProbe(probe(T0 + 60_000 + i * 20_000, 800));
    await log.stop();
    const lines = read();
    expect(lines.length).toBe(6);
    expect(new Set(lines.map((l) => l.id)).size).toBe(6);
    const old = new OutageLog({ dir, offsetMin: 180, now: () => now + 15 * 86_400_000 });
    expect(old.list(0)).toEqual([]);
  });

  it('örnekleyici: sessizlik gecikmeli değerlendirilir, sonda kesintisiyle birleşir, satırlar işaretlenir', () => {
    const s = new SecondSampler({ procRoot: '/yok', dir: null, participants: () => 2 });
    let b = 0;
    const tick = (i: number, pps: number): SecondRow | null => s.tick(T0 + i * 1000, files({ dev: devText((b += pps * 1000), b) }));
    for (let i = 0; i <= 15; i++) tick(i, 1000);
    for (let i = 16; i <= 18; i++) tick(i, 5);
    // İki satır gecikme: 18. saniyede yalnızca 16. saniye değerlendirildi
    expect(s.openSilence()).toMatchObject({ at: T0 + 15_000, seconds: 1, baseline: 1000 });
    expect(s.outages.list(0)).toEqual([]);
    for (let i = 19; i <= 22; i++) tick(i, 1000);
    expect(s.openSilence()).toBeNull();
    // Sondalarla doğrulanmadı: aday
    expect(s.outages.list(0)).toMatchObject([{ kind: 'aday', at: T0 + 15_000, durationMs: 3_000, nic: { probesLost: 0, txCollapsed: true } }]);
    const o = s.addProbeOutage({ at: T0 + 15_200, durationMs: 2_900, lost: 11, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8'], udp: true, tcp: true });
    expect(o.kind).toBe('tam');
    const marks = s.window(T0 + 14_000, T0 + 20_000).map((r) => r.o ?? 0);
    // 15. sn temiz; 16-18: NIC (2) + sonda (1); 19: yalnızca sonda kesintisinin son 100 ms'si
    expect(marks).toEqual([0, 0, 3, 3, 3, 1, 0]);
  });

  it('örnekleyici zamanlayıcısındaki hata süreci düşürmez (yakalanır ve günlüğe yazılır)', async () => {
    const warns: string[] = [];
    let calls = 0;
    const s = new SecondSampler({
      procRoot: '/yok',
      dir: null,
      readFiles: () => {
        calls++;
        throw new Error('okuma patladı');
      },
      log: { warn: (_o, m) => warns.push(m) },
    });
    s.start();
    await sleep(2_300);
    await s.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warns).toEqual(['saniyelik ağ ölçümü hata verdi']); // seyrek: her hatada değil
  });
});

// ---------- LiveKit ölçüm geçmişi ----------

describe('LiveKit ölçüm geçmişi (olay kanıtı)', () => {
  const text = (n: number): string =>
    ['livekit_room_total 1', 'livekit_participant_total 3', `livekit_packet_total{direction="incoming"} ${1000 * n}`, `livekit_packet_total{direction="outgoing"} ${3000 * n}`, `livekit_nack_total ${20 * n}`, `livekit_pli_total ${4 * n}`, `process_cpu_seconds_total ${n}`].join('\n');

  it('window: küçültülmüş satırlar; historySince seyreltir', async () => {
    let n = 0;
    const lk = new LiveKitMetrics({ url: 'http://lk.test/metrics', fetchImpl: (async () => new Response(text(++n), { status: 200 })) as typeof fetch });
    for (let i = 0; i <= 10; i++) await lk.scrape(1_000_000 + i * 2_000);
    const rows = lk.window(1_000_000, 1_100_000);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ t: 1_002_000, pin: 500, pout: 1500, nack: 10, pli: 2, fir: null, lin: null, lout: null, parts: 3, cpu: 0.5 });
    expect(lk.window(1_005_000, 1_009_000).map((r) => r.t)).toEqual([1_006_000, 1_008_000]);
    // Panel grafikleri için ~10 sn'de bir
    expect(lk.historySince(0, 9_000).map((s) => s.at)).toEqual([1_002_000, 1_012_000]);
    expect(lk.historySince(0)).toHaveLength(10);
    // boost: zamanlayıcı yokken (testler) güvenle yok sayılır
    expect(() => lk.boost(Date.now() + 60_000)).not.toThrow();
  });

  it('boost: ölçüm sürerken çağrılırsa ikinci bir ölçüm döngüsü başlamaz', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const slow = new LiveKitMetrics({
      url: 'http://lk.test/metrics',
      fetchImpl: (async () => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return new Response(text(calls), { status: 200 });
      }) as typeof fetch,
    });
    slow.start(); // ilk ölçüm askıda
    await sleep(20);
    expect(calls).toBe(1);
    slow.boost(Date.now() + 60_000); // ölçüm sürerken: yeni zamanlayıcı kurulmamalı
    slow.boost(Date.now() + 60_000);
    release!();
    await sleep(2_400); // sık aralık (2 sn): tek döngü → tek yeni ölçüm
    expect(calls).toBe(2);
    release!();
    slow.stop();
  });
});

// ---------- Yönetim uçları ----------

describe('bağlantı teşhisi uçları', () => {
  let s: TestServer;
  let tmp: string;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskort-net-uc-'));
    s = await startServer({ telemetryDir: tmp });
  });
  afterEach(async () => {
    await s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Örnekleyiciye `n` saniyelik satır verir (şimdiye kadar) */
  function feedSampler(n: number): number {
    const now = Date.now();
    let b = 0;
    for (let i = n; i >= 0; i--) {
      const at = now - i * 1000;
      s.ctx.netSampler.tick(at, files({ dev: devText((b += 1_250_000), b) }));
      s.ctx.netSampler.addProbe('udp 1.1.1.1', at - 300, 9);
    }
    return now;
  }

  it('oturumsuz 401, hesap yöneticisi olmayan 403; geçersiz sorgu 400', async () => {
    const member = await s.member('uye');
    for (const url of ['/api/admin/net/live', '/api/admin/net/seconds?from=1&to=2', '/api/admin/net/outages', '/api/admin/net/minutes']) {
      expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await s.req(member.token, 'GET', url)).statusCode).toBe(403);
      const ok = await s.app.inject({ method: 'GET', url, headers: auth(s.owner.token) });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
    }
    for (const url of [
      '/api/admin/net/live?seconds=5000',
      '/api/admin/net/seconds',
      '/api/admin/net/seconds?from=10&to=5',
      `/api/admin/net/seconds?from=0&to=${16 * 60_000}`,
      '/api/admin/net/outages?days=90',
      '/api/admin/net/minutes?day=dun',
    ]) {
      expect((await s.req(s.owner.token, 'GET', url)).statusCode).toBe(400);
    }
  });

  it('canlı durum: son saniyeler, sondalar, kesintiler; since ile yalnızca yeni satırlar', async () => {
    const now = feedSampler(40);
    s.ctx.netSampler.addProbeOutage({ at: now - 20_000, durationMs: 1_500, lost: 6, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8'], udp: true, tcp: true });
    const d = (await s.req(s.owner.token, 'GET', '/api/admin/net/live?seconds=30')).json();
    expect(d.rows.length).toBeGreaterThanOrEqual(29);
    expect(d.rows.length).toBeLessThanOrEqual(31);
    expect(d.rows.at(-1)).toMatchObject({ rx: 10, rxp: 1250, p: { 'udp 1.1.1.1': 9 } });
    expect(d.sampler).toMatchObject({ iface: 'eth0', gateway: '192.168.0.1', readable: { net: true } });
    expect(d.probes.targets.map((t: { label: string }) => t.label)).toContain('udp 1.1.1.1');
    expect(d.probes.running).toBe(false);
    expect(d.open).toEqual({ probe: null, nic: null });
    expect(d.outages).toHaveLength(1);
    expect(d.outages[0]).toMatchObject({ kind: 'sonda', durationMs: 1_500 });
    expect(d.outageCounts).toEqual({ day: 1, week: 1 });
    expect(d.livekit).toMatchObject({ configured: false, ok: false, history: [] });
    expect(d.voice).toEqual({ participants: 0, streams: 0, channels: 0 });
    const last = d.rows.at(-3).t as number;
    const inc = (await s.req(s.owner.token, 'GET', `/api/admin/net/live?since=${last}`)).json();
    expect(inc.rows.map((r: SecondRow) => r.t)).toEqual(d.rows.slice(-2).map((r: SecondRow) => r.t));
  });

  it('saniyelik aralık, kesinti listesi ve dakikalık özet; makine ağı tek örnekleyiciden', async () => {
    const now = feedSampler(130);
    s.ctx.netSampler.addProbeOutage({ at: now - 50_000, durationMs: 2_000, lost: 8, targets: ['udp 1.1.1.1', 'tcp 8.8.8.8'], udp: true, tcp: true });
    const sec = (await s.req(s.owner.token, 'GET', `/api/admin/net/seconds?from=${now - 60_000}&to=${now - 40_000}`)).json();
    expect(sec.rows).toHaveLength(21);
    expect(sec.outages).toHaveLength(1);
    expect(sec.rows.filter((r: SecondRow) => r.o === 1).length).toBeGreaterThanOrEqual(2);
    const out = (await s.req(s.owner.token, 'GET', '/api/admin/net/outages?days=1')).json();
    expect(out.outages).toHaveLength(1);
    expect(out.iface).toBe('eth0');
    const min = (await s.req(s.owner.token, 'GET', '/api/admin/net/minutes')).json();
    expect(min.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(min.offsetMin).toBe(180);
    // 130 saniyede en az bir dakika bitti (gün dönümüne denk gelirse önceki günün dosyasındadır)
    const all = (await Promise.all((min.days as string[]).map(async (day) => (await s.req(s.owner.token, 'GET', `/api/admin/net/minutes?day=${day}`)).json().rows as MinuteRow[]))).flat();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0]!.rx?.[0]).toBe(10);
    const infra = (await s.req(s.owner.token, 'GET', '/api/admin/infra')).json();
    expect(infra.network).toMatchObject({ ok: true, iface: 'eth0', error: null });
    expect(infra.network.history.length).toBeGreaterThanOrEqual(8);
    expect(infra.network.history.at(-2)).toMatchObject({ rxMbps: 10, txMbps: 10, rxPps: 1250 });
    // Olay listesi ucu: çakışan hat testleri alanı da var
    const inc = (await s.req(s.owner.token, 'GET', '/api/admin/telemetry/incidents')).json();
    expect(inc.lineTests).toEqual([]);
    expect(inc.netSampler.ring).toBe(130);
    await sleep(10);
  });
});
