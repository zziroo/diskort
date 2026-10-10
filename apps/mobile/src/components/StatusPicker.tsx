import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import {
  CUSTOM_STATUS_CLEAR_OPTIONS,
  CUSTOM_STATUS_MAX_LENGTH,
  STATUS_DESCRIPTIONS,
  STATUS_DURATIONS,
  STATUS_LABELS,
  type UserStatus,
} from '@diskort/shared';
import {
  formatRemaining,
  setCustomStatus,
  setUserStatus,
  useCustomStatus,
  useSelfStatus,
  useOnMobile,
  useSession,
  useStatus,
} from '@diskort/client-core';
import { colors, createStyles, font, radius, ripple, space } from '../theme';
import { Avatar } from './Avatar';
import { BottomSheet, SheetGroup } from './BottomSheet';
import { EmojiGrid } from './EmojiGrid';
import { StatusDot } from './StatusDot';
import { Button } from './ui';

const useStatusPicker = create<{ open: boolean }>(() => ({ open: false }));

/** Durum sayfasını açar (kendi avatarına dokununca). Sayfa StatusPickerHost ile bir kez çizilir. */
export function openStatusPicker(): void {
  useStatusPicker.setState({ open: true });
}

/** Uygulamada bir kez çizilir (bkz. _layout.tsx); openStatusPicker() ile açılır */
export function StatusPickerHost() {
  const open = useStatusPicker((s) => s.open);
  return <StatusPickerSheet visible={open} onClose={() => useStatusPicker.setState({ open: false })} />;
}

/** Ayarlar sayfasında adın altında: şu anki durumun ve özel durumun; dokununca durum sayfası açılır */
export function StatusChip() {
  const user = useSession((s) => s.user);
  const status = useStatus(user?.id);
  const custom = useCustomStatus(user?.id);
  return (
    <Pressable
      onPress={openStatusPicker}
      android_ripple={ripple.row}
      style={styles.chipButton}
      accessibilityRole="button"
      accessibilityLabel={`Durumun: ${STATUS_LABELS[status]}. Değiştir`}
    >
      <StatusDot status={status} size={12} surface={colors.main} />
      <Text style={styles.chipButtonText} numberOfLines={1}>
        {custom ? `${custom.emoji ? `${custom.emoji} ` : ''}${custom.text ?? ''}` : STATUS_LABELS[status]}
      </Text>
      <Ionicons name="chevron-down" size={14} color={colors.muted} />
    </Pressable>
  );
}

const STATUS_ORDER: UserStatus[] = ['online', 'idle', 'dnd', 'invisible'];

type Page = { kind: 'main' } | { kind: 'duration'; status: UserStatus } | { kind: 'custom' } | { kind: 'emoji' };

/**
 * Kendi durumun: çevrim içi / boşta / rahatsız etmeyin / görünmez (süre seçenekleriyle) ve özel durum
 * (emoji, kısa metin, ne zaman temizleneceği). Masaüstündeki profil kartının telefondaki karşılığı.
 */
export function StatusPickerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [page, setPage] = useState<Page>({ kind: 'main' });
  useEffect(() => {
    if (visible) setPage({ kind: 'main' });
  }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onClose} avoidKeyboard={page.kind === 'custom'}>
      {page.kind === 'main' && <MainPage onClose={onClose} onPage={setPage} />}
      {page.kind === 'duration' && (
        <DurationPage
          status={page.status}
          onBack={() => setPage({ kind: 'main' })}
          onChoose={(ms) => {
            onClose();
            void setUserStatus(page.status, ms);
          }}
        />
      )}
      {(page.kind === 'custom' || page.kind === 'emoji') && (
        <CustomPage
          pickingEmoji={page.kind === 'emoji'}
          onEmoji={(on) => setPage({ kind: on ? 'emoji' : 'custom' })}
          onBack={() => setPage({ kind: 'main' })}
          onDone={onClose}
        />
      )}
    </BottomSheet>
  );
}

function MainPage({ onClose, onPage }: { onClose: () => void; onPage: (page: Page) => void }) {
  const user = useSession((s) => s.user);
  const self = useSelfStatus();
  const status = useStatus(user?.id);
  const mobile = useOnMobile(user?.id);
  const custom = useCustomStatus(user?.id);
  const current = self?.status ?? 'online';
  const remaining = formatRemaining(self?.expiresAt ?? null);
  if (!user) return null;
  return (
    <View>
      <View style={styles.header}>
        <Avatar user={user} size={56} status={status} mobile={mobile} surface={colors.side} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {STATUS_LABELS[status]}
            {remaining ? ` · ${remaining} biter` : ''}
          </Text>
        </View>
      </View>

      {/* Özel durum: konuşma balonu gibi */}
      <Pressable
        onPress={() => onPage({ kind: 'custom' })}
        android_ripple={ripple.row}
        style={styles.bubble}
        accessibilityRole="button"
        accessibilityLabel={custom ? 'Özel durumu düzenle' : 'Özel durum ayarla'}
      >
        {custom ? (
          <Text style={styles.bubbleText} numberOfLines={3}>
            {custom.emoji ? `${custom.emoji} ` : ''}
            {custom.text}
          </Text>
        ) : (
          <View style={styles.bubbleEmpty}>
            <Ionicons name="happy-outline" size={20} color={colors.muted} />
            <Text style={[styles.bubbleText, { color: colors.muted }]}>Şu an canının çektiği bir şey var mı?</Text>
          </View>
        )}
        {custom ? (
          <Pressable
            hitSlop={10}
            onPress={() => void setCustomStatus(null)}
            accessibilityRole="button"
            accessibilityLabel="Özel durumu temizle"
          >
            <Ionicons name="close-circle" size={20} color={colors.muted} />
          </Pressable>
        ) : null}
      </Pressable>

      <SheetGroup>
        {STATUS_ORDER.map((option) => (
          <StatusRow
            key={option}
            status={option}
            selected={option === current}
            onPress={() => {
              if (option === 'online') {
                onClose();
                void setUserStatus('online');
              } else {
                onPage({ kind: 'duration', status: option });
              }
            }}
          />
        ))}
      </SheetGroup>
    </View>
  );
}

function StatusRow({ status, selected, onPress }: { status: UserStatus; selected: boolean; onPress: () => void }) {
  const description = STATUS_DESCRIPTIONS[status];
  return (
    <Pressable
      onPress={onPress}
      android_ripple={ripple.row}
      style={styles.row}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <View style={styles.rowIcon}>
        <StatusDot status={status} size={14} surface={colors.main} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowText}>{STATUS_LABELS[status]}</Text>
        {description ? <Text style={styles.rowHint}>{description}</Text> : null}
      </View>
      {selected ? <Ionicons name="checkmark" size={20} color={colors.brandText} /> : null}
      {status !== 'online' ? <Ionicons name="chevron-forward" size={18} color={colors.faint} /> : null}
    </Pressable>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.backHeader}>
      <Pressable hitSlop={12} onPress={onBack} accessibilityRole="button" accessibilityLabel="Geri">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.backTitle} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

function DurationPage({
  status,
  onBack,
  onChoose,
}: {
  status: UserStatus;
  onBack: () => void;
  onChoose: (ms: number | null) => void;
}) {
  return (
    <View>
      <BackHeader title={`${STATUS_LABELS[status]} · ne kadar süre?`} onBack={onBack} />
      <SheetGroup>
        {STATUS_DURATIONS.map((d) => (
          <Pressable key={d.label} onPress={() => onChoose(d.ms)} android_ripple={ripple.row} style={styles.row}>
            <View style={styles.rowIcon}>
              <StatusDot status={status} size={14} surface={colors.main} />
            </View>
            <Text style={[styles.rowText, { flex: 1 }]}>{d.ms === null ? d.label : `${d.label} boyunca`}</Text>
          </Pressable>
        ))}
      </SheetGroup>
    </View>
  );
}

type ClearOption = (typeof CUSTOM_STATUS_CLEAR_OPTIONS)[number]['ms'];

function CustomPage({
  pickingEmoji,
  onEmoji,
  onBack,
  onDone,
}: {
  pickingEmoji: boolean;
  onEmoji: (on: boolean) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const current = useSelfStatus()?.customStatus ?? null;
  const [text, setText] = useState(current?.text ?? '');
  const [emoji, setEmoji] = useState<string | null>(current?.emoji ?? null);
  const [clearAfter, setClearAfter] = useState<ClearOption>('today');
  const [busy, setBusy] = useState(false);

  if (pickingEmoji) {
    return (
      <View>
        <BackHeader title="Emoji seç" onBack={() => onEmoji(false)} />
        <EmojiGrid
          onPick={(e) => {
            setEmoji(e);
            onEmoji(false);
          }}
        />
      </View>
    );
  }

  const save = async (): Promise<void> => {
    setBusy(true);
    const ok = await setCustomStatus(text.trim() || emoji ? { text, emoji } : null, clearAfter);
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <View>
      <BackHeader title="Özel durum ayarla" onBack={onBack} />
      <View style={styles.inputRow}>
        <Pressable
          onPress={() => onEmoji(true)}
          hitSlop={6}
          style={styles.emojiButton}
          accessibilityRole="button"
          accessibilityLabel="Emoji seç"
        >
          {emoji ? <Text style={styles.emoji}>{emoji}</Text> : <Ionicons name="happy-outline" size={24} color={colors.muted} />}
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          maxLength={CUSTOM_STATUS_MAX_LENGTH}
          placeholder="Şu an canının çektiği bir şey var mı?"
          placeholderTextColor={colors.faint}
          selectionColor={colors.brand}
          cursorColor={colors.head}
          style={styles.input}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
        />
        {text || emoji ? (
          <Pressable
            hitSlop={10}
            onPress={() => {
              setText('');
              setEmoji(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Temizle"
          >
            <Ionicons name="close-circle" size={20} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.section}>Şundan sonra temizle</Text>
      <View style={styles.chips}>
        {CUSTOM_STATUS_CLEAR_OPTIONS.map((o) => {
          const on = o.ms === clearAfter;
          return (
            <Pressable
              key={o.label}
              onPress={() => setClearAfter(o.ms)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && { color: colors.white }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ paddingHorizontal: space.lg }}>
        <Button title="Kaydet" busy={busy} onPress={() => void save()} />
      </View>
    </View>
  );
}

const styles = createStyles(() => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg + 2, paddingBottom: space.md },
  name: { color: colors.head, fontSize: font.title + 1, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.main,
    overflow: 'hidden',
  },
  bubbleEmpty: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bubbleText: { flex: 1, color: colors.text, fontSize: font.body },
  row: { flexDirection: 'row', alignItems: 'center', gap: 15, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.md },
  rowIcon: { width: 21, alignItems: 'center' },
  rowText: { color: colors.head, fontSize: font.row, fontWeight: '500' },
  rowHint: { color: colors.muted, fontSize: font.caption + 0.5, marginTop: 2 },
  backHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md },
  backTitle: { flex: 1, color: colors.head, fontSize: font.title, fontWeight: '700' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.input,
  },
  emojiButton: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 22 },
  input: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: space.md },
  section: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: space.lg + 2,
    marginBottom: space.sm,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.md, marginBottom: space.lg },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.main },
  chipOn: { backgroundColor: colors.brand },
  chipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'center',
    maxWidth: '90%',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.main,
    overflow: 'hidden',
  },
  chipButtonText: { flexShrink: 1, color: colors.text, fontSize: font.small, fontWeight: '600' },
  chipText: { color: colors.text, fontSize: font.small, fontWeight: '600' },
}));
