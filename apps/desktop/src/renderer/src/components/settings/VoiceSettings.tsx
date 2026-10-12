import { Play } from 'lucide-react';
import { CALL_SOUND_LABELS, CALL_SOUND_NAMES, PREVIEW_SOUND_NAMES, SOUND_LABELS } from '@diskort/client-core';
import { useEffect, useRef, useState } from 'react';
import { voice } from '../../features/voice/voiceClient';
import { MIC_TEST_RECORD_MS, type MicTest, type MicTestPhase } from '../../features/voice/micTest';
import { fallbackLabel } from '../../features/voice/noiseFallback';
import { bridge } from '../../lib/bridge';
import { playSound, previewCallSound } from '../../lib/sfx';
import { cn, clamp } from '../../lib/utils';
import { MAX_VOLUME, useSettings, type NoiseMode, type NoiseStrengthDb } from '../../stores/settings';
import { useVoice } from '../../stores/voice';
import { Button, Divider, RadioCards, SectionTitle, Segmented, Select, Toggle } from '../ui/controls';
import { Slider } from '../ui/Slider';
import { KeybindInput } from './KeybindInput';
import { LineTestSection } from './LineTest';

interface Device {
  deviceId: string;
  label: string;
}

/** Görüşmede seçili model yerine başkası çalışıyorsa: "Şu an: DPDFNet → Standart (işlemci yoğun)" */
function NoiseFallbackHint() {
  const fallback = useVoice((s) => s.noiseFallback);
  if (!fallback) return null;
  return (
    <p className="mt-2 text-xs text-warn">
      Şu an: {fallbackLabel(fallback)}
      {fallback.transient ? ' · birkaç dakika sonra yeniden denenecek' : ' · bu oturumda denenmeyecek'}
    </p>
  );
}

function useDevices(): { inputs: Device[]; outputs: Device[] } {
  const [devices, setDevices] = useState<{ inputs: Device[]; outputs: Device[] }>({ inputs: [], outputs: [] });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      let list = await navigator.mediaDevices.enumerateDevices();
      // Aygıt adları için bir kez mikrofon izni gerekir.
      if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          list = await navigator.mediaDevices.enumerateDevices();
        } catch {
          // izin verilmedi; adsız listele
        }
      }
      if (cancelled) return;
      const map = (kind: MediaDeviceKind): Device[] =>
        list
          .filter((d) => d.kind === kind && d.deviceId !== 'communications')
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.deviceId === 'default' ? `Varsayılan${d.label ? ` — ${d.label.replace(/^Default - /, '')}` : ''}` : d.label || `Aygıt ${i + 1}`,
          }));
      setDevices({ inputs: map('audioinput'), outputs: map('audiooutput') });
    };
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, []);

  return devices;
}

const NOISE_STRENGTH_OPTIONS: { value: NoiseStrengthDb; label: string }[] = [
  { value: 12, label: 'Hafif' },
  { value: 24, label: 'Dengeli' },
  { value: 40, label: 'Güçlü' },
  { value: 100, label: 'Maksimum' },
];

const NOISE_STRENGTH_HINTS: Record<NoiseStrengthDb, string> = {
  12: 'Gürültüyü en fazla 12 dB kısar; ses en doğal hâlinde kalır, arka plan hafifçe duyulabilir.',
  24: 'Önerilen: gürültünün çoğunu bastırır, sesini doğal bırakır.',
  40: 'Gürültülü ortamlar için; ses biraz daha işlenmiş duyulabilir.',
  100: 'Sınırsız bastırma: gürültü tamamen kesilir ama ses robotik duyulabilir.',
};

/** Discord tarzı seviye göstergesi + hassasiyet eşiği. */
function MicMeter({ editable }: { editable: boolean }) {
  const level = useVoice((s) => s.micLevel);
  const threshold = useSettings((s) => s.vadThresholdDb);
  const set = useSettings((s) => s.set);
  const toPct = (db: number): number => clamp(((db + 100) / 100) * 100, 0, 100);
  const thresholdPct = toPct(editable ? threshold : level.threshold);

  return (
    // Kaydırıcılarla aynı ince iz (styles/controls.css); eşik ince bir çentik
    <div className="relative h-6">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-current/20">
        <div
          className="absolute inset-y-0 left-0 bg-warn transition-[width] duration-75"
          style={{ width: `${Math.min(toPct(level.db), thresholdPct)}%` }}
        />
        <div
          className="absolute inset-y-0 bg-ok transition-[width] duration-75"
          style={{ left: `${thresholdPct}%`, width: `${Math.max(0, toPct(level.db) - thresholdPct)}%` }}
        />
      </div>
      {editable ? (
        <input
          type="range"
          className="range-tick absolute inset-x-0 top-1 w-full"
          aria-label="Giriş hassasiyeti"
          min={-100}
          max={0}
          value={threshold}
          onChange={(e) => set({ vadThresholdDb: Number(e.target.value) })}
        />
      ) : (
        <div
          className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-head/80"
          style={{ left: `${thresholdPct}%` }}
        />
      )}
    </div>
  );
}

function MicTestControls() {
  const connected = useVoice((s) => s.status !== 'idle');
  const selfDeaf = useSettings((s) => s.selfDeaf);
  const testRef = useRef<MicTest | null>(null);
  const [loopback, setLoopback] = useState(false);
  const [phase, setPhase] = useState<MicTestPhase>(null);
  const [error, setError] = useState<string | null>(null);
  const active = loopback || phase !== null;
  const loopbackRef = useRef(loopback);
  loopbackRef.current = loopback;

  const ensureTest = (): MicTest => (testRef.current ??= voice.startMicTest(setError));
  const stopTest = (): void => {
    testRef.current?.stop();
    testRef.current = null;
    setLoopback(false);
    setPhase(null);
    setError(null);
  };

  // Görüşmede değilken sayfa açık kaldıkça gösterge için test zinciri çalışır. Görüşmedeyken test yalnızca
  // dinlerken/kaydederken sürer (o sırada odada susturulursun); biter bitmez önceki durum geri gelir.
  // Test sürerken görüşmeye girilir ya da çıkılırsa kesilmeden canlı zincire / kendi zincirine geçer.
  useEffect(() => {
    if (!connected) ensureTest();
    else if (!active && testRef.current) stopTest();
  }, [connected, active]);
  // Ayarlar kapanınca (ya da bu sekmeden çıkınca) test durur; mikrofon ve oda durumu serbest kalır
  useEffect(() => () => stopTest(), []);

  const toggleLoopback = (): void => {
    const next = !loopback;
    if (next) ensureTest().setLoopback(true);
    else testRef.current?.setLoopback(false);
    setLoopback(next);
  };

  const recordAndPlay = (): void => {
    const test = ensureTest();
    void test.recordAndPlay(setPhase).finally(() => {
      // Görüşmedeyken kayıt hiç başlamadıysa da (mikrofon hazır değildi) odadaki susturma hemen kalksın
      if (useVoice.getState().status !== 'idle' && !loopbackRef.current && testRef.current === test) stopTest();
    });
  };

  return (
    <div className="mt-3">
      {connected && active && (
        <div role="status" className="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          Mikrofon testi sürüyor: odada susturuldun, diğerleri seni duymuyor. Test bitince önceki durumun geri gelir.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={loopback ? 'danger' : 'primary'} onClick={toggleLoopback}>
          {loopback ? 'Testi Durdur' : 'Kendini Dinle'}
        </Button>
        <Button variant="secondary" onClick={recordAndPlay} disabled={phase !== null}>
          {phase === 'recording' ? 'Kaydediliyor…' : phase === 'playing' ? 'Çalınıyor…' : `Kaydet ve Dinle (${MIC_TEST_RECORD_MS / 1000} sn)`}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-danger-text">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-text-muted">
          {phase === 'recording'
            ? 'Konuş; kaydın bitince sana çalınacak.'
            : connected
              ? 'Sesini, odaya gittiği hâliyle (gürültü engelleme ve hassasiyet dahil) seçili çıkış aygıtından duy. Test sürerken odada susturulursun; ayar değişiklikleri görüşmedeki mikrofonuna da uygulanır.'
              : 'Sesini, başkalarına gittiği hâliyle (gürültü engelleme ve hassasiyet dahil) seçili çıkış aygıtından duy. Ayarları test sürerken değiştirip karşılaştırabilirsin.'}
        </p>
      )}
      {connected && active && selfDeaf && (
        <p className="mt-1 text-xs text-text-muted">Sağırlaştırılmışsın: odadakileri duymazsın, yalnızca kendi sesin çalınır.</p>
      )}
      {loopback && (
        <p className="mt-1 text-xs text-warn">Hoparlörden dinlersen ses mikrofona geri girip yankı yapar; kulaklık kullan.</p>
      )}
    </div>
  );
}

/** Giriş/çıkış ses seviyesi (%0–200; alt paneldeki mikrofon/kulaklık menülerindekiyle aynı ayar) */
function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const percent = Math.round(value * 100);
  return (
    <div>
      <div className="mb-2 flex justify-between text-xs font-bold text-text-muted uppercase">
        <span>{label}</span>
        <span className="tabular-nums">%{percent}</span>
      </div>
      <Slider
        className="w-full"
        aria-label={label}
        min={0}
        max={MAX_VOLUME * 100}
        value={percent}
        onValueChange={(v) => onChange(v / 100)}
      />
    </div>
  );
}

export function VoiceSettings() {
  const s = useSettings();
  const { inputs, outputs } = useDevices();
  const [hotkeysAvailable, setHotkeysAvailable] = useState(true);

  useEffect(() => {
    void bridge?.hotkeys.available().then(setHotkeysAvailable);
  }, []);

  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Ses ve Görüntü</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="mb-2 text-xs font-bold text-text-muted uppercase">Giriş Aygıtı</div>
          <Select
            aria-label="Giriş aygıtı"
            value={s.inputDeviceId}
            onChange={(inputDeviceId) => s.set({ inputDeviceId })}
            options={inputs.length ? inputs.map((d) => ({ value: d.deviceId, label: d.label })) : [{ value: 'default', label: 'Varsayılan' }]}
          />
        </div>
        <div>
          <div className="mb-2 text-xs font-bold text-text-muted uppercase">Çıkış Aygıtı</div>
          <Select
            aria-label="Çıkış aygıtı"
            value={s.outputDeviceId}
            onChange={(outputDeviceId) => s.set({ outputDeviceId })}
            options={outputs.length ? outputs.map((d) => ({ value: d.deviceId, label: d.label })) : [{ value: 'default', label: 'Varsayılan' }]}
          />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <VolumeSlider label="Giriş ses seviyesi" value={s.inputVolume} onChange={(inputVolume) => s.set({ inputVolume })} />
        <VolumeSlider label="Çıkış ses seviyesi" value={s.outputVolume} onChange={(outputVolume) => s.set({ outputVolume })} />
      </div>

      <SectionTitle>Mikrofon Testi</SectionTitle>
      <MicMeter editable={false} />
      <MicTestControls />

      <Divider />

      <SectionTitle>Giriş Modu</SectionTitle>
      <RadioCards
        value={s.inputMode}
        onChange={(inputMode) => s.set({ inputMode })}
        options={[
          { value: 'vad', label: 'Ses Aktivitesi', description: 'Konuştuğunda mikrofon otomatik açılır.' },
          { value: 'ptt', label: 'Bas-Konuş', description: 'Yalnızca atadığın tuşa basılıyken konuşursun.' },
        ]}
      />

      {s.inputMode === 'vad' ? (
        <>
          <SectionTitle>Giriş Hassasiyeti</SectionTitle>
          <Toggle
            label="Giriş hassasiyetini otomatik belirle"
            checked={s.vadAuto}
            onChange={(vadAuto) => s.set({ vadAuto })}
          />
          <div className={cn('mt-2', s.vadAuto && 'pointer-events-none opacity-60')}>
            <MicMeter editable={!s.vadAuto} />
            <p className="mt-1 text-xs text-text-muted">
              Yeşil bölgeye geçtiğinde sesin iletilir. Eşik: {s.vadAuto ? 'otomatik' : `${s.vadThresholdDb} dB`}
            </p>
          </div>
        </>
      ) : (
        <>
          <SectionTitle>Bas-Konuş Kısayolu</SectionTitle>
          <KeybindInput
            value={s.hotkeys.pushToTalk}
            onChange={(pushToTalk) => s.set({ hotkeys: { ...s.hotkeys, pushToTalk } })}
          />
          {!bridge || !hotkeysAvailable ? (
            <p className="mt-2 text-xs text-warn">Global kısayollar bu sistemde kullanılamıyor.</p>
          ) : null}
          <SectionTitle>Bırakma Gecikmesi — {s.pttReleaseMs} ms</SectionTitle>
          <Slider
            className="w-full"
            aria-label="Bırakma gecikmesi"
            min={0}
            max={1000}
            step={10}
            value={s.pttReleaseMs}
            onValueChange={(pttReleaseMs) => s.set({ pttReleaseMs })}
          />
        </>
      )}

      <Divider />

      <SectionTitle>Gürültü Engelleme</SectionTitle>
      <RadioCards<NoiseMode>
        value={s.noise}
        onChange={(noise) => s.set({ noise })}
        options={[
          {
            value: 'dpdfnet',
            label: 'Gelişmiş yapay zekâ (DPDFNet)',
            description:
              'En temiz ses: klavye, fan, arkadaki konuşmalar ve TV sesini daha iyi ayırır. İşlemci yetmezse geçici olarak standart engellemeye geçilir, birkaç dakika sonra yeniden denenir.',
          },
          { value: 'standard', label: 'Standart', description: 'Tarayıcı motorunun yerleşik gürültü engellemesi; daha az işlemci kullanır.' },
          { value: 'off', label: 'Kapalı', description: 'Stüdyo mikrofonları veya müzik için.' },
        ]}
      />
      <NoiseFallbackHint />
      {s.noise === 'dpdfnet' && (
        <>
          <SectionTitle>Gürültü engelleme gücü</SectionTitle>
          <Segmented<NoiseStrengthDb>
            aria-label="Gürültü engelleme gücü"
            value={s.noiseStrengthDb}
            onChange={(noiseStrengthDb) => s.set({ noiseStrengthDb })}
            options={NOISE_STRENGTH_OPTIONS}
          />
          <p className="mt-2 text-xs text-text-muted">{NOISE_STRENGTH_HINTS[s.noiseStrengthDb]}</p>
        </>
      )}
      <div className="mt-3">
        <Toggle
          label="Yankı engelleme"
          description="Hoparlörden gelen sesin mikrofona geri girmesini önler."
          checked={s.echoCancellation}
          onChange={(echoCancellation) => s.set({ echoCancellation })}
        />
        <Toggle
          label="Otomatik kazanç kontrolü"
          description={
            s.noise === 'dpdfnet'
              ? 'Ses seviyeni otomatik olarak dengeler. Gelişmiş yapay zekâ çalışırken mikrofonun sistem seviyesine dokunmayan yazılımsal kazanç kullanılır; standart engellemede tarayıcının kazanç kontrolü çalışır.'
              : 'Ses seviyeni otomatik olarak dengeler.'
          }
          checked={s.autoGainControl}
          onChange={(autoGainControl) => s.set({ autoGainControl })}
        />
      </div>

      <SectionTitle>Ses Kalitesi</SectionTitle>
      <Select
        aria-label="Ses kalitesi"
        value={s.audioBitrateKbps}
        onChange={(audioBitrateKbps) => s.set({ audioBitrateKbps })}
        options={[
          { value: 32, label: '32 kbps — düşük bant' },
          { value: 64, label: '64 kbps — önerilen' },
          { value: 96, label: '96 kbps — yüksek' },
          { value: 128, label: '128 kbps — müzik' },
        ]}
      />

      <LineTestSection />
    </div>
  );
}

/** Ses efektleri: açık/kapalı ve her sesi dinleme listesi */
export function SoundSettings() {
  const s = useSettings();
  return (
    <>
      <SectionTitle>Ses Efektleri</SectionTitle>
      <div className="mt-4 space-y-4">
        <Toggle
          label="Arayüz sesleri"
          description="Katılma/ayrılma, susturma, sağırlaştırma, yayın ve kanala biri girip çıkınca sesler."
          checked={s.sounds}
          onChange={(sounds) => s.set({ sounds })}
        />
        <Toggle
          label="Bildirim sesi"
          description="Senden bahsedilince ya da direkt mesaj gelince. Rahatsız Etmeyin durumunda çalmaz."
          checked={s.notificationSound}
          onChange={(notificationSound) => s.set({ notificationSound })}
        />
        <Toggle
          label="Bas-konuş sesleri"
          description="Bas-konuş tuşuna basınca ve bırakınca kısa, kısık bir ses."
          checked={s.pttSounds}
          onChange={(pttSounds) => s.set({ pttSounds })}
        />
      </div>
      <SectionTitle>Sesleri Dinle</SectionTitle>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {PREVIEW_SOUND_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => playSound(name, { preview: true })}
            className="press flex items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-normal"
          >
            <Play size={14} className="ico-nudge-r shrink-0 text-text-faint" aria-hidden />
            <span className="truncate">{SOUND_LABELS[name]}</span>
          </button>
        ))}
        {/* Arama sesleri (aramada döngüyle çalar; burada bir kez) */}
        {CALL_SOUND_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => previewCallSound(name)}
            className="press flex items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-normal"
          >
            <Play size={14} className="ico-nudge-r shrink-0 text-text-faint" aria-hidden />
            <span className="truncate">{CALL_SOUND_LABELS[name]}</span>
          </button>
        ))}
      </div>
    </>
  );
}
