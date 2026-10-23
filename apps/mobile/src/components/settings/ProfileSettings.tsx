import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProfileTheme, User } from '@diskort/shared';
import {
  errorMessage,
  introSoundUrl,
  PROFILE_THEME_PRESETS,
  profileGradient,
  removeAvatar,
  removeBanner,
  removeIntroSound,
  updateProfileLook,
  uploadAvatar,
  uploadBanner,
  uploadIntroSound,
  useSession,
} from '@diskort/client-core';
import { pickAvatar, pickBanner, pickIntroSound } from '../../attachments';
import { playIntroSound, soundsAvailable } from '../../sounds';
import { toast } from '../../stores/ui';
import { colors, createStyles, font, radius, space } from '../../theme';
import { PresenceAvatar } from '../Avatar';
import { confirmDialog } from '../Dialog';
import { PressableScale } from '../PressableScale';
import { ProfileHeader } from '../ProfileHeader';
import { StatusChip } from '../StatusPicker';
import { Button, Card, SectionTitle } from '../ui';

/**
 * Ayarlar → Profil (masaüstündeki profil fotoğrafı ve görünüm): fotoğraf galeriden seçilip kare
 * kırpılır; durum ve özel durum; afiş, giriş sesi ve profil teması.
 * En üstteki kart, üyelerin gördüğü profil kartının canlı önizlemesidir.
 */
export function ProfileSettings() {
  const user = useSession((s) => s.user);
  const photo = useProfilePhoto();
  const banner = useProfileBanner();
  const intro = useIntroSound();
  const introUrl = introSoundUrl(user);
  const look = useProfileLook();

  if (!user) return null;
  // Önizleme: seçimler kaydedilmeden önce de kartta görünür
  const preview: User = { ...user, profileTheme: look.theme };
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
            <PresenceAvatar userId={user.id} user={user} size={88} surface={ring} />
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

    </View>
  );
}

const sameTheme = (a: ProfileTheme | null, b: ProfileTheme | null): boolean =>
  a === b || (a !== null && b !== null && a.primary === b.primary && a.accent === b.accent);

type LookPatch = { profileTheme?: ProfileTheme | null };

/**
 * Profil teması: seçim önizlemede hemen görünür ve sunucuya kaydedilir; kaydedilemezse eskisine döner ve hata
 * gösterilir.
 */
function useProfileLook() {
  const user = useSession((s) => s.user);
  const [draft, setDraft] = useState<LookPatch>({});

  const save = (patch: LookPatch): void => {
    setDraft((d) => ({ ...d, ...patch }));
    updateProfileLook(patch)
      .catch((err: unknown) => toast(errorMessage(err), 'error'))
      // Bu arada başka bir seçim yapıldıysa taslak onundur
      .finally(() => setDraft((d) => (d.profileTheme === patch.profileTheme ? {} : d)));
  };

  return {
    theme: 'profileTheme' in draft ? (draft.profileTheme ?? null) : (user?.profileTheme ?? null),
    setTheme: (profileTheme: ProfileTheme | null) => save({ profileTheme }),
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
  button: { flex: 1 },
}));
