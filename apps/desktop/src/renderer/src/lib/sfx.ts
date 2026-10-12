// Arayüz sesleri. Sesler client-core'da tek yerde tanımlı (packages/client-core/src/sfx.ts); burada
// bellekte üretilip Web Audio ile çalınır. Telefon aynı tanımdan üretilmiş WAV dosyalarını çalar.
//
// Çıkış aygıtı: sesler seçili çıkış aygıtından (Ayarlar → Ses ve Görüntü → Çıkış Aygıtı) çalınır. Aygıt değişimi
// (setSinkId) bitmeden çalınan ses eskiden kayboluyordu (ilk ses genelde "katıldın" sesiydi); artık
// aygıt hazır olana dek beklenir.
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
 * Sesi çalar. `preview`: ayarlardaki dinleme düğmesi (açık/kapalı ayarlarına bakılmaz).
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
