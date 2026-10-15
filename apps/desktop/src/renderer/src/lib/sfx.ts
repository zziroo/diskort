// Arayüz sesleri. Sesler client-core'da tek yerde tanımlı (packages/client-core/src/sfx.ts); burada
// bellekte üretilip Web Audio ile çalınır. Telefon aynı tanımdan üretilmiş WAV dosyalarını çalar.
//
// Çıkış aygıtı: sesler seçili çıkış aygıtından (Ayarlar → Ses ve Görüntü → Çıkış Aygıtı) çalınır. Aygıt değişimi
// (setSinkId) bitmeden çalınan ses eskiden kayboluyordu (ilk ses genelde "katıldın" sesiydi); artık
// aygıt hazır olana dek beklenir.
import { INTRO_SOUND_MAX_SECONDS } from '@diskort/shared';
import {
  CALL_SOUND_REPEAT_MS,
  OTHERS_SOUNDS,
  renderSound,
  SFX_SAMPLE_RATE,
  useGuild,
  useSession,
  type CallSoundName,
  type SoundName,
} from '@diskort/client-core';
import { getSettings, useSettings } from '../stores/settings';
import { resolveOutputSink } from '../features/voice/outputSink';
import { createPromiseLru } from './promiseLru';

export type { SoundName } from '@diskort/client-core';

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let ctx: SinkContext | null = null;
/** Bağlama uygulanmış çıkış aygıtı ('' = sistemin varsayılanı) */
let appliedSink = '';
let sinkChange: Promise<void> | null = null;
const buffers = new Map<SoundName | CallSoundName, AudioBuffer>();
const lastPlayed = new Map<SoundName, number>();

/** Aynı ses bu süreden sık çalınmaz (ör. kısayola art arda basınca üst üste binmesin) */
const SAME_SOUND_GAP_MS = 90;

/** Uygulama genelinde paylaşılan AudioContext (arayüz sesleri, LiveKit işlemci bağlamı). */
export function sharedAudioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' }) as SinkContext;
  return ctx;
}


/** Her uygulama isteğinde artar; çözümleme bitince eski isteklerin sonucu atılır */
let sinkGen = 0;
let sinkStarted = false;

/**
 * Seçili çıkış aygıtını bağlama uygular. Zincirler sıraya dizilir (setSinkId'ler üst üste binmez), ayar
 * çözümleme anında okunur, eski istek sonucu atılır. Çalınan sesler bekleyen değişimi bekler.
 */
function applySink(ac: SinkContext): void {
  if (!ac.setSinkId) return;
  const gen = ++sinkGen;
  const prev = sinkChange ?? Promise.resolve();
  const change: Promise<void> = prev
    .then(() => resolveOutputSink(getSettings().outputDeviceId))
    .then(async (sink) => {
      if (gen !== sinkGen || sink === appliedSink) return;
      const before = appliedSink;
      appliedSink = sink;
      await ac.setSinkId?.(sink).catch(() => {
        appliedSink = before;
      });
    })
    .catch(() => undefined)
    .finally(() => {
      if (sinkChange === change) sinkChange = null;
    });
  sinkChange = change;
}

async function ready(): Promise<AudioContext> {
  const ac = sharedAudioContext() as SinkContext;
  // Çözümleme yalnız ilk kullanımda, ayar değişince ve aygıt takılıp çıkınca yapılır (her seste değil)
  if (!sinkStarted) {
    sinkStarted = true;
    applySink(ac);
  }
  if (sinkChange) await sinkChange;
  if (ac.state === 'suspended') await ac.resume().catch(() => undefined);
  return ac;
}

function buffer(ac: AudioContext, name: SoundName | CallSoundName): AudioBuffer {
  let b = buffers.get(name);
  if (!b) {
    const samples = renderSound(name, SFX_SAMPLE_RATE);
    b = ac.createBuffer(1, samples.length, SFX_SAMPLE_RATE);
    b.copyToChannel(samples, 0);
    buffers.set(name, b);
  }
  return b;
}

/**
 * Ses bağlamını ve çıkış aygıtını önceden hazırlar (ses kanalına bağlanırken çağrılır): "katıldın" sesi
 * çalınacağı anda aygıt değişimiyle ya da bağlamın açılışıyla yarışmasın.
 */
export function prepareSounds(): void {
  void ready()
    .then((ac) => {
      for (const name of ['join', 'leave', 'mute', 'unmute', 'userJoin', 'userLeave'] as const) buffer(ac, name);
    })
    .catch(() => undefined);
}

// Çıkış aygıtı değişince bağlam hemen taşınır (bir sonraki ses beklemesin)
useSettings.subscribe((next, prev) => {
  if (ctx && next.outputDeviceId !== prev.outputDeviceId) applySink(ctx);
});

// Aygıt takılıp çıkınca (modül ömrü boyunca tek dinleyici, 300 ms debounce) çıkış yeniden çözülür
let deviceChangeTimer: number | null = null;
if (typeof navigator !== 'undefined') {
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (deviceChangeTimer !== null) window.clearTimeout(deviceChangeTimer);
    deviceChangeTimer = window.setTimeout(() => {
      deviceChangeTimer = null;
      if (ctx) applySink(ctx);
    }, 300);
  });
}

function selfDeafened(): boolean {
  const s = getSettings();
  if (s.selfDeaf) return true;
  const selfId = useSession.getState().user?.id;
  return selfId !== undefined && useGuild.getState().voiceStates[selfId]?.serverDeaf === true;
}

/** Ayarlara göre bu ses çalınmalı mı */
function allowed(name: SoundName): boolean {
  const s = getSettings();
  if (name === 'mention') return s.notificationSound;
  if (!s.sounds) return false;
  if ((name === 'pttOn' || name === 'pttOff') && !s.pttSounds) return false;
  // Sağırken başkalarının kanal olayları duyulmaz; kendi işlemlerinin sesi çalar
  return !(OTHERS_SOUNDS.has(name) && selfDeafened());
}

/**
 * Sesi çalar. `own`: kendi girişin (sağırlaştırma kontrolü atlanır; kendi eylemin hep sesli). `preview`: ayarlardaki dinleme düğmesi (açık/kapalı ayarlarına bakılmaz).
 */
export function playSound(name: SoundName, opts: { preview?: boolean } = {}): void {
  if (!opts.preview && !allowed(name)) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < SAME_SOUND_GAP_MS) return;
  lastPlayed.set(name, now);
  void ready()
    .then((ac) => {
      const src = ac.createBufferSource();
      src.buffer = buffer(ac, name);
      src.connect(ac.destination);
      src.onended = () => src.disconnect();
      src.start(ac.currentTime + 0.005);
    })
    .catch(() => undefined);
}

// ---------- Kişisel giriş sesleri ----------

/** Çözülmüş giriş sesleri (adres → ses); adresler değişmez (içerik özeti adreste), en son kullanılan 16 tanesi tutulur */
const introBuffers = createPromiseLru<AudioBuffer>(16, async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`giriş sesi alınamadı: HTTP ${res.status}`);
  return sharedAudioContext().decodeAudioData(await res.arrayBuffer());
});

/** Çalan giriş sesi (aynı anda tek giriş sesi çalar; yenisi eskisini susturur) */
let intro: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
/** Her başlatma/durdurmada artar: indirme ya da çözme bitene dek başka bir ses başladıysa eski sonuç çalınmaz */
let introGen = 0;
/** Bitişte yumuşak kısılma (sunucu da kısar; önizlemede kesit ortadan kesildiği için gerekli) */
const INTRO_FADE_S = 0.25;

/** Giriş seslerinin seviyesi: dinleme düğmeleri ayar kapalıyken (0) de duyulsun diye tam seviyeye düşer */
const introVolume = (preview: boolean): number => {
  const v = getSettings().introSoundVolume;
  return preview && v <= 0 ? 1 : v;
};

/**
 * Giriş sesleri çalınabilir mi (seslerin açık olması ve seviyenin 0 olmaması). Kapalıysa giriş sesi yerine genel
 * katılma sesi çalınır (ses kanalı bunu kapıya null adres vererek sağlar).
 */
export function introSoundsEnabled(): boolean {
  const s = getSettings();
  return s.sounds && s.introSoundVolume > 0;
}

function startIntro(ac: AudioContext, buf: AudioBuffer, gainValue: number, offset: number, duration: number, onEnd?: () => void): void {
  stopIntroNodes();
  const gain = ac.createGain();
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(gain).connect(ac.destination);
  const at = ac.currentTime + 0.005;
  const length = Math.max(0.05, Math.min(duration, buf.duration - offset));
  gain.gain.setValueAtTime(gainValue, at);
  // Kesitin sonunda kısılarak biter (önizlemede pencere sesin ortasında kapanır, tık sesi olmasın)
  const fadeAt = at + Math.max(0, length - INTRO_FADE_S);
  gain.gain.setValueAtTime(gainValue, fadeAt);
  gain.gain.linearRampToValueAtTime(0.0001, at + length);
  const current = { src, gain };
  src.onended = () => {
    src.disconnect();
    gain.disconnect();
    if (intro === current) intro = null;
    onEnd?.();
  };
  intro = current;
  src.start(at, offset, length);
}

function stopIntroNodes(): void {
  const current = intro;
  intro = null;
  if (!current) return;
  try {
    // Kısa kısılma: aniden kesilen ses tık yapar
    const t = current.gain.context.currentTime;
    current.gain.gain.cancelScheduledValues(t);
    current.gain.gain.setTargetAtTime(0, t, 0.015);
    current.src.stop(t + 0.08);
  } catch {
    // zaten bitmiş
  }
}

/**
 * Kişisel giriş sesini (bkz. introSoundUrl) seçili çıkış aygıtından çalar; çalan önceki giriş sesini susturur.
 * Ayarlar (sesler kapalı, giriş sesi seviyesi 0) ya da sağırlaştırma giriş sesine izin vermiyorsa, ya da ses
 * alınamaz/çözülemezse yerine `fallback` (varsayılan genel "biri girdi") sesi çalınır; o da kendi kurallarına
 * uyar. `preview`: ayarlardaki dinleme düğmesi (ayarlara bakılmaz, yedek ses çalmaz). Ses çaldıysa true döner.
 */
export async function playIntroSound(
  url: string,
  opts: { preview?: boolean; own?: boolean; fallback?: SoundName; onEnd?: () => void } = {},
): Promise<boolean> {
  const preview = opts.preview === true;
  const fallback = opts.fallback ?? 'userJoin';
  if (!preview && (!introSoundsEnabled() || (!opts.own && selfDeafened()))) {
    playSound(fallback);
    return false;
  }
  const gen = ++introGen;
  stopIntroNodes();
  try {
    const [ac, buf] = await Promise.all([ready(), introBuffers.get(url)]);
    if (gen !== introGen) return false; // bu arada başka bir giriş sesi başladı ya da kanaldan çıkıldı
    startIntro(ac, buf, introVolume(preview), 0, INTRO_SOUND_MAX_SECONDS + 0.5, opts.onEnd);
    return true;
  } catch {
    if (gen === introGen && !preview) playSound(fallback);
    return false;
  }
}

/**
 * Yüklenmeden önceki sesin seçilen kesitini (başlangıç `start`, en fazla INTRO_SOUND_MAX_SECONDS) dinletir;
 * giriş sesiyle aynı yoldan çalar (çalan giriş sesini susturur), sonunda kısılarak biter.
 */
export function previewIntroClip(buf: AudioBuffer, start: number, onEnd?: () => void): void {
  const gen = ++introGen;
  stopIntroNodes();
  void ready()
    .then((ac) => {
      if (gen !== introGen) {
        onEnd?.(); // bu arada başka bir ses başladı ya da durduruldu
        return;
      }
      startIntro(ac, buf, introVolume(true), Math.max(0, start), INTRO_SOUND_MAX_SECONDS, onEnd);
    })
    .catch(() => onEnd?.());
}

/** Çalan (ya da indirilmekte olan) giriş sesini susturur: kanaldan çıkınca, bağlantı kopunca, dinleme bitince */
export function stopIntroSound(): void {
  introGen++;
  stopIntroNodes();
}

/** Seçilen ses dosyasını çözer (giriş sesi düzenleyicisi: süre ve dinleme için) */
export function decodeAudioFile(data: ArrayBuffer): Promise<AudioBuffer> {
  return sharedAudioContext().decodeAudioData(data);
}

// ---------- Arama sesleri (döngülü) ----------

/** Çalan arama sesleri: ad → yeniden çalma zamanlayıcısı ve son çalınan kaynak */
const loops = new Map<CallSoundName, { timer: number; source: AudioBufferSourceNode | null }>();

/**
 * Arama sesinin ayarı (telefondakiyle aynı): zil bir bildirim gibidir (bildirim sesi ayarı), bekleme sesi
 * arayüz sesidir (sesler ayarı). Sağırken ikisi de çalmaz. Her turda yeniden bakılır.
 */
function callSoundAllowed(name: CallSoundName): boolean {
  if (selfDeafened()) return false;
  const s = getSettings();
  return name === 'ring' ? s.notificationSound : s.sounds;
}

function playLoopOnce(name: CallSoundName): void {
  if (!callSoundAllowed(name)) return;
  void ready()
    .then((ac) => {
      const loop = loops.get(name);
      if (!loop) return; // bu arada durduruldu
      const src = ac.createBufferSource();
      src.buffer = buffer(ac, name);
      src.connect(ac.destination);
      src.onended = () => {
        src.disconnect();
        if (loop.source === src) loop.source = null;
      };
      loop.source = src;
      src.start(ac.currentTime + 0.005);
    })
    .catch(() => undefined);
}

/**
 * Arama sesini (gelen arama 'ring', aranıyor 'ringback') açar ya da kapatır: açıkken CALL_SOUND_REPEAT_MS
 * aralıkla yeniden çalar. Tekrarlanan açma/kapama zararsızdır. Kapatınca çalmakta olan ses de hemen susar.
 */
export function setCallSound(name: CallSoundName, on: boolean): void {
  const current = loops.get(name);
  if (on) {
    if (current) return;
    const loop = { timer: 0, source: null as AudioBufferSourceNode | null };
    loops.set(name, loop);
    loop.timer = window.setInterval(() => playLoopOnce(name), CALL_SOUND_REPEAT_MS[name]);
    playLoopOnce(name);
    return;
  }
  if (!current) return;
  loops.delete(name);
  window.clearInterval(current.timer);
  try {
    current.source?.stop();
  } catch {
    // zaten bitmiş
  }
}

/** Arama sesini ayarlardaki dinleme düğmesi için bir kez çalar */
export function previewCallSound(name: CallSoundName): void {
  void ready()
    .then((ac) => {
      const src = ac.createBufferSource();
      src.buffer = buffer(ac, name);
      src.connect(ac.destination);
      src.onended = () => src.disconnect();
      src.start(ac.currentTime + 0.005);
    })
    .catch(() => undefined);
}

/** Şu an döngüde çalan arama sesleri (hata ayıklama ve test için) */
export const activeCallSounds = (): CallSoundName[] => [...loops.keys()];
