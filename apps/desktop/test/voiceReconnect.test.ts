import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason, RoomEvent, Track } from 'livekit-client';

/**
 * VoiceClient'ın gerçek olay işleyicileri, sahte bir LiveKit odasıyla. Olay sırası livekit-client 2.22
 * Room.handleRestarting / handleSignalRestarted ile aynı: sökme ve Reconnecting aynı akışta, sonra Reconnected,
 * hemen ardından ertelenen katılımcı/yayın olayları.
 */
const h = vi.hoisted(() => ({
  rooms: [] as unknown[],
  tracks: [] as unknown[],
  playSound: vi.fn(),
  setWatching: vi.fn(),
  failCapture: false,
}));

vi.mock('livekit-client', async (original) => {
  const actual = await original<typeof import('livekit-client')>();
  class FakeRoom {
    readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
    readonly remoteParticipants = new Map<string, unknown>();
    readonly canPlaybackAudio = true;
    pubs: { track: unknown }[] = [];
    readonly localParticipant = {
      permissions: undefined as unknown,
      getTrackPublications: () => this.pubs,
      publishTrack: vi.fn(async (track: unknown) => {
        this.pubs.push({ track });
      }),
      unpublishTrack: vi.fn(async (track: unknown) => {
        this.pubs = this.pubs.filter((p) => p.track !== track);
      }),
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
    startAudio = vi.fn(async () => undefined);
  }
  return {
    ...actual,
    Room: FakeRoom,
    createLocalAudioTrack: vi.fn(async () => {
      if (h.failCapture) throw new Error('aygıt meşgul');
      const track = {
        isMuted: false,
        setAudioContext: vi.fn(),
        setProcessor: vi.fn(async () => undefined),
        mute: vi.fn(async function (this: { isMuted: boolean }) {
          this.isMuted = true;
        }),
        unmute: vi.fn(async function (this: { isMuted: boolean }) {
          this.isMuted = false;
        }),
        stop: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      };
      h.tracks.push(track);
      return track;
    }),
  };
});

vi.mock('@diskort/client-core', async (original) => ({
  ...(await original<typeof import('@diskort/client-core')>()),
  api: { joinVoice: vi.fn(async () => ({ url: 'wss://ses.test', token: 'jeton' })) },
  gateway: { on: vi.fn(), send: vi.fn(), setWatching: h.setWatching },
  reportClientError: vi.fn(),
  reportVoiceLog: vi.fn(),
  voiceTelemetry: { setContext: vi.fn(), noteReconnect: vi.fn(), reset: vi.fn() },
  voiceTrace: { mark: vi.fn(), stop: vi.fn() },
}));

vi.mock('../src/renderer/src/lib/bridge', () => ({ bridge: {}, isMac: false }));
vi.mock('../src/renderer/src/lib/sfx', () => ({
  introSoundsEnabled: () => false,
  playIntroSound: vi.fn(),
  playSound: h.playSound,
  playSoundboardSound: vi.fn(),
  prepareSounds: vi.fn(),
  sharedAudioContext: vi.fn(),
  stopIntroSound: vi.fn(),
  stopSoundboardForDeaf: vi.fn(),
  stopSoundboardSounds: vi.fn(),
}));
vi.mock('../src/renderer/src/features/voice/micProcessor', () => ({
  firstAvailableDenoiser: vi.fn(async () => null),
  MicProcessor: class {
    denoiserFailed = false;
    activeDenoiser = null;
    stats = null;
    setSendMuted = vi.fn();
    setInputGain = vi.fn();
    updateGate = vi.fn();
    destroy = vi.fn(async () => undefined);
  },
}));
vi.mock('../src/renderer/src/features/voice/micTest', () => ({ MicTest: class {} }));
vi.mock('../src/renderer/src/features/voice/hardwareEncoder', () => ({
  prepareHardwareEncoder: vi.fn(),
  releaseHardwareEncoder: vi.fn(),
}));
vi.mock('../src/renderer/src/features/voice/remoteSpeaking', () => ({
  RemoteSpeakingMeter: class {
    add = vi.fn();
    remove = vi.fn();
    removeIdentity = vi.fn();
    clear = vi.fn();
    measures = () => false;
    isSpeaking = () => false;
  },
}));
vi.mock('../src/renderer/src/features/voice/outputSink', () => ({ resolveOutputSink: vi.fn(async () => '') }));

interface FakePub {
  source: Track.Source;
  setSubscribed: ReturnType<typeof vi.fn>;
}
interface FakeParticipant {
  identity: string;
  pubs: Map<Track.Source, FakePub>;
  getTrackPublication(source: Track.Source): FakePub | undefined;
  setVolume: ReturnType<typeof vi.fn>;
}
interface FakeRoom {
  remoteParticipants: Map<string, FakeParticipant>;
  pubs: { track: unknown }[];
  localParticipant: {
    permissions: unknown;
    publishTrack: ReturnType<typeof vi.fn>;
    unpublishTrack: ReturnType<typeof vi.fn>;
  };
  emit(event: string, ...args: unknown[]): void;
}
interface FakeTrack {
  isMuted: boolean;
  mute: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const participant = (identity: string, sources: Track.Source[] = []): FakeParticipant => {
  const pubs = new Map(sources.map((source) => [source, { source, setSubscribed: vi.fn() }]));
  return { identity, pubs, getTrackPublication: (s) => pubs.get(s), setVolume: vi.fn() };
};

/**
 * Room.handleRestarting: herkes sökülür, Reconnecting aynı akışın sonunda gelir (durum zaten Reconnecting ise
 * LiveKit olayı yeniden vermez: `again`).
 */
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

let voice: typeof import('../src/renderer/src/features/voice/voiceClient').voice;
let useVoice: typeof import('../src/renderer/src/stores/voice').useVoice;
let useSettings: typeof import('../src/renderer/src/stores/settings').useSettings;
let room: FakeRoom;

const SCREEN = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];

/** Kanala katılır, sesi oturtur (bağlanma sessizliği biter) ve odadaki yayıncıyı izlemeye alır */
async function joinAndWatch(id = 'yayinci'): Promise<FakeParticipant> {
  const p = participant(id, SCREEN);
  const joined = voice.join('kanal', { silent: true });
  await flush();
  room = h.rooms.at(-1) as FakeRoom;
  await joined;
  await flush();
  room.remoteParticipants.set(id, p);
  for (const pub of p.pubs.values()) room.emit(RoomEvent.TrackPublished, pub, p);
  await vi.advanceTimersByTimeAsync(2000);
  h.playSound.mockClear();
  voice.watchStream(id);
  h.setWatching.mockClear();
  return p;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', {
    createElement: () => ({ hidden: false, appendChild: vi.fn(), replaceChildren: vi.fn() }),
    body: { appendChild: vi.fn() },
  });
  vi.resetModules();
  h.rooms.length = 0;
  h.tracks.length = 0;
  h.failCapture = false;
  h.playSound.mockClear();
  h.setWatching.mockClear();
  ({ voice } = await import('../src/renderer/src/features/voice/voiceClient'));
  ({ useVoice } = await import('../src/renderer/src/stores/voice'));
  ({ useSettings } = await import('../src/renderer/src/stores/settings'));
  useSettings.setState({ noise: 'off', selfMute: false, selfDeaf: false });
  const internals = voice as unknown as { startStats(): void; bindDeviceChange(): void };
  internals.startStats = () => undefined;
  internals.bindDeviceChange = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tam yeniden bağlanmada mikrofon', () => {
  it('LiveKit mikrofonu geri yayınlayamadıysa yeniden kurulur', async () => {
    await joinAndWatch();
    const old = h.tracks[0];
    room.pubs = [];
    unwind(room);
    restored(room);
    await flush();
    expect(h.tracks).toHaveLength(2);
    expect(room.pubs.map((p) => p.track)).toEqual([h.tracks[1]]);
    expect(room.pubs[0]?.track).not.toBe(old);
  });

  it('mikrofon yayındaysa dokunulmaz (kısa kopma, başarılı yeniden yayın)', async () => {
    await joinAndWatch();
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(h.tracks).toHaveLength(1);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  });

  it('ertelenmiş kurulum ve düşen mikrofon tek kurulum yapar', async () => {
    await joinAndWatch();
    room.pubs = [];
    unwind(room);
    // Yeniden bağlanırken ayar değişti: kurulum ertelenir
    useSettings.setState({ audioBitrateKbps: useSettings.getState().audioBitrateKbps + 8 });
    await flush();
    restored(room);
    await flush();
    expect(h.tracks).toHaveLength(2);
    expect(room.pubs).toHaveLength(1);
  });

  it('kullanıcı susturmuşsa yeni mikrofon susturulmuş yayınlanır', async () => {
    await joinAndWatch();
    useSettings.setState({ selfMute: true });
    room.pubs = [];
    unwind(room);
    restored(room);
    await flush();
    const track = h.tracks[1] as FakeTrack;
    expect(track.mute).toHaveBeenCalled();
    expect(track.isMuted).toBe(true);
    expect(room.pubs.map((p) => p.track)).toEqual([track]);
  });

  it('konuşma izni yoksa yeniden kurulmaz', async () => {
    await joinAndWatch();
    room.localParticipant.permissions = { canPublish: false, canPublishSources: [] };
    room.pubs = [];
    unwind(room);
    restored(room);
    await flush();
    expect(h.tracks).toHaveLength(1);
    // Mikrofonu kaldırmak onPermissionsChanged'in işi: burada sökülmez
    expect((h.tracks[0] as FakeTrack).stop).not.toHaveBeenCalled();
    expect(useVoice.getState().error).toBeNull();
  });

  it('yeniden bağlanırken gelen konuşma izni bağlantı dönünce mikrofonu yayınlar', async () => {
    await joinAndWatch();
    room.localParticipant.permissions = { canPublish: false, canPublishSources: [] };
    room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, { isLocal: true });
    await flush();
    expect(room.pubs).toHaveLength(0);

    unwind(room);
    room.localParticipant.permissions = undefined;
    room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, { isLocal: true });
    await flush();
    expect(room.pubs).toHaveLength(0); // bağlantı yokken yayınlanmaz

    restored(room);
    await flush();
    expect(room.pubs).toHaveLength(1);
  });

  it('mikrofon açılamazsa bir kez daha denenir', async () => {
    await joinAndWatch();
    room.pubs = [];
    unwind(room);
    h.failCapture = true;
    restored(room);
    await flush();
    expect(useVoice.getState().error).toMatch(/Mikrofon açılamadı/);
    h.failCapture = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(useVoice.getState().error).toBeNull();
    expect(room.pubs).toHaveLength(1);
  });
});

describe('tam yeniden bağlanmada izlenen yayın', () => {
  it('izleme sürer, yayın geri gelince yeniden abone olunur, ses çalmaz', async () => {
    const p = await joinAndWatch();
    unwind(room);
    await flush();
    expect(useVoice.getState()).toMatchObject({
      status: 'reconnecting',
      watching: { yayinci: true },
      focusedStream: 'yayinci',
    });
    expect(useVoice.getState().streams.yayinci).toEqual({ hasAudio: true });

    const back = participant(p.identity, SCREEN);
    restored(room, [back]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(back.pubs.get(Track.Source.ScreenShare)?.setSubscribed).toHaveBeenCalledWith(true);
    expect(back.pubs.get(Track.Source.ScreenShareAudio)?.setSubscribed).toHaveBeenCalledWith(true);
    expect(useVoice.getState()).toMatchObject({
      status: 'connected',
      watching: { yayinci: true },
      focusedStream: 'yayinci',
      streams: { yayinci: { hasAudio: true } },
    });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.setWatching).not.toHaveBeenCalled();
  });

  it('yayıncı bu arada yayını bitirdiyse süre sonunda durum temizlenir', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room, [participant('yayinci')]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(useVoice.getState().watching.yayinci).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVoice.getState()).toMatchObject({ watching: {}, focusedStream: null, streams: {} });
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
    expect(useVoice.getState().watching.yayinci).toBe(true);
  });

  it('ikinci kopma süreyi durdurur, ikinci denemedeki söküm de ses çıkarmaz', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room);
    await vi.advanceTimersByTimeAsync(1000);
    room.emit(RoomEvent.Reconnecting);
    // Bağlantı denemesi yarıda kaldı, katılımcılar gelmişti: ikinci söküm sessizlik penceresinden sonra da sessiz
    await vi.advanceTimersByTimeAsync(2000);
    room.remoteParticipants.set('diger', participant('diger', SCREEN));
    unwind(room, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState().watching.yayinci).toBe(true);
    expect(h.playSound.mock.calls.map((c) => c[0])).toEqual(['disconnect']);
  });

  it('bekleme sırasında izlemeyi bırakınca yayın kaydı da süre sonunda silinir', async () => {
    await joinAndWatch();
    unwind(room);
    restored(room);
    voice.stopWatching('yayinci');
    expect(useVoice.getState()).toMatchObject({ watching: {}, focusedStream: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().streams).toEqual({});
  });

  it('yeniden bağlanamazsa tutulanlar temizlenir ve geç zamanlayıcı bir şey yapmaz', async () => {
    await joinAndWatch();
    unwind(room);
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', watching: {}, focusedStream: null, streams: {} });
  });

  it('kopan odada tutulan izleme sonraki odaya taşınmaz', async () => {
    await joinAndWatch();
    unwind(room);
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await flush();
    const joined = voice.join('kanal', { silent: true });
    await flush();
    await joined;
    room = h.rooms.at(-1) as FakeRoom;
    // Yayın henüz görünmeden izlemeye alındı: eski odadan kalan kayıt bunu silmemeli
    voice.watchStream('yayinci');
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoice.getState().watching.yayinci).toBe(true);
  });

  it('bağlantı yerindeyken yayın biterse izleme hemen biter ve ses çalar', async () => {
    const p = await joinAndWatch();
    const pub = p.pubs.get(Track.Source.ScreenShare);
    p.pubs.clear();
    room.emit(RoomEvent.TrackUnpublished, pub, p);
    await flush();
    expect(useVoice.getState()).toMatchObject({ status: 'connected', watching: {}, focusedStream: null, streams: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.playSound).toHaveBeenCalledWith('userStreamStop');
  });

  it('izlenen yayıncı gerçekten çıkınca izleme hemen biter ve ses çalar', async () => {
    const p = await joinAndWatch();
    room.remoteParticipants.delete(p.identity);
    p.pubs.clear();
    room.emit(RoomEvent.ParticipantDisconnected, p);
    await flush();
    expect(useVoice.getState()).toMatchObject({ watching: {}, focusedStream: null, streams: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.playSound).toHaveBeenCalledWith('userLeave');
  });
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
    expect(h.playSound).not.toHaveBeenCalled();
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
    expect(h.playSound.mock.calls.map((c) => c[0])).toEqual(['disconnect']);
  });

  it('bağlantı kapanınca zamanlayıcı durumu ezmez', async () => {
    await joinAndWatch();
    room.emit(RoomEvent.SignalReconnecting);
    room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    await vi.advanceTimersByTimeAsync(5000);
    expect(useVoice.getState().status).toBe('idle');
  });
});

describe('yayın kaynağının adı', () => {
  it('yayın sürüyorsa yeniden bağlanınca yeniden bildirilir', async () => {
    await joinAndWatch();
    const reportSource = vi.fn();
    const internals = voice as unknown as { screen: unknown };
    internals.screen = {
      video: { mediaStreamTrack: {}, stop: vi.fn() },
      audio: null,
      preview: { reportSource, stop: vi.fn() },
    };
    room.emit(RoomEvent.Reconnected);
    expect(reportSource).toHaveBeenCalledTimes(1);
  });
});
