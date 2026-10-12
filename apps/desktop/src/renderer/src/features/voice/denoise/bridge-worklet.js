// Gürültü engelleyici köprüsü (AudioWorklet). Model burada ÇALIŞMAZ: bu işlemci yalnızca 128'lik ses
// bloklarını paylaşımlı bir halka tampona (SharedArrayBuffer) yazar ve işçinin (denoise.worker.ts) ürettiği
// temiz sesi diğer halkadan okur. Ses iş parçacığında blok başına iş birkaç mikrosaniyedir; hiç beklemez,
// bellek ayırmaz, ileti göndermez. Böylece modelin yavaş bir karesi ses bloğunun süresini (2,67 ms)
// aşsa da çıkan ses cızırdamaz.
//
// Tampon: (kare − ebob(128, kare)) = 448 örnek hizalama + ek pay (micProcessor: 3 kare = 30 ms; seçenek
// verilmezse 1 kare). İşçi bir kareyi payından geç bitirirse boşluk (underrun) olur: o blokta sessizlik çalınır,
// pay bir blok (2,67 ms) artırılıp (en fazla 4 kare; seçenek verilmezse 3) tampon yeniden doldurulur. İşçi takılıp birden çok kare döndürürse gecikme büyümesin diye
// fazlası atılır. Sayaçlar paylaşımlı denetim alanına yazılır; işçi bunları istatistiklerle bildirir.
//
// Bellek düzeni ring.ts ile aynı olmalı.

const HOP = 480;
const BLOCK = 128;
const ALIGN = HOP - 32; // kare − ebob(128, 480)
const CAP = 8192;
const MASK = CAP - 1;
const CTRL_INTS = 8;
const IN_WRITE = 0;
const IN_READ = 1;
const OUT_WRITE = 2;
const OUT_READ = 3;
const UNDERRUNS = 4;
const BUFFER_SAMPLES = 5;
const DROPPED = 6;

class DiskortDenoiseBridge extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    const sab = o.sab;
    this.ctrl = new Int32Array(sab, 0, CTRL_INTS);
    this.inRing = new Float32Array(sab, CTRL_INTS * 4, CAP);
    this.outRing = new Float32Array(sab, CTRL_INTS * 4 + CAP * 4, CAP);
    this.extra = o.extraSamples ?? HOP;
    this.maxExtra = o.maxExtraSamples ?? 3 * HOP;
    this.inW = 0;
    this.outR = 0;
    this.sinceNotify = 0;
    this.playing = false;
    this.underruns = 0;
    this.dropped = 0;
    Atomics.store(this.ctrl, BUFFER_SAMPLES, ALIGN + this.extra);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const ctrl = this.ctrl;
    const input = inputs[0] && inputs[0][0];
    const ch0 = out[0];
    const n = ch0.length;

    // 1) Girişi halkaya yaz; her tam karede işçiyi uyandır
    const inR = Atomics.load(ctrl, IN_READ);
    if (((this.inW - inR) | 0) + n <= CAP) {
      const ring = this.inRing;
      let w = this.inW;
      for (let i = 0; i < n; i++) ring[(w + i) & MASK] = input ? input[i] : 0;
      this.inW = (w + n) | 0;
      Atomics.store(ctrl, IN_WRITE, this.inW);
      this.sinceNotify += n;
      if (this.sinceNotify >= HOP) {
        this.sinceNotify -= HOP;
        Atomics.notify(ctrl, IN_WRITE);
      }
    } else {
      // İşçi uzun süredir okumuyor (takıldı); halka dolu, bu blok atılır
      this.dropped += n;
      Atomics.store(ctrl, DROPPED, this.dropped);
    }

    // 2) Temiz sesi çıkış halkasından oku
    const target = ALIGN + this.extra;
    let avail = (Atomics.load(ctrl, OUT_WRITE) - this.outR) | 0;
    if (this.playing && avail > target + HOP + BLOCK) {
      const drop = avail - target;
      this.outR = (this.outR + drop) | 0;
      avail -= drop;
      this.dropped += drop;
      Atomics.store(ctrl, DROPPED, this.dropped);
    }
    if (!this.playing && avail >= target) this.playing = true;
    if (this.playing) {
      const ring = this.outRing;
      const take = avail < n ? avail : n;
      const r = this.outR;
      for (let i = 0; i < take; i++) ch0[i] = ring[(r + i) & MASK];
      this.outR = (r + take) | 0;
      if (take < n) {
        ch0.fill(0, take);
        this.underruns++;
        this.playing = false;
        if (this.extra < this.maxExtra) this.extra = Math.min(this.maxExtra, this.extra + BLOCK);
        Atomics.store(ctrl, UNDERRUNS, this.underruns);
        Atomics.store(ctrl, BUFFER_SAMPLES, ALIGN + this.extra);
      }
      Atomics.store(ctrl, OUT_READ, this.outR);
    } else {
      ch0.fill(0);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('diskort-denoise-bridge', DiskortDenoiseBridge);
