import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SOUNDBOARD_MAX_SOUNDS, SOUNDBOARD_NAME_MAX, type Guild, type GuildSound } from '@diskort/shared';
import {
  ApiError,
  errorMessage,
  guildSoundUrl,
  removeGuildSound,
  soundsOf,
  updateGuildSound,
  useGuild,
  type LocalFile,
} from '@diskort/client-core';
import { pickGuildSound } from '../../attachments';
import { previewSoundboardSound, soundsAvailable } from '../../sounds';
import { toast } from '../../stores/ui';
import { colors, createStyles, font, space, tint } from '../../theme';
import { BottomSheet, SheetHeader } from '../BottomSheet';
import { confirmDialog } from '../Dialog';
import { SoundUploadForm } from '../SoundUploadForm';
import { Button, Card, Field, SectionTitle, ui } from '../ui';
import { Intro } from './common';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} sn`;

/** Sesler: sunucunun ses paneli sesleri; ekle, dinle, yeniden adlandır, sil ("Ses Panelini Yönet" yetkisi) */
export function SoundsSection({ guild }: { guild: Guild }) {
  const sounds = useGuild((s) => soundsOf(s, guild.id));
  const users = useGuild((s) => s.users);
  const [file, setFile] = useState<LocalFile | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // Ad/emoji düzenlenen ses (sayfa açık)
  const [editing, setEditing] = useState<GuildSound | null>(null);
  // Sayfa kapanırken içerik kaybolmasın diye düzenlenen ses kapanışta silinmez (yükleme formuyla aynı)
  const [editOpen, setEditOpen] = useState(false);
  const full = sounds.length >= SOUNDBOARD_MAX_SOUNDS;
  const canPreview = soundsAvailable();

  const add = async (): Promise<void> => {
    setPicking(true);
    try {
      const picked = await pickGuildSound();
      if (picked) {
        setFile(picked);
        setFormOpen(true);
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setPicking(false);
    }
  };

  const rename = (sound: GuildSound): void => {
    setEditing(sound);
    setEditOpen(true);
  };

  const remove = async (sound: GuildSound): Promise<void> => {
    const ok = await confirmDialog({
      title: `${sound.name} silinsin mi?`,
      message: 'Ses bu sunucunun ses panelinden kalkar. Bu işlem geri alınamaz.',
      icon: 'trash-outline',
      confirmLabel: 'Sil',
      danger: true,
    });
    if (!ok) return;
    removeGuildSound(guild.id, sound.id).catch((err: unknown) => toast(errorMessage(err), 'error'));
  };

  return (
    <View>
      <Intro>Ses kanalındaki üyeler bu sesleri ses panelinden herkese çalabilir. Ses en çok 5 saniye olur.</Intro>
      <Button title="Ses ekle" busy={picking} disabled={full} onPress={() => void add()} />
      {full ? <Text style={styles.limit}>Sunucuda en çok {SOUNDBOARD_MAX_SOUNDS} ses olabilir.</Text> : null}

      <SectionTitle>
        Sesler ({sounds.length}/{SOUNDBOARD_MAX_SOUNDS})
      </SectionTitle>
      <Card>
        {sounds.length === 0 ? (
          <Text style={styles.empty}>Henüz ses yok.</Text>
        ) : (
          sounds.map((sound, i) => {
            const uploaderUser = sound.uploaderId ? users[sound.uploaderId] : undefined;
            const uploader = uploaderUser ? uploaderUser.displayName || uploaderUser.username : undefined;
            return (
              <View key={sound.id}>
                {i > 0 && <View style={styles.divider} />}
                <View style={styles.row}>
                  <View style={styles.icon}>
                    {sound.emoji ? (
                      <Text style={styles.emoji}>{sound.emoji}</Text>
                    ) : (
                      <Ionicons name="musical-notes" size={19} color={colors.muted} />
                    )}
                  </View>
                  <Pressable
                    style={styles.text}
                    onPress={() => rename(sound)}
                    accessibilityRole="button"
                    accessibilityLabel={`${sound.name}, yeniden adlandır`}
                  >
                    <Text style={styles.name} numberOfLines={1}>
                      {sound.name}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {seconds(sound.durationMs)}
                      {uploader ? ` · ${uploader}` : ''}
                    </Text>
                  </Pressable>
                  {canPreview ? (
                    <IconButton icon="play-circle-outline" label={`${sound.name} dinle`} onPress={() => previewSoundboardSound(guildSoundUrl(sound))} />
                  ) : null}
                  <IconButton icon="pencil-outline" label={`${sound.name} yeniden adlandır`} onPress={() => rename(sound)} />
                  <IconButton icon="trash-outline" label={`${sound.name} sil`} danger onPress={() => void remove(sound)} />
                </View>
              </View>
            );
          })
        )}
      </Card>

      <BottomSheet visible={editOpen} onClose={() => setEditOpen(false)} avoidKeyboard>
        {editing ? (
          <SoundEditForm key={editing.id} guildId={guild.id} sound={editing} onClose={() => setEditOpen(false)} />
        ) : null}
      </BottomSheet>

      <BottomSheet visible={formOpen} onClose={() => setFormOpen(false)} avoidKeyboard>
        {file ? (
          <SoundUploadForm
            key={file.uri}
            guildId={guild.id}
            file={file}
            onCancel={() => setFormOpen(false)}
            onDone={(sound) => {
              setFormOpen(false);
              toast(`${sound.name} eklendi.`);
            }}
          />
        ) : null}
      </BottomSheet>
    </View>
  );
}

function editError(err: unknown): string {
  return err instanceof ApiError && err.code === 'invalid_emoji' ? 'Tek bir emoji gir.' : errorMessage(err);
}

/** Sesin adını ve emojisini değiştirme sayfası; emoji alanı boş bırakılırsa emoji kaldırılır */
function SoundEditForm({ guildId, sound, onClose }: { guildId: string; sound: GuildSound; onClose: () => void }) {
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState(sound.emoji ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const nextName = name.trim();
    const nextEmoji = emoji.trim() || null;
    const patch: { name?: string; emoji?: string | null } = {};
    if (nextName && nextName !== sound.name) patch.name = nextName;
    if (nextEmoji !== (sound.emoji ?? null)) patch.emoji = nextEmoji;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateGuildSound(guildId, sound.id, patch);
      onClose();
    } catch (err) {
      setError(editError(err));
      setBusy(false);
    }
  };

  return (
    <View style={styles.sheet}>
      <SheetHeader title="Sesi düzenle" />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <Field label="Ad" value={name} onChangeText={setName} maxLength={SOUNDBOARD_NAME_MAX} placeholder="Sesin adı" editable={!busy} />
        <Field label="Emoji (boş bırakırsan kaldırılır)" value={emoji} onChangeText={setEmoji} maxLength={32} placeholder="Tek emoji" editable={!busy} />
        {error ? (
          <View style={ui.errorBox}>
            <Text style={ui.errorText}>{error}</Text>
          </View>
        ) : null}
        <View style={styles.sheetButtons}>
          <View style={styles.sheetButton}>
            <Button title="Vazgeç" variant="secondary" onPress={onClose} />
          </View>
          <View style={styles.sheetButton}>
            <Button title="Kaydet" busy={busy} disabled={name.trim() === ''} onPress={() => void save()} />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      android_ripple={{ color: tint(0.14), borderless: true, radius: 18 }}
      style={styles.iconButton}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={19} color={danger ? colors.danger : colors.muted} />
    </Pressable>
  );
}

const styles = createStyles(() => ({
  limit: { color: colors.muted, fontSize: font.small, marginTop: space.sm },
  empty: { color: colors.muted, fontSize: font.small, padding: space.lg },
  divider: { height: 0.5, backgroundColor: colors.line, marginLeft: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.md, paddingRight: space.sm, paddingVertical: space.sm + 2 },
  icon: { width: 30, alignItems: 'center' },
  emoji: { fontSize: 20 },
  text: { flex: 1, paddingHorizontal: space.xs },
  name: { color: colors.head, fontSize: font.row, fontWeight: '500' },
  meta: { color: colors.muted, fontSize: font.caption, marginTop: 2 },
  sheet: { flexShrink: 1 },
  sheetContent: { paddingHorizontal: space.lg + 2 },
  sheetButtons: { flexDirection: 'row', gap: space.sm },
  sheetButton: { flex: 1 },
  iconButton: { width: 34, height: 36, alignItems: 'center', justifyContent: 'center' },
}));
