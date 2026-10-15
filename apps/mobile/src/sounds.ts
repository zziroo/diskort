// Arayüz sesleri (katıl, ayrıl, sustur, sağırlaştır, yayın, biri girdi/çıktı, bahsedilme, bağlantı): tek
// tanımdan (packages/client-core/src/sfx.ts) üretilmiş WAV dosyaları (scripts/generate-sounds.mjs); masaüstü
// aynı sesleri çalar. expo-audio ile çalınır, haptics.ts'e takılır; çağıran yerler feedback('mute') /
// soundCue('userJoin') kullanır. Ayarlar → Bildirimler ve Sesler: aç/kapat ve dinleme listesi. DM arama
// sesleri (zil, bekleme) döngüyle çalar: startCallSound / stopCallSound (IncomingCall.tsx yönetir).
//
// Görüşme sesiyle birlikte çalmalı: expo-audio'nun "mixWithOthers" kipinde ses odağı (audio focus)
// istenmez, LiveKit'in görüşmesi kısılmaz ya da duraklatılmaz. Dikkat: setAudioModeAsync Android'de ses
// yöneticisinin kipini (MODE_NORMAL) ve hoparlörü de değiştiriyor; görüşme sürerken çağrılırsa ses
// yolu bozulur. Bu yüzden yalnızca açılışta, sesli sohbete girilmeden önce bir kez çağrılır.
//
// iOS: ses oturumu (AVAudioSession) LiveKit'indir. expo-audio'nun ses kipi hiç ayarlanmaz (kategoriyi
// "ambient" yapıp görüşmeyi bozabilir) ve çalış bitince oturumu kapatmaması istenir (keepAudioSessionActive);
// kapatırsa görüşmenin sesi de kesilir.
//
// Yerel modül yalnızca yeni APK'larda var: yoksa (ör. eski APK) ses sessizce atlanır, titreşim sürer.

import {
  CALL_SOUND_REPEAT_MS,
  OTHERS_SOUNDS,
  SOUND_ALIASES,
  useGuild,
  useSession,
  type CallSoundName,
  type SoundName,
} from '@diskort/client-core';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type * as ExpoAudio from 'expo-audio';
import { setFeedbackSound, type SoundEvent } from './haptics';
import { getSettings } from './stores/settings';

/** Telefonda çalınan sesler (bas-konuş telefonda yok) */
export type MobileSoundName = Exclude<SoundName, 'pttOn' | 'pttOff'>;

// Metro yalnızca sabit yollu require() ile paketler: her dosya ayrı yazılır
const FILES: Record<MobileSoundName, number> = {
  join: require('../assets/sounds/join.wav'),
  leave: require('../assets/sounds/leave.wav'),
  // Başkasının girip çıkması ve yayını kendininkiyle aynı sesi çalar (SOUND_ALIASES)
  userJoin: require('../assets/sounds/join.wav'),
  userLeave: require('../assets/sounds/leave.wav'),
  mute: require('../assets/sounds/mute.wav'),
  unmute: require('../assets/sounds/unmute.wav'),
  deafen: require('../assets/sounds/deafen.wav'),
  undeafen: require('../assets/sounds/undeafen.wav'),
  streamStart: require('../assets/sounds/streamStart.wav'),
  streamStop: require('../assets/sounds/streamStop.wav'),
  userStreamStart: require('../assets/sounds/streamStart.wav'),
  userStreamStop: require('../assets/sounds/streamStop.wav'),
  mention: require('../assets/sounds/mention.wav'),
  disconnect: require('../assets/sounds/disconnect.wav'),
  reconnected: require('../assets/sounds/reconnected.wav'),
};

/**
 * Arama sesleri (DM aramaları): tek seferlik değil, arama sürdükçe CALL_SOUND_REPEAT_MS aralıkla yeniden
 * çalınır (startCallSound / stopCallSound). Dinleme listesinde yoklar (masaüstündeki gibi ayrı liste).
 */
const CALL_FILES: Record<CallSoundName, number> = {
  ring: require('../assets/sounds/ring.wav'),
  ringback: require('../assets/sounds/ringback.wav'),
};

/** Ayarlardaki dinleme listesi */
export const MOBILE_SOUND_NAMES = (Object.keys(FILES) as MobileSoundName[]).filter((name) => !SOUND_ALIASES[name]);

/** Olay → ses. Hoparlör, yönetim ve hata olaylarının sesi yok (masaüstünde de yok), yalnızca titreşim. */
const EVENT_SOUND: Partial<Record<SoundEvent, MobileSoundName>> = {
  join: 'join',
  leave: 'leave',
  userJoin: 'userJoin',
  userLeave: 'userLeave',
  mute: 'mute',
  unmute: 'unmute',
  deafen: 'deafen',
  undeafen: 'undeafen',
  shareStart: 'streamStart',
  shareStop: 'streamStop',
  userStreamStart: 'userStreamStart',
  userStreamStop: 'userStreamStop',
  mention: 'mention',
  disconnect: 'disconnect',
  reconnected: 'reconnected',
};

const players = new Map<MobileSoundName | CallSoundName, ExpoAudio.AudioPlayer>();
let audio: typeof ExpoAudio | null = null;

function player(name: MobileSoundName | CallSoundName): ExpoAudio.AudioPlayer | null {
  if (!audio) return null;
  let p = players.get(name);
  if (!p) {
    const file = name in CALL_FILES ? CALL_FILES[name as CallSoundName] : FILES[name as MobileSoundName];
    p = audio.createAudioPlayer(file, { keepAudioSessionActive: Platform.OS === 'ios' });
    players.set(name, p);
  }
  return p;
}

function deafened(): boolean {
  if (getSettings().selfDeaf) return true;
  const selfId = useSession.getState().user?.id;
  return selfId !== undefined && useGuild.getState().voiceStates[selfId]?.serverDeaf === true;
}

/** Ayarlara göre bu ses çalınmalı mı */
function allowed(name: MobileSoundName): boolean {
  const s = getSettings();
  if (name === 'mention') return s.notificationSound;
  if (!s.sounds) return false;
  // Sağırken başkalarının kanal olayları duyulmaz; kendi işlemlerinin sesi çalar (masaüstündeki gibi)
  return !(OTHERS_SOUNDS.has(name) && deafened());
}

function start(name: MobileSoundName | CallSoundName): void {
  const p = player(name);
  if (!p) return;
  // Oynatıcı bir önceki çalışın sonunda durur: başa sarıp yeniden çal
  void p
    .seekTo(0)
    .then(() => p.play())
    .catch(() => undefined);
}

function play(event: SoundEvent): void {
  const name = EVENT_SOUND[event];
  if (name && allowed(name)) start(name);
}

/** Ayarlardaki dinleme düğmesi: açık/kapalı ayarlarına bakılmaz */
export function previewSound(name: MobileSoundName): void {
  start(name);
}

/**
 * Kişisel giriş sesleri (kanala girenin yüklediği en fazla INTRO_SOUND_MAX_SECONDS saniyelik MP3, sunucudan
 * akıtılır). Aynı anda tek bir tane çalar: yenisi başlayınca öncekisi kesilir. Oynatıcı her ses için yeniden
 * kurulur ve çalış bitince (ya da kesilince) bırakılır; ses dosyaları önbelleğe alınmaz.
 */
let intro: { player: ExpoAudio.AudioPlayer; timer: ReturnType<typeof setTimeout>; started: boolean } | null = null;

/** Ses bu süre içinde çalmaya başlamazsa (yavaş ağ, bozuk dosya) genel katılma sesine dönülür */
const INTRO_START_TIMEOUT_MS = 2500;
/** Bitiş olayı hiç gelmezse oynatıcı en geç bu sürede bırakılır */
const INTRO_MAX_LIFETIME_MS = 15_000;

/**
 * Giriş sesleri çalınabilir mi (yerel modül var, sesler açık, giriş sesi seviyesi 0 değil). Değilse çağıran
 * ChannelSoundGate'e null verir ve genel katılma sesi çalar (o da ayarlara göre).
 */
export function introSoundsEnabled(): boolean {
  const s = getSettings();
  return audio !== null && s.sounds && s.introSoundVolume > 0;
}

/** Çalan giriş sesini keser ve oynatıcısını bırakır */
export function stopIntroSound(): void {
  if (!intro) return;
  const { player: p, timer } = intro;
  intro = null;
  clearTimeout(timer);
  try {
    p.pause();
  } catch {
    // oynatıcı kapatılmış olabilir: önemli değil
  }
  try {
    p.remove();
  } catch {
    // önemli değil
  }
}

/**
 * Bir giriş sesini çalar (çalan giriş sesini keser). `own`: kendi girişin (sağırken de çalar, hata olursa
 * genel "katıldın" sesi); değilse başkasının girişi (sağırken çalmaz, hata olursa "biri girdi" sesi).
 * `preview`: profil ayarlarındaki dinleme düğmesi; ses ayarlarına bakılmaz, tam seviyede çalar, hatada
 * yerine bir şey çalınmaz.
 */
export function playIntroSound(url: string, opts: { preview?: boolean; own?: boolean } = {}): void {
  if (!audio) return;
  const fallback: MobileSoundName | null = opts.preview ? null : opts.own ? 'join' : 'userJoin';
  if (!opts.preview) {
    const s = getSettings();
    if (!s.sounds) return;
    if (!opts.own && deafened()) return;
    if (s.introSoundVolume <= 0) {
      if (fallback) start(fallback);
      return;
    }
  }
  stopIntroSound();
  const fail = (p: ExpoAudio.AudioPlayer): void => {
    // Yalnızca hâlâ çalan giriş sesi buysa (bu arada yenisi başlamadıysa) genel sese dönülür
    if (intro?.player !== p) return;
    const started = intro.started;
    stopIntroSound();
    if (!started && fallback && allowed(fallback)) start(fallback);
  };
  let p: ExpoAudio.AudioPlayer;
  try {
    p = audio.createAudioPlayer({ uri: url }, { keepAudioSessionActive: Platform.OS === 'ios' });
  } catch {
    if (fallback && allowed(fallback)) start(fallback);
    return;
  }
  const current = {
    player: p,
    started: false,
    timer: setTimeout(() => fail(p), INTRO_START_TIMEOUT_MS),
  };
  intro = current;
  try {
    p.volume = opts.preview ? 1 : Math.min(1, Math.max(0, getSettings().introSoundVolume));
    p.addListener('playbackStatusUpdate', (status) => {
      if (intro !== current) return;
      if (status.error) {
        fail(p);
      } else if (status.didJustFinish) {
        stopIntroSound();
      } else if (status.playing && !current.started) {
        // Çalmaya başladı: zaman aşımı yerine en uzun ömür sınırı
        current.started = true;
        clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          if (intro === current) stopIntroSound();
        }, INTRO_MAX_LIFETIME_MS);
      }
    });
    // Yükleme bitmeden çağrılabilir: hazır olunca çalar
    p.play();
  } catch {
    fail(p);
  }
}

/** Döngüdeki arama sesi (aynı anda tek bir tane) */
let looping: { name: CallSoundName; timer: ReturnType<typeof setInterval> } | null = null;

/**
 * Arama sesinin ayarı: zil bir bildirim gibidir (bildirim sesi ayarı), bekleme sesi arayüz sesidir (sesler
 * ayarı). Sağırken ikisi de çalmaz. Telefon sessizdeyken/titreşimdeyken expo-audio'nun kipi gereği zaten
 * duyulmaz (setupSounds: playsInSilentMode false).
 */
function callSoundAllowed(name: CallSoundName): boolean {
  const s = getSettings();
  if (deafened()) return false;
  return name === 'ring' ? s.notificationSound : s.sounds;
}

/**
 * Arama sesini döngüyle çalar (sesin başından bir sonrakinin başına CALL_SOUND_REPEAT_MS). Aynı ses zaten
 * çalıyorsa bir şey yapmaz; başka arama sesi çalıyorsa onun yerini alır. Her turda ayarlara yeniden bakılır.
 */
export function startCallSound(name: CallSoundName): void {
  if (looping?.name === name) return;
  stopCallSound();
  const tick = (): void => {
    const p = callSoundAllowed(name) ? player(name) : null;
    if (!p) return;
    // Başa sarma bitmeden durdurulduysa (kabul/ret) çalınmaz
    void p
      .seekTo(0)
      .then(() => {
        if (looping?.name === name) p.play();
      })
      .catch(() => undefined);
  };
  looping = { name, timer: setInterval(tick, CALL_SOUND_REPEAT_MS[name]) };
  tick();
}

/** Döngüdeki arama sesini durdurur (çalan turu da keser) */
export function stopCallSound(): void {
  if (!looping) return;
  const { name, timer } = looping;
  looping = null;
  clearInterval(timer);
  const p = players.get(name);
  if (p) {
    try {
      p.pause();
    } catch {
      // oynatıcı kapatılmış olabilir: önemli değil
    }
  }
}

/** Bu APK'da ses çalınabiliyor mu (eski APK'larda expo-audio yok) */
export function soundsAvailable(): boolean {
  return audio !== null;
}

/** Açılışta bir kez (sesli sohbete girilmeden önce) çağrılır; bkz. dosyanın başı */
export function setupSounds(): void {
  if (audio || requireOptionalNativeModule('ExpoAudio') === null) return;
  try {
    // Koşullu yükleme: modül yoksa paket hiç yüklenmez
    audio = require('expo-audio') as typeof ExpoAudio;
  } catch {
    audio = null;
    return;
  }
  if (Platform.OS !== 'ios') {
    audio
      .setAudioModeAsync({
        // Ses odağı istenmez: görüşme ve başka uygulamaların sesi kısılmaz
        interruptionMode: 'mixWithOthers',
        // Ekran kapalıyken de (biri kanala girdi) çalınabilsin
        shouldPlayInBackground: true,
        // Telefon sessizdeyken ya da titreşimdeyken arayüz sesi çalınmaz
        playsInSilentMode: false,
        shouldRouteThroughEarpiece: false,
      })
      .catch(() => undefined);
  }
  // İlk çalışta gecikme olmasın diye en sık kullanılanlar önceden hazırlanır
  for (const name of ['mute', 'unmute', 'join', 'leave'] as const) player(name);
  setFeedbackSound(play);
}
