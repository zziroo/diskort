import { useEffect, useRef, useState } from 'react';
import { Camera, Check } from 'lucide-react';
import { HEX_COLOR, type ProfileTheme, type User } from '@diskort/shared';
import {
  errorMessage,
  formatBytes,
  PROFILE_THEME_PRESETS,
  profileGradient,
  removeBanner,
  updateProfileLook,
  uploadBanner,
  useCustomStatus,
  useStatus,
} from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { IntroSoundPicker } from './IntroSoundPicker';
import { PresenceProvider, usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import { Button, SectionTitle } from '../ui/controls';
import { AvatarCropper } from './AvatarCropper';
import { ProfileBanner, ProfileCardTop, StatusBubble, themedCardStyle } from '../profile/ProfileLook';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
/** Tarayıcıda açılıp kırpılacak resmin en büyük boyutu (sunucuya kırpılmış küçük kopya gider) */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Renk seçici sürüklenirken her adımda kaydedilmesin: bırakıldıktan bu kadar sonra kaydedilir */
const SAVE_DELAY = 400;

const sameTheme = (a: ProfileTheme | null | undefined, b: ProfileTheme | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (Boolean(a && b) && a!.primary === b!.primary && a!.accent === b!.accent);

/**
 * Ayarlar → Profil'deki görünüm: afiş, giriş sesi ve profil teması (hazır ya da elle iki renk). Yanda kendi
 * profil kartının canlı önizlemesi (üyelerin gördüğü kartın üst kısmıyla aynı).
 */
export function ProfileLookSettings({ user }: { user: User }) {
  // Renk seçici sürüklenirken kart hemen değişsin: taslak önizlemede gösterilir, kısa süre sonra kaydedilir
  const [draft, setDraft] = useState<ProfileTheme | null | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const theme = draft === undefined ? (user.profileTheme ?? null) : draft;

  const saveTheme = async (profileTheme: ProfileTheme | null): Promise<void> => {
    try {
      await updateProfileLook({ profileTheme });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      // Bu arada yeni bir renk seçildiyse taslak onundur
      setDraft((d) => (d === profileTheme ? undefined : d));
    }
  };

  // Kaydedilmeyi bekleyen tema (renk seçici bırakılınca)
  const queued = useRef<ProfileTheme | null | undefined>(undefined);
  const pickTheme = (next: ProfileTheme | null, delay = 0): void => {
    window.clearTimeout(timer.current);
    queued.current = undefined;
    if (delay === 0 && sameTheme(next, user.profileTheme)) {
      setDraft(undefined);
      return;
    }
    setDraft(next);
    queued.current = next;
    timer.current = window.setTimeout(() => {
      queued.current = undefined;
      void saveTheme(next);
    }, delay);
  };
  // Bölümden çıkılırken bekleyen renk hemen kaydedilir
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (queued.current !== undefined) void saveTheme(queued.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Tema yokken renk seçicilerin başladığı renkler: üstte avatarın rengi, altta koyu bir ton
  const fallback: ProfileTheme = {
    primary: HEX_COLOR.test(user.avatarColor.toLowerCase()) ? user.avatarColor.toLowerCase() : '#5865f2',
    accent: '#1e1f22',
  };
  const setColor = (key: keyof ProfileTheme, value: string): void => {
    const color = value.toLowerCase();
    if (HEX_COLOR.test(color)) pickTheme({ ...(theme ?? fallback), [key]: color }, SAVE_DELAY);
  };

  const preview: User = { ...user, profileTheme: theme };

  return (
    <div className="flex flex-wrap-reverse items-start gap-x-8">
      <div className="min-w-[260px] flex-1">
        <BannerPicker user={preview} />
        <IntroSoundPicker user={preview} />

        <SectionTitle>Profil Teması</SectionTitle>
        <p className="mb-3 text-sm text-text-muted">Profil kartının zemini: yukarıdan aşağıya iki renk.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Profil teması">
          <button
            type="button"
            role="radio"
            aria-checked={theme === null}
            onClick={() => pickTheme(null)}
            data-tooltip="Yok"
            aria-label="Yok"
            className={cn(
              'press-icon flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-edge-strong bg-bg-float transition-transform hover:scale-110',
              theme === null && 'ring-2 ring-text-head ring-offset-2 ring-offset-bg-main',
            )}
          >
            <span className="h-0.5 w-5 rotate-45 rounded-full bg-text-muted" />
          </button>
          {PROFILE_THEME_PRESETS.map((preset) => {
            const selected = sameTheme(theme, preset);
            return (
              <button
                key={preset.name}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pickTheme({ primary: preset.primary, accent: preset.accent })}
                data-tooltip={preset.name}
                aria-label={preset.name}
                className={cn(
                  'press-icon flex h-10 w-10 items-center justify-center rounded-full text-white transition-transform hover:scale-110',
                  selected && 'ring-2 ring-text-head ring-offset-2 ring-offset-bg-main',
                )}
                style={{ background: profileGradient(preset) }}
              >
                {selected && <Check size={18} strokeWidth={3} className="anim-pill-in drop-shadow" />}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <ColorInput label="Üst renk" value={(theme ?? fallback).primary} onChange={(v) => setColor('primary', v)} />
          <ColorInput label="Alt renk" value={(theme ?? fallback).accent} onChange={(v) => setColor('accent', v)} />
        </div>
      </div>

      {/* Önizleme seçicilerin yanında kaydırılırken görünür kalır */}
      <div className="shrink-0 self-stretch">
        <div className="sticky top-0 pb-4">
          <SectionTitle>Önizleme</SectionTitle>
          <ProfilePreviewCard user={preview} />
        </div>
      </div>
    </div>
  );
}

/** Kendi profil kartının üst kısmı, üyelerin gördüğü gibi (tema ve afiş canlı) */
function ProfilePreviewCard({ user }: { user: User }) {
  const status = useStatus(user.id);
  const custom = useCustomStatus(user.id);
  return (
    <div
      className="relative w-[300px] overflow-hidden rounded-lg border border-edge bg-bg-float pb-4 shadow-[0_8px_24px_rgb(0_0_0/0.25)]"
      style={themedCardStyle(user.profileTheme)}
      aria-label="Profil kartı önizlemesi"
    >
      <ProfileCardTop user={user} status={status} aside={custom && <StatusBubble custom={custom} />} />
    </div>
  );
}

/** Rengi adıyla birlikte gösteren yerel renk seçici */
function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-normal">
      <span
        className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full border border-edge-strong transition-transform hover:scale-110"
        style={{ background: value }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={label}
        />
      </span>
      <span>
        {label} <span className="font-mono text-xs text-text-muted uppercase">{value}</span>
      </span>
    </label>
  );
}

/** Afiş: seçilen resim 17:6 kırpılıp (1020×360) yüklenir */
function BannerPicker({ user }: { user: User }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'remove' | null>(null);
  const cropper = usePresence(file);
  const pick = (): void => input.current?.click();

  const save = async (image: Blob): Promise<void> => {
    try {
      await uploadBanner({ name: 'afis.webp', size: image.size, type: image.type, blob: image });
      setFile(null);
      toast('Afiş güncellendi.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
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
      toast('Afiş kaldırıldı.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SectionTitle>Afiş</SectionTitle>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="press-icon group relative w-[204px] shrink-0 overflow-hidden rounded-md"
          onClick={pick}
          disabled={busy !== null}
          data-tooltip={user.bannerUrl ? 'Afişi değiştir' : 'Afiş yükle'}
          aria-label={user.bannerUrl ? 'Afişi değiştir' : 'Afiş yükle'}
        >
          <ProfileBanner user={user} className="aspect-[17/6] w-full" />
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <Camera size={20} className="scale-75 transition-transform duration-200 ease-(--ease-hov) group-hover:scale-100" />
          </span>
        </button>
        <div className="flex gap-2">
          <Button type="button" onClick={pick} disabled={busy !== null}>
            {user.bannerUrl ? 'Afişi Değiştir' : 'Afiş Yükle'}
          </Button>
          {user.bannerUrl && (
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void remove()}>
              Kaldır
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        PNG, JPEG, WebP ya da GIF. Seçtikten sonra 17:6 kırparsın.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = ''; // aynı dosya yeniden seçilebilsin
          if (!picked) return;
          if (picked.size > MAX_SOURCE_BYTES) {
            toast(`Resim çok büyük (en fazla ${formatBytes(MAX_SOURCE_BYTES)}).`, 'error');
            return;
          }
          setFile(picked);
        }}
      />
      {/* Kırpma penceresi kapanırken de animasyonla kaybolur */}
      <PresenceProvider value={cropper.closing}>
        {cropper.value && (
          <AvatarCropper
            file={cropper.value}
            shape="banner"
            title="Afişi düzenle"
            onCancel={() => setFile(null)}
            onSave={save}
          />
        )}
      </PresenceProvider>
    </div>
  );
}
