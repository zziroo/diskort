import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CALL_SOUND_LABELS,
  CALL_SOUND_NAMES,
  CALL_SOUND_REPEAT_MS,
  ChannelSoundGate,
  encodeWav,
  OTHERS_QUIET_MS,
  OTHERS_SOUNDS,
  PREVIEW_SOUND_NAMES,
  renderSound,
  SFX_PEAK_DBFS,
  SFX_SAMPLE_RATE,
  SFX_TARGET_RMS_DBFS,
  SOUND_ALIASES,
  SOUND_LABELS,
  SOUND_NAMES,
  type SoundName,
} from '../src/sfx';

const dbfs = (v: number): number => 20 * Math.log10(v);
const peak = (b: Float32Array): number => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const ms = (b: Float32Array): number => (b.length / SFX_SAMPLE_RATE) * 1000;

/** Ardışık iki örnek arasındaki en büyük fark: kesinti/tık olursa sıçrar */
function maxJump(b: Float32Array): number {
  let jump = 0;
  for (let i = 1; i < b.length; i++) jump = Math.max(jump, Math.abs(b[i]! - b[i - 1]!));
  return jump;
}

/** Algılanan seviye: en yüksek 50 ms'lik pencerenin RMS'i (dBFS), sfx.ts'teki ölçümle aynı */
function loudness(b: Float32Array): number {
  const w = Math.round(0.05 * SFX_SAMPLE_RATE);
  let sum = 0;
  let best = 0;
  for (let i = 0; i < b.length; i++) {
    sum += b[i]! * b[i]!;
    if (i >= w) sum -= b[i - w]! * b[i - w]!;
    best = Math.max(best, sum);
  }
  return dbfs(Math.sqrt(best / Math.min(w, b.length)));
}

/** Ardışık 25 ms'lik pencerelerin RMS'i (dBFS) */
function envelope(b: Float32Array): number[] {
  const w = Math.round(0.025 * SFX_SAMPLE_RATE);
  const out: number[] = [];
  for (let i = 0; i + w <= b.length; i += w) {
    let sum = 0;
    for (let k = i; k < i + w; k++) sum += b[k]! * b[k]!;
    out.push(dbfs(Math.sqrt(sum / w)));
  }
  return out;
}

/** Tasarımdaki seviye ayarları (dB): algılanan seviye = -23 dBFS + bu değer (tepe sınırı da bu kadar iner) */
const TRIM_DB: Record<SoundName, number> = {
  join: 0,
  leave: 0,
  userJoin: 0,
  userLeave: 0,
  mute: 0,
  unmute: 0,
  deafen: 0,
  undeafen: 0,
  streamStart: -1,
  streamStop: -1,
  userStreamStart: -1,
  userStreamStop: -1,
  mention: 0,
  disconnect: 0,
  reconnected: -2,
  pttOn: -10,
  pttOff: -10,
};

describe('arayüz sesleri', () => {
  it('her sesin adı var, seviye hedefinde (algılanan -16 dBFS ya da tepe -8 dBFS, + sese özel ayar), kırpılma yok', () => {
    expect(SFX_PEAK_DBFS).toBe(-8);
    expect(SFX_TARGET_RMS_DBFS).toBe(-16);
    for (const name of SOUND_NAMES) {
      expect(SOUND_LABELS[name], name).toBeTruthy();
      const b = renderSound(name);
      expect(b.every((v) => Number.isFinite(v) && Math.abs(v) < 1), name).toBe(true);
      const p = dbfs(peak(b));
      const l = loudness(b);
      expect(p, name).toBeLessThanOrEqual(SFX_PEAK_DBFS + 0.01);
      // İki sınırın ikisi de aşılmaz, en az biri tutturulur (±0,5 dB)
      expect(p, name).toBeLessThanOrEqual(SFX_PEAK_DBFS + TRIM_DB[name] + 0.01);
      expect(l, name).toBeLessThanOrEqual(SFX_TARGET_RMS_DBFS + TRIM_DB[name] + 0.01);
      const off = Math.max(p - (SFX_PEAK_DBFS + TRIM_DB[name]), l - (SFX_TARGET_RMS_DBFS + TRIM_DB[name]));
      expect(off, name).toBeGreaterThanOrEqual(-0.5);
    }
  });

  it('algılanan seviyeler dengeli: ayarı 0 olan her ses katılma sesinin 1 dB yakınında (kısa sesler cılız değil)', () => {
    const ref = loudness(renderSound('join'));
    for (const name of SOUND_NAMES) {
      if (TRIM_DB[name] !== 0) continue;
      expect(Math.abs(loudness(renderSound(name)) - ref), name).toBeLessThanOrEqual(1);
    }
  });

  it('kısa ve tıksız: sessizlikle başlar ve biter, sert başlangıç ve kesinti yok, DC yok', () => {
    for (const name of SOUND_NAMES) {
      const b = renderSound(name);
      expect(ms(b), name).toBeGreaterThanOrEqual(60);
      expect(ms(b), name).toBeLessThanOrEqual(600);
      expect(Math.abs(b[0]!), name).toBeLessThan(1e-3);
      expect(Math.abs(b[b.length - 1]!), name).toBeLessThan(1e-3);
      // 5 ms'lik yumuşak başlangıç: ilk 0,5 ms tepenin %5, ilk 1 ms %12 altında (sert vuruş yok)
      expect(peak(b.subarray(0, Math.round(0.0005 * SFX_SAMPLE_RATE))), name).toBeLessThan(0.05 * peak(b));
      expect(peak(b.subarray(0, Math.round(0.001 * SFX_SAMPLE_RATE))), name).toBeLessThan(0.12 * peak(b));
      // Tık koruması tepe seviyesine göre (-15 dBFS tepede 0,04 idi); seviye değişse de aynı sıkılıkta kalır
      expect(maxJump(b), name).toBeLessThan(0.225 * Math.pow(10, SFX_PEAK_DBFS / 20));
      const mean = b.reduce((s, v) => s + v, 0) / b.length;
      expect(Math.abs(mean), name).toBeLessThan(1e-4);
    }
  });

  it('katılma/ayrılma sakin: ilk 150 ms boyunca seviye 6 dB içinde kalır, ikinci nota vurgulu değil', () => {
    for (const name of ['join', 'leave'] as const) {
      const head = envelope(renderSound(name)).slice(0, 6);
      expect(Math.max(...head) - Math.min(...head), name).toBeLessThanOrEqual(6);
      expect(Math.max(...head.slice(2)), name).toBeLessThanOrEqual(Math.max(...head.slice(0, 2)));
    }
  });

  it('başkalarının girip çıkması ve yayını kendininkiyle aynı ses (Discord gibi)', () => {
    for (const name of OTHERS_SOUNDS) {
      const base = SOUND_ALIASES[name];
      expect(base, name).toBeDefined();
      expect(renderSound(name), name).toEqual(renderSound(base!));
    }
    expect(PREVIEW_SOUND_NAMES.some((name) => SOUND_ALIASES[name])).toBe(false);
  });

  it('her çalışta aynı örnekler', () => {
    expect(renderSound('join')).toEqual(renderSound('join'));
    expect(renderSound('join')).toEqual(renderSound('join', SFX_SAMPLE_RATE));
  });

  it('başkalarının olayları: bağlanınca sel yok, aynı anda gelenler tek ses, öncelikli olan duyulur', () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const gate = new ChannelSoundGate((n) => played.push(n));
      gate.quiet();
      gate.push('userJoin');
      gate.push('userStreamStart');
      vi.advanceTimersByTime(OTHERS_QUIET_MS + 100);
      expect(played).toEqual([]);

      gate.push('userStreamStop');
      gate.push('userLeave');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['userLeave']);

      // Hemen ardından gelen ikinci giriş yutulur, biraz sonra gelen çalınır
      gate.push('userJoin');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['userLeave']);
      vi.advanceTimersByTime(400);
      gate.push('userJoin');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['userLeave', 'userJoin']);

      gate.push('userLeave');
      gate.cancel();
      vi.advanceTimersByTime(1000);
      expect(played).toEqual(['userLeave', 'userJoin']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('giriş sesi: girenin adresi varsa genel ses yerine o çalar; aynı anda girenlerden ilki', () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const gate = new ChannelSoundGate(
        (n) => played.push(n),
        (url) => played.push(`intro:${url}`),
      );
      gate.push('userJoin', 'https://x/a.mp3');
      gate.push('userJoin', 'https://x/b.mp3');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['intro:https://x/a.mp3']);

      // Adresi olmayan giriş genel sesi çalar; aynı yığındaki sonraki adres yine kullanılır
      vi.advanceTimersByTime(400);
      gate.push('userJoin', null);
      gate.push('userJoin', 'https://x/c.mp3');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['intro:https://x/a.mp3', 'intro:https://x/c.mp3']);

      vi.advanceTimersByTime(400);
      gate.push('userJoin');
      vi.advanceTimersByTime(100);
      expect(played.at(-1)).toBe('userJoin');

      // Önce çıkış geldiyse (aynı öncelik) çıkış duyulur; adres sonraki yığına taşınmaz
      vi.advanceTimersByTime(400);
      gate.push('userLeave');
      gate.push('userJoin', 'https://x/d.mp3');
      vi.advanceTimersByTime(100);
      expect(played.at(-1)).toBe('userLeave');
      vi.advanceTimersByTime(400);
      gate.push('userStreamStart');
      vi.advanceTimersByTime(100);
      expect(played.at(-1)).toBe('userStreamStart');

      // İptal ve sessizlik bekleyen adresi de siler
      vi.advanceTimersByTime(400);
      gate.push('userJoin', 'https://x/e.mp3');
      gate.cancel();
      vi.advanceTimersByTime(100);
      gate.quiet(0);
      gate.push('userJoin');
      vi.advanceTimersByTime(100);
      expect(played.at(-1)).toBe('userJoin');
      expect(played).not.toContain('intro:https://x/e.mp3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('giriş sesi çalıcısı verilmezse adres yok sayılır (eski kullanım)', () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const gate = new ChannelSoundGate((n) => played.push(n));
      gate.push('userJoin', 'https://x/a.mp3');
      vi.advanceTimersByTime(100);
      expect(played).toEqual(['userJoin']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('WAV başlığı: 48 kHz, mono, 16 bit', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(46, true)).toBe(16384);
  });

  it('telefondaki hazır sesler güncel (değişince: node apps/mobile/scripts/generate-sounds.mjs)', () => {
    const dir = join(__dirname, '..', '..', '..', 'apps', 'mobile', 'assets', 'sounds');
    for (const name of [...PREVIEW_SOUND_NAMES, ...CALL_SOUND_NAMES]) {
      const file = readFileSync(join(dir, `${name}.wav`));
      const expected = encodeWav(renderSound(name));
      expect(file.length, name).toBe(expected.length);
      const a = new Int16Array(Uint8Array.from(file.subarray(44)).buffer);
      const b = new Int16Array(expected.buffer, 44, (expected.length - 44) / 2);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
      expect(diff, name).toBeLessThanOrEqual(1);
    }
  });

  it('arama sesleri: zil ve bekleme sesi ayrı listede; tıksız, tepe sınırında, aralarına sessizlik kalacak kadar kısa', () => {
    expect(CALL_SOUND_NAMES).toEqual(['ring', 'ringback']);
    for (const name of CALL_SOUND_NAMES) {
      expect(CALL_SOUND_LABELS[name], name).toBeTruthy();
      expect((SOUND_NAMES as readonly string[]).includes(name), name).toBe(false);
      const b = renderSound(name);
      expect(b.every((v) => Number.isFinite(v) && Math.abs(v) < 1), name).toBe(true);
      expect(dbfs(peak(b)), name).toBeLessThanOrEqual(SFX_PEAK_DBFS + 0.01);
      expect(loudness(b), name).toBeLessThanOrEqual(SFX_TARGET_RMS_DBFS + 0.01);
      expect(Math.abs(b[0]!), name).toBeLessThan(1e-3);
      expect(Math.abs(b[b.length - 1]!), name).toBeLessThan(1e-3);
      expect(maxJump(b), name).toBeLessThan(0.225 * Math.pow(10, SFX_PEAK_DBFS / 20));
      // Yinelenirken arada en az ~1 sn sessizlik kalır
      expect(ms(b), name).toBeLessThanOrEqual(CALL_SOUND_REPEAT_MS[name] - 1000);
      expect(ms(b), name).toBeGreaterThanOrEqual(400);
    }
    // Bekleme sesi zilden sakin (kısık)
    expect(loudness(renderSound('ringback'))).toBeLessThan(loudness(renderSound('ring')) - 2);
  });
});
