import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SOUNDBOARD_MAX_SOUNDS, SOUNDBOARD_NAME_MAX, SOUNDBOARD_SOUND_MAX_SECONDS, type GuildSound } from '@diskort/shared';
import { ApiError, errorMessage, formatBytes, uploadGuildSound, useGuild, type LocalFile } from '@diskort/client-core';
import { SOUND_TOO_LARGE } from '../attachments';
import { colors, createStyles, font, space } from '../theme';
import { SheetHeader } from './BottomSheet';
import { Button, Field, ui } from './ui';

/** Dosya adı uzantısız, ad sınırına kırpılmış (yarım kalan emoji/surrogate atılır) */
function defaultSoundName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, SOUNDBOARD_NAME_MAX)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
}

function uploadError(err: unknown): string {
  switch (err instanceof ApiError ? err.code : null) {
    case 'sound_limit':
      return `Sunucuda en çok ${SOUNDBOARD_MAX_SOUNDS} ses olabilir.`;
    case 'too_large':
      return SOUND_TOO_LARGE;
    case 'unsupported':
      return 'Bu ses dosyası okunamadı.';
    case 'rate_limited':
      return 'Çok sık ses yüklüyorsun, biraz bekle.';
    default:
      return errorMessage(err);
  }
}

/**
 * Sunucunun ses paneline ses ekleme formu (BottomSheet içinde; ses paneli ve Sunucu Ayarları → Sesler paylaşır).
 * Dosya önceden `pickGuildSound` ile seçilir. Telefonda kesit seçilmez: sunucu ilk 5 saniyeyi alır. Sayfa kapanınca
 * (form kalkınca) süren yükleme iptal edilir.
 */
export function SoundUploadForm({
  guildId,
  file,
  onDone,
  onCancel,
}: {
  guildId: string;
  file: LocalFile;
  onDone: (sound: GuildSound) => void;
  onCancel: () => void;
}) {
  const guildName = useGuild((s) => s.guilds[guildId]?.guild.name);
  const [name, setName] = useState(() => defaultSoundName(file.name));
  const [emoji, setEmoji] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useRef<AbortController | null>(null);
  useEffect(() => () => upload.current?.abort(), []);

  const submit = async (): Promise<void> => {
    const controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setError(null);
    try {
      onDone(await uploadGuildSound(file, { guildId, name, emoji: emoji.trim() || null, start: 0, duration: SOUNDBOARD_SOUND_MAX_SECONDS }, controller.signal));
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(uploadError(err));
        setBusy(false);
      }
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Ses ekle" subtitle={guildName} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.file} numberOfLines={1}>
          {file.name} · {formatBytes(file.size)}
        </Text>
        <Text style={styles.hint}>Sesin ilk {SOUNDBOARD_SOUND_MAX_SECONDS} saniyesi alınır, telefonda kesit seçilmez.</Text>
        <Field label="Ad" value={name} onChangeText={setName} maxLength={SOUNDBOARD_NAME_MAX} placeholder="Sesin adı" editable={!busy} />
        <Field label="Emoji (isteğe bağlı)" value={emoji} onChangeText={setEmoji} maxLength={32} placeholder="Tek emoji" editable={!busy} />
        {error ? (
          <View style={ui.errorBox}>
            <Text style={ui.errorText}>{error}</Text>
          </View>
        ) : null}
        {busy ? (
          <View style={styles.progress}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={styles.hint}>Yükleniyor ve işleniyor…</Text>
          </View>
        ) : null}
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button title="Vazgeç" variant="secondary" onPress={onCancel} />
          </View>
          <View style={styles.button}>
            <Button title="Yükle" busy={busy} disabled={name.trim() === ''} onPress={() => void submit()} />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = createStyles(() => ({
  page: { flexShrink: 1 },
  scroll: { flexShrink: 1 },
  content: { paddingHorizontal: space.lg + 2 },
  file: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: font.small, lineHeight: 19, marginTop: 2, marginBottom: space.md },
  progress: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  button: { flex: 1 },
}));
