import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  animatedDecoration,
  animatedDecorationId,
  userEffectId,
  userNameplateId,
  type AnimatedDecoration,
  type CosmeticSetId,
  type ProfileTheme,
  type User,
} from '@diskort/shared';
import {
  cosmeticPacks,
  errorMessage,
  introSoundUrl,
  PROFILE_THEME_PRESETS,
  profileGradient,
  refreshCosmeticPacks,
  removeAvatar,
  removeBanner,
  removeIntroSound,
  updateProfileLook,
  uploadAvatar,
  uploadBanner,
  uploadIntroSound,
  useCosmeticManifest,
  useSession,
} from '@diskort/client-core';
import { pickAvatar, pickBanner, pickIntroSound } from '../../attachments';
import { playIntroSound, soundsAvailable } from '../../sounds';
import { toast } from '../../stores/ui';
import { colors, createStyles, font, radius, space } from '../../theme';
import { Avatar, PresenceAvatar } from '../Avatar';
import { useHasSkia, NAMEPLATE_TEXT_SHADOW, NameplateBackground, nameplateNameColor, SetThumb } from '../cosmetics/Cosmetics';
import { confirmDialog } from '../Dialog';
import { PressableScale } from '../PressableScale';
import { ProfileHeader } from '../ProfileHeader';
import { StatusChip } from '../StatusPicker';
import { Button, Card, Choices, SectionTitle } from '../ui';

/**
 * Ayarlar → Profil (masaüstündeki profil fotoğrafı ve süsler): fotoğraf galeriden seçilip kare
 * kırpılır; durum ve özel durum; profil süsleri (afiş, tema, efekt).
 * En üstteki kart, üyelerin gördüğü profil kartının canlı önizlemesidir.
 */
export function ProfileSettings() {
  const user = useSession((s) => s.user);
  const photo = useProfilePhoto();
  const banner = useProfileBanner();
  const intro = useIntroSound();
  const introUrl = introSoundUrl(user);
  const look = useProfileLook();
  // Hareketli setler yalnızca Skia'lı uygulamada sunulur (yoksa gösterilemez)
  const animated = useHasSkia();
  // Seçilebilir setler sunucudaki bildirimden gelir (yeni set yayınlanınca uygulama güncellemesi gerekmez);
  // sayfa açılırken tazelenir
  useCosmeticManifest();
  const sets = cosmeticPacks.selectable();
  useEffect(() => {
    void refreshCosmeticPacks();
  }, []);

  if (!user) return null;
  // Önizleme: seçimler kaydedilmeden önce de kartta görünür
  const preview: User = {
    ...user,
    profileTheme: look.theme,
    animatedEffect: look.effect,
    avatarDecoration: look.decoration,
    nameplate: look.nameplate,
  };
  // Setin üç parçası birden seçili mi
  const appliedSet =
    sets.find((set) => look.effect === set && animatedDecorationId(look.decoration) === set && look.nameplate === set) ?? null;
  const effectOptions: { value: CosmeticSetId | 'none'; label: string }[] = [
    { value: 'none', label: 'Yok' },
    ...sets.map((set) => ({ value: set, label: cosmeticPacks.label(set) ?? set })),
  ];
  return (
    <View>
      <ProfileHeader
        user={preview}
        centered
        avatar={(ring) => (
          <PressableScale
            scaleTo={0.94}
            onPress={() => void photo.change()}
            disabled={photo.busy !== null}
            accessibilityLabel="Profil fotoğrafını değiştir"
          >
            {/* Önizleme kartı açık profildir: seçili dekorasyon burada oynar */}
            <PresenceAvatar userId={user.id} user={user} size={88} surface={ring} decoration={look.decoration} animateDecoration />
            <View style={[styles.cameraBadge, { borderColor: ring }]}>
              {photo.busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="camera" size={15} color="#fff" />}
            </View>
          </PressableScale>
        )}
      >
        <StatusChip />
        {user.avatarUrl ? (
          <Pressable
            onPress={() => void photo.remove()}
            disabled={photo.busy !== null}
            hitSlop={8}
            style={styles.removePhoto}
            accessibilityRole="button"
          >
            <Text style={styles.removePhotoText}>Fotoğrafı kaldır</Text>
          </Pressable>
        ) : (
          <Text style={styles.photoHint}>Fotoğraf eklemek için avatara dokun</Text>
        )}
      </ProfileHeader>

      <SectionTitle>Afiş</SectionTitle>
      <Card style={styles.pad}>
        <Text style={styles.hint}>Profil kartının üstündeki geniş resim. Seçerken 17:6 kırpılır.</Text>
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button
              title={user.bannerUrl ? 'Afişi değiştir' : 'Afiş seç'}
              busy={banner.busy === 'upload'}
              disabled={banner.busy !== null}
              onPress={() => void banner.change()}
            />
          </View>
          {user.bannerUrl ? (
            <View style={styles.button}>
              <Button
                title="Kaldır"
                variant="secondary"
                busy={banner.busy === 'remove'}
                disabled={banner.busy !== null}
                onPress={() => void banner.remove()}
              />
            </View>
          ) : null}
        </View>
      </Card>

      <SectionTitle>Giriş Sesi</SectionTitle>
      <Card style={styles.pad}>
        <Text style={styles.hint}>MP3, WAV, OGG, M4A… İlk 5 saniyesi alınır. Kanala girince herkes duyar.</Text>
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button
              title={introUrl ? 'Değiştir' : 'Ses seç'}
              busy={intro.busy === 'upload'}
              disabled={intro.busy !== null}
              onPress={() => void intro.change()}
            />
          </View>
          {introUrl && soundsAvailable() ? (
            <View style={styles.button}>
              <Button
                title="Dinle"
                variant="secondary"
                onPress={() => playIntroSound(introUrl, { preview: true })}
              />
            </View>
          ) : null}
          {introUrl ? (
            <View style={styles.button}>
              <Button
                title="Kaldır"
                variant="secondary"
                busy={intro.busy === 'remove'}
                disabled={intro.busy !== null}
                onPress={() => void intro.remove()}
              />
            </View>
          ) : null}
        </View>
      </Card>

      <SectionTitle>Profil teması</SectionTitle>
      <Card style={styles.pad}>
        <Text style={styles.hint}>Profil kartının zemini: yukarıdan aşağıya iki renk.</Text>
        <View style={styles.colors} accessibilityRole="radiogroup" accessibilityLabel="Profil teması">
          <Pressable
            onPress={() => look.setTheme(null)}
            style={[styles.swatch, styles.swatchNone, look.theme === null && styles.swatchOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: look.theme === null }}
            accessibilityLabel="Yok"
          >
            <Ionicons name={look.theme === null ? 'checkmark' : 'close'} size={20} color={colors.muted} />
          </Pressable>
          {PROFILE_THEME_PRESETS.map((preset) => {
            const selected = sameTheme(look.theme, preset);
            return (
              <Pressable
                key={preset.name}
                onPress={() => look.setTheme({ primary: preset.primary, accent: preset.accent })}
                style={[styles.swatch, selected && styles.swatchOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={preset.name}
              >
                {/* Degrade kenarlığı hiç olmayan ayrı görünümde (#28, #29): Android'de (RN 0.86) kenarlık kaldırılınca
                    genişlik NaN gelir, degradeli görünümde LinearGradient NaN noktalarla kurulur ve uygulama çöker
                    (IllegalArgumentException, BackgroundImageDrawable.draw) */}
                <View
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, { experimental_backgroundImage: profileGradient(preset) }]}
                />
                {selected ? <Ionicons name="checkmark" size={20} color="#fff" /> : null}
              </Pressable>
            );
          })}
        </View>
      </Card>

      {animated && sets.length === 0 ? (
        <>
          <SectionTitle>Hareketli setler</SectionTitle>
          <Card style={styles.pad}>
            <Text style={[styles.hint, styles.hintLast]}>Şu anda seçilebilecek hareketli set yok.</Text>
          </Card>
        </>
      ) : animated ? (
        <>
          <SectionTitle>Hareketli setler</SectionTitle>
          <Card style={styles.pad}>
            <Text style={styles.hint}>
              Her set üç parça: kartı saran efekt, avatar dekorasyonu ve üye listesindeki isim plakası. Seti uygula ya
              da parçaları aşağıdan tek tek seçip karıştır.
            </Text>
            <SetPicker sets={sets} applied={appliedSet} onApply={look.applySet} />
          </Card>

          <SectionTitle>Profil efekti</SectionTitle>
          <Card style={styles.pad}>
            <Text style={styles.hint}>Profil kartında oynayan süs.</Text>
            <Choices
              label="Profil efekti"
              options={effectOptions}
              value={look.effect ?? 'none'}
              onChange={(value) => look.setEffect(value === 'none' ? null : value)}
            />
          </Card>

          <SectionTitle>Avatar dekorasyonu</SectionTitle>
          <Card style={styles.pad}>
            <Text style={styles.hint}>
              Avatarının çevresindeki süs; mesajlarda ve üye listesinde de görünür (küçük avatarda sabit bir halka olur).
            </Text>
            <DecorationChoices sets={sets} user={user} value={look.decoration} onPick={look.setDecoration} />
          </Card>

          <SectionTitle>İsim plakası</SectionTitle>
          <Card style={styles.pad}>
            <Text style={styles.hint}>Üye listesinde adının arkasındaki zemin.</Text>
            <NameplatePicker sets={sets} user={preview} value={look.nameplate} onPick={look.setNameplate} />
          </Card>
        </>
      ) : (
        <>
          <SectionTitle>Hareketli setler</SectionTitle>
          <Card style={styles.pad}>
            <Text style={[styles.hint, styles.hintLast]}>
              Profil efekti, avatar dekorasyonu ve isim plakası bu sürümde telefonda gösterilemiyor. Uygulamayı
              güncelleyince buradan seçebilirsin.
            </Text>
          </Card>
        </>
      )}
    </View>
  );
}

/** Hareketli setler: küçük resimli kutular; dokununca setin üç parçası birden uygulanır */
function SetPicker({
  sets,
  applied,
  onApply,
}: {
  sets: readonly CosmeticSetId[];
  applied: CosmeticSetId | null;
  onApply: (set: CosmeticSetId) => void;
}) {
  return (
    <View style={styles.sets}>
      {sets.map((set) => {
        const info = cosmeticPacks.info(set);
        if (!info) return null;
        const on = applied === set;
        return (
          <Pressable
            key={set}
            onPress={() => onApply(set)}
            style={({ pressed }) => [
              styles.set,
              on && { borderColor: info.accent, boxShadow: `0 6px 18px -8px ${info.accent}` },
              pressed && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${info.label} setini uygula`}
            accessibilityHint={info.description || undefined}
          >
            <SetThumb set={set} style={styles.setThumb} />
            <View style={styles.setLabel}>
              <Text style={styles.setName} numberOfLines={1}>
                {info.label}
              </Text>
              {on && <Ionicons name="checkmark" size={16} color={info.accent} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** İsim plakaları: "Yok" ve her setin plakası, üye listesindeki satırın küçük kopyasıyla */
function NameplatePicker({
  sets,
  user,
  value,
  onPick,
}: {
  sets: readonly CosmeticSetId[];
  user: User;
  value: CosmeticSetId | null;
  onPick: (id: CosmeticSetId | null) => void;
}) {
  const options: { id: CosmeticSetId | null; name: string }[] = [
    { id: null, name: 'Yok' },
    ...sets.map((id) => ({ id, name: cosmeticPacks.label(id) ?? id })),
  ];
  return (
    <View style={styles.plates} accessibilityRole="radiogroup" accessibilityLabel="İsim plakası">
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <Pressable
            key={o.id ?? 'none'}
            onPress={() => onPick(o.id)}
            style={({ pressed }) => [styles.plateOption, selected && styles.tileOn, pressed && { opacity: 0.85 }]}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.name}
          >
            <View style={styles.plateRow}>
              {/* Seçenekler sabit resimdir (telefonda kozmetikler yalnızca açık profilde oynar) */}
              {o.id && <NameplateBackground set={o.id} />}
              <Avatar user={user} size={30} status="online" surface={o.id ? '#0a0a0a' : colors.main} decoration={user.avatarDecoration} />
              <Text
                style={[styles.plateName, o.id ? [{ color: nameplateNameColor(null) }, NAMEPLATE_TEXT_SHADOW] : null]}
                numberOfLines={1}
              >
                {user.displayName}
              </Text>
              <Text style={[styles.plateLabel, o.id ? styles.plateLabelOn : null]} numberOfLines={1}>
                {o.name}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const sameTheme = (a: ProfileTheme | null, b: ProfileTheme | null): boolean =>
  a === b || (a !== null && b !== null && a.primary === b.primary && a.accent === b.accent);

/** Hareketli avatar dekorasyonları ve "Yok": avatarın önizlemesiyle küçük kutular */
function DecorationChoices({
  sets,
  user,
  value,
  onPick,
}: {
  sets: readonly CosmeticSetId[];
  user: User;
  value: AnimatedDecoration | null;
  onPick: (id: AnimatedDecoration | null) => void;
}) {
  const options: { id: AnimatedDecoration | null; name: string }[] = [
    { id: null, name: 'Yok' },
    ...sets.map((set) => ({ id: animatedDecoration(set), name: cosmeticPacks.label(set) ?? set })),
  ];
  return (
    <View style={styles.tiles} accessibilityRole="radiogroup" accessibilityLabel="Avatar dekorasyonu">
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <Pressable
            key={o.id ?? 'none'}
            onPress={() => onPick(o.id)}
            style={({ pressed }) => [styles.tile, selected && styles.tileOn, pressed && { opacity: 0.8 }]}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.name}
          >
            {/* Seçenekler sabit resimdir; seçili dekorasyon yukarıdaki önizleme kartında oynar */}
            <Avatar user={user} size={42} decoration={o.id} decorationPoster />
          </Pressable>
        );
      })}
    </View>
  );
}

type LookPatch = {
  profileTheme?: ProfileTheme | null;
  profileEffect?: CosmeticSetId | null;
  avatarDecoration?: AnimatedDecoration | null;
  nameplate?: CosmeticSetId | null;
};

/**
 * Profil teması, efekti, dekorasyonu ve isim plakası: seçim önizlemede hemen görünür ve sunucuya kaydedilir;
 * kaydedilemezse eskisine döner ve hata gösterilir. Setin üç parçası tek istekle kaydedilir.
 */
function useProfileLook() {
  const user = useSession((s) => s.user);
  const [draft, setDraft] = useState<LookPatch>({});

  const save = (patch: LookPatch): void => {
    setDraft((d) => ({ ...d, ...patch }));
    updateProfileLook(patch)
      .catch((err: unknown) => toast(errorMessage(err), 'error'))
      // Bu arada aynı alan için başka bir seçim yapıldıysa taslak onundur
      .finally(() =>
        setDraft((d) => {
          const next = { ...d };
          for (const key of Object.keys(patch) as (keyof LookPatch)[]) if (next[key] === patch[key]) delete next[key];
          return next;
        }),
      );
  };
  const pick = <K extends keyof LookPatch>(key: K): NonNullable<LookPatch[K]> | null =>
    ((key in draft ? draft[key] : user?.[key]) ?? null) as NonNullable<LookPatch[K]> | null;

  const savedDecoration = animatedDecorationId(user?.avatarDecoration);

  return {
    theme: pick('profileTheme'),
    // Efekt istekte profileEffect'le gider, kullanıcıda animatedEffect'te durur
    effect: 'profileEffect' in draft ? (draft.profileEffect ?? null) : user ? userEffectId(user) : null,
    decoration:
      'avatarDecoration' in draft
        ? (draft.avatarDecoration ?? null)
        : savedDecoration
          ? animatedDecoration(savedDecoration)
          : null,
    nameplate: 'nameplate' in draft ? (draft.nameplate ?? null) : user ? userNameplateId(user) : null,
    setTheme: (profileTheme: ProfileTheme | null) => save({ profileTheme }),
    setEffect: (profileEffect: CosmeticSetId | null) => save({ profileEffect }),
    setDecoration: (avatarDecoration: AnimatedDecoration | null) => save({ avatarDecoration }),
    setNameplate: (nameplate: CosmeticSetId | null) => save({ nameplate }),
    applySet: (set: CosmeticSetId) =>
      save({ profileEffect: set, avatarDecoration: animatedDecoration(set), nameplate: set }),
  };
}

/** Profil afişi: galeriden seçilip 17:6 kırpılır, sunucu küçültür. Kaldırmadan önce onay sorulur. */
function useProfileBanner() {
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);

  const change = async (): Promise<void> => {
    const file = await pickBanner().catch((err: unknown) => {
      toast(errorMessage(err), 'error');
      return null;
    });
    if (!file) return;
    setBusy('upload');
    try {
      await uploadBanner(file);
      toast('Afiş güncellendi.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Afiş kaldırılsın mı?',
      message: 'Kartının üstünde yeniden tema rengin (yoksa avatarının rengi) görünür.',
      confirmLabel: 'Kaldır',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    try {
      await removeBanner();
      toast('Afiş kaldırıldı.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return { busy, change, remove };
}

/**
 * Kişisel giriş sesi: dosya seçicisinden bir ses seçilir, sunucu ilk 5 saniyesini alır (telefonda başlangıç
 * noktası seçilmez). Kaldırmadan önce onay sorulur.
 */
function useIntroSound() {
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);

  const change = async (): Promise<void> => {
    const file = await pickIntroSound().catch((err: unknown) => {
      toast(errorMessage(err), 'error');
      return null;
    });
    if (!file) return;
    setBusy('upload');
    try {
      await uploadIntroSound(file);
      toast('Giriş sesi güncellendi.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Giriş sesi kaldırılsın mı?',
      message: 'Kanala girince yeniden genel katılma sesi çalar.',
      confirmLabel: 'Kaldır',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    try {
      await removeIntroSound();
      toast('Giriş sesi kaldırıldı.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return { busy, change, remove };
}

/** Profil fotoğrafı: galeriden seçilip kare kırpılır, sunucu küçültür. Kaldırmadan önce onay sorulur. */
function useProfilePhoto() {
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);

  const change = async (): Promise<void> => {
    const file = await pickAvatar().catch((err: unknown) => {
      toast(errorMessage(err), 'error');
      return null;
    });
    if (!file) return;
    setBusy('upload');
    try {
      await uploadAvatar(file);
      toast('Profil fotoğrafı güncellendi.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Fotoğraf kaldırılsın mı?',
      message: 'Avatarında adının baş harfleri görünür.',
      confirmLabel: 'Kaldır',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    try {
      await removeAvatar();
      toast('Profil fotoğrafı kaldırıldı.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return { busy, change, remove };
}

const styles = createStyles(() => ({
  cameraBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.brand,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removePhoto: { marginTop: space.md, alignSelf: 'center' },
  removePhotoText: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  photoHint: { color: colors.faint, fontSize: font.caption, marginTop: space.md, textAlign: 'center' },
  pad: { padding: space.lg },
  hint: { color: colors.muted, fontSize: font.small, marginBottom: space.md },
  hintLast: { marginBottom: 0 },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  // borderWidth: 0 bilerek: seçim kalkınca kenarlık "kaldırılmasın", 0 olsun. Android'de (RN 0.86) kaldırılan
  // kenarlığın genişliği NaN gelir; yuvarlak kırpma alanı NaN olur, içerik (degrade) görünmez (#29)
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  swatchOn: { borderWidth: 3, borderColor: colors.head },
  swatchNone: { backgroundColor: colors.main, borderWidth: 1, borderColor: colors.line },
  buttons: { flexDirection: 'row', gap: space.sm },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.main,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileOn: { borderColor: colors.brand },
  button: { flex: 1 },
  // Hareketli setler: iki sütun, 16:10 küçük resim ve adı
  sets: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  set: {
    width: '48.5%',
    flexGrow: 1,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.main,
    overflow: 'hidden',
  },
  setThumb: { width: '100%', aspectRatio: 16 / 10 },
  setLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm - 2,
  },
  setName: { color: colors.head, fontSize: font.small, fontWeight: '700', flexShrink: 1 },
  // İsim plakası seçenekleri: üye listesindeki satırın küçük kopyası
  plates: { gap: space.sm },
  plateOption: { borderRadius: radius.md, borderWidth: 2, borderColor: 'transparent', padding: 2 },
  plateRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.main,
  },
  plateName: { color: colors.text, fontSize: font.small, fontWeight: '600', flexShrink: 1 },
  plateLabel: { marginLeft: 'auto', color: colors.muted, fontSize: font.caption },
  plateLabelOn: { color: 'rgba(255,255,255,0.85)', ...NAMEPLATE_TEXT_SHADOW },
}));
