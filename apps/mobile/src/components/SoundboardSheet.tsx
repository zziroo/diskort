import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hasPermission, Permission, SOUNDBOARD_MAX_SOUNDS, type GuildSound } from '@diskort/shared';
import {
  allSounds,
  ApiError,
  errorMessage,
  guildSoundUrl,
  permissionsInGuild,
  playGuildSound,
  useGuild,
  useSession,
  useSoundboardCooling,
  type LocalFile,
} from '@diskort/client-core';
import { pickGuildSound } from '../attachments';
import { feedback, haptic } from '../haptics';
import { previewSoundboardSound } from '../sounds';
import { colors, createStyles, font, radius, space, tint } from '../theme';
import { useVoice } from '../voice/voice';
import { BottomSheet, SheetHeader } from './BottomSheet';
import { PressableScale } from './PressableScale';
import { SoundboardVolume } from './SoundboardVolume';
import { SoundUploadForm } from './SoundUploadForm';
import { Notice } from './States';

const COLUMNS = 4;
const GRID_PADDING = space.md;
const GRID_GAP = space.sm;
const NOTICE_MS = 4000;

type Page = { kind: 'board' } | { kind: 'upload'; guildId: string; file: LocalFile };
type BoardNotice = { text: string; tone: 'danger' | 'ok' };

/**
 * Ses paneli (ses ekranındaki düğmeden): üyesi olunan bütün sunucuların sesleri, bulunulan sunucu üstte. Dokun =
 * kanaldaki herkese çal, uzun bas = yalnız kendine dinle. "Ses Panelini Yönet" yetkisi olan sunucuda ses de eklenir.
 * Toast bu sayfanın (Modal) arkasında kalır: hatalar sayfanın içinde gösterilir.
 */
export function SoundboardSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [page, setPage] = useState<Page>({ kind: 'board' });
  const [notice, setNotice] = useState<BoardNotice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string, tone: BoardNotice['tone'] = 'danger') => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, tone });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);
  useEffect(() => {
    if (visible) {
      setPage({ kind: 'board' });
      setNotice(null);
    }
  }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onClose} avoidKeyboard={page.kind === 'upload'}>
      {page.kind === 'upload' ? (
        <SoundUploadForm
          guildId={page.guildId}
          file={page.file}
          onCancel={() => setPage({ kind: 'board' })}
          onDone={(sound) => {
            setPage({ kind: 'board' });
            showNotice(`${sound.name} eklendi.`, 'ok');
          }}
        />
      ) : (
        <Board notice={notice} showNotice={showNotice} onUpload={(guildId, file) => setPage({ kind: 'upload', guildId, file })} />
      )}
    </BottomSheet>
  );
}

function Board({
  notice,
  showNotice,
  onUpload,
}: {
  notice: BoardNotice | null;
  showNotice: (text: string) => void;
  onUpload: (guildId: string, file: LocalFile) => void;
}) {
  const guilds = useGuild((s) => s.guilds);
  const selfId = useSession((s) => s.user?.id);
  const channelId = useVoice((s) => s.channelId);
  const connected = useVoice((s) => s.status === 'connected');
  const cooling = useSoundboardCooling();
  const currentGuildId = useGuild((s) => (channelId ? s.channelGuild[channelId] : undefined));
  const window = useWindowDimensions();
  const tileWidth = Math.floor((window.width - GRID_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS);
  const picking = useRef(false);

  const groups = useMemo(() => {
    const shown = allSounds({ guilds })
      .map((group) => ({
        ...group,
        canManage: hasPermission(permissionsInGuild(guilds[group.guild.id], selfId), Permission.MANAGE_SOUNDBOARD),
      }))
      // Sesi olmayan sunucu yalnızca ses ekleyebilene görünür
      .filter((group) => group.sounds.length > 0 || group.canManage);
    return [...shown.filter((g) => g.guild.id === currentGuildId), ...shown.filter((g) => g.guild.id !== currentGuildId)];
  }, [guilds, selfId, currentGuildId]);

  const play = (sound: GuildSound): void => {
    haptic('tick');
    playGuildSound(sound).catch((err: unknown) => {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'rate_limited') return;
      feedback('error');
      showNotice(
        code === 'muted'
          ? 'Susturulmuşken ya da sağırken ses çalamazsın.'
          : code === 'not_in_voice'
            ? 'Önce bir ses kanalına katıl.'
            : code === 'unknown_sound'
              ? 'Bu ses artık yok.'
              : errorMessage(err),
      );
    });
  };

  const preview = (sound: GuildSound): void => {
    haptic('tick');
    previewSoundboardSound(guildSoundUrl(sound));
  };

  const add = async (guildId: string): Promise<void> => {
    if (picking.current) return;
    picking.current = true;
    try {
      const file = await pickGuildSound();
      if (file) onUpload(guildId, file);
    } catch (err) {
      showNotice(errorMessage(err));
    } finally {
      picking.current = false;
    }
  };

  return (
    <View style={styles.board}>
      <SheetHeader title="Ses Paneli" />
      <View style={styles.volume}>
        <SoundboardVolume />
      </View>
      {notice ? (
        <View style={styles.notice}>
          <Notice icon={notice.tone === 'ok' ? 'checkmark-circle' : 'alert-circle'} tone={notice.tone}>
            {notice.text}
          </Notice>
        </View>
      ) : null}
      <ScrollView style={[styles.scroll, { maxHeight: window.height * 0.6 }]} contentContainerStyle={styles.content}>
        {groups.length === 0 ? <Text style={styles.empty}>Henüz ses yok.</Text> : null}
        {groups.map(({ guild, sounds, canManage }) => {
          const full = sounds.length >= SOUNDBOARD_MAX_SOUNDS;
          return (
            <View key={guild.id} style={styles.group}>
              <View style={styles.groupHead}>
                <Text style={styles.groupTitle} numberOfLines={1}>
                  {guild.name}
                </Text>
                {canManage ? (
                  <Pressable
                    onPress={() => void add(guild.id)}
                    disabled={full}
                    hitSlop={8}
                    style={({ pressed }) => [styles.add, full && styles.dim, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${guild.name} sunucusuna ses ekle`}
                    accessibilityState={{ disabled: full }}
                  >
                    <Ionicons name="add" size={16} color={colors.brand} />
                    <Text style={styles.addText}>Ses ekle</Text>
                  </Pressable>
                ) : null}
              </View>
              {sounds.length === 0 ? <Text style={styles.emptyGroup}>Henüz ses yok.</Text> : null}
              <View style={styles.grid}>
                {sounds.map((sound) => (
                  <SoundTile
                    key={sound.id}
                    sound={sound}
                    width={tileWidth}
                    disabled={!connected || cooling}
                    onPlay={() => play(sound)}
                    onPreview={() => preview(sound)}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Kutucuk: emoji (yoksa nota) ve ad. Bağlantı kurulana ve çalınan ses bitene dek çalınamaz ama uzun basınca dinlenir. */
function SoundTile({
  sound,
  width,
  disabled,
  onPlay,
  onPreview,
}: {
  sound: GuildSound;
  width: number;
  disabled: boolean;
  onPlay: () => void;
  onPreview: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.92}
      ripple={{ color: tint(0.14), foreground: true }}
      containerStyle={{ width }}
      onPress={disabled ? undefined : onPlay}
      onLongPress={onPreview}
      delayLongPress={350}
      style={[styles.tile, disabled && styles.dim]}
      accessibilityRole="button"
      accessibilityLabel={`${sound.name}, herkese çal`}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'longpress', label: 'Yalnız kendin dinle' }]}
      onAccessibilityAction={onPreview}
    >
      {sound.emoji ? (
        <Text style={styles.emoji}>{sound.emoji}</Text>
      ) : (
        <Ionicons name="musical-notes" size={24} color={colors.muted} />
      )}
      <Text style={styles.name} numberOfLines={2}>
        {sound.name}
      </Text>
    </PressableScale>
  );
}

const styles = createStyles(() => ({
  board: { flexShrink: 1 },
  volume: { paddingHorizontal: space.lg + 2, paddingBottom: space.sm },
  notice: { marginHorizontal: GRID_PADDING, marginBottom: space.sm, borderRadius: radius.md, overflow: 'hidden' },
  scroll: { flexShrink: 1 },
  content: { paddingHorizontal: GRID_PADDING, paddingBottom: space.sm },
  empty: { color: colors.muted, fontSize: font.small, textAlign: 'center', paddingVertical: space.xl },
  emptyGroup: { color: colors.muted, fontSize: font.small, paddingHorizontal: space.xs, paddingBottom: space.sm },
  group: { marginBottom: space.md },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28, marginBottom: space.xs },
  groupTitle: {
    flex: 1,
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: space.xs,
  },
  add: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: space.xs },
  addText: { color: colors.brand, fontSize: font.small, fontWeight: '600' },
  dim: { opacity: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  tile: {
    height: 84,
    borderRadius: radius.md,
    backgroundColor: colors.main,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.xs,
    overflow: 'hidden',
  },
  emoji: { fontSize: 24, lineHeight: 30 },
  name: { color: colors.text, fontSize: font.caption, fontWeight: '500', textAlign: 'center', lineHeight: 15 },
}));
