import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
// Gesture-handler'ın kaydırma görünümü: yatay kaydırma sol paneli açan sağa kaydırmayla çakışmasın (önce o kazanır)
import { ScrollView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { MESSAGE_MAX_LENGTH, Permission, type Channel, type Role, type User } from '@diskort/shared';
import {
  addFiles,
  broadcastSuggestions,
  decodeRoleMentions,
  editMessage,
  encodeRoleMentions,
  typableRoles,
  formatBytes,
  insertText,
  notifyTyping,
  registerComposer,
  removeFile,
  roleMentionText,
  roleSuggestions,
  sendGif,
  sendMessage,
  useCan,
  useFeatures,
  useGuild,
  useMessages,
  type LocalFile,
  type LocalMessage,
  type MemberUser,
} from '@diskort/client-core';
import { pickDocuments, pickMedia } from '../attachments';
import { useAppear, useBump, useLayoutAnimationOn, useTimingTo } from '../motion';
import { toast } from '../stores/ui';
import { brandTint, colors, createStyles, font, radius, ripple, space, text as textStyles, tint, useTheme } from '../theme';
import { fileIcon } from './Attachments';
import { PresenceAvatar } from './Avatar';
import { BottomSheet, SheetHeader } from './BottomSheet';
import { ExpressionSheet, type ExpressionTab } from './ExpressionSheet';
import { PressableScale } from './PressableScale';
import { ContextBar } from './ContextBar';
import { ComposerText } from './Markdown';
import { ReplyBar } from './ReplyBar';

/** Kanal değiştirince yarım kalan mesaj kaybolmasın */
const drafts = new Map<string, string>();

/**
 * Herhangi bir kanalda gönderilmeyi bekleyen (boşluktan ibaret olmayan) taslak metin var mı. Güncelleme
 * şeridinden yeniden başlatmadan önce (bkz. UpdateBanner) varsa kullanıcıya sorulur; yeniden başlatma
 * taslağı siler. Artık görülemeyen (sunucudan çıkıldı, DM kapandı) kanalların taslakları burada süzülür
 * ve haritadan silinir: yoksa hiç açılamayacak bir kanalın taslağı için boşuna sorulurdu.
 */
export function hasDraftText(): boolean {
  if (drafts.size === 0) return false;
  const guild = useGuild.getState();
  let found = false;
  for (const id of [...drafts.keys()]) {
    if (guild.channelGuild[id] || guild.dms[id]) found = true;
    else drafts.delete(id);
  }
  return found;
}

/** Şu an düzenleme kipinde açık kutusu olan kanallar (bkz. Composer bileşeni: editing prop'u izler) */
const openEdits = new Set<string>();

/** Herhangi bir kanalda açık bir mesaj düzenlemesi var mı: güncelleme için yeniden başlatmadan önce sorulur. */
export function hasOpenEdit(): boolean {
  return openEdits.size > 0;
}

// Rol adlarında Türkçe harfler olabilir (\p{…} yok: Hermes); boşluk içeren rol adının ilk sözcüğüyle aranır
const MENTION_QUERY = /(?:^|[\s(])@([a-z0-9_.çğıöşüâîûÇĞİÖŞÜÂÎÛ]{0,32})$/i;
const NO_FILES: LocalFile[] = [];
const NO_ROLES: Record<string, Role> = {};

/** Bilinen bir kullanıcı adı mı (adı kullanıcı adıyla aynı rol kutuda gömülü biçimiyle kalır) */
const isUsername = (name: string): boolean => Object.values(useGuild.getState().users).some((u) => u.username === name);
// Bahsetme yazılmıyorken (çoğu zaman) kullanıcı/çevrimiçi listesine hiç ihtiyaç yok: sabit boş nesneler
// döndürülünce zustand aboneliği tetiklemez, yazma kutusu her üye/çevrimiçi güncellemesinde yeniden çizilmez.
const EMPTY_USERS: Record<string, MemberUser> = {};
const EMPTY_ONLINE: Record<string, true> = {};

interface Props {
  /** Metin kanalı ya da direkt mesaj konuşması (kimlik ve görünen ad) */
  channel: Pick<Channel, 'id' | 'name'>;
  /** Düzenlenen mesaj (varsa kutu düzenleme kipine geçer) */
  editing: LocalMessage | null;
  onDoneEditing: () => void;
  onSent: () => void;
  /** Kutudaki ipucu (verilmezse "#kanal kanalına mesaj gönder") */
  placeholder?: string;
  /** Yazılamıyorsa kutu yerine gösterilecek açıklama (verilmezse izin yok mesajı) */
  lockedText?: string;
  /** Kilitli kutunun sağında işlem (ör. engellediğin kişide "Engeli kaldır") */
  lockedAction?: { title: string; onPress: () => void };
  /** Bahsetme önerilerinde yalnızca bu kişiler (ör. konuşmanın katılımcıları) */
  mentionable?: readonly string[];
}

export function Composer({
  channel,
  editing,
  onDoneEditing,
  onSent,
  placeholder,
  lockedText,
  lockedAction,
  mentionable,
}: Props) {
  const [value, setValue] = useState(() => drafts.get(channel.id) ?? '');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  // İmleç yalnızca bahsetme seçilince bir kez ayarlanır (sürekli kontrol Android'de imleci zıplatır)
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>();
  const [editText, setEditText] = useState<string | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [expressions, setExpressions] = useState<ExpressionTab | null>(null);
  const gifsEnabled = useFeatures((s) => s.gifs);
  // Rol etiketi yalnızca sunucu kanalında (direkt mesajda `mentionable` verilir, rol yoktur)
  const roleScope = useGuild((s) => (mentionable ? null : (s.channelGuild[channel.id] ?? null)));
  const roles = useGuild((s) => (roleScope ? (s.guilds[roleScope]?.roles ?? NO_ROLES) : NO_ROLES));
  // Düzenleme kipine geçince mesaj metniyle başla; rol etiketleri (`<@&kimlik>`) kutuda `@Rol Adı` görünür
  const editingText = useMemo(
    () => (editing ? (roleScope ? decodeRoleMentions(editing.content, roles, isUsername) : editing.content) : ''),
    // Yalnızca düzenleme başlarken: sonradan değişen rol listesi yazılanı değiştirmesin
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing],
  );
  const text = editing ? (editText ?? editingText) : value;
  const query = MENTION_QUERY.exec(text.slice(0, selection.start))?.[1];
  // Yalnızca bahsetme yazılırken gerçek listeler abone olunur (bkz. EMPTY_USERS/EMPTY_ONLINE yukarısı)
  const users = useGuild((s) => (query !== undefined ? s.users : EMPTY_USERS));
  const online = useGuild((s) => (query !== undefined ? s.online : EMPTY_ONLINE));
  const files = useMessages((s) => s.pendingFiles[channel.id] ?? NO_FILES);
  const canSend = useCan(Permission.SEND_MESSAGES, channel.id);
  const canAttach = useCan(Permission.ATTACH_FILES, channel.id);
  // @everyone / @here yalnızca yetkisi olana önerilir (direkt mesajda bu yetki yoktur)
  const canMentionEveryone = useCan(Permission.MENTION_EVERYONE, channel.id);

  const setText = (next: string): void => {
    if (editing) {
      setEditText(next);
      return;
    }
    setValue(next);
    // Yalnızca boşluktan ibaret metin taslak sayılmaz (bkz. hasDraftText, UpdateBanner)
    if (next.trim()) drafts.set(channel.id, next);
    else drafts.delete(channel.id);
    if (next.trim()) notifyTyping(channel.id);
  };

  const suggestions = useMemo(() => {
    if (query === undefined) return [];
    const q = query.toLocaleLowerCase('tr');
    return Object.values(users)
      .filter((u) => !u.removed && (!mentionable || mentionable.includes(u.id)))
      .filter((u) => u.username.startsWith(q) || u.displayName.toLocaleLowerCase('tr').includes(q))
      .sort((a, b) => Number(!!online[b.id]) - Number(!!online[a.id]) || a.username.localeCompare(b.username))
      .slice(0, 5);
  }, [query, users, online, mentionable]);
  const roleItems = useMemo(
    () => (query === undefined || !roleScope ? [] : roleSuggestions(query, roles, roleScope, 3)),
    [query, roles, roleScope],
  );
  const broadcasts = useMemo(
    () => (query === undefined ? [] : broadcastSuggestions(query, canMentionEveryone)),
    [query, canMentionEveryone],
  );

  // Yazma kutusunun üstüne şerit (yanıt, düzenleme, dosyalar, öneriler) gelip gidince liste
  // sıçramak yerine yumuşakça kayar
  const replying = useMessages((s) => Boolean(s.replies[channel.id]));
  useLayoutAnimationOn(`${files.length}:${replying}:${Boolean(editing)}:${suggestions.length + roleItems.length > 0}`, 180, false);

  // Düzenleme kipindeyken kanal açık düzenleme olarak işaretlenir (bkz. hasOpenEdit, UpdateBanner):
  // güncelleme için yeniden başlatmadan önce sorulur. ChannelChat, editing değişince Composer'ı
  // `key` ile yeniden kurduğundan (bkz. ChannelChat.tsx) bu efekt her düzenleme oturumu için bir kez çalışır.
  useEffect(() => {
    if (!editing) return;
    openEdits.add(channel.id);
    return () => {
      openEdits.delete(channel.id);
    };
  }, [editing, channel.id]);

  /**
   * Metni JS'ten değiştirdikten (bahsetme, emoji, dışarıdan ekleme) sonra imleci eklenenin sonuna koyar.
   * Kutu `value` değil stilli çocuklarla çizildiği için yeni metin yerel görünüme bir durum güncellemesiyle,
   * imleç ise ayrı bir komutla gider; Android komutları aynı karedeki metin güncellemesinden ÖNCE işler
   * (imleç eski metnin boyuna kırpılır). Kısa bir gecikmeyle bir kez daha istenir: imleç zaten doğru
   * yerdeyse TextInput komutu göndermez.
   */
  const caretRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(caretRetry.current), []);
  const placeCaret = (at: number): void => {
    clearTimeout(caretRetry.current);
    setSelection({ start: at, end: at });
    setForcedSelection({ start: at, end: at });
    caretRetry.current = setTimeout(() => {
      setSelection({ start: at, end: at });
      setForcedSelection({ start: at, end: at });
    }, 60);
  };

  /** Öneriden seçilen: kullanıcı / @everyone adıyla; rol kutuda adıyla görünür, gönderirken çevrilir */
  const pick = (target: Pick<User, 'username'> | { role: Role }): void => {
    const inserted = 'role' in target ? roleMentionText(target.role, isUsername) : `@${target.username} `;
    const before = text.slice(0, selection.start).replace(/@[a-z0-9_.çğıöşüâîûÇĞİÖŞÜÂÎÛ]*$/i, () => inserted);
    setText(before + text.slice(selection.start));
    placeCaret(before.length);
  };

  /** Emoji: imlecin olduğu yere (seçiliyse yerine) eklenir */
  const insert = (emoji: string): void => {
    setText(text.slice(0, selection.start) + emoji + text.slice(selection.end));
    placeCaret(selection.start + emoji.length);
  };

  // Dışarıdan erişim (yazarın adına dokununca bahsetme, "Yanıtla" deyince odaklanma): bkz. client-core/composer
  const input = useRef<TextInput>(null);
  const insertAtCaret = useRef((_text: string) => {});
  insertAtCaret.current = (inserted: string): void => {
    const next = insertText(text, selection.start, selection.end, inserted);
    setText(next.value);
    placeCaret(next.caret);
    input.current?.focus();
  };
  useEffect(() => {
    if (!canSend && !editing) return;
    return registerComposer(channel.id, {
      // Uzun basma menüsü kapanırken odaklanılırsa klavye açılmayabilir; sayfa kapandıktan sonra
      focus: () => setTimeout(() => input.current?.focus(), 250),
      insert: (inserted) => insertAtCaret.current(inserted),
    });
  }, [channel.id, canSend, editing]);

  // Dosyalı mesajın metni boş olabilir
  const canSubmit = Boolean(text.trim()) || (editing ? editing.attachments.length > 0 : files.length > 0);

  const submit = (): void => {
    if (!canSubmit) return;
    // `@Rol Adı` yazıları rol etiketine (`<@&kimlik>`) çevrilir; sınır gönderilecek metne uygulanır
    const typed = text.trim();
    const content = roleScope ? encodeRoleMentions(typed, typableRoles(roles, roleScope), isUsername) : typed;
    if (content.length > MESSAGE_MAX_LENGTH) {
      toast(`Mesaj en fazla ${MESSAGE_MAX_LENGTH} karakter olabilir.`, 'error');
      return;
    }
    if (editing) {
      if (content !== editing.content) void editMessage(editing, content);
      setEditText(null);
      onDoneEditing();
      return;
    }
    sendMessage(channel.id, content);
    setText('');
    onSent();
  };

  const attach = async (pick: () => Promise<LocalFile[]>): Promise<void> => {
    setAttachMenu(false);
    try {
      const picked = await pick();
      if (picked.length) addFiles(channel.id, picked);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Dosya seçilemedi.', 'error');
    }
  };

  // Tema değişince de yeniden çizilsin (stiller temaya bağlı)
  const themeVersion = useTheme((s) => s.version);
  const styledText = useMemo(
    () => <ComposerText text={text} lineHeight={LINE_HEIGHT} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, themeVersion],
  );

  const remaining = MESSAGE_MAX_LENGTH - text.trim().length;
  const hint = placeholder ?? `#${channel.name} kanalına mesaj gönder`;

  // Salt okunur kanal (kendi mesajını düzenlemek yine serbest)
  if ((!canSend || lockedText) && !editing) {
    return (
      <View style={styles.locked}>
        <Ionicons name="lock-closed" size={16} color={colors.muted} />
        <Text style={styles.lockedText}>{lockedText ?? 'Bu kanala mesaj gönderme iznin yok.'}</Text>
        {lockedAction ? (
          <Pressable
            onPress={lockedAction.onPress}
            hitSlop={8}
            accessibilityRole="button"
            style={styles.lockedAction}
          >
            <Text style={styles.lockedActionText}>{lockedAction.title}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {suggestions.length + roleItems.length + broadcasts.length > 0 && (
        <Suggestions>
          {suggestions.map((u) => (
            <Pressable key={u.id} android_ripple={ripple.row} style={styles.suggestion} onPress={() => pick(u)}>
              <PresenceAvatar userId={u.id} user={u} size={28} surface={colors.side} />
              <Text style={styles.suggestionName}>{u.displayName}</Text>
              <Text style={styles.suggestionUser}>@{u.username}</Text>
            </Pressable>
          ))}
          {roleItems.map((r) => (
            <Pressable key={r.id} android_ripple={ripple.row} style={styles.suggestion} onPress={() => pick({ role: r })}>
              <Ionicons
                name="at"
                size={22}
                color={r.color ?? colors.mention}
                style={{ width: 26, textAlign: 'center' }}
              />
              <Text style={[styles.suggestionName, { flexShrink: 1 }, r.color ? { color: r.color } : null]} numberOfLines={1}>
                @{r.name}
              </Text>
              <Text style={styles.suggestionUser}>Rol</Text>
            </Pressable>
          ))}
          {broadcasts.map((b) => (
            <Pressable
              key={b.name}
              style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.active }]}
              onPress={() => pick({ username: b.name })}
            >
              <Ionicons name="at" size={22} color={colors.muted} style={{ width: 26, textAlign: 'center' }} />
              <Text style={styles.suggestionName}>@{b.name}</Text>
              <Text style={[styles.suggestionUser, { flexShrink: 1 }]} numberOfLines={1}>
                {b.description}
              </Text>
            </Pressable>
          ))}
        </Suggestions>
      )}
      {editing && (
        <ContextBar>
          <Ionicons name="create-outline" size={15} color={colors.brandText} />
          <Text style={styles.editText}>Mesajı düzenliyorsun</Text>
          <Pressable
            hitSlop={10}
            onPress={() => {
              setEditText(null);
              onDoneEditing();
            }}
            accessibilityLabel="Düzenlemeyi bırak"
          >
            <Ionicons name="close-circle" size={20} color={colors.muted} />
          </Pressable>
        </ContextBar>
      )}
      {!editing && <ReplyBar channelId={channel.id} />}
      {!editing && files.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tray}
          contentContainerStyle={styles.trayContent}
          keyboardShouldPersistTaps="handled"
        >
          {files.map((file, i) => (
            <TrayItem key={`${file.uri}-${i}`} file={file} onRemove={() => removeFile(channel.id, i)} />
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        {!editing && canAttach && (
          <PressableScale
            scaleTo={0.86}
            onPress={() => setAttachMenu(true)}
            ripple={{ color: tint(0.14), borderless: true, radius: 21 }}
            style={styles.circle}
            accessibilityLabel="Dosya ekle"
          >
            <Ionicons name="add" size={26} color={colors.text} />
          </PressableScale>
        )}
        <View style={styles.field}>
          {/* Android'in kendi ipucu tek satıra sığdırılamıyor (kayıp kutuyu iki satır yapıyor): ipucu,
              Discord'daki gibi tek satırda "…" ile kısalan kendi yazımızla gösterilir */}
          <View style={styles.inputWrap}>
            {!text && (
              <View pointerEvents="none" style={styles.placeholder}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.placeholderText}>
                  {hint}
                </Text>
              </View>
            )}
            {/* `value` yerine stilli çocuklar: biçimlendirme yazarken canlı görünür (bkz. ComposerText). Metin
                aynen kalır, onChangeText düz metni verir; gönderilen içerik yazılanın kendisidir. */}
            <TextInput
              ref={input}
              onChangeText={(t) => {
                // Yazılırsa bekleyen imleç tekrarı iptal: imleci geri çekmesin
                clearTimeout(caretRetry.current);
                setText(t);
              }}
              onSelectionChange={(e) => {
                setSelection(e.nativeEvent.selection);
                setForcedSelection(undefined);
              }}
              selection={forcedSelection}
              accessibilityLabel={hint}
              selectionColor={brandTint(0.5)}
              cursorColor={colors.head}
              multiline
              maxLength={MESSAGE_MAX_LENGTH * 2}
              style={styles.input}
            >
              {styledText}
            </TextInput>
          </View>
          {remaining < 200 && <Text style={[styles.counter, remaining < 0 && { color: colors.danger }]}>{remaining}</Text>}
          {gifsEnabled && !editing && (
            <PressableScale
              scaleTo={0.85}
              onPress={() => setExpressions('gif')}
              hitSlop={6}
              style={styles.gifButton}
              accessibilityLabel="GIF"
            >
              <Text style={styles.gifButtonText}>GIF</Text>
            </PressableScale>
          )}
          <PressableScale
            scaleTo={0.85}
            onPress={() => setExpressions('emoji')}
            ripple={{ color: tint(0.14), borderless: true, radius: 18 }}
            hitSlop={4}
            style={styles.fieldIcon}
            accessibilityLabel="Emoji"
          >
            <Ionicons name="happy-outline" size={24} color={colors.muted} />
          </PressableScale>
        </View>
        <SendButton ready={canSubmit} editing={Boolean(editing)} onPress={submit} />
      </View>

      <ExpressionSheet
        tab={expressions}
        gifs={gifsEnabled && !editing}
        onTab={setExpressions}
        onClose={() => setExpressions(null)}
        onEmoji={(emoji) => {
          insert(emoji);
          setExpressions(null);
        }}
        onGif={(gif) => {
          setExpressions(null);
          sendGif(channel.id, gif);
          onSent();
        }}
      />
      <BottomSheet visible={attachMenu} onClose={() => setAttachMenu(false)}>
        <SheetHeader title="Ekle" subtitle="Dosyalar mesajla birlikte gönderilir" />
        <View style={styles.attachTiles}>
          <AttachTile icon="images" color={colors.brand} label="Fotoğraf veya video" onPress={() => void attach(pickMedia)} />
          <AttachTile icon="document" color={colors.ok} label="Dosya" onPress={() => void attach(pickDocuments)} />
        </View>
      </BottomSheet>
    </View>
  );
}

/**
 * Gönder düğmesi: gönderilecek bir şey yokken sönük, yazınca mor dolgu yumuşakça gelir ve simge
 * zıplar. Genişliği hep aynı: yazmaya başlayınca kutu kaymaz.
 */
function SendButton({ ready, editing, onPress }: { ready: boolean; editing: boolean; onPress: () => void }) {
  const fill = useTimingTo(ready ? 1 : 0, 150);
  const bump = useBump(ready);
  return (
    <PressableScale
      scaleTo={0.86}
      onPress={onPress}
      disabled={!ready}
      accessibilityLabel={editing ? 'Kaydet' : 'Gönder'}
      accessibilityState={{ disabled: !ready }}
      style={styles.circle}
    >
      <Animated.View style={[StyleSheet.absoluteFill, styles.sendFill, { opacity: fill }]} />
      <Animated.View style={{ transform: [{ scale: bump }] }}>
        <Ionicons name={editing ? 'checkmark' : 'send'} size={editing ? 22 : 18} color={ready ? '#fff' : colors.faint} />
      </Animated.View>
    </PressableScale>
  );
}

/** Eklenen dosya: resimse küçük önizleme, değilse simge; köşede kaldır düğmesi. Büyüyerek belirir. */
function TrayItem({ file, onRemove }: { file: LocalFile; onRemove: () => void }) {
  const appear = useAppear(true, 200);
  const image = Boolean(file.uri) && /^image\/(png|jpeg|gif|webp)$/.test(file.type);
  return (
    <Animated.View
      style={[
        styles.trayItem,
        { opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] },
      ]}
    >
      {image ? (
        <Image source={{ uri: file.uri }} style={styles.trayImage} />
      ) : (
        <View style={[styles.trayImage, styles.trayIcon]}>
          <Ionicons name={fileIcon(file.type)} size={30} color={colors.muted} />
        </View>
      )}
      <Text style={styles.trayName} numberOfLines={1}>
        {file.name}
      </Text>
      <Text style={styles.traySize}>{formatBytes(file.size)}</Text>
      <Pressable hitSlop={8} style={styles.trayRemove} onPress={onRemove} accessibilityLabel={`${file.name} dosyasını kaldır`}>
        <Ionicons name="close" size={14} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

/** @bahsetme önerileri: yazma kutusunun üstünde hafifçe yükselerek belirir */
function Suggestions({ children }: { children: ReactNode }) {
  const appear = useAppear(true, 160);
  return (
    <Animated.View
      style={[
        styles.suggestions,
        {
          opacity: appear,
          transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
      <Text style={styles.suggestionsTitle}>Üyeler</Text>
      {children}
    </Animated.View>
  );
}

function AttachTile({
  icon,
  color,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <PressableScale scaleTo={0.95} ripple onPress={onPress} containerStyle={{ flex: 1 }} style={styles.tile} accessibilityRole="button">
      <View style={[styles.tileIcon, { backgroundColor: color }]}>
        <Ionicons name={icon} size={24} color="#fff" />
      </View>
      <Text style={styles.tileText}>{label}</Text>
    </PressableScale>
  );
}

/** Yazma kutusu ölçüleri: tek satırken düğmelerle aynı boy, en çok 6 satıra kadar uzar */
const FIELD_HEIGHT = 42;
const LINE_HEIGHT = 21;
const MAX_LINES = 6;
const INPUT_PADDING = (FIELD_HEIGHT - LINE_HEIGHT) / 2;

const styles = createStyles(() => ({
  wrap: { backgroundColor: colors.main },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.sm + 2, paddingTop: 6, paddingBottom: space.sm },
  circle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.field,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sendFill: { backgroundColor: colors.brand, borderRadius: 21 },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: FIELD_HEIGHT,
    borderRadius: 21,
    backgroundColor: colors.field,
    paddingLeft: space.lg,
    paddingRight: 4,
  },
  inputWrap: { flex: 1, minHeight: FIELD_HEIGHT, justifyContent: 'flex-end' },
  // Tek satırken tam bir satır (düğmelerle aynı boy); yazdıkça kendiliğinden uzar, 6 satırdan sonra
  // içinde kayar. Satır yüksekliği sabit: Android'in yazı tipi boşluğu kutuyu şişirmesin.
  input: {
    minHeight: FIELD_HEIGHT,
    maxHeight: LINE_HEIGHT * MAX_LINES + INPUT_PADDING * 2,
    paddingTop: INPUT_PADDING,
    paddingBottom: INPUT_PADDING,
    paddingHorizontal: 0,
    color: colors.text,
    fontSize: font.row,
    lineHeight: LINE_HEIGHT,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  placeholder: { position: 'absolute', left: 0, right: 0, top: 0, height: FIELD_HEIGHT, justifyContent: 'center' },
  placeholderText: { color: colors.faint, fontSize: font.row, lineHeight: LINE_HEIGHT, includeFontPadding: false },
  fieldIcon: { width: 36, height: 42, alignItems: 'center', justifyContent: 'center' },
  gifButton: {
    height: 42,
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  gifButtonText: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '800',
    letterSpacing: 0.3,
    borderWidth: 1.5,
    borderColor: colors.muted,
    borderRadius: 5,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  locked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    margin: space.sm,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: colors.side,
  },
  lockedText: { color: colors.muted, fontSize: 15, flexShrink: 1 },
  lockedAction: { marginLeft: 'auto', paddingVertical: 6, paddingLeft: space.xs },
  lockedActionText: { color: colors.link, fontSize: 15, fontWeight: '700' },
  tray: { flexGrow: 0 },
  trayContent: { gap: 10, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: 4 },
  trayItem: { width: 88 },
  trayImage: { width: 88, height: 88, borderRadius: radius.lg - 4, backgroundColor: colors.side },
  trayIcon: { alignItems: 'center', justifyContent: 'center' },
  trayName: { color: colors.text, fontSize: 12, marginTop: 4 },
  traySize: { color: colors.muted, fontSize: 11 },
  trayRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
    borderWidth: 2,
    borderColor: colors.main,
  },
  attachTiles: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.md, paddingBottom: space.sm },
  tile: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.lg,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.main,
    overflow: 'hidden',
  },
  tileIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  tileText: { color: colors.head, fontSize: font.body - 0.5, fontWeight: '600' },
  counter: { color: colors.muted, fontSize: 12, alignSelf: 'center', marginHorizontal: 4 },
  suggestions: {
    backgroundColor: colors.side,
    marginHorizontal: space.sm,
    borderRadius: radius.lg - 4,
    paddingVertical: 6,
    marginBottom: 4,
    overflow: 'hidden',
    elevation: 4,
  },
  suggestionsTitle: { ...textStyles.section, paddingHorizontal: 14, paddingVertical: 4 },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  suggestionName: { color: colors.head, fontSize: 15, fontWeight: '600' },
  suggestionUser: { color: colors.muted, fontSize: 13 },
  editText: { flex: 1, color: colors.muted, fontSize: 13.5, fontWeight: '600' },
}));
