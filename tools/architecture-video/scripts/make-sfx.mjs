// Ses efektlerini harici dosya kullanmadan sentezler (16-bit mono WAV, 44.1 kHz) -> public/sfx/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sfx');
fs.mkdirSync(dir, { recursive: true });

let seed = 1234;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 * 2 - 1;
};

function write(name, samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.85 / peak : 1;
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * gain)) * 32767), 44 + i * 2));
  fs.writeFileSync(path.join(dir, name + '.wav'), buf);
}

const make = (sec, fn) => Array.from({ length: Math.floor(sec * SR) }, (_, i) => fn(i / SR, i));
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);

// whoosh: bant geçiren süzgeçle taranan gürültü, yükselip söner
{
  let lp = 0, bp = 0;
  const dur = 0.9;
  write('whoosh', make(dur, (t) => {
    const p = t / dur;
    const f = 300 + 3200 * Math.sin(Math.PI * Math.min(1, p * 0.9)) ** 2;
    const k = 2 * Math.sin(Math.PI * f / SR);
    lp += k * bp;
    const hp = rnd() - lp - 0.35 * bp;
    bp += k * hp;
    return bp * Math.sin(Math.PI * p) ** 1.5 * 0.9;
  }));
}
// pop: kısa, düşen frekanslı sinüs
write('pop', make(0.18, (t) => {
  const f = 520 - 300 * Math.min(1, t / 0.08);
  return Math.sin(2 * Math.PI * f * t) * env(t, 0.002, 0.04);
}));
// tık: çok kısa tıklama
write('tick', make(0.06, (t) => (Math.sin(2 * Math.PI * 1800 * t) * 0.6 + rnd() * 0.3) * env(t, 0.0005, 0.008)));
// ding: iki üst ses, uzun sönümlü çan
write('ding', make(1.3, (t) =>
  (Math.sin(2 * Math.PI * 1318.5 * t) + 0.45 * Math.sin(2 * Math.PI * 2637 * t) + 0.2 * Math.sin(2 * Math.PI * 3951 * t)) * env(t, 0.003, 0.35)));
// bağlantı blip'i: iki hızlı artan nota
write('blip', make(0.22, (t) => {
  const f = t < 0.09 ? 880 : 1320;
  const tt = t < 0.09 ? t : t - 0.09;
  return Math.sin(2 * Math.PI * f * t) * env(tt, 0.002, 0.03) * 0.9;
}));
// yayın/sürüm için yükselen arpej
write('rise', make(0.6, (t) => {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  const i = Math.min(3, Math.floor(t / 0.11));
  const tt = t - i * 0.11;
  return Math.sin(2 * Math.PI * notes[i] * t) * env(tt, 0.003, 0.12) * (i === 3 ? 1.2 : 0.8);
}));
console.log('SFX hazır:', dir);
