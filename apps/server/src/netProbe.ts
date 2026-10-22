import dgram from 'node:dgram';
import net from 'node:net';
import { GATEWAY_LABEL } from './netSeconds.js';

// Bağlantı teşhisi: sunucudan dış hedeflere etkin sondalar (tek motor). İki soruyu yanıtlar:
//  1) İstemcilerde aynı anda paket kaybı olduğunda sunucunun sağlayıcı yolunda da kayıp/gecikme var mıydı?
//  2) Sunucunun dış bağlantısı kısa süreliğine (yarım saniye ve üstü) tümden kesildi mi? ("kesinti")
//
// Yöntem (yalnızca Node, yerel bağımlılık ve ek yetki yok):
// - ICMP ping kullanılmaz: node:24-slim imajında `ping` yok, ham soket CAP_NET_RAW ister.
// - UDP: kök alanı için açık çözücülere 53. porttan DNS sorgusu (NS .), yanıt gelene kadar süre = RTT.
//   Sorunlar UDP medya akışında görüldüğü için UDP sondası en ilgili olanıdır; her sonda yeni bir kaynak
//   portundan çıkar (durağan bir akışa takılı kalmaz).
// - TCP: 443'e bağlantı kurma süresi (SYN → SYN/ACK); kayıp = zaman aşımı.
// - Yük düşük tutulur: toplam saniyede ~4 sonda, hedefler sırayla (her hedefe ~1,25 sn'de bir). Aynı çözücüye
//   saniyede onlarca sorgu göndermek hem kabalıktır hem de çözücünün hız sınırı sahte kayıp üretir.
// - Sayım GÖNDERİM sırasıyladır: sondalar farklı anlarda sonuçlanır (yanıtsız olan zaman aşımında, sonraki
//   başarılı olan ondan önce), bu yüzden sonuçlar sıra numarasına göre dizilip öyle değerlendirilir.
// - Kesinti: gönderim sırasıyla art arda en az 3 sonda, en az 2 farklı hedefte yanıtsız kalırsa. Seriler hem tüm
//   sondalar için hem protokol başına (UDP ayrı, TCP ayrı) tutulur: yalnız UDP'yi etkileyen kesinti, araya giren
//   başarılı TCP sondalarına rağmen yakalanır (kayıtta proto: "udp"). Tek bir çözücünün hız sınırı ya da arızası
//   bu yüzden hiçbir zaman kesinti sayılmaz.
// - Ağ geçidi (/proc/net/route'tan): birkaç saniyede bir TCP 80'e bağlantı denemesi ("bağlantı reddedildi" de
//   yanıttır). Ağ geçitleri çoğu zaman yanıt vermez: hiç yanıt gelmezse sonda kendini kapatır; kesinti
//   yargısına hiç katılmaz.

export interface ProbeTarget {
  label: string;
  kind: 'udp' | 'tcp';
  host: string;
  port: number;
}

export const DEFAULT_PROBE_TARGETS: ProbeTarget[] = [
  { label: 'udp 1.1.1.1', kind: 'udp', host: '1.1.1.1', port: 53 },
  { label: 'tcp 8.8.8.8', kind: 'tcp', host: '8.8.8.8', port: 443 },
  { label: 'udp 8.8.8.8', kind: 'udp', host: '8.8.8.8', port: 53 },
  { label: 'tcp 1.1.1.1', kind: 'tcp', host: '1.1.1.1', port: 443 },
  { label: 'udp 9.9.9.9', kind: 'udp', host: '9.9.9.9', port: 53 },
];

/** "udp:1.1.1.1:53,tcp:1.1.1.1:443" biçimli ayarı hedeflere çevirir; geçersiz parçalar atılır */
export function parseProbeTargets(spec: string | undefined): ProbeTarget[] | null {
  if (spec === undefined || spec.trim() === '') return null;
  if (spec.trim() === '0') return [];
  const out: ProbeTarget[] = [];
  for (const part of spec.split(',')) {
    const m = /^(udp|tcp):([0-9a-fA-F.:]+):(\d{1,5})$/.exec(part.trim());
    if (!m) continue;
    const port = Number(m[3]);
    if (port < 1 || port > 65535) continue;
    out.push({ label: `${m[1]} ${m[2]}`, kind: m[1] as 'udp' | 'tcp', host: m[2]!, port });
  }
  return out;
}

/** Kök alanı için NS sorgusu (12 baytlık başlık + "." adı + tür NS + sınıf IN) */
export function dnsQuery(id: number): Buffer {
  const b = Buffer.alloc(17);
  b.writeUInt16BE(id, 0);
  b.writeUInt16BE(0x0100, 2); // RD
  b.writeUInt16BE(1, 4); // QDCOUNT
  // b[12] = 0 (kök adı); tür NS=2, sınıf IN=1
  b.writeUInt16BE(2, 13);
  b.writeUInt16BE(1, 15);
  return b;
}

/** UDP DNS sondası: yanıt gelirse RTT (ms), gelmezse null */
export function probeUdp(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 0xffff);
    const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const start = process.hrtime.bigint();
    let done = false;
    const finish = (v: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // zaten kapalı
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('message', (msg) => {
      if (msg.length >= 2 && msg.readUInt16BE(0) === id) finish(Number(process.hrtime.bigint() - start) / 1e6);
    });
    socket.on('error', () => finish(null));
    socket.send(dnsQuery(id), port, host, (err) => {
      if (err) finish(null);
    });
  });
}

/** TCP bağlantı sondası: bağlanırsa (reddedilse de, yanıt sayılır) süre (ms), zaman aşımında null */
export function probeTcp(host: string, port: number, timeoutMs: number, refusedCounts = false): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (v: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const elapsed = (): number => Number(process.hrtime.bigint() - start) / 1e6;
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('connect', () => finish(elapsed()));
    socket.on('error', (err: NodeJS.ErrnoException) => finish(refusedCounts && err.code === 'ECONNREFUSED' ? elapsed() : null));
  });
}

// ---------- Kesinti dedektörü (saf; gönderim sırasıyla beslenir) ----------

/** Bir sondanın sonucu; `seq` gönderim sırası */
export interface ProbeResult {
  seq: number;
  label: string;
  kind: 'udp' | 'tcp';
  sentAt: number;
  /** RTT (ms); null: zaman aşımı */
  rtt: number | null;
  /** Yargıya katılmaz (kapatılmış hedefin yanıtsız kalan yeniden denemesi) */
  skip?: boolean;
}

/** Kesintiden etkilenen protokol: both = tüm yol (UDP ve TCP sondaları birlikte, gönderim sırasıyla art arda yanıtsız) */
export type ProbeProto = 'udp' | 'tcp' | 'both';

/** Dış bağlantı kesintisi: art arda yanıtsız sondalar (≥2 farklı hedef) */
export interface ProbeOutage {
  /** İlk yanıtsız sondanın gönderildiği an (ms) */
  at: number;
  /** İlk yanıtsız gönderimden ilk yanıt alan gönderime kadar (ms) */
  durationMs: number;
  /** Art arda yanıtsız sonda sayısı ve etkilenen hedefler */
  lost: number;
  targets: string[];
  /** UDP ve TCP hedefleri etkilendi mi (ikisi de: yol tümden kesik; yalnızca UDP: UDP'ye özgü süzgeç olabilir) */
  udp: boolean;
  tcp: boolean;
  /**
   * Kesintiyi hangi seri yakaladı: both = tüm sondalar (protokol ayırmadan) art arda yanıtsız; udp / tcp = yalnızca o
   * protokolün sondaları art arda yanıtsız, öbür protokol yanıt vermeye devam etti. Eski kayıtlarda yok.
   */
  proto?: ProbeProto;
}

export interface OutageDetectorOptions {
  /** Art arda en az bu kadar yanıtsız sonda (varsayılan 3) */
  minRun?: number;
  /** ... ve en az bu kadar farklı hedef (varsayılan 2) */
  minTargets?: number;
  onOutage: (o: ProbeOutage) => void;
}

/** Art arda yanıtsız sondalardan oluşan seri: yalnızca özet tutulur (seri ne kadar uzarsa uzasın bellek sabit) */
interface LossRun {
  at: number;
  n: number;
  targets: Set<string>;
  /** Protokol başına yanıtsız sonda sayısı ve hedefler */
  count: Record<'udp' | 'tcp', number>;
  kindTargets: Record<'udp' | 'tcp', Set<string>>;
  /** Farklı gönderim anları (en çok 2 tutulur: "en az iki tur" koşulu için) */
  rounds: Set<number>;
  /** Yalnız tüm-sonda serisinde: seri başladığında hangi protokol serisi zaten KENDİ BAŞINA eşiği aşmıştı */
  preDown: Record<'udp' | 'tcp', boolean>;
}

const newRun = (): LossRun => ({ at: 0, n: 0, targets: new Set(), count: { udp: 0, tcp: 0 }, kindTargets: { udp: new Set(), tcp: new Set() }, rounds: new Set(), preDown: { udp: false, tcp: false } });

function addLoss(run: LossRun, r: ProbeResult): void {
  if (run.n === 0) run.at = r.sentAt;
  run.n++;
  run.targets.add(r.label);
  run.count[r.kind]++;
  run.kindTargets[r.kind].add(r.label);
  if (run.rounds.size < 2) run.rounds.add(r.sentAt);
}

/**
 * Üç seri birlikte tutulur: tüm sondalar (gönderim sırasıyla, herhangi bir yanıt seriyi bitirir) ve protokol başına
 * (UDP ayrı, TCP ayrı: yalnızca aynı protokolden bir yanıt seriyi bitirir). Böylece araya giren başarılı TCP
 * sondaları yalnızca UDP'yi etkileyen bir kesintiyi (ses/yayın paketleri) gizlemez. Her seride eşik aynıdır
 * (art arda ≥minRun yanıtsız, ≥minTargets farklı hedef): tek çözücünün hız sınırı hiçbir seride kesinti sayılmaz.
 * - Protokol serisi ayrıca en az iki farklı gönderim turuna yayılmalıdır; aynı turda o protokolden yanıt gelmişse o
 *   turun kayıpları seriye katılmaz (aynı anda gönderilmiş sondaların sonuçlanma sırası tek başına kesinti üretmesin).
 * - Tüm-sonda serisi "tüm yol" (both) sayılır, ama bir protokol seri başlamadan önce kendi başına kesinti eşiğini
 *   aşmışken öbüründen tek hedefin kaybı araya düştüyse değil: o durumda öbür protokolde de ≥minTargets hedef yanıtsız kalmalıdır; yoksa kayıt
 *   önceden kesik protokolün serisi olarak sürer. Tüm yol kaydında o sırada açık protokol serileri de ona katılır.
 */
export class OutageDetector {
  private run = newRun();
  private readonly byKind: Record<'udp' | 'tcp', LossRun> = { udp: newRun(), tcp: newRun() };
  /** Son yanıtın gönderim anı (tüm sondalar / protokol başına) */
  private lastReply = Number.NaN;
  private readonly lastReplyByKind: Record<'udp' | 'tcp', number> = { udp: Number.NaN, tcp: Number.NaN };

  constructor(private readonly opts: OutageDetectorOptions) {}

  private get minRun(): number {
    return this.opts.minRun ?? 3;
  }

  private get minTargets(): number {
    return this.opts.minTargets ?? 2;
  }

  private kindQualifies(k: 'udp' | 'tcp'): boolean {
    const r = this.byKind[k];
    return r.n >= this.minRun && r.targets.size >= this.minTargets && r.rounds.size >= 2;
  }

  /** Tüm-sonda serisi "tüm yol" kesintisi mi */
  private bothQualifies(): boolean {
    const r = this.run;
    if (r.n < this.minRun || r.targets.size < this.minTargets) return false;
    for (const k of ['udp', 'tcp'] as const) {
      const other = k === 'udp' ? 'tcp' : 'udp';
      // k protokolü bu seri başlamadan önce kendi başına kesinti eşiğini aşmıştı: öbür protokolün kaybı da yaygın
      // olmalı (tek hedefin araya düşen kaybı kaydı "tüm yol" yapmasın). Önceki tek tük kayıplar bu şartı doğurmaz.
      if (r.preDown[k] && r.kindTargets[other].size < this.minTargets) return false;
    }
    return true;
  }

  private describe(kinds: readonly ('udp' | 'tcp')[], end: number, proto: ProbeProto, base?: LossRun): ProbeOutage {
    // base (tüm-sonda serisi) varsa protokol serilerinin ondan ÖNCEKİ kayıpları eklenir (sonrakiler zaten içinde)
    let lost = base?.n ?? 0;
    let at = base && base.n > 0 ? base.at : Number.POSITIVE_INFINITY;
    const targets = new Set(base?.targets ?? []);
    let udp = (base?.count.udp ?? 0) > 0;
    let tcp = (base?.count.tcp ?? 0) > 0;
    for (const k of kinds) {
      const r = this.byKind[k];
      if (r.n === 0) continue;
      lost += base ? Math.max(0, r.n - base.count[k]) : r.n;
      at = Math.min(at, r.at);
      for (const t of r.targets) targets.add(t);
      if (k === 'udp') udp = true;
      else tcp = true;
    }
    return { at, durationMs: Math.max(0, Math.round(end - at)), lost, targets: [...targets], udp, tcp, proto };
  }

  /** Şu an kesinti sayılacak seriler (yoksa null) */
  private current(end: number): ProbeOutage | null {
    if (this.bothQualifies()) return this.describe(['udp', 'tcp'], end, 'both', this.run);
    const q = (['udp', 'tcp'] as const).filter((k) => this.kindQualifies(k));
    if (q.length === 0) return null;
    return this.describe(q, end, q.length === 2 ? 'both' : q[0]!);
  }

  /** Sonuçlar GÖNDERİM sırasıyla verilmelidir */
  push(r: ProbeResult): void {
    if (r.rtt === null) {
      if (r.sentAt !== this.lastReply) {
        // Tüm-sonda serisi başlarken protokol serilerinin (bu sonda henüz katılmadan) durumu kaydedilir
        if (this.run.n === 0) this.run.preDown = { udp: this.kindQualifies('udp'), tcp: this.kindQualifies('tcp') };
        addLoss(this.run, r);
      }
      if (r.sentAt !== this.lastReplyByKind[r.kind]) addLoss(this.byKind[r.kind], r);
      return;
    }
    let out: ProbeOutage | null = null;
    let closeAll = false;
    if (this.bothQualifies()) {
      // Yol geri geldi: açık protokol serileri de bu kesintinin parçasıdır
      out = this.describe(['udp', 'tcp'], r.sentAt, 'both', this.run);
      closeAll = true;
    } else if (this.kindQualifies(r.kind)) {
      out = this.describe([r.kind], r.sentAt, r.kind);
    }
    // Seriler bildirimden önce sıfırlanır (bildirimdeki bir hata dedektörü bozuk bırakmasın)
    this.run = newRun();
    this.byKind[r.kind] = newRun();
    if (closeAll) {
      this.byKind.udp = newRun();
      this.byKind.tcp = newRun();
    }
    this.lastReply = r.sentAt;
    this.lastReplyByKind[r.kind] = r.sentAt;
    if (out) this.opts.onOutage(out);
  }

  /** Süren (henüz yanıt alınmamış) kesinti; yoksa null */
  open(now: number): ProbeOutage | null {
    return this.current(now);
  }
}

// ---------- Sonda motoru ----------

export interface ProbeEngineOptions {
  targets: ProbeTarget[];
  /** İki sonda arası (ms; varsayılan 250: saniyede 4 sonda, hedefler sırayla) */
  intervalMs?: number;
  /** Yanıt bekleme süresi (ms; varsayılan 450) */
  timeoutMs?: number;
  /** Ağ geçidi adresi (her seferinde sorulur: yol değişebilir); verilmezse ağ geçidi sondası yok */
  gateway?: () => string | null;
  /** Ağ geçidi yoklama aralığı (ms; varsayılan 5000) */
  gatewayIntervalMs?: number;
  /** Her sondanın sonucu: gönderilme anı, hedef etiketi, RTT (null: yanıt yok). Sonuçlanma sırasıyla gelir. */
  onResult: (label: string, sentAt: number, rttMs: number | null) => void;
  onOutage?: (o: ProbeOutage) => void;
  /** Testler: gerçek ağ yerine */
  run?: (target: ProbeTarget, timeoutMs: number) => Promise<number | null>;
  now?: () => number;
}

export interface ProbeTargetStatus {
  label: string;
  kind: 'udp' | 'tcp';
  /** Son 60 saniyede gönderilen / yanıtsız kalan */
  sent: number;
  lost: number;
  lastRtt: number | null;
  lastAt: number | null;
  /** Hiç yanıt vermediği için sıradan çıkarıldı */
  disabled: boolean;
}

export interface ProbeStatus {
  running: boolean;
  intervalMs: number;
  timeoutMs: number;
  targets: ProbeTargetStatus[];
  gateway: { host: string | null; disabled: boolean };
  /** Süren kesinti (henüz yanıt alınmadı) */
  open: ProbeOutage | null;
}

interface TargetState {
  target: ProbeTarget;
  sent: number;
  replied: number;
  disabled: boolean;
  /** Kapalıyken en son yeniden denendiği an */
  retriedAt: number;
  lastReplyAt: number;
  recent: { at: number; rtt: number | null }[];
}

/** İlk bu kadar sondanın hiçbiri yanıtlanmadıysa hedef (ya da ağ geçidi) bu yöntemle yoklanamıyor: bırakılır */
const NEVER_REPLIED_AFTER = 15;
const RECENT_MS = 60_000;
/** Kapatılan hedef bu aralıkla yeniden denenir; yanıt verirse sıraya döner */
const RETRY_DISABLED_MS = 60_000;
/** Bir hedef ancak başka bir hedef bu süre içinde yanıt vermişken kapatılır (kesinti sırasında hepsi birden kapanmasın) */
const OTHERS_ALIVE_MS = 10_000;

export class ProbeEngine {
  private timer: NodeJS.Timeout | null = null;
  private gwTimer: NodeJS.Timeout | null = null;
  private gwSent = 0;
  private gwReplied = 0;
  gatewayDisabled = false;
  private seq = 0;
  private cursor = 0;
  private rotation = 0;
  private readonly done = new Map<number, ProbeResult>();
  private readonly states: TargetState[];
  private readonly detector: OutageDetector;

  constructor(private readonly opts: ProbeEngineOptions) {
    this.states = opts.targets.map((target) => ({ target, sent: 0, replied: 0, disabled: false, retriedAt: 0, lastReplyAt: 0, recent: [] }));
    this.detector = new OutageDetector({
      // Tek hedef varsa "iki farklı hedef" koşulu sağlanamaz: kesinti yargısı verilmez
      minTargets: 2,
      onOutage: (o) => this.opts.onOutage?.(o),
    });
  }

  private get interval(): number {
    return this.opts.intervalMs ?? 250;
  }

  private get timeout(): number {
    return this.opts.timeoutMs ?? 450;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(): void {
    if (this.timer || this.gwTimer) return;
    // Bir sondadaki beklenmeyen hata süreci düşürmemeli
    if (this.states.length > 0) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.interval);
      this.timer.unref();
    }
    if (this.opts.gateway) {
      this.gwTimer = setInterval(() => void this.gatewayOnce().catch(() => undefined), this.opts.gatewayIntervalMs ?? 5_000);
      this.gwTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.gwTimer) clearInterval(this.gwTimer);
    this.timer = this.gwTimer = null;
  }

  /** Sıradaki hedef: kapatılmış olanlar atlanır, ama dakikada bir yeniden denenir (yanıt verirse sıraya döner) */
  private next(now: number): TargetState | null {
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[(this.rotation + i) % this.states.length]!;
      if (s.disabled) {
        if (now - s.retriedAt < RETRY_DISABLED_MS) continue;
        s.retriedAt = now;
      }
      this.rotation = (this.rotation + i + 1) % this.states.length;
      return s;
    }
    return null;
  }

  /** Sıradaki hedefe bir sonda gönderir; sonuç gönderim sırasına dizilir (testler doğrudan çağırır) */
  async tick(sentAt = this.now()): Promise<number | null> {
    const s = this.next(sentAt);
    if (!s) return null;
    const seq = this.seq++;
    const wasDisabled = s.disabled;
    const rtt = await (this.opts.run ?? defaultRun)(s.target, this.timeout).catch(() => null);
    s.sent++;
    if (rtt !== null) {
      s.replied++;
      s.lastReplyAt = sentAt;
      // Kapatılmış hedef yanıt verdi: sıraya döner
      s.disabled = false;
    }
    s.recent.push({ at: sentAt, rtt });
    while (s.recent.length > 0 && s.recent[0]!.at < sentAt - RECENT_MS) s.recent.shift();
    // Yoklanamayan hedefin kayıpları saniyelik satırlara YAZILMAZ: kapatılmış hedefin yeniden denemesi ya da henüz
    // hiç yanıt vermemiş hedef "yanıtsız sonda" gibi görünüp NIC sessizliğini doğrulamamalı, kayıp özetini şişirmemeli
    if (rtt !== null || (!wasDisabled && s.replied > 0)) this.opts.onResult(s.target.label, sentAt, rtt);
    // Kapalı hedefin yeniden deneme sondası kesinti yargısına katılmaz (yanıtsızsa sıradaki boşluk sayılmaz)
    this.done.set(seq, { seq, label: s.target.label, kind: s.target.kind, sentAt, rtt, skip: wasDisabled && rtt === null });
    // Hiç yanıt vermeyen hedef (ör. sağlayıcı o portu süzüyor) sıradan çıkar; sonuçları kesinti sayılmaz. Ama
    // yalnızca başka bir hedef yakın zamanda yanıt vermişse: hepsi birden yanıtsızsa bu hedefin değil yolun sorunudur
    // (ör. sunucu kesinti sırasında başladı) ve hiçbir hedef kapatılmaz.
    const othersAlive = this.states.some((x) => x !== s && x.lastReplyAt > 0 && sentAt - x.lastReplyAt <= OTHERS_ALIVE_MS);
    if (s.sent >= NEVER_REPLIED_AFTER && s.replied === 0 && othersAlive) s.disabled = true;
    this.drain();
    return rtt;
  }

  /** Sonuçlanan sondaları sıra numarasıyla (boşluk bırakmadan) dedektöre verir */
  private drain(): void {
    for (;;) {
      const r = this.done.get(this.cursor);
      if (!r) return;
      this.done.delete(this.cursor);
      this.cursor++;
      const state = this.states.find((x) => x.target.label === r.label);
      // Henüz hiç yanıt vermemiş hedefin kayıpları ve kapalı hedefin yeniden denemeleri yargıya katılmaz
      // (hedef yoklanamıyor olabilir)
      if (r.skip || (r.rtt === null && state && state.replied === 0)) continue;
      this.detector.push(r);
    }
  }

  async gatewayOnce(sentAt = this.now()): Promise<void> {
    const host = this.opts.gateway?.() ?? null;
    if (!host || this.gatewayDisabled) return;
    const target: ProbeTarget = { label: GATEWAY_LABEL, kind: 'tcp', host, port: 80 };
    const rtt = await (this.opts.run ?? gatewayRun)(target, this.timeout).catch(() => null);
    this.gwSent++;
    if (rtt !== null) this.gwReplied++;
    if (this.gwSent >= NEVER_REPLIED_AFTER && this.gwReplied === 0) {
      this.gatewayDisabled = true;
      return;
    }
    this.opts.onResult(target.label, sentAt, rtt);
  }

  /** Panel: hedeflerin son bir dakikası ve süren kesinti */
  status(now = this.now()): ProbeStatus {
    return {
      running: this.timer !== null,
      intervalMs: this.interval,
      timeoutMs: this.timeout,
      targets: this.states.map((s) => {
        const recent = s.recent.filter((r) => r.at >= now - RECENT_MS);
        const last = recent[recent.length - 1] ?? null;
        return {
          label: s.target.label,
          kind: s.target.kind,
          sent: recent.length,
          lost: recent.filter((r) => r.rtt === null).length,
          lastRtt: last?.rtt === null || last === null ? null : Number(last.rtt.toFixed(1)),
          lastAt: last?.at ?? null,
          disabled: s.disabled,
        };
      }),
      gateway: { host: this.opts.gateway?.() ?? null, disabled: this.gatewayDisabled },
      open: this.detector.open(now),
    };
  }
}

const defaultRun = (t: ProbeTarget, timeoutMs: number): Promise<number | null> =>
  t.kind === 'udp' ? probeUdp(t.host, t.port, timeoutMs) : probeTcp(t.host, t.port, timeoutMs);
const gatewayRun = (t: ProbeTarget, timeoutMs: number): Promise<number | null> => probeTcp(t.host, t.port, timeoutMs, true);
