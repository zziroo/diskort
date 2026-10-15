import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SOUND_LABELS } from '@diskort/client-core';
import { feedback, soundCue, useHapticsAvailable } from '../haptics';
import { MOBILE_SOUND_NAMES, previewSound, soundsAvailable } from '../sounds';
import { useSettings, type NoiseMode, type NoiseStrengthDb } from '../stores/settings';
import { colors, createStyles } from '../theme';
import { dpdfnetAvailable, effectiveNoiseMode, useNoiseFilter } from '../voice/noiseFilter';
import { useVoice, voice } from '../voice/voice';
import { Slider } from './Slider';
import { Card, SectionTitle } from './ui';

/** Göstergenin ölçeği (dBFS): -80 en sol, 0 en sağ */
const METER_MIN = -80;
const toRatio = (db: number): number => Math.min(1, Math.max(0, (db - METER_MIN) / -METER_MIN));

/**
 * Ayarlar → Ses ve Görüntü: titreşim, gürültü/yankı engelleme, otomatik ses seviyesi ve ses algılama (masaüstündeki
 * "ses aktivitesi"nin telefondaki karşılığı; canlı seviye göstergesiyle).
 */
export function VoiceSettings() {
  const echoCancellation = useSettings((s) => s.echoCancellation);
  const autoGainControl = useSettings((s) => s.autoGainControl);
  const voiceActivity = useSettings((s) => s.voiceActivity);
  const vadAuto = useSettings((s) => s.vadAuto);
  const threshold = useSettings((s) => s.vadThresholdDb);
  const set = useSettings((s) => s.set);
  const inVoice = useVoice((s) => s.status !== 'idle');
  const haptics = useSettings((s) => s.haptics);
  const hapticsAvailable = useHapticsAvailable((s) => s.available);
  // Eşik sürüklenirken göstergedeki çizgi anında kayar; bırakınca kaydedilir
  const [preview, setPreview] = useState<number | null>(null);

  return (
    <View>
      <SectionTitle>Ses</SectionTitle>
      <Card style={styles.card}>
        <ToggleRow
          label="Dokunma titreşimi"
          description={
            hapticsAvailable === false
              ? 'Bu telefonda titreşim kullanılamıyor.'
              : 'Sustur, sağırlaştır, hoparlör, ekran paylaşımı, katıl ve ayrıl düğmelerine basınca kısa titreşim. Susturunca çift, açınca tek tık.'
          }
          value={haptics && hapticsAvailable !== false}
          onChange={(v) => {
            set({ haptics: v });
            if (v) feedback('unmute');
          }}
        />
        <NoiseSetting />
        <ToggleRow
          label="Yankı engelleme"
          description="Hoparlörden gelen sesin mikrofona geri girmesini önler."
          value={echoCancellation}
          onChange={(v) => set({ echoCancellation: v })}
        />
        <ToggleRow
          label="Otomatik ses seviyesi"
          description="Mikrofonunun seviyesini otomatik dengeler."
          value={autoGainControl}
          onChange={(v) => set({ autoGainControl: v })}
        />
        {inVoice && (
          <Text style={styles.note}>Bu üç ayar sesli sohbete bir sonraki katılışında uygulanır.</Text>
        )}

        <ToggleRow
          label="Ses algılama"
          description="Konuşmadığın anlarda mikrofonun sessize alınır; klavye, tabak çanak gibi sesler gitmez."
          value={voiceActivity}
          onChange={(v) => set({ voiceActivity: v })}
        />
        {voiceActivity && (
          <View style={styles.vad}>
            <ToggleRow
              label="Hassasiyeti otomatik belirle"
              description="Eşik ortamın gürültüsüne göre kendiliğinden ayarlanır."
              value={vadAuto}
              onChange={(v) => set({ vadAuto: v })}
            />
            <MicMeter threshold={vadAuto ? null : (preview ?? threshold)} />
            {!vadAuto && (
              <Slider
                value={threshold}
                min={METER_MIN}
                max={0}
                step={1}
                accessibilityLabel="Giriş hassasiyeti"
                accessibilityText={(v) => `${Math.round(v)} desibel`}
                onChange={setPreview}
                onChangeEnd={(v) => {
                  setPreview(null);
                  set({ vadThresholdDb: Math.round(v) });
                }}
              />
            )}
            <Text style={styles.hint}>
              {inVoice
                ? `Çubuk yeşile döndüğünde sesin iletilir. Eşik: ${vadAuto ? 'otomatik' : `${Math.round(preview ?? threshold)} dB`}.`
                : 'Seviye göstergesi sesli sohbete bağlıyken çalışır.'}{' '}
              Uygulama arka plandayken (ekran kapalı) ses algılama çalışmaz; mikrofon açık kalır.
            </Text>
          </View>
        )}
      </Card>
    </View>
  );
}

/** Arayüz sesleri: aç/kapat, bildirim sesi ve her sesi dinleme listesi */
export function SoundSettings() {
  const sounds = useSettings((s) => s.sounds);
  const notificationSound = useSettings((s) => s.notificationSound);
  const introVolume = useSettings((s) => s.introSoundVolume);
  const set = useSettings((s) => s.set);
  const [listOpen, setListOpen] = useState(false);
  // Giriş sesi seviyesi sürüklenirken yüzde anında güncellenir; bırakınca kaydedilir
  const [introPreview, setIntroPreview] = useState<number | null>(null);
  const introPercent = Math.round((introPreview ?? introVolume) * 100);
  // Eski APK'larda (expo-audio yok) ses çalınamaz; ayarlar gösterilmez
  if (!soundsAvailable()) return null;
  return (
    <>
      <ToggleRow
        label="Sesli sohbet sesleri"
        description="Katılınca, ayrılınca, susturunca, sağırlaştırınca, yayın açılıp kapanınca ve kanala biri girip çıkınca kısa ses. Telefon sessizdeyken çalmaz."
        value={sounds}
        onChange={(v) => {
          set({ sounds: v });
          if (v) soundCue('unmute');
        }}
      />
      {sounds && (
        <View style={styles.choiceBlock}>
          <View style={styles.sliderHead}>
            <Text style={styles.label}>Giriş sesleri</Text>
            <Text style={styles.sliderValue}>{introPercent === 0 ? 'Kapalı' : `%${introPercent}`}</Text>
          </View>
          <Slider
            value={introVolume}
            min={0}
            max={1}
            step={0.05}
            accessibilityLabel="Giriş seslerinin seviyesi"
            accessibilityText={(v) => (v <= 0 ? 'Kapalı' : `Yüzde ${Math.round(v * 100)}`)}
            onChange={setIntroPreview}
            onChangeEnd={(v) => {
              setIntroPreview(null);
              set({ introSoundVolume: Math.round(v * 100) / 100 });
            }}
          />
          <Text style={styles.description}>Kanala girenlerin kendi yüklediği kısa ses. 0 = kapalı</Text>
        </View>
      )}
      <ToggleRow
        label="Bildirim sesi"
        description="Uygulama açıkken senden bahsedilince ya da direkt mesaj gelince. Rahatsız Etmeyin durumunda çalmaz."
        value={notificationSound}
        onChange={(v) => {
          set({ notificationSound: v });
          if (v) previewSound('mention');
        }}
      />
      <View style={styles.choiceBlock}>
        <Pressable
          onPress={() => setListOpen((o) => !o)}
          style={({ pressed }) => [styles.listToggle, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          accessibilityState={{ expanded: listOpen }}
        >
          <Text style={styles.listToggleText}>Sesleri dinle</Text>
          <Ionicons name={listOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.muted} />
        </Pressable>
        {listOpen &&
          MOBILE_SOUND_NAMES.map((name) => (
            <Pressable
              key={name}
              onPress={() => previewSound(name)}
              style={({ pressed }) => [styles.soundRow, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel={`Dinle: ${SOUND_LABELS[name]}`}
            >
              <Ionicons name="play-circle-outline" size={20} color={colors.brand} />
              <Text style={styles.soundLabel}>{SOUND_LABELS[name]}</Text>
            </Pressable>
          ))}
      </View>
    </>
  );
}

const NOISE_MODE_OPTIONS: { value: NoiseMode; label: string }[] = [
  { value: 'dpdfnet', label: 'DPDFNet (önerilen)' },
  { value: 'standard', label: 'Standart' },
  { value: 'off', label: 'Kapalı' },
];

const NOISE_MODE_HINTS: Record<NoiseMode, string> = {
  dpdfnet:
    'Yapay zekâ modeli telefonunda çalışır (masaüstündekiyle aynı): klavye, fan, trafik, kalabalık gibi sesleri keser, sesini doğal bırakır. Sese yaklaşık 50 ms gecikme ekler.',
  standard: 'Fan, trafik, klima gibi sürekli arka plan seslerini azaltır (WebRTC). Pil dostu.',
  off: 'Mikrofonun sesi gürültü engellemeden geçer.',
};

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

/** Gürültü engelleme türü (DPDFNet / standart / kapalı) ve DPDFNet'in gücü */
function NoiseSetting() {
  const mode = effectiveNoiseMode(useSettings((s) => s.noiseMode));
  const strength = useSettings((s) => s.noiseStrengthDb);
  const set = useSettings((s) => s.set);
  const status = useNoiseFilter((s) => s.status);
  const inVoice = useVoice((s) => s.status !== 'idle');
  // Eski APK'larda (yerel modül yok) DPDFNet seçeneği gösterilmez
  const modes = dpdfnetAvailable ? NOISE_MODE_OPTIONS : NOISE_MODE_OPTIONS.filter((o) => o.value !== 'dpdfnet');
  return (
    <View style={styles.choiceBlock}>
      <Text style={styles.label}>Gürültü engelleme</Text>
      <Choices options={modes} value={mode} onChange={(v) => set({ noiseMode: v })} label="Gürültü engelleme" />
      <Text style={styles.description}>{NOISE_MODE_HINTS[mode]}</Text>
      {mode === 'dpdfnet' && inVoice && status && !status.active && status.reason ? (
        <Text style={styles.note}>
          DPDFNet bu bağlantıda çalışmıyor ({status.reason}); standart gürültü engelleme kullanılıyor.
        </Text>
      ) : null}
      {mode === 'dpdfnet' && (
        <>
          <Text style={[styles.label, styles.subLabel]}>Güç</Text>
          <Choices options={NOISE_STRENGTH_OPTIONS} value={strength} onChange={(v) => set({ noiseStrengthDb: v })} label="Gürültü engelleme gücü" />
          <Text style={styles.description}>{NOISE_STRENGTH_HINTS[strength]}</Text>
        </>
      )}
    </View>
  );
}

/** Yan yana seçenek düğmeleri (tek seçim) */
function Choices<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, pressed && { opacity: 0.8 }]}
          >
            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Mikrofonun anlık seviyesi ve eşik çizgisi (yalnızca sesli sohbetteyken ölçülür) */
function MicMeter({ threshold }: { threshold: number | null }) {
  const inVoice = useVoice((s) => s.status === 'connected');
  const level = useVoice((s) => s.micLevel);
  // Gösterge ekrandayken ölçüm sürer
  useEffect(() => (inVoice ? voice.watchMicLevel() : undefined), [inVoice]);

  const levelRatio = toRatio(level.db);
  // Otomatikte o anki (gürültüye göre belirlenen) eşik gösterilir
  const thresholdRatio = toRatio(threshold ?? level.threshold);
  return (
    <View style={styles.meter} accessibilityLabel="Mikrofon seviyesi">
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${Math.min(levelRatio, thresholdRatio) * 100}%` }]} />
        {levelRatio > thresholdRatio && (
          <View
            style={[
              styles.meterFill,
              styles.meterOpen,
              { left: `${thresholdRatio * 100}%`, width: `${(levelRatio - thresholdRatio) * 100}%` },
            ]}
          />
        )}
      </View>
      <View style={[styles.meterMark, { left: `${thresholdRatio * 100}%` }]} />
    </View>
  );
}

export function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.control, true: colors.brand }}
        thumbColor="#fff"
      />
    </Pressable>
  );
}

const THUMB_PAD = 9;

const styles = createStyles(() => ({
  card: { paddingHorizontal: 16, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  label: { color: colors.text, fontSize: 15.5, fontWeight: '500' },
  description: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  note: { color: colors.warn, fontSize: 13, lineHeight: 18, marginBottom: 4 },
  choiceBlock: { paddingVertical: 10 },
  subLabel: { marginTop: 12 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 6 },
  choice: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.control,
    borderWidth: 1,
    borderColor: colors.control,
  },
  choiceSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  choiceText: { color: colors.onControl, fontSize: 14, fontWeight: '500' },
  choiceTextSelected: { color: colors.white },
  vad: { paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.line, marginLeft: 2, marginBottom: 4 },
  hint: { color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  listToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, alignSelf: 'flex-start' },
  listToggleText: { color: colors.muted, fontSize: 14, fontWeight: '500' },
  soundRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  soundLabel: { color: colors.text, fontSize: 14.5 },
  sliderHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderValue: { color: colors.muted, fontSize: 14, fontVariant: ['tabular-nums'] },
  // Kaydırıcıyla hizalı olsun diye iki yanda başparmak payı bırakılır
  meter: { height: 22, justifyContent: 'center', marginHorizontal: THUMB_PAD, marginTop: 6 },
  meterTrack: { height: 8, borderRadius: 4, backgroundColor: colors.control, overflow: 'hidden' },
  meterFill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.warn },
  meterOpen: { backgroundColor: colors.ok },
  meterMark: { position: 'absolute', top: 1, bottom: 1, width: 2, marginLeft: -1, backgroundColor: colors.head, opacity: 0.8 },
}));
