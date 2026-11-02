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
  reportClientError: vi.fn(),
  order: [] as string[],
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
    connect = vi.fn(async () => undefined);
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
  gateway: { on: vi.fn(), send: h.send, setWatching: h.setWatching },
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
  h.settings = { selfMute: false, selfDeaf: false, speaker: false, voiceActivity: false, vadAuto: true, vadThresholdDb: -50 };
  h.settings.set = (patch: Record<string, unknown>) => Object.assign(h.settings, patch);
  h.settings.userVolumes = {};
  h.settings.streamVolumes = {};
  h.settings.streamMuted = {};
  for (const fn of [h.soundCue, h.toast, h.setWatching, h.send, h.reportClientError, h.requestMultiple, h.check]) fn.mockClear();
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

  it('uzun kopuşta kendiliğinden yeniden katılmaz (ürün kararı bekliyor)', async () => {
    await join();
    room.state = 'disconnected';
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', channelId: null });
    expect(h.rooms).toHaveLength(1);
    expect(h.toast).toHaveBeenCalledWith('Ses bağlantısı koptu.', 'error');
  });
});
