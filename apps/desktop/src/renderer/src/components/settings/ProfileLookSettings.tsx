import { useEffect, useRef, useState } from 'react';
import { Camera, Check } from 'lucide-react';
import {
  animatedDecoration,
  animatedDecorationId,
  HEX_COLOR,
  userEffectId,
  userNameplateId,
  type AnimatedDecoration,
  type CosmeticPack,
  type CosmeticSetId,
  type ProfileTheme,
  type User,
} from '@diskort/shared';
import {
  errorMessage,
  formatBytes,
  PROFILE_THEME_PRESETS,
  profileGradient,
  refreshCosmeticPacks,
  removeBanner,
  updateProfileLook,
  uploadBanner,
  useCosmeticManifest,
  useCosmeticPacks,
  useCustomStatus,
  useStatus,
} from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { IntroSoundPicker } from './IntroSoundPicker';
import { PresenceProvider, usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import {
  Nameplate,
  PlayOnHover,
  PlayScope,
  SetThumb,
  useHoverPlay,
  useKnownCosmeticSet,
  useSelectableCosmeticSets,
} from '../cosmetics/Cosmetics';
import { Avatar } from '../ui/Avatar';
import { Button, SectionTitle } from '../ui/controls';
import { AvatarCropper } from './AvatarCropper';
import { ProfileBanner, ProfileCardTop, ProfileEffectLayer, StatusBubble, themedCardStyle } from '../profile/ProfileLook';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
/** Tarayıcıda açılıp kırpılacak resmin en büyük boyutu (sunucuya kırpılmış küçük kopya gider) */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Renk seçici sürüklenirken her adımda kaydedilmesin: bırakıldıktan bu kadar sonra kaydedilir */
const SAVE_DELAY = 400;

const sameTheme = (a: ProfileTheme | null | undefined, b: ProfileTheme | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (Boolean(a && b) && a!.primary === b!.primary && a!.accent === b!.accent);

/**
 * Ayarlar → Profil'deki süsler: afiş, profil teması (hazır ya da elle iki renk) ve hareketli setler (sunucuda
 * yayınlanmış paketler: profil efekti, avatar dekorasyonu, isim plakası). Yanda kendi profil kartının canlı
 * önizlemesi (üyelerin gördüğü kartın üst kısmıyla aynı).
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

  const { effect, decoration, nameplate, pick } = useLook(user);
  // Seçilebilir setler sunucunun bildiriminden gelir; bölüm açılırken tazelenir (yeni yayınlanan set görünsün)
  const sets = useSelectableCosmeticSets();
  const manifestLoaded = useCosmeticManifest() !== null;
  useEffect(() => {
    void refreshCosmeticPacks();
  }, []);

  const preview: User = {
    ...user,
    profileTheme: theme,
    animatedEffect: effect,
    avatarDecoration: decoration,
    nameplate,
  };
  // Setin üç parçası birden seçili mi
  const appliedSet = sets.find(
    (set) => effect === set.id && animatedDecorationId(decoration) === set.id && nameplate === set.id,
  );
  // Seçili kimlik bildirimde yoksa (paketi yayından kalkmış) hiçbir şey çizilmez: seçicilerde "Yok" işaretlidir
  // (grubun hep bir seçimi olur); "Yok"a tıklamak kaydedilmiş seçimi de temizler. Bildirim hiç yüklenemediyse
  // kayıtlı seçim bilinmiyor sayılmaz (yoksa "Yok" yanlışlıkla seçili görünürdü)
  const known = (id: CosmeticSetId | null): boolean =>
    id !== null && (!manifestLoaded || sets.some((set) => set.id === id));
  const shownEffect = known(effect) ? effect : null;
  const shownDecoration = known(animatedDecorationId(decoration)) ? decoration : null;
  const shownNameplate = known(nameplate) ? nameplate : null;

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

        <SectionTitle>Hareketli Setler</SectionTitle>
        <p className="mb-3 text-sm text-text-muted">
          Her set üç parça: kartı saran efekt, avatar dekorasyonu ve üye listesindeki isim plakası. Seti uygula ya da
          parçaları aşağıdan tek tek seçip karıştır.
        </p>
        {sets.length > 0 ? (
          <SetPicker sets={sets} applied={appliedSet?.id ?? null} onApply={(set) => void pick(setPatch(set))} />
        ) : (
          <NoSetsNote />
        )}

        <SectionTitle>Profil Efekti</SectionTitle>
        <p className="mb-3 text-sm text-text-muted">Profil kartında oynayan süs.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Profil efekti">
          {[null, ...sets].map((set) => {
            const selected = shownEffect === (set?.id ?? null);
            return (
              <button
                key={set?.id ?? 'none'}
                type="button"
                role="radio"
                aria-checked={selected}
                data-tooltip={set?.pieces[0] || undefined}
                onClick={() => void pick({ profileEffect: set?.id ?? null })}
                className={cn(
                  'press flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                  selected ? 'bg-brand text-white' : 'bg-bg-side text-text-normal hover:bg-bg-hover hover:text-text-head',
                )}
              >
                {set && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: set.accent, boxShadow: `0 0 6px ${set.accent}` }}
                  />
                )}
                {set ? set.label : 'Yok'}
              </button>
            );
          })}
        </div>

        <SectionTitle>Avatar Dekorasyonu</SectionTitle>
        <p className="mb-3 text-sm text-text-muted">
          Avatarının çevresindeki süs; mesajlarda ve üye listesinde de görünür (hareketli olanlar küçük avatarda sabit bir
          halka olur).
        </p>
        <DecorationPicker
          sets={sets}
          user={user}
          value={shownDecoration}
          onPick={(id) => void pick({ avatarDecoration: id })}
        />

        <SectionTitle>İsim Plakası</SectionTitle>
        <p className="mb-3 text-sm text-text-muted">Üye listesinde adının arkasında oynayan zemin.</p>
        <NameplatePicker sets={sets} user={user} value={shownNameplate} onPick={(id) => void pick({ nameplate: id })} />
      </div>

      {/* Önizleme seçicilerin yanında kaydırılırken görünür kalır */}
      <div className="shrink-0 self-stretch">
        <div className="sticky top-0 pb-4">
          <SectionTitle>Önizleme</SectionTitle>
          <ProfilePreviewCard user={preview} />
          <div className="mt-4 mb-1.5 text-xs font-bold tracking-wide text-text-muted uppercase">Üye listesinde</div>
          {/* Üye listesindeki gibi: plaka ve dekorasyon satırın üstüne gelinince oynar */}
          <PlayOnHover className="w-[300px] rounded-lg border border-edge bg-bg-side p-2">
            <MemberRowPreview user={preview} />
          </PlayOnHover>
        </div>
      </div>
    </div>
  );
}

// Parçalar ayrı ayrı seçilir: her biri sunucuda yayınlanmış bir setin kimliğini taşır
type LookPatch = {
  profileEffect?: CosmeticSetId | null;
  avatarDecoration?: AnimatedDecoration | null;
  nameplate?: CosmeticSetId | null;
};

/** Setin üç parçası birden */
const setPatch = (set: CosmeticSetId): LookPatch => ({
  profileEffect: set,
  avatarDecoration: animatedDecoration(set),
  nameplate: set,
});

/** Parçanın ipucu: setin adı ve (varsa) parçanın bildirimdeki açıklaması (0: efekt, 1: dekorasyon, 2: plaka) */
const pieceTooltip = (set: CosmeticPack, piece: 0 | 1 | 2): string =>
  set.pieces[piece] ? `${set.label}: ${set.pieces[piece]}` : set.label;

/**
 * Tek seçimli süsler (efekt, dekorasyon, isim plakası): seçim önizlemede hemen görünür ve kaydedilir;
 * kaydedilemezse eskisine döner ve hata gösterilir. Setin tamamı tek istekle kaydedilir.
 */
function useLook(user: User) {
  const [draft, setDraft] = useState<LookPatch>({});
  const effect = 'profileEffect' in draft ? (draft.profileEffect ?? null) : userEffectId(user);
  const saved = animatedDecorationId(user.avatarDecoration);
  const decoration = 'avatarDecoration' in draft ? (draft.avatarDecoration ?? null) : saved ? animatedDecoration(saved) : null;
  const nameplate = 'nameplate' in draft ? (draft.nameplate ?? null) : userNameplateId(user);
  const current: Required<LookPatch> = { profileEffect: effect, avatarDecoration: decoration, nameplate };

  const pick = async (patch: LookPatch): Promise<void> => {
    const keys = (Object.keys(patch) as (keyof LookPatch)[]).filter((k) => patch[k] !== current[k]);
    if (keys.length === 0) return;
    const changed = Object.fromEntries(keys.map((k) => [k, patch[k]])) as LookPatch;
    setDraft((d) => ({ ...d, ...changed }));
    try {
      await updateProfileLook(changed);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      // Bu arada aynı alan için başka bir seçim yapıldıysa taslak onundur
      setDraft((d) => {
        const next = { ...d };
        for (const k of keys) if (next[k] === changed[k]) delete next[k];
        return next;
      });
    }
  };
  return { effect, decoration, nameplate, pick };
}

/**
 * Gösterilecek set yokken kutuların yerine: bildirim hiç alınamadıysa yeniden deneme, alınıyorsa bekleme,
 * alındı ama boşsa kısa bir not.
 */
function NoSetsNote() {
  const loaded = useCosmeticManifest() !== null;
  const status = useCosmeticPacks((s) => s.status);
  const failed = !loaded && status === 'error';
  return (
    <div
      className="flex min-h-[54px] items-center justify-between gap-3 rounded-lg border border-edge bg-bg-side px-3 py-2 text-sm text-text-muted"
      role="status"
    >
      <span>{loaded ? 'Şu anda yayında bir set yok.' : failed ? 'Setler yüklenemedi.' : 'Setler yükleniyor…'}</span>
      {failed && (
        <Button type="button" variant="secondary" className="shrink-0" onClick={() => void refreshCosmeticPacks()}>
          Yeniden dene
        </Button>
      )}
    </div>
  );
}

/** Hareketli setler: küçük resimli kutular; tıklayınca setin üç parçası birden uygulanır */
function SetPicker({
  sets,
  applied,
  onApply,
}: {
  sets: CosmeticPack[];
  applied: CosmeticSetId | null;
  onApply: (set: CosmeticSetId) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
      {sets.map((set) => (
        <SetTile key={set.id} set={set} on={applied === set.id} onApply={onApply} />
      ))}
    </div>
  );
}

/**
 * Setin kutusu: profil efektinin sabit resmi; üstüne gelince (ya da klavyeyle odaklanınca) oynar. Hepsi birden
 * oynamaz: kutu başına kart boyunda bir hareketli resim çözmek gereksiz yük (canlısı yandaki önizlemede).
 */
function SetTile({ set, on, onApply }: { set: CosmeticPack; on: boolean; onApply: (set: CosmeticSetId) => void }) {
  const [active, setActive] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${set.label} setini uygula`}
      data-tooltip={set.description || undefined}
      onClick={() => onApply(set.id)}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      className={cn(
        'press group flex flex-col overflow-hidden rounded-lg border bg-bg-side text-left transition-[border-color,box-shadow]',
        on ? 'border-transparent' : 'border-edge hover:border-edge-strong',
      )}
      style={on ? { boxShadow: `0 0 0 2px ${set.accent}, 0 10px 26px -14px ${set.accent}` } : undefined}
    >
      <span className="relative block aspect-[16/10] w-full">
        <SetThumb id={set.id} paused={!active} />
        {!on && (
          <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            Seti uygula
          </span>
        )}
      </span>
      <span className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate text-sm font-semibold text-text-head">{set.label}</span>
        {on && <Check size={16} strokeWidth={3} className="anim-pill-in shrink-0" style={{ color: set.accent }} />}
      </span>
    </button>
  );
}

/** İsim plakaları: "Yok" ve her setin plakası, kendi satırının küçük önizlemesiyle */
function NameplatePicker({
  sets,
  user,
  value,
  onPick,
}: {
  sets: CosmeticPack[];
  user: User;
  value: CosmeticSetId | null;
  onPick: (id: CosmeticSetId | null) => void;
}) {
  const options: { id: CosmeticSetId | null; name: string; tooltip: string }[] = [
    { id: null, name: 'Yok', tooltip: 'Yok' },
    ...sets.map((set) => ({ id: set.id, name: set.label, tooltip: pieceTooltip(set, 2) })),
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2" role="radiogroup" aria-label="İsim plakası">
      {options.map((o) => (
        <NameplateTile key={o.id ?? 'none'} option={o} user={user} selected={value === o.id} onPick={onPick} />
      ))}
    </div>
  );
}

/** Plaka seçicinin kutusu: plaka ve dekorasyon yalnızca kutunun üstüne gelinince (ya da odaklanınca) oynar */
function NameplateTile({
  option: o,
  user,
  selected,
  onPick,
}: {
  option: { id: CosmeticSetId | null; name: string; tooltip: string };
  user: User;
  selected: boolean;
  onPick: (id: CosmeticSetId | null) => void;
}) {
  const { playing, bind } = useHoverPlay();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={o.name}
      data-tooltip={o.tooltip}
      onClick={() => onPick(o.id)}
      {...bind}
      className={cn(
        'press rounded-lg border-2 bg-bg-side p-1 transition-colors',
        selected ? 'border-brand' : 'border-transparent hover:border-edge-strong hover:bg-bg-hover',
      )}
    >
      <PlayScope playing={playing}>
        <MemberRowPreview user={{ ...user, nameplate: o.id }} label={o.id ? undefined : 'Yok'} />
      </PlayScope>
    </button>
  );
}

/** Üye listesindeki satırın küçük kopyası (isim plakasıyla) */
function MemberRowPreview({ user, label }: { user: User; label?: string }) {
  const plate = useKnownCosmeticSet(userNameplateId(user));
  return (
    <div className="relative isolate flex h-[42px] items-center gap-3 overflow-hidden rounded px-2 text-left">
      {plate && <Nameplate id={plate} />}
      <Avatar
        user={user}
        size={32}
        status="online"
        ringClassName="bg-bg-side"
        ringColor={plate ? '#0a0a0a' : undefined}
        decoration={user.avatarDecoration}
      />
      <span className={cn('min-w-0 truncate font-medium', plate ? 'nameplate-text' : 'text-text-normal')}>
        {user.displayName}
      </span>
      {label && <span className="ml-auto shrink-0 text-xs text-text-muted">{label}</span>}
    </div>
  );
}

/** Hareketli avatar dekorasyonları ve "Yok": avatarın canlı önizlemesiyle küçük kutular */
function DecorationPicker({
  sets,
  user,
  value,
  onPick,
}: {
  sets: CosmeticPack[];
  user: User;
  value: AnimatedDecoration | null;
  onPick: (id: AnimatedDecoration | null) => void;
}) {
  const options: { id: AnimatedDecoration | null; name: string; tooltip: string }[] = [
    { id: null, name: 'Yok', tooltip: 'Yok' },
    ...sets.map((set) => ({ id: animatedDecoration(set.id), name: set.label, tooltip: pieceTooltip(set, 1) })),
  ];
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar dekorasyonu">
      {options.map((o) => (
        <DecorationTile key={o.id ?? 'none'} option={o} user={user} selected={value === o.id} onPick={onPick} />
      ))}
    </div>
  );
}

/** Dekorasyon seçicinin kutusu: dekorasyon yalnızca kutunun üstüne gelinince (ya da odaklanınca) oynar */
function DecorationTile({
  option: o,
  user,
  selected,
  onPick,
}: {
  option: { id: AnimatedDecoration | null; name: string; tooltip: string };
  user: User;
  selected: boolean;
  onPick: (id: AnimatedDecoration | null) => void;
}) {
  const { playing, bind } = useHoverPlay();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={o.name}
      data-tooltip={o.tooltip}
      onClick={() => onPick(o.id)}
      {...bind}
      className={cn(
        'press flex h-[84px] w-[84px] items-center justify-center rounded-lg border-2 bg-bg-side transition-colors',
        selected ? 'border-brand' : 'border-transparent hover:border-edge-strong hover:bg-bg-hover',
      )}
    >
      <Avatar user={user} size={44} decoration={o.id} animateDecoration={playing} />
    </button>
  );
}

/** Kendi profil kartının üst kısmı, üyelerin gördüğü gibi (tema, afiş ve efekt canlı) */
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
      <ProfileEffectLayer effect={userEffectId(user)} />
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
