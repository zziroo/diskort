import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason, RoomEvent, Track } from 'livekit-client';

/**
 * MobileVoiceClient'ın gerçek olay işleyicileri, sahte bir LiveKit odasıyla. Olay sırası livekit-client 2.22
 * Room.handleRestarting / handleSignalRestarted ile aynı (masaüstü karşılığı: apps/desktop/test/voiceReconnect.test.ts):
 * sökme ve Reconnecting aynı akışta, sonra Reconnected, hemen ardından ertelenen katılımcı/yayın olayları.
 */
const h = vi.hoisted(() => ({
  rooms: [] as unknown[],
  soundCue: vi.fn(),
  toast: vi.fn(),
  setWatching: vi.fn(),
  send: vi.fn(),
  resume: vi.fn(),
  reportClientError: vi.fn(),
  order: [] as string[],
  failConnect: null as null | 'throw' | 'close' | 'hang',
  onConnect: null as null | ((room: never) => void),
  platform: 'android',
  broadcast: null as null | { addListener: () => void; stop: () => void; isActive: () => Promise<boolean> },
  settings: { selfMute: false, selfDeaf: false, speaker: false } as Record<string, unknown>,
  requestMultiple: vi.fn(async () => ({ 'android.permission.RECORD_AUDIO': 'granted' })),
  check: vi.fn(async () => true),
  voiceService: {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
    addListener: vi.fn(() => ({ remove: () => undefined })),
  },
}));

vi.mock('livekit-client', async (original) => {
  const actual = await original<typeof import('livekit-client')>();
  class FakeRoom {
    readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
    readonly remoteParticipants = new Map<string, unknown>();
    state = 'connected';
    readonly pubs = new Map<Track.Source, { track: object; audioTrack?: object; videoTrack?: { sender: unknown } }>();
    micFailures = 0;
    readonly localParticipant = {
      permissions: undefined as unknown,
      getTrackPublication: (source: Track.Source) => this.pubs.get(source),
      setMicrophoneEnabled: vi.fn(async (on: boolean) => {
        if (!on) return;
        if (this.micFailures > 0) {
          this.micFailures--;
          throw new Error('mikrofon meşgul');
        }
        if (!this.pubs.has(Track.Source.Microphone)) this.pubs.set(Track.Source.Microphone, { track: {} });
      }),
      setScreenShareEnabled: vi.fn(async () => undefined),
    };
    constructor() {
      h.rooms.push(this);
    }
    on(event: string, fn: (...args: never[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: never[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    connect = vi.fn(async () => {
      h.onConnect?.(this as never);
      if (h.failConnect === 'throw') throw new Error('could not establish pc connection');
      if (h.failConnect === 'hang') await new Promise(() => undefined);
      if (h.failConnect === 'close') {
        this.state = 'disconnected';
        this.emit(actual.RoomEvent.Disconnected, actual.DisconnectReason.JOIN_FAILURE as never);
      }
    });
    disconnect = vi.fn(async () => undefined);
    removeAllListeners = vi.fn();
  }
  return { ...actual, Room: FakeRoom, setLogExtension: vi.fn() };
});

vi.mock('@livekit/react-native', () => ({
  AndroidAudioTypePresets: { communication: {} },
  AudioSession: {
    configureAudio: vi.fn(async () => undefined),
    startAudioSession: vi.fn(async () => undefined),
    stopAudioSession: vi.fn(async () => {
      h.order.push('stopAudioSession');
    }),
    selectAudioOutput: vi.fn(async () => undefined),
    getAudioOutputs: vi.fn(async () => []),
  },
}));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn() },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  PermissionsAndroid: {
    PERMISSIONS: {
      RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
    },
    RESULTS: { GRANTED: 'granted' },
    requestMultiple: h.requestMultiple,
    check: h.check,
  },
  PixelRatio: { get: () => 3 },
  Platform: {
    get OS() {
      return h.platform;
    },
    Version: 34,
  },
}));

vi.mock('@diskort/client-core', async (original) => ({
  ...(await original<typeof import('@diskort/client-core')>()),
  api: { joinVoice: vi.fn(async () => ({ url: 'wss://ses.test', token: 'jeton' })) },
  gateway: { on: vi.fn(), send: h.send, setWatching: h.setWatching, resume: h.resume },
  reportClientError: h.reportClientError,
  reportVoiceLog: vi.fn(),
  voiceTelemetry: { noteReconnect: vi.fn() },
  voiceTrace: { mark: vi.fn() },
}));

vi.mock('../modules/voice-service', () => ({ VoiceService: h.voiceService }));
vi.mock('../modules/screen-broadcast', () => ({
  get ScreenBroadcast() {
    return h.broadcast;
  },
}));
vi.mock('../src/haptics', () => ({
  soundCue: (name: string) => {
    h.order.push(`sound:${name}`);
    h.soundCue(name);
  },
}));
vi.mock('../src/sounds', () => ({
  INTRO_AFTER_CUE_MS: 0,
  introSoundsEnabled: () => false,
  playIntroSound: vi.fn(),
  playSoundboardSound: vi.fn(),
  stopIntroSound: vi.fn(),
  stopSoundboardSounds: vi.fn(),
}));
vi.mock('../src/stores/settings', () => ({
  getSettings: () => h.settings,
  useSettings: { subscribe: vi.fn() },
}));
vi.mock('../src/stores/ui', () => ({ toast: h.toast }));
vi.mock('../src/voice/noiseFilter', () => ({
  noteVideoActivity: vi.fn(),
  onNoiseFilterBypass: vi.fn(),
  onNoiseFilterRecover: vi.fn(),
  prepareNoiseFilter: vi.fn(async () => undefined),
  releaseNoiseFilter: vi.fn(async () => undefined),
  suspendNoiseFilterRetry: vi.fn(),
  webrtcNoiseSuppression: () => true,
}));

interface FakePub {
  source: Track.Source;
  kind?: Track.Kind;
  setSubscribed: ReturnType<typeof vi.fn>;
}
interface FakeParticipant {
  identity: string;
  isLocal: false;
  pubs: Map<Track.Source, FakePub>;
  trackPublications: Map<Track.Source, FakePub>;
  getTrackPublication(source: Track.Source): FakePub | undefined;
  setVolume: ReturnType<typeof vi.fn>;
}
interface FakeRoom {
  remoteParticipants: Map<string, FakeParticipant>;
  pubs: Map<Track.Source, { track: object; audioTrack?: object; videoTrack?: { sender: unknown } }>;
  micFailures: number;
  state: string;
  localParticipant: {
    permissions: unknown;
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
  };
  emit(event: string, ...args: unknown[]): void;
}

const SCREEN = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];

const participant = (identity: string, sources: Track.Source[] = []): FakeParticipant => {
  const pubs = new Map(sources.map((source) => [source, { source, setSubscribed: vi.fn() }]));
  return { identity, isLocal: false, pubs, trackPublications: pubs, getTrackPublication: (s) => pubs.get(s), setVolume: vi.fn() };
};

/** Room.handleRestarting: herkes sökülür, Reconnecting aynı akışın sonunda gelir */
function unwind(room: FakeRoom, again = false): void {
  for (const p of room.remoteParticipants.values()) {
    room.remoteParticipants.delete(p.identity);
    for (const [source, pub] of p.pubs) {
      p.pubs.delete(source);
      room.emit(RoomEvent.TrackUnpublished, pub, p);
    }
    room.emit(RoomEvent.ParticipantDisconnected, p);
  }
  if (!again) room.emit(RoomEvent.Reconnecting);
}

/** handleSignalRestarted: Reconnected, ardından ertelenen ParticipantConnected ve TrackPublished olayları */
function restored(room: FakeRoom, participants: FakeParticipant[] = []): void {
  for (const p of participants) room.remoteParticipants.set(p.identity, p);
  room.emit(RoomEvent.Reconnected);
  for (const p of participants) {
    room.emit(RoomEvent.ParticipantConnected, p);
    for (const pub of p.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, p);
  }
}

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);
/** Yeniden yayının sonucuna bakılana kadar (REPUBLISH_SETTLE_MS) */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(2000).then(() => undefined);

let voice: typeof import('../src/voice/voice').voice;
let useVoice: typeof import('../src/voice/voice').useVoice;
let room: FakeRoom;

async function join(): Promise<void> {
  const joined = voice.join('kanal', { silent: true });
  await flush();
  await joined;
  room = h.rooms.at(-1) as FakeRoom;
  await vi.advanceTimersByTimeAsync(2000);
}

/** Kanala katılır, sesi oturtur (bağlanma sessizliği biter) ve odadaki yayıncıyı izlemeye alır */
async function joinAndWatch(id = 'yayinci'): Promise<FakeParticipant> {
  await join();
  const p = participant(id, SCREEN);
  room.remoteParticipants.set(id, p);
  for (const pub of p.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, p);
  await vi.advanceTimersByTimeAsync(2000);
  h.soundCue.mockClear();
  voice.watch(id);
  h.setWatching.mockClear();
  return p;
}

async function load(platform: 'android' | 'ios'): Promise<void> {
  h.platform = platform;
  h.broadcast = platform === 'ios' ? { addListener: vi.fn(), stop: vi.fn(), isActive: vi.fn(async () => true) } : null;
  ({ voice, useVoice } = await import('../src/voice/voice'));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  h.rooms.length = 0;
  h.order.length = 0;
  h.failConnect = null;
  h.onConnect = null;
  h.settings = { selfMute: false, selfDeaf: false, speaker: false, voiceActivity: false, vadAuto: true, vadThresholdDb: -50 };
  h.settings.set = (patch: Record<string, unknown>) => Object.assign(h.settings, patch);
  h.settings.userVolumes = {};
  h.settings.streamVolumes = {};
  h.settings.streamMuted = {};
  for (const fn of [h.soundCue, h.toast, h.setWatching, h.send, h.resume, h.reportClientError, h.requestMultiple, h.check]) fn.mockClear();
  for (const fn of [h.voiceService.start, h.voiceService.update, h.voiceService.stop]) fn.mockClear();
  await load('android');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sinyal kopması', () => {
  it('süre dolunca durum yeniden bağlanıyor olur, ses çalmaz; dönünce bağlı', async () => {
    await joinAndWatch();
    room.emit(RoomEvent.SignalReconnecting);
    await vi.advanceTimersByTimeAsync(2499);
    expect(useVoice.getState().status).toBe('connected');
    await vi.advanceTimersByTimeAsync(1);
    expect(useVoice.getState().status).toBe('reconnecting');
    room.emit(RoomEvent.Reconnected);
    expect(useVoice.getState().status).toBe('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().status).toBe('connected');
    expect(h.soundCue).not.toHaveBeenCalled();
  });

  it('süre dolmadan dönerse durum hiç değişmez', async () => {
    await joinAndWatch();
    const statuses: string[] = [];
    useVoice.subscribe((s) => statuses.push(s.status));
    room.emit(RoomEvent.SignalReconnecting);
    await vi.advanceTimersByTimeAsync(1000);
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses).not.toContain('reconnecting');
  });

  it('tam yeniden bağlanmaya dönerse "koptu" sesi bir kez çalar', async () => {
    await joinAndWatch();
    room.emit(RoomEvent.SignalReconnecting);
    await vi.advanceTimersByTimeAsync(1000);
    unwind(room);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.soundCue.mock.calls.map((c) => c[0])).toEqual(['disconnect']);
  });

  it('bağlantı kapanınca zamanlayıcı durumu ezmez', async () => {
    await joinAndWatch();
    room.emit(RoomEvent.SignalReconnecting);
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().status).toBe('idle');
  });

  it('kilit ekranındaki bildirim kopmayı gösterir, dönünce eski hâline gelir', async () => {
    await joinAndWatch();
    h.voiceService.update.mockClear();
    room.emit(RoomEvent.SignalReconnecting);
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.voiceService.update).toHaveBeenLastCalledWith(expect.anything(), 'Yeniden bağlanıyor…', false);
    room.emit(RoomEvent.Reconnected);
    expect(h.voiceService.update).toHaveBeenLastCalledWith(expect.anything(), 'Sesli sohbete bağlı', false);
  });
});

describe('tam yeniden bağlanmada mikrofon', () => {
  it('LiveKit mikrofonu geri yayınlayamadıysa yeniden açılır', async () => {
    await joinAndWatch();
    room.localParticipant.setMicrophoneEnabled.mockClear();
    room.pubs.delete(Track.Source.Microphone);
    unwind(room);
    restored(room);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(room.pubs.has(Track.Source.Microphone)).toBe(true);
  });

  it('mikrofon yayındaysa dokunulmaz (kısa kopma, başarılı yeniden yayın)', async () => {
    await joinAndWatch();
    room.localParticipant.setMicrophoneEnabled.mockClear();
    room.emit(RoomEvent.Reconnected);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('Reconnected yeniden yayın bitmeden gelirse ikinci mikrofon açılmaz', async () => {
    await joinAndWatch();
    room.localParticipant.setMicrophoneEnabled.mockClear();
    const mic = room.pubs.get(Track.Source.Microphone);
    room.pubs.delete(Track.Source.Microphone);
    unwind(room);
    restored(room);
    await vi.advanceTimersByTimeAsync(1000);
    room.pubs.set(Track.Source.Microphone, mic as { track: object });
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('bu arada yine koparsa bakılmaz, dönünce yeniden bakılır', async () => {
    await joinAndWatch();
    room.localParticipant.setMicrophoneEnabled.mockClear();
    room.pubs.delete(Track.Source.Microphone);
    unwind(room);
    restored(room);
    await vi.advanceTimersByTimeAsync(1000);
    room.emit(RoomEvent.Reconnecting);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    restored(room);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
  });

  it('kullanıcı susturmuşsa açılmaz', async () => {
    await joinAndWatch();
    h.settings.selfMute = true;
    room.localParticipant.setMicrophoneEnabled.mockClear();
    room.pubs.delete(Track.Source.Microphone);
    unwind(room);
    restored(room);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('konuşma izni yoksa açılmaz', async () => {
    await joinAndWatch();
    useVoice.setState({ micAllowed: false });
    room.localParticipant.setMicrophoneEnabled.mockClear();
    room.pubs.delete(Track.Source.Microphone);
    unwind(room);
    restored(room);
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('açılamazsa bir kez daha denenir', async () => {
    await joinAndWatch();
    room.pubs.delete(Track.Source.Microphone);
    room.micFailures = 1;
    unwind(room);
    restored(room);
    await settle();
    expect(room.pubs.has(Track.Source.Microphone)).toBe(false);
    await settle();
    expect(room.pubs.has(Track.Source.Microphone)).toBe(true);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('ikinci deneme de başarısızsa kullanıcıya söylenir', async () => {
    await joinAndWatch();
    room.pubs.delete(Track.Source.Microphone);
    room.micFailures = 2;
    unwind(room);
    restored(room);
    await settle();
    await settle();
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/Mikrofon/), 'error');
    expect(h.reportClientError).toHaveBeenCalledTimes(1);
  });

  it('yeniden deneme beklerken sesten çıkılırsa mikrofon açılmaz', async () => {
    await joinAndWatch();
    room.pubs.delete(Track.Source.Microphone);
    room.micFailures = 1;
    unwind(room);
    restored(room);
    await settle();
    await voice.leave();
    room.localParticipant.setMicrophoneEnabled.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
});

describe('tam yeniden bağlanmada izlenen yayın', () => {
  it('izleme sürer, yayın geri gelince yeniden abone olunur, ses çalmaz', async () => {
    const p = await joinAndWatch();
    unwind(room);
    await flush();
    expect(useVoice.getState()).toMatchObject({ status: 'reconnecting', watching: 'yayinci', streamEnded: null });
    expect(useVoice.getState().streams.yayinci).toBe(true);

    const back = participant(p.identity, SCREEN);
    restored(room, [back]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(back.pubs.get(Track.Source.ScreenShare)?.setSubscribed).toHaveBeenCalledWith(true);
    expect(back.pubs.get(Track.Source.ScreenShareAudio)?.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoice.getState()).toMatchObject({ status: 'connected', watching: 'yayinci', streamEnded: null });
    expect(useVoice.getState().streams.yayinci).toBe(true);
    expect(h.soundCue).not.toHaveBeenCalled();
    expect(h.setWatching).not.toHaveBeenCalled();
  });

  it('yayıncı bu arada yayını bitirdiyse süre sonunda "sona erdi" görünür', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room, [participant('yayinci')]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(useVoice.getState().watching).toBe('yayinci');
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: 'yayinci', streams: {} });
    expect(h.setWatching).toHaveBeenCalledWith([]);
  });

  it('süre içinde geç gelen yayın izlenmeye devam eder', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room);
    await vi.advanceTimersByTimeAsync(3000);
    const late = participant('yayinci', SCREEN);
    room.remoteParticipants.set('yayinci', late);
    for (const pub of late.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, late);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(late.pubs.get(Track.Source.ScreenShare)?.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoice.getState().watching).toBe('yayinci');
  });

  it('ikinci kopma süreyi durdurur, ikinci denemedeki söküm de ses çıkarmaz', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room);
    await vi.advanceTimersByTimeAsync(1000);
    room.emit(RoomEvent.Reconnecting);
    await vi.advanceTimersByTimeAsync(2000);
    room.remoteParticipants.set('diger', participant('diger', SCREEN));
    unwind(room, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState().watching).toBe('yayinci');
    expect(h.soundCue.mock.calls.map((c) => c[0])).toEqual(['disconnect']);
  });

  it('bekleme sırasında izlemeyi bırakınca yayın kaydı da silinir', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room);
    voice.watch(null);
    expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: null, streams: {} });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: null, streams: {} });
  });

  it('bekleme sırasında başka yayına geçilince o yayının bitişi gecikmez', async () => {
    await joinAndWatch();
    const other = participant('diger', SCREEN);
    unwind(room);
    restored(room, [other]);
    await flush();
    voice.watch('diger');
    await flush();
    const pub = other.pubs.get(Track.Source.ScreenShare);
    other.pubs.clear();
    room.emit(RoomEvent.TrackUnpublished, pub, other);
    await flush();
    expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: 'diger' });
  });

  it('yeniden bağlanamazsa durum temizlenir ve geç zamanlayıcı bir şey yapmaz', async () => {
    await joinAndWatch();
    unwind(room);
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', watching: null, streamEnded: null, streams: {} });
  });

  it('bağlantı yerindeyken yayın biterse izleme hemen biter ve ses çalar', async () => {
    const p = await joinAndWatch();
    const pub = p.pubs.get(Track.Source.ScreenShare);
    p.pubs.clear();
    room.emit(RoomEvent.TrackUnpublished, pub, p);
    await flush();
    expect(useVoice.getState()).toMatchObject({ status: 'connected', watching: null, streamEnded: 'yayinci', streams: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.soundCue).toHaveBeenCalledWith('userStreamStop');
  });

  it('izlenen yayıncı gerçekten çıkınca izleme hemen biter ve ses çalar', async () => {
    const p = await joinAndWatch();
    room.remoteParticipants.delete(p.identity);
    p.pubs.clear();
    room.emit(RoomEvent.ParticipantDisconnected, p);
    await flush();
    expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: 'yayinci', streams: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.soundCue).toHaveBeenCalledWith('userLeave');
  });

  it('izlenmeyen yayıncı yeniden bağlanırken sökülünce kayıt silinir, ses çalmaz', async () => {
    await join();
    const p = participant('baska', SCREEN);
    room.remoteParticipants.set('baska', p);
    for (const pub of p.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, p);
    await vi.advanceTimersByTimeAsync(2000);
    h.soundCue.mockClear();
    unwind(room);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVoice.getState().streams).toEqual({});
    expect(h.soundCue).not.toHaveBeenCalled();
  });
});

describe('tam yeniden bağlanmada ekran paylaşımı', () => {
  const sender = (): { getParameters: ReturnType<typeof vi.fn>; setParameters: ReturnType<typeof vi.fn> } => ({
    getParameters: vi.fn(() => ({ encodings: [{}] })),
    setParameters: vi.fn(async () => undefined),
  });
  const share = (s: unknown): void => {
    room.pubs.set(Track.Source.ScreenShare, { track: {}, videoTrack: { sender: s } });
    useVoice.setState({ sharing: true });
  };
  const localUnpublish = (): void => {
    room.pubs.delete(Track.Source.ScreenShare);
    room.emit(RoomEvent.LocalTrackUnpublished, { source: Track.Source.ScreenShare }, {});
  };

  it('Android: yayın sürer ve yeni gönderici yeniden küçültülür', async () => {
    await join();
    share(sender());
    unwind(room);
    localUnpublish();
    expect(useVoice.getState().sharing).toBe(true);
    const fresh = sender();
    room.pubs.set(Track.Source.ScreenShare, { track: {}, videoTrack: { sender: fresh } });
    restored(room);
    await settle();
    expect(useVoice.getState().sharing).toBe(true);
    expect(fresh.setParameters).toHaveBeenCalledTimes(1);
  });

  it('Android: yeniden yayımlanamadıysa paylaşım kapalı görünür', async () => {
    await join();
    share(sender());
    unwind(room);
    localUnpublish();
    restored(room);
    await settle();
    expect(useVoice.getState().sharing).toBe(false);
  });

  it('iOS: Reconnected yeniden yayın bitmeden gelirse yayın durdurulmaz', async () => {
    vi.resetModules();
    await load('ios');
    await join();
    share(sender());
    unwind(room);
    localUnpublish();
    restored(room);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVoice.getState().sharing).toBe(true);
    room.pubs.set(Track.Source.ScreenShare, { track: {}, videoTrack: { sender: sender() } });
    await settle();
    expect(useVoice.getState().sharing).toBe(true);
    expect(h.broadcast?.stop).not.toHaveBeenCalled();
  });

  it('iOS: yeniden yayımlanamadıysa yayın eklentisi de durur', async () => {
    vi.resetModules();
    await load('ios');
    await join();
    share(sender());
    unwind(room);
    localUnpublish();
    restored(room);
    await settle();
    expect(useVoice.getState().sharing).toBe(false);
    expect(h.broadcast?.stop).toHaveBeenCalledTimes(1);
  });

  it('iOS: yayın sürüyorsa eklentiye dokunulmaz, görüntü eklentide küçültüldüğü için göndericiye de', async () => {
    vi.resetModules();
    await load('ios');
    await join();
    const s = sender();
    share(s);
    unwind(room);
    restored(room);
    await settle();
    expect(useVoice.getState().sharing).toBe(true);
    expect(h.broadcast?.stop).not.toHaveBeenCalled();
    expect(s.setParameters).not.toHaveBeenCalled();
  });

  it('bağlantı yerindeyken paylaşım durursa hemen kapalı görünür', async () => {
    await join();
    share(sender());
    localUnpublish();
    expect(useVoice.getState().sharing).toBe(false);
  });
});

describe('süren sesten yeniden katılma', () => {
  const duplicate = (): void => {
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);
  };

  it('izin penceresi açılmaz: arka planda istek hiç dönmez, yalnızca bakılır', async () => {
    await join();
    expect(h.requestMultiple).toHaveBeenCalledTimes(1);
    room.emit(RoomEvent.Reconnecting);
    duplicate();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.requestMultiple).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().status).toBe('connected');
    expect(h.rooms).toHaveLength(2);
  });

  it('mikrofon izni geri alınmışsa yalnızca dinlenir', async () => {
    await join();
    h.check.mockResolvedValueOnce(false);
    room.emit(RoomEvent.Reconnecting);
    duplicate();
    await vi.advanceTimersByTimeAsync(100);
    expect(useVoice.getState()).toMatchObject({ status: 'connected', listenOnly: true });
  });

  it('eski odanın geç olayı yeni bağlantının durumunu bozmaz', async () => {
    await join();
    const old = room;
    room.emit(RoomEvent.Reconnecting);
    duplicate();
    await vi.advanceTimersByTimeAsync(100);
    old.emit(RoomEvent.Reconnecting);
    expect(useVoice.getState().status).toBe('connected');
  });
});

describe('sesten çıkış', () => {
  it('mikrofon açılırken çıkılırsa kapanmayan bildirim kalmaz', async () => {
    await join();
    h.settings.selfMute = true;
    let release = (): void => undefined;
    room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    voice.toggleMute();
    await flush();
    await voice.leave();
    h.voiceService.update.mockClear();
    release();
    await flush();
    expect(h.voiceService.update).not.toHaveBeenCalled();
  });

  it('bağlantı kopunca "koptu" sesi ses oturumu kapandıktan sonra çalar', async () => {
    await join();
    h.order.length = 0;
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await flush();
    expect(h.order).toEqual(['stopAudioSession', 'sound:disconnect']);
  });
});

describe('uzun kopuştan sonra kanala dönüş', () => {
  const MINUTE = 60_000;
  const lose = (reason?: DisconnectReason): void => {
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, reason);
  };
  /** Uyku: saat ilerler, zamanlayıcılar çalışmaz */
  const sleep = (ms: number): void => void vi.setSystemTime(Date.now() + ms);
  const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(50);
  const sounds = (): string[] => h.soundCue.mock.calls.map((c) => c[0] as string);
  const latest = (): FakeRoom => h.rooms.at(-1) as FakeRoom;

  let core: typeof import('@diskort/client-core');

  /** Bir kez hata, bir kez "koptu" sesi; servis ve ses oturumu kapalı, sonrasında bildirim yazılmaz */
  const expectGaveUp = (): void => {
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
    expect(h.toast.mock.calls).toEqual([['Ses bağlantısı koptu.', 'error']]);
    expect(sounds()).toEqual(['disconnect']);
    expect(h.voiceService.stop).toHaveBeenCalled();
    expect(h.order.indexOf('stopAudioSession')).toBeGreaterThanOrEqual(0);
    expect(h.order.at(-1)).toBe('sound:disconnect');
  };

  beforeEach(async () => {
    core = await import('@diskort/client-core');
    core.useGuild.setState({ status: 'ready', dms: {}, dmCalls: {}, voiceStates: {}, channelGuild: { kanal: 'sunucu', diger: 'sunucu' } });
    await join();
    h.order.length = 0;
    h.soundCue.mockClear();
    h.voiceService.update.mockClear();
    h.voiceService.stop.mockClear();
    h.voiceService.start.mockClear();
    vi.mocked(core.api.joinVoice).mockClear();
  });

  it.each([
    ['nedensiz (LiveKit vazgeçti)', undefined],
    ['UNKNOWN_REASON', DisconnectReason.UNKNOWN_REASON],
    ['STATE_MISMATCH', DisconnectReason.STATE_MISMATCH],
    ['JOIN_FAILURE', DisconnectReason.JOIN_FAILURE],
    ['SIGNAL_CLOSE', DisconnectReason.SIGNAL_CLOSE],
  ])('%s: yeni jetonla bir kez sessizce döner', async (_name, reason) => {
    lose(reason);
    await settle();
    expect(h.rooms).toHaveLength(2);
    expect(core.api.joinVoice).toHaveBeenCalledTimes(1);
    expect(useVoice.getState()).toMatchObject({ channelId: 'kanal', status: 'connected' });
    expect(sounds()).toEqual([]);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it.each([
    ['CLIENT_INITIATED', DisconnectReason.CLIENT_INITIATED],
    ['DUPLICATE_IDENTITY', DisconnectReason.DUPLICATE_IDENTITY],
    ['PARTICIPANT_REMOVED', DisconnectReason.PARTICIPANT_REMOVED],
    ['ROOM_DELETED', DisconnectReason.ROOM_DELETED],
    ['ROOM_CLOSED', DisconnectReason.ROOM_CLOSED],
    ['SERVER_SHUTDOWN', DisconnectReason.SERVER_SHUTDOWN],
    ['USER_UNAVAILABLE', DisconnectReason.USER_UNAVAILABLE],
  ])('%s: dönülmez', async (_name, reason) => {
    lose(reason);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.rooms).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
    expect(h.voiceService.stop).toHaveBeenCalled();
  });

  it.each([
    ['listede açık', { dms: { kanal: {} } }],
    ['listeden kapatılmış, arama sürüyor', { dmCalls: { kanal: {} } }],
    ['listeden kapatılmış, arama da silinmiş', {}],
  ])('DM aramasına dönülmez: %s', async (_name, state) => {
    core.useGuild.setState({ channelGuild: {}, ...state } as never);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(1);
    expect(core.api.joinVoice).not.toHaveBeenCalled();
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
  });

  describe('başka cihazdan girilmişse', () => {
    const stateIn = (channelId: string): never => ({ ben: { userId: 'ben', channelId } }) as never;

    // setState kalıcı depolamaya yazar, o da configureClient ister
    beforeEach(() => void vi.spyOn(core.useSession, 'getState').mockReturnValue({ user: { id: 'ben' } } as never));

    it('başka kanaldaysa dönülmez, o oturum düşürülmez', async () => {
      core.useGuild.setState({ status: 'reconnecting' });
      lose();
      await settle();
      core.useGuild.setState({ status: 'ready', voiceStates: stateIn('diger') });
      await settle();
      expect(h.rooms).toHaveLength(1);
      expect(core.api.joinVoice).not.toHaveBeenCalled();
      expectGaveUp();
    });

    it('kayıt aynı kanalı gösteriyorsa (eski olabilir) dönülür', async () => {
      core.useGuild.setState({ voiceStates: stateIn('kanal') });
      lose();
      await settle();
      expect(h.rooms).toHaveLength(2);
      expect(useVoice.getState()).toMatchObject({ channelId: 'kanal', status: 'connected' });
    });
  });

  it('uykuda süre aşıldıysa dönülmez', async () => {
    sleep(31 * MINUTE);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(1);
    expectGaveUp();
  });

  it('uyanışta zamanlayıcı kopmadan önce çalışsa da süre aşımı görülür', async () => {
    sleep(8 * 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(11_000); // durum hâlâ "bağlı": LiveKit kopmayı henüz fark etmedi
    room.emit(RoomEvent.Reconnecting);
    await vi.advanceTimersByTimeAsync(40_000);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
  });

  it('süreden kısa uykuda döner', async () => {
    sleep(29 * MINUTE);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(2);
  });

  it('uzun süredir bağlıysa süre işlemez', async () => {
    await vi.advanceTimersByTimeAsync(31 * MINUTE);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(2);
  });

  it('oda uykudan sağ çıktıysa sonraki kopmada döner', async () => {
    sleep(31 * MINUTE);
    await vi.advanceTimersByTimeAsync(11_000);
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(10_000);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(2);
  });

  it('süreler arka planda da dolan zamanlayıcılarla kurulur (Android JS zamanlayıcıları durur)', async () => {
    const { CriticalTimers } = await import('livekit-client');
    const timeout = vi.spyOn(CriticalTimers, 'setTimeout');
    const interval = vi.spyOn(CriticalTimers, 'setInterval');
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    expect(timeout.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true);
    expect(interval).toHaveBeenCalled();
    core.useGuild.setState({ status: 'ready' });
    await settle();
    expect(timeout.mock.calls.some(([, ms]) => ms === 45_000)).toBe(true);
    expect(interval.mock.calls.length).toBeGreaterThan(1); // yeni odanın canlılık damgası
  });

  it('ağ geçidini bekler, beklerken hata ve ses yok; hazır olunca döner', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.rooms).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ channelId: 'kanal', status: 'reconnecting' });
    expect(sounds()).toEqual([]);
    expect(h.toast).not.toHaveBeenCalled();
    core.useGuild.setState({ status: 'ready' });
    await settle();
    expect(h.rooms).toHaveLength(2);
    expect(useVoice.getState()).toMatchObject({ channelId: 'kanal', status: 'connected' });
    expect(sounds()).toEqual([]);
  });

  it('beklerken ağ geçidi dürtülür: kendi yeniden bağlanma zamanlayıcısı arka planda durur', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    expect(h.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.resume).toHaveBeenCalledTimes(3);
    core.useGuild.setState({ status: 'ready' });
    await settle();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.resume).toHaveBeenCalledTimes(3);
  });

  it('ağ geçidi hazırsa dürtülmez', async () => {
    lose();
    await settle();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('ağ geçidi gelmezse süre sonunda vazgeçer; servis kapanır, geç gelen hazır durumu bir şey yapmaz', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(useVoice.getState().status).toBe('reconnecting');
    expect(h.voiceService.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expectGaveUp();
    h.voiceService.update.mockClear();
    core.useGuild.setState({ status: 'ready' });
    await settle();
    expect(h.rooms).toHaveLength(1);
    expect(h.voiceService.update).not.toHaveBeenCalled();
  });

  it('beklerken telefon uyursa uyanışta kanala girilmez', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    sleep(8 * 60 * MINUTE);
    core.useGuild.setState({ status: 'ready' });
    await settle();
    expect(h.rooms).toHaveLength(1);
    expectGaveUp();
  });

  it('ayrılmak bekleyen denemeyi iptal eder (bildirimdeki düğme, arayüz güncellemesi)', async () => {
    const before = vi.getTimerCount();
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    expect(useVoice.getState().status).not.toBe('idle');
    await voice.leave();
    expect(vi.getTimerCount()).toBeLessThan(before); // bekleme ve canlılık damgası söküldü
    core.useGuild.setState({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.rooms).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
    expect(h.voiceService.stop).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled();
    expect(sounds()).toEqual([]);
  });

  it('beklerken başka kanala girilirse eski kanala dönülmez', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    void voice.join('diger', { silent: true });
    await settle();
    core.useGuild.setState({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.rooms).toHaveLength(2);
    expect(useVoice.getState()).toMatchObject({ channelId: 'diger', status: 'connected' });
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('beklerken yetkili başka kanala taşırsa eski kanala dönülmez', async () => {
    core.useGuild.setState({ status: 'reconnecting' });
    lose();
    await settle();
    const onGateway = vi.mocked(core.gateway.on).mock.calls.at(-1)![0];
    onGateway({ t: 'VOICE_MOVE', d: { channelId: 'diger' } } as never);
    await settle();
    core.useGuild.setState({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.rooms).toHaveLength(2);
    expect(useVoice.getState()).toMatchObject({ channelId: 'diger', status: 'connected' });
    expect(h.voiceService.stop).not.toHaveBeenCalled();
  });

  it('ön plan servisi ve ses oturumu kapatılmadan döner, durum hiç boşa düşmez', async () => {
    const statuses: string[] = [];
    const stop = useVoice.subscribe((s) => void statuses.push(s.status));
    lose();
    await settle();
    stop();
    expect(h.voiceService.stop).not.toHaveBeenCalled();
    expect(h.voiceService.start).not.toHaveBeenCalled();
    expect(h.order).not.toContain('stopAudioSession');
    expect(statuses).not.toContain('idle'); // setBeforeReload boştaki durumda sesten çıkmaz
    expect(h.voiceService.update.mock.calls.at(-1)?.[1]).toBe('Sesli sohbete bağlı');
  });

  it('dönüş sürerken bildirim "bağlı" demez', async () => {
    let release = (): void => undefined;
    vi.mocked(core.api.joinVoice).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ url: 'wss://ses.test', token: 'jeton' } as never))),
    );
    lose();
    await settle();
    expect(useVoice.getState().status).toBe('connecting');
    for (const call of h.voiceService.update.mock.calls) expect(call[1]).toBe('Yeniden bağlanıyor…');
    expect(h.voiceService.update).toHaveBeenCalled();
    release();
    await settle();
    expect(h.voiceService.update.mock.calls.at(-1)?.[1]).toBe('Sesli sohbete bağlı');
  });

  it.each(['throw', 'close'] as const)('dönüş başarısızsa hata bir kez gösterilir, servis kapanır (%s)', async (how) => {
    h.failConnect = how;
    lose();
    await settle();
    expect(h.rooms).toHaveLength(2);
    expectGaveUp();
    h.voiceService.update.mockClear();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.voiceService.update).not.toHaveBeenCalled();
  });

  it('takılan bağlanma süre sonunda bırakılır: bildirim ve servis sızmaz', async () => {
    h.failConnect = 'hang';
    lose();
    await settle();
    expect(useVoice.getState().status).toBe('connecting');
    expect(h.voiceService.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expectGaveUp();
  });

  it('dönüş bitince süre dolsa da bağlı oda düşürülmez', async () => {
    lose();
    await settle();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(useVoice.getState().status).toBe('connected');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('dönülen oda hemen ölürse ikinci deneme yapılmaz', async () => {
    lose();
    await settle();
    room = latest();
    await vi.advanceTimersByTimeAsync(MINUTE);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(2);
    expectGaveUp();
  });

  it('dönüş uzun sürdüyse sonraki kopma yeniden denenir', async () => {
    lose();
    await settle();
    room = latest();
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    lose();
    await settle();
    expect(h.rooms).toHaveLength(3);
  });

  it('hiç bağlanmamış odanın kapanması dönüş açmaz', async () => {
    await voice.leave();
    h.order.length = 0;
    h.failConnect = 'close';
    await voice.join('kanal', { silent: true });
    await settle();
    expect(h.rooms).toHaveLength(2);
    expectGaveUp();
  });

  it('"koptu" sesi çaldıysa dönünce "geri geldi" çalar', async () => {
    room.emit(RoomEvent.Reconnecting);
    await vi.advanceTimersByTimeAsync(2500);
    lose();
    await settle();
    expect(sounds()).toEqual(['disconnect', 'reconnected']);
  });

  it('dönüşte izin penceresi açılmaz, yalnızca bakılır', async () => {
    h.requestMultiple.mockClear();
    lose();
    await settle();
    expect(h.requestMultiple).not.toHaveBeenCalled();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('susturma ve sağırlık korunur', async () => {
    h.settings.selfMute = true;
    h.settings.selfDeaf = true;
    const p = participant('biri', [Track.Source.Microphone]);
    h.onConnect = (r: FakeRoom) => void r.remoteParticipants.set('biri', p);
    lose();
    await settle();
    expect(latest().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(p.pubs.get(Track.Source.Microphone)?.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.send).toHaveBeenLastCalledWith({ t: 'VOICE_STATE_SET', d: { selfMute: true, selfDeaf: true } });
  });

  it('mikrofon açıksa açık döner', async () => {
    lose();
    await settle();
    expect(latest()).not.toBe(room);
    expect(latest().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());
  });

  describe('izlenen yayın', () => {
    const watchStreamer = (): FakeParticipant => {
      const p = participant('yayinci', SCREEN);
      room.remoteParticipants.set('yayinci', p);
      for (const pub of p.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, p);
      voice.watch('yayinci');
      return p;
    };

    it('yayın sürüyorsa dönüşte yeniden abone olunur', async () => {
      watchStreamer();
      unwind(room);
      const again = participant('yayinci', SCREEN);
      h.onConnect = (r: FakeRoom) => void r.remoteParticipants.set('yayinci', again);
      lose();
      await settle();
      expect(useVoice.getState()).toMatchObject({ watching: 'yayinci', streamEnded: null, streams: { yayinci: true } });
      expect(again.pubs.get(Track.Source.ScreenShare)?.setSubscribed).toHaveBeenCalledWith(true);
      expect(h.setWatching).toHaveBeenLastCalledWith(['yayinci']);
    });

    it('yayın bu arada bittiyse "sona erdi" görünür', async () => {
      watchStreamer();
      unwind(room);
      lose();
      await settle();
      expect(useVoice.getState()).toMatchObject({ watching: null, streamEnded: 'yayinci', status: 'connected' });
    });
  });

  describe('ekran paylaşımı', () => {
    const share = (): void => {
      room.pubs.set(Track.Source.ScreenShare, { track: {} });
      useVoice.setState({ sharing: true });
    };

    it('Android: dönüşte kendiliğinden geri gelmez', async () => {
      share();
      lose();
      await settle();
      expect(useVoice.getState()).toMatchObject({ status: 'connected', sharing: false });
      expect((latest().localParticipant as unknown as { setScreenShareEnabled: ReturnType<typeof vi.fn> }).setScreenShareEnabled).not.toHaveBeenCalled();
    });

    it('iOS: yayın eklentisi de durur, görüntüsüz yayın kalmaz', async () => {
      h.broadcast = { addListener: vi.fn(), stop: vi.fn(), isActive: vi.fn(async () => true) };
      share();
      lose();
      await settle();
      expect(h.broadcast.stop).toHaveBeenCalledTimes(1);
      expect(useVoice.getState().sharing).toBe(false);
    });

    it('iOS: LiveKit sökümü durumu önce sıfırlasa da yayın eklentisi durur', async () => {
      h.broadcast = { addListener: vi.fn(), stop: vi.fn(), isActive: vi.fn(async () => true) };
      share();
      useVoice.setState({ sharing: false }); // LocalTrackUnpublished, Disconnected'dan önce
      lose();
      await settle();
      expect(h.broadcast.stop).toHaveBeenCalledTimes(1);
    });
  });

  it('başarısız dönüş soğuma bırakmaz: elle girişin sonraki kopuşu yine döner', async () => {
    h.failConnect = 'throw';
    lose();
    await settle();
    expect(useVoice.getState()).toMatchObject({ channelId: null, status: 'idle' });
    h.failConnect = null;
    await join();
    lose();
    await settle();
    expect(useVoice.getState()).toMatchObject({ channelId: 'kanal', status: 'connected' });
  });
});

describe('sağırken konuşma halkaları', () => {
  const speaker = (identity: string, isLocal = false): never => ({ identity, isLocal }) as never;

  it('başkalarının halkası söner, kendi halkan ve sağırlık kalkınca diğerleri geri gelir', async () => {
    await join();
    room.emit(RoomEvent.ActiveSpeakersChanged, [speaker('konusan'), speaker('ben', true)]);
    expect(useVoice.getState().speaking).toEqual({ konusan: true, ben: true });
    await voice.toggleDeafen();
    expect(useVoice.getState().speaking).toEqual({ ben: true });
    room.emit(RoomEvent.ActiveSpeakersChanged, [speaker('konusan')]);
    expect(useVoice.getState().speaking).toEqual({});
    await voice.toggleDeafen();
    expect(useVoice.getState().speaking).toEqual({ konusan: true });
  });

  it('yalnız mikrofon kapalıyken halkalar yanmaya devam eder', async () => {
    await join();
    room.emit(RoomEvent.ActiveSpeakersChanged, [speaker('konusan')]);
    await voice.toggleMute();
    expect(useVoice.getState().speaking).toEqual({ konusan: true });
  });
});
