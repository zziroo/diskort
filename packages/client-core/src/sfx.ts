// Arayüz sesleri: tek tanım, iki çalıcı. Masaüstü bu dosyadaki renderSound() ile sesi bellekte üretip
// Web Audio ile çalar (apps/desktop/src/renderer/src/lib/sfx.ts); telefon aynı işlevle önceden yazılmış
// WAV dosyalarını çalar (apps/mobile/scripts/generate-sounds.mjs → assets/sounds/*.wav). İkisi de aynı
// örnekleri ürettiği için sesler birebir aynıdır.
//
// Bu dosya bilerek hiçbir şey içe aktarmaz ve yalnızca silinebilir TypeScript sözdizimi kullanır: Node
// (tür soyma ile) üretici betikten doğrudan yükleyebilsin.
//
// Tasarım: kısa (çoğu 100–450 ms), yumuşak marimba/tahta tınılı sesler; Re majör pentatonikte (D E F# A
// B). Gövde üçgene yakın sinüs (çok hafif üst harmonikler); üstüne marimba çubuğu gibi temelin ~3,99 ve ~9,8
// katında iki uyumsuz kısmi eklenir, 30 ms ve 9 ms'de söner: kısa, tahtamsı ama yumuşak bir "tok" başlangıç.
// Bahsedilmede ayrıca hafif bir cam/çan kısmisi var. Anlamlar: kendi katılman / sesi açman / yayına
// başlaman yükselir, ayrılman / susturman / yayını bitirmen iner; aynı olayın başkası için olanı (biri
// girdi, biri yayına başladı) daha kısa ve biraz daha kısıktır. Çoğu nota hedef perdesine küçük bir kaymayla
// varır; katılma/ayrılma iki yakın, bağlı nota (küçük üçlü), neredeyse kaymasız ve diğerlerinden az söner.
// 5 ms'lik yükseltilmiş kosinüs başlangıç (tık yok), notalar üst üste biner, ~5,5 kHz altında süzülür
// (karanlık sesler daha kapalı). Kesik yankı yerine birkaç kısa, süzülmüş yansımadan oluşan küçük bir
// "oda". Algılanan seviyeler eşitlenir (en yüksek 50 ms'lik pencerenin RMS'i, -16 dBFS); tepe hiçbir seste
// -8 dBFS'i geçmez.
//
// Perdeler, aralıklar ve zamanlamalar bu uygulamaya özgü; hiçbir uygulamanın sesi örnek alınmadı ya da
// kopyalanmadı, sesler yalnızca aşağıdaki sayılardan üretilir.

export const SOUND_NAMES = [
  'join',
  'leave',
  'userJoin',
  'userLeave',
  'mute',
  'unmute',
  'deafen',
  'undeafen',
  'streamStart',
  'streamStop',
  'userStreamStart',
  'userStreamStop',
  'mention',
  'disconnect',
  'reconnected',
  'pttOn',
  'pttOff',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** Ayarlardaki ses listesi (dinleme düğmeleri) için adlar */
export const SOUND_LABELS: Record<SoundName, string> = {
  join: 'Kanala katılma (sen ya da başkası)',
  leave: 'Kanaldan ayrılma (sen ya da başkası)',
  userJoin: 'Biri kanala girdi',
  userLeave: 'Biri kanaldan çıktı',
  mute: 'Susturuldun',
  unmute: 'Mikrofon açıldı',
  deafen: 'Sağırlaştırıldın',
  undeafen: 'Sağırlaştırma kalktı',
  streamStart: 'Yayın başladı',
  streamStop: 'Yayın bitti',
  userStreamStart: 'Biri yayına başladı',
  userStreamStop: 'Birinin yayını bitti',
  mention: 'Bahsedilme / direkt mesaj',
  disconnect: 'Bağlantı koptu',
  reconnected: 'Bağlantı geri geldi',
  pttOn: 'Bas-konuş: basıldı',
  pttOff: 'Bas-konuş: bırakıldı',
};

/**
 * Discord'daki gibi başkasının kanala girip çıkması ve yayın açıp kapaması, kendininkiyle aynı sesi çalar. Adlar ayrı
 * kalır (sağırken başkalarınınki çalmaz, aynı anda gelenler tek sese indirilir, bkz. ChannelSoundGate); ses aynıdır.
 */
export const SOUND_ALIASES: Partial<Record<SoundName, SoundName>> = {
  userJoin: 'join',
  userLeave: 'leave',
  userStreamStart: 'streamStart',
  userStreamStop: 'streamStop',
};

/**
 * Arama sesleri (DM aramaları): ayrı liste, çünkü tek seferlik değil, arama sürdükçe CALL_SOUND_REPEAT_MS
 * aralıkla yeniden çalınırlar. 'ring': seni biri arıyor (gelen arama; Rahatsız Etmeyin'de sunucu zaten
 * çalmaz). 'ringback': sen arıyorsun, karşı taraf henüz açmadı (çalınan biri varken). Telefonda da WAV
 * dosyaları vardır (assets/sounds/ring.wav, ringback.wav).
 */
export const CALL_SOUND_NAMES = ['ring', 'ringback'] as const;

export type CallSoundName = (typeof CALL_SOUND_NAMES)[number];

export const CALL_SOUND_LABELS: Record<CallSoundName, string> = {
  ring: 'Gelen arama',
  ringback: 'Aranıyor (karşı taraf henüz açmadı)',
};

/** Arama seslerinin yeniden çalma aralığı (ms; sesin başından bir sonrakinin başına) */
export const CALL_SOUND_REPEAT_MS: Record<CallSoundName, number> = {
  ring: 2600,
  ringback: 3200,
};

/** Ayrı sesi olanlar (dinleme listesi, telefondaki WAV dosyaları) */
export const PREVIEW_SOUND_NAMES: readonly SoundName[] = SOUND_NAMES.filter((name) => !SOUND_ALIASES[name]);

/**
 * Başkalarıyla ilgili kanal sesleri: sağırlaştırılmışken çalınmaz (kanalı duymak istemiyorsun).
 * Kendi işlemlerinin sesleri (sustur, ayrıl…) sağırken de çalınır; yaptığın işin geri bildirimi.
 */
export const OTHERS_SOUNDS: ReadonlySet<SoundName> = new Set<SoundName>([
  'userJoin',
  'userLeave',
  'userStreamStart',
  'userStreamStop',
]);

/** Hazır seslerin örnekleme hızı (telefondaki WAV dosyaları da bu hızda) */
export const SFX_SAMPLE_RATE = 48000;
/** Hiçbir sesin geçmediği tepe seviyesi (dBFS); sesler bu sabit seviyede çalınır (seviye ayarı yok) */
export const SFX_PEAK_DBFS = -8;

interface Tone {
  /** MIDI nota numarası (varılan perde; 69 = La4 = 440 Hz) */
  note: number;
  /** Başlangıç (ms) */
  at: number;
  /** Notanın toplam süresi (ms); sonunda tam sıfıra iner */
  dur: number;
  /** Başlangıçtaki perde farkı (yarım ses): -3 = üç yarım ses aşağıdan kayarak gelir, +3 = yukarıdan */
  from?: number;
  /** Kaymanın zaman sabiti (ms; varsayılan 22): küçük = damla gibi hızlı, büyük = süpürme */
  glideMs?: number;
  /** Göreli seviye (varsayılan 1) */
  gain?: number;
}

interface SoundSpec {
  tones: Tone[];
  /** Başlangıç süresi (ms, yükseltilmiş kosinüs): sert vuruş/tık yok */
  attack: number;
  /** Notanın salınıma kadar ne kadar söndüğü (dB): küçük = düz, dolgun; büyük = tokmak gibi sönen */
  decayDb: number;
  /** Notanın son ne kadarı (oran) yumuşakça sıfıra iner; sonraki nota bu sırada girer */
  release: number;
  /** İkinci harmoniğin payı (başta, hızla söner: sıcaklık) */
  h2: number;
  /** Marimba çubuğu kısmilerinin (BAR_PARTIALS) payı: 1 = tam tahta tınısı, 0 = yalnızca yuvarlak gövde */
  bar: number;
  /** Çan kısmisi (2,76 oranlı, çok kısık, hızla söner): yalnızca bildirim */
  chime?: number;
  /** Alçak geçiren süzgeç (Hz) */
  lowpass: number;
  /** Küçük oda yansımalarının payı (0: yok) */
  room: number;
  /** Algılanan seviyeye göre ek ayar (dB) */
  trimDb: number;
}

// Re majör pentatonik: D E F# A B (Fa4 yalnızca "bağlantı koptu"da, diziden bilerek çıkan karanlık nota)
const D4 = 62;
const F4 = 65;
const Fs4 = 66;
const A4 = 69;
const B4 = 71;
const D5 = 74;
const E5 = 76;
const Fs5 = 78;
const A5 = 81;
const B5 = 83;

/** Çoğu sesin ortak ayarları */
const BASE = { attack: 5, decayDb: 28, release: 0.4, h2: 0.06, bar: 1, lowpass: 5500, room: 0.3, trimDb: 0 };

const SPECS: Partial<Record<SoundName | CallSoundName, SoundSpec>> = {
  // Sakin: küçük üçlü yukarı (Si4 → Re5), bağlı (legato), neredeyse kaymasız; üstteki nota biraz kısık
  // (vurgu yok), diğer seslerden az sönen gövde. "İçerdesin" der.
  join: {
    ...BASE,
    tones: [
      { note: B4, at: 0, dur: 180, from: -0.3, glideMs: 15 },
      { note: D5, at: 80, dur: 290, from: -0.3, glideMs: 15, gain: 0.8 },
    ],
    decayDb: 20,
    release: 0.45,
    h2: 0.05,
  },
  // Katılmanın aynası, biraz daha pes: küçük üçlü aşağı (La4 → Fa#4), aynı bağlı notalar
  leave: {
    ...BASE,
    tones: [
      { note: A4, at: 0, dur: 180, from: 0.3, glideMs: 15 },
      { note: Fs4, at: 80, dur: 300, from: 0.3, glideMs: 15, gain: 0.8 },
    ],
    decayDb: 20,
    release: 0.45,
    h2: 0.05,
  },
  // Pes, kısa "tok" (Si4'e hafifçe inerek)
  mute: {
    ...BASE,
    tones: [{ note: B4, at: 0, dur: 120, from: 1.5, glideMs: 15 }],
    decayDb: 32,
    room: 0.15,
  },
  // Tiz, kısa "tok" (Fa#5'e hafifçe çıkarak)
  unmute: {
    ...BASE,
    tones: [{ note: Fs5, at: 0, dur: 120, from: -1.5, glideMs: 15 }],
    decayDb: 32,
    room: 0.15,
  },
  // Daha derin: iki nota iner (La4 → Re4), biraz boğuk
  deafen: {
    ...BASE,
    tones: [
      { note: A4, at: 0, dur: 130, from: 1.5 },
      { note: D4, at: 60, dur: 230, from: 2 },
    ],
    h2: 0.09,
    lowpass: 4500,
    room: 0.2,
  },
  // Derin iki nota çıkar (Re4 → La4)
  undeafen: {
    ...BASE,
    tones: [
      { note: D4, at: 0, dur: 130, from: -1.5 },
      { note: A4, at: 60, dur: 230, from: -2 },
    ],
    h2: 0.09,
    room: 0.2,
  },
  // Biraz daha uzun süpürme: Re5'e beş yarım ses aşağıdan yavaşça kayar, üstüne La5 konar
  streamStart: {
    ...BASE,
    tones: [
      { note: D5, at: 0, dur: 240, from: -5, glideMs: 55 },
      { note: A5, at: 140, dur: 230, from: -2 },
    ],
    decayDb: 24,
    room: 0.35,
    trimDb: -1,
  },
  // Tersi: La5'ten Re5'e, beş yarım ses yukarıdan yavaşça iner
  streamStop: {
    ...BASE,
    tones: [
      { note: A5, at: 0, dur: 170, from: 2 },
      { note: D5, at: 100, dur: 270, from: 5, glideMs: 55 },
    ],
    decayDb: 24,
    room: 0.35,
    trimDb: -1,
  },
  // Dostça iki "ping" (Fa#5 → Si5): tahtaya ek olarak hafif cam/çan kısmisi
  mention: {
    ...BASE,
    tones: [
      { note: Fs5, at: 0, dur: 190, from: -1 },
      { note: B5, at: 90, dur: 300, from: -1 },
    ],
    decayDb: 30,
    h2: 0.05,
    chime: 0.06,
    room: 0.35,
  },
  // Pes ve karanlık: dizinin dışındaki Fa ile inen üç nota (La4 → Fa4 → Re4), sonuncusu aşağı kayar;
  // süzgeç diğerlerinden kapalı, tahta tınısı az
  disconnect: {
    ...BASE,
    tones: [
      { note: A4, at: 0, dur: 150, from: 1 },
      { note: F4, at: 75, dur: 150, from: 1 },
      { note: D4, at: 150, dur: 300, from: 2, glideMs: 60 },
    ],
    decayDb: 24,
    h2: 0.1,
    bar: 0.7,
    lowpass: 3000,
    room: 0.35,
  },
  // Kısa, yukarı iki damla (Re5 → Fa#5): "geri geldin"
  reconnected: {
    ...BASE,
    tones: [
      { note: D5, at: 0, dur: 120, from: -2 },
      { note: Fs5, at: 55, dur: 220, from: -2 },
    ],
    trimDb: -2,
  },
  // Bas-konuş: neredeyse duyulmayan, çok kısa blip'ler (varsayılan kapalı); tahta tınısı yarım
  pttOn: {
    ...BASE,
    tones: [{ note: A5, at: 0, dur: 75, from: -1, glideMs: 12 }],
    h2: 0.02,
    bar: 0.5,
    lowpass: 4000,
    room: 0,
    trimDb: -10,
  },
  pttOff: {
    ...BASE,
    tones: [{ note: E5, at: 0, dur: 75, from: 1, glideMs: 12 }],
    h2: 0.02,
    bar: 0.5,
    lowpass: 3000,
    room: 0,
    trimDb: -10,
  },
  // Gelen arama: iki kısa, yükselen arpej (Re5 → Fa#5 → La5, sonra Re5 → Fa#5 → Si5); ikincisi bir basamak
  // yukarıda biter ("kim o?"). Bahsedilmedeki hafif çan kısmisi burada da var; arada sessizlikle yinelenir.
  ring: {
    ...BASE,
    tones: [
      { note: D5, at: 0, dur: 200, from: -1 },
      { note: Fs5, at: 100, dur: 200, from: -1 },
      { note: A5, at: 200, dur: 320, from: -1 },
      { note: D5, at: 600, dur: 200, from: -1 },
      { note: Fs5, at: 700, dur: 200, from: -1 },
      { note: B5, at: 800, dur: 420, from: -1 },
    ],
    decayDb: 26,
    h2: 0.05,
    chime: 0.05,
    room: 0.35,
  },
  // Aranıyor (bekleme sesi): pes, yavaş, yumuşak iki nota (La4 → Re5, dörtlü yukarı); tahta tınısı az, gelen
  // aramadan belirgin şekilde sakin ve kısık
  ringback: {
    ...BASE,
    tones: [
      { note: A4, at: 0, dur: 300, from: -0.3, glideMs: 15 },
      { note: D5, at: 180, dur: 520, from: -0.3, glideMs: 15, gain: 0.85 },
    ],
    decayDb: 18,
    release: 0.5,
    bar: 0.5,
    lowpass: 4000,
    room: 0.3,
    trimDb: -4,
  },
};

// ---------- Sentez ----------

/** Kuyruk tepe seviyesinin bu kadar altına inince kesilir (dB) */
const TAIL_FLOOR_DB = -48;
/** Sondaki kapanış (ms): kuyruk zaten sıfıra iner, bu yalnızca güvence */
const FADE_OUT_MS = 30;
/**
 * Algılanan seviye hedefi (dBFS): en yüksek 50 ms'lik pencerenin RMS'i. Çoğu ses bu hedefe iner; tahta
 * kısmilerinin başlangıç tepesi yüksek olan çok kısa sesler (sustur/aç) tepe sınırına takılıp hedefin hemen
 * altında kalır. Böylece kısa tek notalı sesler uzun olanlardan cılız duyulmaz.
 */
export const SFX_TARGET_RMS_DBFS = -16;
const RMS_WINDOW_MS = 50;
/**
 * Küçük oda: tek, belirgin bir yankı (tekrar eden "tık tık") yerine yakın aralıklı, giderek kısılan ve
 * süzülmüş birkaç yansıma; ses kuruyup kesilmez, hafifçe yayılır.
 */
const ROOM_TAPS: readonly { ms: number; gain: number }[] = [
  { ms: 23, gain: 0.5 },
  { ms: 37, gain: 0.38 },
  { ms: 53, gain: 0.28 },
  { ms: 79, gain: 0.2 },
  { ms: 113, gain: 0.13 },
];
const ROOM_LOWPASS = 1400;
const ROOM_LEVEL = 0.35;
/** Üçüncü harmoniğin payı (sabit, çok az): saf sinüsten biraz daha dolgun, üçgene yakın gövde */
const H3 = 0.03;
/**
 * Marimba çubuğu kısmileri: temel frekansın tam katı olmayan (uyumsuz) iki kısmi, çabucak söner. Tahta
 * tınısını ve kısa, yumuşak "tok" başlangıcını bunlar verir; gövde sinüs olarak kalır.
 */
const BAR_PARTIALS: readonly { ratio: number; level: number; tauMs: number }[] = [
  { ratio: 3.99, level: 0.22, tauMs: 30 },
  { ratio: 9.8, level: 0.07, tauMs: 9 },
];

const midiHz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);
const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Tek kutuplu alçak geçiren süzgeç katsayısı */
const lowpassCoef = (hz: number, rate: number): number => 1 - Math.exp((-2 * Math.PI * hz) / rate);

function addTone(out: Float32Array, tone: Tone, spec: SoundSpec, rate: number): void {
  const f = midiHz(tone.note);
  const start = Math.round((tone.at / 1000) * rate);
  const durS = tone.dur / 1000;
  const len = Math.min(out.length - start, Math.ceil(durS * rate));
  const attack = Math.min(spec.attack / 1000, durS * 0.4);
  // Salınıma dek decayDb sönen üstel eğri
  const tau = durS / ((spec.decayDb / 20) * Math.LN10);
  const releaseLen = durS * spec.release;
  const releaseFrom = durS - releaseLen;
  const gain = tone.gain ?? 1;
  const from = tone.from ?? 0;
  const glide = (tone.glideMs ?? 22) / 1000;
  // Perde kayarken faz birikerek ilerler (anlık frekans değişse de dalga kesintisiz)
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let env = Math.exp(-t / tau);
    // Yükseltilmiş kosinüs başlangıç: vuruş yok, ses yuvarlakça "açılır"
    if (t < attack) env *= 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
    // Salınım notanın sonunda tam sıfıra iner; sonraki nota bu sırada girer
    if (t > releaseFrom) env *= 0.5 + 0.5 * Math.cos((Math.PI * (t - releaseFrom)) / releaseLen);
    // Üçgene yakın gövde (temel + başta biraz ikinci, çok az üçüncü harmonik) + hızla sönen çubuk kısmileri
    let s = Math.sin(phase) + spec.h2 * Math.exp(-t / (tau * 0.4)) * Math.sin(2 * phase) + H3 * Math.sin(3 * phase);
    for (const p of BAR_PARTIALS) s += spec.bar * p.level * Math.exp(-t / (p.tauMs / 1000)) * Math.sin(p.ratio * phase);
    if (spec.chime) s += spec.chime * Math.exp(-t / 0.08) * Math.sin(2.76 * phase);
    out[start + i] = (out[start + i] ?? 0) + gain * env * s;
    phase += (2 * Math.PI * f * Math.pow(2, (from * Math.exp(-t / glide)) / 12)) / rate;
  }
}

function lowpass(buf: Float32Array, hz: number, rate: number): void {
  const a = lowpassCoef(hz, rate);
  // İki kademe: 12 dB/oktav
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    y1 += a * ((buf[i] ?? 0) - y1);
    y2 += a * (y1 - y2);
    buf[i] = y2;
  }
}

function addRoom(buf: Float32Array, wet: number, rate: number): void {
  const src = buf.slice();
  lowpass(src, ROOM_LOWPASS, rate);
  for (const tap of ROOM_TAPS) {
    const d = Math.round((tap.ms / 1000) * rate);
    const g = wet * ROOM_LEVEL * tap.gain;
    for (let i = d; i < buf.length; i++) buf[i] = (buf[i] ?? 0) + g * (src[i - d] ?? 0);
  }
}

function peakOf(buf: Float32Array): number {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

function maxWindowRms(buf: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round((RMS_WINDOW_MS / 1000) * rate));
  let sum = 0;
  let best = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] ?? 0;
    sum += v * v;
    if (i >= win) {
      const old = buf[i - win] ?? 0;
      sum -= old * old;
    }
    best = Math.max(best, sum);
  }
  return Math.sqrt(best / Math.min(win, buf.length));
}

/**
 * Sessiz kuyruğu keser, sonu yumuşak kapatır ve seviyeyi ayarlar: algılanan seviye (en yüksek 50 ms'lik
 * pencerenin RMS'i) hedefe gelir, tepe SFX_PEAK_DBFS'yi geçmez; sonra sese özel ayar.
 */
function finish(buf: Float32Array, rate: number, trimDb: number): Float32Array<ArrayBuffer> {
  const floor = peakOf(buf) * dbToGain(TAIL_FLOOR_DB);
  let end = buf.length;
  while (end > 1 && Math.abs(buf[end - 1] ?? 0) < floor) end--;
  const fade = Math.round((FADE_OUT_MS / 1000) * rate);
  end = Math.min(buf.length, end + fade);
  const out = buf.slice(0, end);
  for (let i = 0; i < fade && i < out.length; i++) {
    const k = out.length - 1 - i;
    out[k] = (out[k] ?? 0) * (0.5 - 0.5 * Math.cos((Math.PI * i) / fade));
  }

  const peakGain = dbToGain(SFX_PEAK_DBFS) / peakOf(out);
  const rmsGain = dbToGain(SFX_TARGET_RMS_DBFS) / maxWindowRms(out, rate);
  const gain = Math.min(peakGain, rmsGain) * dbToGain(Math.min(0, trimDb));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * gain;
  return out;
}

/**
 * Sesi üretir: mono, [-1, 1], tepe en çok SFX_PEAK_DBFS. Aynı ad ve hız için her zaman aynı örnekler döner.
 */
export function renderSound(name: SoundName | CallSoundName, rate: number = SFX_SAMPLE_RATE): Float32Array<ArrayBuffer> {
  const alias = (SOUND_ALIASES as Partial<Record<string, SoundName>>)[name];
  const spec = SPECS[alias ?? name]!;
  const endMs = Math.max(...spec.tones.map((t) => t.at + t.dur));
  const lastTap = ROOM_TAPS[ROOM_TAPS.length - 1]?.ms ?? 0;
  const tailMs = spec.room > 0 ? lastTap + 40 : 0;
  const buf = new Float32Array(Math.ceil(((endMs + tailMs + FADE_OUT_MS) / 1000) * rate));

  for (const tone of spec.tones) addTone(buf, tone, spec, rate);
  lowpass(buf, spec.lowpass, rate);
  if (spec.room > 0) addRoom(buf, spec.room, rate);

  return finish(buf, rate, spec.trimDb);
}

// ---------- Başkalarının kanal olayları ----------

/** Aynı anda gelen olaylardan hangisinin sesi çalınır (biri çıkarken yayını da kapanır: "çıktı" duyulur) */
const OTHERS_PRIORITY: Partial<Record<SoundName, number>> = {
  userJoin: 2,
  userLeave: 2,
  userStreamStart: 1,
  userStreamStop: 1,
};
/** Bu süre içinde gelen olaylar tek sese iner (ms) */
const OTHERS_BATCH_MS = 60;
/** İki "başkası" sesi arasındaki en kısa süre (ms): kalabalık girip çıkarken ses seli olmaz */
const OTHERS_MIN_GAP_MS = 350;
/** Kanala bağlanınca / yeniden bağlanınca başkalarının sesleri bu süre çalınmaz (ms) */
export const OTHERS_QUIET_MS = 1500;

/**
 * Başkalarının kanal olaylarının (biri girdi/çıktı, yayına başladı/bitirdi) sesleri: kanala girer girmez
 * ya da yeniden bağlanınca gelen olay seli susturulur, art arda gelenler tek sese iner.
 *
 * Kişisel giriş sesi: `push('userJoin', url)` giren kişinin giriş sesi adresini (bkz. introSoundUrl) taşır.
 * Çalınacak ses "userJoin" olursa ve bekleyen bir adres varsa `play('userJoin')` yerine `playIntro(url)`
 * çağrılır. Aynı anda (OTHERS_BATCH_MS içinde) birden çok kişi girerse ilk gelen adres çalınır: sesler üst
 * üste binmez, tek ses kuralı bozulmaz; sonrakiler genel ses gibi yutulur. `playIntro` verilmezse ya da
 * adres null ise (sunucu bilmiyor, kişinin sesi yok, dinleyici başkalarının giriş seslerini kapatmış) genel
 * katılma sesi çalar. Kendi girişin bu kapıdan geçmez (bağlanınca quiet() çağrılır); kendi giriş sesini
 * istemci ayrıca çalar.
 */
export class ChannelSoundGate {
  private quietUntil = 0;
  private lastAt = -Infinity;
  private pending: SoundName | null = null;
  /** Bekleyen girişlerden ilkinin giriş sesi adresi */
  private pendingIntro: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly play: (name: SoundName) => void;
  private readonly playIntro: ((url: string) => void) | undefined;
  private readonly now: () => number;

  constructor(play: (name: SoundName) => void, playIntro?: (url: string) => void, now: () => number = Date.now) {
    this.play = play;
    this.playIntro = playIntro;
    this.now = now;
  }

  /** Bağlanınca / yeniden bağlanınca: bir süre başkalarının sesleri çalınmaz */
  quiet(ms: number = OTHERS_QUIET_MS): void {
    this.quietUntil = this.now() + ms;
    this.cancel();
  }

  /** Olayı sıraya koyar; `intro` yalnızca "userJoin" için anlamlıdır (girenin giriş sesi adresi). */
  push(name: SoundName, intro?: string | null): void {
    if (this.now() < this.quietUntil) return;
    if (this.pending === null || (OTHERS_PRIORITY[name] ?? 0) > (OTHERS_PRIORITY[this.pending] ?? 0)) {
      this.pending = name;
    }
    if (name === 'userJoin' && intro && this.pendingIntro === null) this.pendingIntro = intro;
    this.timer ??= setTimeout(() => this.flush(), OTHERS_BATCH_MS);
  }

  /** Bekleyen sesi iptal et (ör. kanaldan ayrılınca) */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingIntro = null;
  }

  private flush(): void {
    const name = this.pending;
    const intro = this.pendingIntro;
    this.timer = null;
    this.pending = null;
    this.pendingIntro = null;
    const now = this.now();
    if (!name || now < this.quietUntil || now - this.lastAt < OTHERS_MIN_GAP_MS) return;
    this.lastAt = now;
    if (name === 'userJoin' && intro && this.playIntro) this.playIntro(intro);
    else this.play(name);
  }
}

/** 16 bit PCM mono WAV dosyası (telefondaki hazır sesler ve dinleme kopyaları için) */
export function encodeWav(samples: Float32Array, rate: number = SFX_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
