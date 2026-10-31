import { useState } from 'react';
import { Text, View } from 'react-native';
import { applySoundboardVolume } from '../sounds';
import { useSettings } from '../stores/settings';
import { colors, createStyles, font } from '../theme';
import { Slider } from './Slider';

/** Giriş sesleri ve ses paneli seslerinin ortak seviyesi (Ayarlar → Ses Paneli, ses paneli sayfası) */
export function SoundboardVolume({ description }: { description?: string }) {
  const volume = useSettings((s) => s.soundboardVolume);
  const set = useSettings((s) => s.set);
  // Sürüklenirken yüzde anında güncellenir; bırakınca kaydedilir
  const [dragging, setDragging] = useState<number | null>(null);
  const percent = Math.round((dragging ?? volume) * 100);
  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.label}>Ses paneli ses seviyesi</Text>
        <Text style={styles.value}>{percent === 0 ? 'Kapalı' : `%${percent}`}</Text>
      </View>
      <Slider
        value={volume}
        min={0}
        max={1}
        step={0.05}
        accessibilityLabel="Ses paneli ses seviyesi"
        accessibilityText={(v) => (v <= 0 ? 'Kapalı' : `Yüzde ${Math.round(v * 100)}`)}
        onChange={(v) => {
          setDragging(v);
          applySoundboardVolume(v);
        }}
        onChangeEnd={(v) => {
          setDragging(null);
          const next = Math.round(v * 100) / 100;
          set({ soundboardVolume: next });
          applySoundboardVolume(next);
        }}
      />
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

const styles = createStyles(() => ({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.text, fontSize: 15.5, fontWeight: '500' },
  value: { color: colors.muted, fontSize: 14, fontVariant: ['tabular-nums'] },
  description: { color: colors.muted, fontSize: font.small - 0.5, lineHeight: 18, marginTop: 2 },
}));
