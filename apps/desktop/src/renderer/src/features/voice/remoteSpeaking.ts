/**
 * Uzak katılımcıların konuşma halkası (yeşil) yerelde, gerçekten duyulan sesten ölçülür. Sunucunun
 * ActiveSpeakersChanged bildirimi sinyal bağlantısından gelir: duyulan (titreşim tamponundan geçmiş) sesle
 * eş zamanlı değildir, hece aralarında yanıp söner ve kısık konuşmayı kaçırır. Burada abone olunan her uzak
 * mikrofon izi bir AnalyserNode'a bağlanır; seviyeler tek ortak zamanlayıcıyla okunur.
 *
 * Ölçüm kişi başı ses seviyesinden (ve yerel susturmadan) öncedir: halka, Discord'daki gibi kişinin konuştuğunu
 * gösterir, senin onu ne kadar duyduğunu değil. Sağırken ölçüm sürer ama halkalar gösterilmez (voiceClient
 * `publishSpeaking`). Yayın sesi (ekran paylaşımı) ölçülmez.
 */

/**
 * Konuşma eşiği (RMS, dBFS). Gönderen taraf sesi zaten ses kapısından geçirip kapalıyken sessizlik gönderiyor
 * (DTX); gelen ses çoğunlukla ya konuşma ya sıfırdır. Eşik kısık konuşmayı yakalayacak kadar düşük, kapının
 * açık kalma süresindeki (gürültüsü engellenmiş) arka plan sesinin üstündedir.
 */
export const SPEAKING_THRESHOLD_DB = -55;
/** Son eşik aşımından sonra halka bu kadar açık kalır: hece aralarında yanıp sönmez, susunca da geç kalmaz */
export const SPEAKING_HOLD_MS = 300;
/** Ortak okuma aralığı (~20 Hz; arayüz için yeterli, 25 kişide de ucuz) */
export const SPEAKING_POLL_MS = 50;
/** Okunan pencere: 48 kHz'de ~43 ms, okuma aralığının neredeyse tamamı (kısa heceler arada kaçmaz) */
const FFT_SIZE = 2048;

/** Örneklerin RMS seviyesi (dBFS); sessizlikte -100 */
export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100;
}

/** Son eşik aşımına göre konuşuyor mu (açılış eşiği aşan ilk okumada, kapanış SPEAKING_HOLD_MS sonra) */
export function heldSpeaking(lastAboveAt: number, now: number): boolean {
  return lastAboveAt > 0 && now - lastAboveAt < SPEAKING_HOLD_MS;
}

interface Entry {
  identity: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  lastAboveAt: number;
}

export class RemoteSpeakingMeter {
  /** Anahtar: uzak mikrofonun MediaStreamTrack'i (aynı kişi yeniden yayınlarsa kısa süre iki iz olabilir) */
  private readonly entries = new Map<MediaStreamTrack, Entry>();
  private timer: number | null = null;
  /** İzler sırayla okunduğu için tek tampon yeter */
  private buf: Float32Array<ArrayBuffer> | null = null;
  private speaking = new Set<string>();
  /** Ses bağlamı çalışıyor muydu (durmuşken çözümleyiciler eski veriyi verir; o arada sunucunun bildirimi geçer) */
  private running = false;

  constructor(
    private readonly context: () => AudioContext,
    /** Konuşanlar kümesi değişince çağrılır (her okumada değil) */
    private readonly onChange: () => void,
  ) {}

  /** Bu kişinin sesi yerelde ölçülüyor mu; ölçülmüyorsa çağıran sunucunun bildirimini kullanır */
  measures(identity: string): boolean {
    if (!this.running) return false;
    for (const e of this.entries.values()) if (e.identity === identity) return true;
    return false;
  }

  isSpeaking(identity: string): boolean {
    return this.speaking.has(identity);
  }

  add(identity: string, track: MediaStreamTrack): void {
    if (this.entries.has(track)) return;
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(new MediaStream([track]));
    } catch {
      return; // iz bitmiş olabilir; sunucunun bildirimi kullanılır
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    // Çıkışa bağlanmaz: çözümleyici bağlı olmasa da işlenir, ses ikinci kez çalınmaz
    source.connect(analyser);
    this.entries.set(track, { identity, source, analyser, lastAboveAt: 0 });
    this.timer ??= window.setInterval(() => this.poll(), SPEAKING_POLL_MS);
  }

  remove(track: MediaStreamTrack): void {
    const e = this.entries.get(track);
    if (!e) return;
    this.entries.delete(track);
    this.dispose(e);
    this.afterRemove();
  }

  removeIdentity(identity: string): void {
    for (const [track, e] of this.entries) {
      if (e.identity !== identity) continue;
      this.entries.delete(track);
      this.dispose(e);
    }
    this.afterRemove();
  }

  clear(): void {
    for (const e of this.entries.values()) this.dispose(e);
    this.entries.clear();
    this.afterRemove();
  }

  private dispose(e: Entry): void {
    e.source.disconnect();
    e.analyser.disconnect();
  }

  /** İz kalmadıysa zamanlayıcı durur; kalkan kişinin halkası hemen söner */
  private afterRemove(): void {
    if (this.entries.size === 0 && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
      this.buf = null;
      this.running = false;
    }
    this.refresh(performance.now());
  }

  private poll(): void {
    const now = performance.now();
    const running = this.context().state === 'running';
    if (running !== this.running) {
      // Bağlam durdu ya da yeniden başladı: ölçüm baştan; ölçüm ile sunucu bildirimi arasındaki seçim değişir
      this.running = running;
      for (const e of this.entries.values()) e.lastAboveAt = 0;
      this.speaking.clear();
      this.onChange();
    }
    if (!running) return;
    for (const e of this.entries.values()) {
      if (this.buf?.length !== e.analyser.fftSize) this.buf = new Float32Array(e.analyser.fftSize);
      e.analyser.getFloatTimeDomainData(this.buf);
      if (rmsDb(this.buf) >= SPEAKING_THRESHOLD_DB) e.lastAboveAt = now;
    }
    this.refresh(now);
  }

  /** Konuşanlar kümesini yeniden hesaplar; değiştiyse bildirir */
  private refresh(now: number): void {
    const next = new Set<string>();
    for (const e of this.entries.values()) if (heldSpeaking(e.lastAboveAt, now)) next.add(e.identity);
    let changed = next.size !== this.speaking.size;
    if (!changed) for (const id of next) if (!this.speaking.has(id)) changed = true;
    this.speaking = next;
    if (changed) this.onChange();
  }
}
