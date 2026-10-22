import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OutageLog, type NicSilence, type Outage } from '../src/netOutages.js';
import { OutageDetector, type ProbeOutage } from '../src/netProbe.js';
import { GATEWAY_LABEL, SilenceScanner, type SecondRow } from '../src/netSeconds.js';

// Gerçek sunucu verisiyle yeniden oynatma (fixtures/real-seconds-2026-10-01.json: VPS'in 2026-10-01 gecesindeki
// saniyelik satırları). Bilinen gerçek: yalnızca üç gerçek kesinti var; geri kalan her şey (konuşma durunca
// ~250 → ~30 pk/sn, yayında ekran durağanlaşınca ~1100 → ~80 pk/sn, tek tük yanıtsız sonda) kesinti DEĞİLDİR.
//  - muosc0b1-2 (yayın yok, 4 kişi seste): +23..+25 sn (gelen 41 → 21 → 0 pk/sn, sondalar yanıtsız)
//  - muosc0b1-2: +60..+64 sn (gelen 32 → 8 → 4 → 3 → 0 pk/sn, üç sonda hedefi de yanıtsız)
//  - muoq8g01-0 (yayın): ≈ +57..+58 sn (gelen 1 pk/sn, sondalar 54/56/57. saniyelerde yanıtsız)
// Eski veri her hedefi 2 sn'de bir yokluyordu (yeni motor saniyede 4 sonda gönderir): oynatma düzeneği satırlardaki
// sonda sonuçlarını olduğu gibi, ÜRETİMDEKİ eşiklerle (art arda ≥3 kayıp, ≥2 hedef) dedektöre verir.

type Slim = [number, number | null, number | null, Record<string, number>?];
interface Fixture {
  netsec: Slim[];
  events: { id: string; start: number; end: number; streaming: boolean; rows: Slim[] }[];
}
const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/real-seconds-2026-10-01.json'), 'utf8')) as Fixture;

const toRow = ([t, rxp, txp, p]: Slim): SecondRow => ({ t, rx: null, tx: null, rxp, txp, nd: 0, ue: 0, ur: 0, us: 0, sd: null, psi: null, lk: null, ...(p ? { p } : {}) });

/** Satırları üretimdeki zincirden geçirir: gecikmeli NIC sessizliği + sonda kesintisi + kesinti kaydı */
function replay(slim: Slim[]): { outages: Outage[]; silences: NicSilence[]; probes: ProbeOutage[]; rows: SecondRow[] } {
  const rows = slim.map(toRow);
  const log = new OutageLog({ dir: null, offsetMin: 180, now: () => rows.at(-1)!.t });
  const silences: NicSilence[] = [];
  const probes: ProbeOutage[] = [];
  const scanner = new SilenceScanner((s) => {
    silences.push(s);
    log.addNic(s);
  });
  const detector = new OutageDetector({
    onOutage: (o) => {
      probes.push(o);
      log.addProbe(o);
    },
  });
  let seq = 0;
  let prevT: number | null = null;
  for (const row of rows) {
    // Kayıt kesikse (dosya yalnızca anormal saniyelerin çevresini içerir) süren sonda dizisi sıfırlanır
    if (prevT !== null && row.t - prevT > 5_000) {
      // Protokol başına seriler de sıfırlansın: her iki protokolden bir "yanıt"
      detector.push({ seq: seq++, label: 'boşluk', kind: 'udp', sentAt: row.t, rtt: 0 });
      detector.push({ seq: seq++, label: 'boşluk', kind: 'tcp', sentAt: row.t, rtt: 0 });
    }
    prevT = row.t;
    for (const [label, v] of Object.entries(row.p ?? {})) {
      if (label === GATEWAY_LABEL) continue;
      detector.push({ seq: seq++, label, kind: label.startsWith('tcp') ? 'tcp' : 'udp', sentAt: row.t - 500, rtt: v < 0 ? null : v });
    }
    scanner.push(row);
  }
  scanner.drain();
  return { outages: log.list(0).reverse(), silences, probes, rows };
}

const offsetSec = (o: { at: number }, start: number): number => Math.round((o.at - start) / 1000);

describe('gerçek veriyle yeniden oynatma', () => {
  const event = (id: string) => fixture.events.find((e) => e.id === id)!;

  it('muosc0b1-2 (yayın yok, konuşmayla 30–250 pk/sn oynayan trafik): iki gerçek kesinti, başka hiçbir şey', () => {
    const e = event('muosc0b1-2');
    const r = replay(e.rows);
    expect(r.outages.map((o) => [offsetSec(o, e.start), o.kind])).toEqual([
      [24, 'tam'],
      [60, 'tam'],
    ]);
    const [first, second] = r.outages;
    // +25. saniye: gelen 0 pk/sn (bir önceki saniye 21); 23-24. saniyelerde iki sonda yanıtsız
    expect(first!.nic).toMatchObject({ rxpMin: 0, txCollapsed: true });
    expect(Math.round(first!.nic!.durationMs / 1000)).toBe(1);
    // Doğrulama: iki farklı hedeften iki yanıtsız sonda (aynı adresin TCP ve UDP sondaları)
    expect(first!.nic!.probesLost).toBe(2);
    expect(first!.nic!.probeTargets!.sort()).toEqual(['tcp 1.1.1.1', 'udp 1.1.1.1']);
    expect(first!.nic!.baseline).toBeGreaterThanOrEqual(28);
    expect(first!.probe).toBeNull(); // eski yoklama sıklığında art arda üç kayıp oluşmadı: doğrulama yanıtsız sondalardan
    // +61..+64: gelen 8 → 4 → 3 → 0; üç hedef de yanıtsız (üretim eşikleriyle sonda kesintisi)
    expect(second!.nic).toMatchObject({ rxpMin: 0, txCollapsed: true });
    expect(Math.round(second!.nic!.durationMs / 1000)).toBe(4);
    expect(second!.probe).toMatchObject({ lost: 6, udp: true, tcp: true });
    expect(second!.probe!.targets.sort()).toEqual(['tcp 1.1.1.1', 'udp 1.1.1.1', 'udp 8.8.8.8']);
    expect(second!.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(r.probes).toHaveLength(1);
    // İşaretli saniyeler yalnızca bunlar
    expect(r.rows.filter((x) => (x.o ?? 0) & 2).map((x) => Math.round((x.t - e.start) / 1000))).toEqual([25, 61, 62, 63, 64]);
  });

  it('muoq8g01-0 (yayın): tek gerçek kesinti (+58. saniye); ekran durağanlaşınca 1100 → 80 pk/sn kesinti değil', () => {
    const e = event('muoq8g01-0');
    const r = replay(e.rows);
    expect(r.outages.map((o) => [offsetSec(o, e.start), o.kind])).toEqual([[57, 'tam']]);
    expect(r.outages[0]!.nic).toMatchObject({ rxpMin: 1, txCollapsed: true });
    expect(Math.round(r.outages[0]!.nic!.durationMs / 1000)).toBe(1);
    // Doğrulama: iki farklı çözücüye giden iki yanıtsız UDP sondası (56. ve 57. saniyeler)
    expect(r.outages[0]!.nic!.probesLost).toBe(2);
    expect(r.outages[0]!.nic!.probeTargets!.sort()).toEqual(['udp 1.1.1.1', 'udp 8.8.8.8']);
    expect(r.probes).toEqual([]);
    // Verideki büyük düşüşler (ör. 1140 → 78 pk/sn) dedektörü tetiklemedi
    const rx = r.rows.map((x) => x.rxp ?? 0);
    expect(rx.some((v, i) => i > 0 && rx[i - 1]! > 1_000 && v < 100 && v > 8)).toBe(true);
  });

  it('öbür üç olayda (yayın; kare hızı / kodlayıcı / kullanıcı hatları) hiçbir kesinti ya da aday yok', () => {
    // muosxa5r-0'da UDP kayıpları aynı turdaki UDP yanıtlarıyla iç içe: protokol serisi tur koşulu yüzünden kesinti saymaz
    for (const id of ['muosxa5r-0', 'muot5prx-1', 'muoth67a-0']) {
      const r = replay(event(id).rows);
      expect([id, r.outages.map((o) => o.kind), r.silences.length]).toEqual([id, [], 0]);
    }
  });

  it('gün dosyasının tamamı (1001 saniye, 15 ayrı bölüm): yalnızca 00:18 kesintisi; tek tük yanıtsız sonda ve sessizlik tabanı (~28 pk/sn) kesinti değil', () => {
    const r = replay(fixture.netsec);
    expect(r.outages).toHaveLength(1);
    const [o] = r.outages;
    expect(o).toMatchObject({ kind: 'tam' });
    expect(o!.t.slice(0, 16)).toBe('2026-10-01 03:18');
    expect(o!.nic).toMatchObject({ rxpMin: 0 });
    expect(Math.round(o!.nic!.durationMs / 1000)).toBe(4);
    expect(r.silences).toHaveLength(1);
    // Dosyada tabana inen (≤ 30 pk/sn) onlarca saniye var; hiçbiri sessizlik sayılmadı
    expect(r.rows.filter((x) => x.rxp !== null && x.rxp <= 30 && x.rxp > 8).length).toBeGreaterThan(20);
    expect(r.rows.filter((x) => (x.o ?? 0) & 2)).toHaveLength(4);
  });
});
