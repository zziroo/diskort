// Ses kapısı (voice activity gate) + bas-konuş için AudioWorklet işlemcisi.
// Her 128 örneklik blokta seviyeyi ölçer, eşik/PTT durumuna göre kazancı yumuşakça açıp kapatır
// ve arayüze ~20 Hz ile seviye bilgisi gönderir. Zamanlayıcı kullanmadığı için arka planda da hassastır.
// Kapıyla birlikte bir tepe sınırlayıcı da çalışır (giriş ses seviyesi 2'ye kadar çıkar, kırpılma olmasın).
// İstenirse (agc) sınırlayıcıdan önce yazılımsal otomatik kazanç da uygulanır (bkz. AGC_* sabitleri).

const ATTACK_S = 0.004;
const RELEASE_S = 0.06;
const REPORT_INTERVAL_S = 0.05;
// Tepe sınırlayıcı: -3 dBFS tavan, anında atak (ileriye bakmasız: ek gecikme yok, tavan hiç aşılmaz), 150 ms
// bırakma. Normal konuşma tavanın altında kaldığı için dokunulmaz; yalnızca tepeler ve kırpılacak bağırmalar
// kısılır. DynamicsCompressorNode yerine bu: Chromium'da sabit 6 ms ileriye bakma gecikmesi ve tüm sese
// uygulanan otomatik telafi kazancı (-3 dB eşikte ~+1,7 dB) var.
const LIMIT_CEILING = Math.pow(10, -3 / 20);
const LIMIT_RELEASE_S = 0.15;
// Yazılımsal otomatik kazanç (gürültü modeli çalışırken; o sırada tarayıcının AGC'si kapalıdır, çünkü Windows'ta
// sistem mikrofon seviyesini düşürüp sesi boğuklaştırıyordu). Sistem seviyesine dokunmaz, gecikme eklemez.
// Konuşma seviyesi (yalnızca konuşma bloklarının ~0,4 sn'lik güç ortalaması) hedefe doğru çekilir; yükseltme
// yavaş (nefes/kelime aralarında pompalamasın), kısma hızlıdır (bağırınca hemen insin). Kazanç yalnızca kapı
// açıkken ve ses gürültü tabanının belirgin üstündeyken güncellenir; sessizlikte donar (gürültü yükseltilmez).
// Kapı kararı ve seviye göstergesi kazanç öncesi seviyeyle çalışır (eşikler kaymaz); sınırlayıcı kazanç sonrası
// sinyalde çalıştığı için -3 dBFS tavanı korunur.
const AGC_TARGET_DB = -20;
const AGC_MAX_DB = 18;
const AGC_MIN_DB = -6;
const AGC_UP_DB_PER_S = 3;
const AGC_DOWN_DB_PER_S = 20;
/** Konuşma sayılan blok: gürültü tabanının en az bu kadar üstünde */
const AGC_SPEECH_OVER_FLOOR_DB = 12;
const AGC_LEVEL_S = 0.4;
/** Kazancı yükseltmek için mutlak alt sınır: bunun altındaki ses (yankı kalıntısı/nefes) kazancı artırmaz, düşürebilir */
const AGC_RAISE_FLOOR_DB = -55;
// Konuşma seviyesi ölçümü (tanılama): kapı açık ve eşik üstündeki blokların RMS'i (kazanç öncesi/sonrası),
// 0,5 dB'lik kutularla -100..0 dBFS (client-core SpeechLevelHistogram ile aynı); ~1 sn'de bir gönderilir.
const SPEECH_BINS = 200;
const SPEECH_BIN_DB = 0.5;
const SPEECH_MIN_DB = -100;
const SPEECH_REPORT_S = 1;

function speechBin(db) {
  const i = Math.floor((db - SPEECH_MIN_DB) / SPEECH_BIN_DB);
  return i < 0 ? 0 : i >= SPEECH_BINS ? SPEECH_BINS - 1 : i;
}

class DiskortGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'vad'; // 'vad' | 'ptt' | 'open'
    this.auto = true;
    this.threshold = -50;
    this.holdMs = 350;
    this.ptt = false;
    this.gain = 0;
    this.lastAboveS = -1;
    this.noiseFloor = -65;
    this.peakDb = -100;
    this.lastReportS = 0;
    this.gains = new Float32Array(128);
    this.attackCoef = 1 - Math.exp(-1 / (sampleRate * ATTACK_S));
    this.releaseCoef = 1 - Math.exp(-1 / (sampleRate * RELEASE_S));
    this.limitGain = 1;
    this.limitReleaseCoef = 1 - Math.exp(-1 / (sampleRate * LIMIT_RELEASE_S));
    this.agc = false;
    // Seviye ortalaması katsayısı (blok 128 örnek, sabit): her blokta exp hesaplanmasın
    this.agcLevelCoef = 1 - Math.exp(-(128 / sampleRate) / AGC_LEVEL_S);
    /** Uygulanan yazılımsal kazanç (dB) ve konuşma seviyesi ortalaması (güç) */
    this.agcDb = 0;
    this.agcLevel = -1;
    this.speechPre = new Uint32Array(SPEECH_BINS);
    this.speechPost = new Uint32Array(SPEECH_BINS);
    this.speechCount = 0;
    this.lastSpeechReportS = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !input[0]) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    const ch0 = input[0];
    let sum = 0;
    for (let i = 0; i < ch0.length; i++) sum += ch0[i] * ch0[i];
    const rms = Math.sqrt(sum / ch0.length);
    const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;

    // Uyarlanabilir gürültü tabanı: hızlı iner, yavaş yükselir.
    const k = db < this.noiseFloor ? 0.02 : 0.0004;
    this.noiseFloor += (db - this.noiseFloor) * k;
    const threshold = this.auto ? Math.min(-30, Math.max(-62, this.noiseFloor + 9)) : this.threshold;

    let open;
    if (this.mode === 'ptt') {
      open = this.ptt;
    } else if (this.mode === 'open') {
      open = true;
    } else {
      if (db >= threshold) this.lastAboveS = currentTime;
      open = this.lastAboveS >= 0 && currentTime - this.lastAboveS < this.holdMs / 1000;
    }

    const n = ch0.length;
    // Otomatik kazanç: bu blokta eski kazançtan yenisine doğrusal geçilir (blok başına en çok ~0,05 dB)
    const agcFrom = Math.pow(10, this.agcDb / 20);
    if (!this.agc) {
      this.agcDb = 0;
      this.agcLevel = -1;
    } else if (open && db >= Math.max(threshold, this.noiseFloor + AGC_SPEECH_OVER_FLOOR_DB)) {
      // Konuşma: kapı açık, kapı eşiğinin ve gürültü tabanı+12 dB'nin üstünde (kapı hep açık kipte de kalıntı sayılmasın)
      const dt = n / sampleRate;
      const p = rms * rms;
      this.agcLevel = this.agcLevel < 0 ? p : this.agcLevel + (p - this.agcLevel) * this.agcLevelCoef;
      const levelDb = 10 * Math.log10(Math.max(this.agcLevel, 1e-12));
      const want = Math.min(AGC_MAX_DB, Math.max(AGC_MIN_DB, AGC_TARGET_DB - levelDb));
      let step = want - this.agcDb;
      // Çok zayıf sesle kazanç artmaz (yalnız düşebilir)
      if (db <= AGC_RAISE_FLOOR_DB && step > 0) step = 0;
      this.agcDb += Math.min(AGC_UP_DB_PER_S * dt, Math.max(-AGC_DOWN_DB_PER_S * dt, step));
    }
    const agcTo = Math.pow(10, this.agcDb / 20);
    const agcStep = (agcTo - agcFrom) / n;

    const target = open ? 1 : 0;
    if (this.gains.length < n) this.gains = new Float32Array(n);
    let g = this.gain;
    let lg = this.limitGain;
    for (let i = 0; i < n; i++) {
      g += (target - g) * (target > g ? this.attackCoef : this.releaseCoef);
      const ag = agcFrom + agcStep * (i + 1);
      // Sınırlayıcı (kazanç sonrası sinyalde): gereken kazanç düşükse hemen ona iner, değilse yavaşça geri çıkar
      const a = Math.abs(ch0[i] * ag);
      const need = a > LIMIT_CEILING ? LIMIT_CEILING / a : 1;
      if (need < lg) lg = need;
      else lg += (need - lg) * this.limitReleaseCoef;
      this.gains[i] = ag * g * lg;
    }
    this.gain = g;
    this.limitGain = lg;

    for (let c = 0; c < output.length; c++) {
      const inp = input[c] || ch0;
      const out = output[c];
      for (let i = 0; i < out.length; i++) out[i] = inp[i] * this.gains[i];
    }

    // Konuşma seviyesi (kazanç öncesi ve gönderilen)
    if (open && db >= threshold) {
      const out0 = output[0];
      let outSum = 0;
      if (out0) for (let i = 0; i < out0.length; i++) outSum += out0[i] * out0[i];
      const outRms = out0 ? Math.sqrt(outSum / out0.length) : 0;
      this.speechPre[speechBin(db)]++;
      this.speechPost[speechBin(outRms > 1e-6 ? 20 * Math.log10(outRms) : -100)]++;
      this.speechCount++;
    }
    if (currentTime - this.lastSpeechReportS >= SPEECH_REPORT_S) {
      if (this.speechCount > 0) {
        this.port.postMessage({ type: 'speech', pre: Array.from(this.speechPre), post: Array.from(this.speechPost) });
        this.speechPre.fill(0);
        this.speechPost.fill(0);
        this.speechCount = 0;
      }
      this.lastSpeechReportS = currentTime;
    }

    if (db > this.peakDb) this.peakDb = db;
    if (currentTime - this.lastReportS >= REPORT_INTERVAL_S) {
      this.port.postMessage({ db: this.peakDb, threshold, open });
      this.peakDb = -100;
      this.lastReportS = currentTime;
    }
    return true;
  }
}

registerProcessor('diskort-gate', DiskortGateProcessor);
