import type { CSSProperties, ReactNode } from 'react';
import { userEffectId, type CosmeticSetId, type CustomStatus, type ProfileTheme, type User } from '@diskort/shared';
import { bannerUrl, profileGradient, type DisplayStatus } from '@diskort/client-core';
import { cn } from '../../lib/utils';
import { CardEffect, useCosmeticSetInfo } from '../cosmetics/Cosmetics';
import { Avatar } from '../ui/Avatar';

// Profil süsleri (afiş, tema, efekt) masaüstünde: profil kartı ve Ayarlar > Profil'deki önizleme kullanır.

/**
 * Temalı kartın zemini: tema degradesinin üstüne uygulamanın kart rengi yarı saydam serilir (yazılar
 * açık ve koyu temada okunur kalsın). Tema yoksa undefined: kart kendi rengini kullanır.
 */
export function themedCardStyle(theme: ProfileTheme | null | undefined): CSSProperties | undefined {
  if (!theme) return undefined;
  const veil = 'color-mix(in srgb, var(--color-bg-float) 55%, transparent)';
  return { background: `linear-gradient(${veil}, ${veil}), ${profileGradient(theme)}` };
}

/**
 * Avatarın çevresindeki halkanın rengi: kartın o hizadaki rengi (degradenin üçte biri kadar aşağısı,
 * tüle karışmış). Tema yoksa undefined.
 */
export function themedRingColor(theme: ProfileTheme | null | undefined): string | undefined {
  return theme
    ? `color-mix(in srgb, var(--color-bg-float) 55%, color-mix(in srgb, ${theme.primary} 70%, ${theme.accent}))`
    : undefined;
}

/**
 * Kartın üstündeki afiş: resim, yoksa tema rengi, yoksa hareketli set efektinin gökyüzü degradesi, o da yoksa
 * avatarın rengi (sunucu, tema varsa onun ana rengini avatarColor olarak gönderir)
 */
export function ProfileBanner({
  user,
  className,
}: {
  user: Pick<User, 'bannerUrl' | 'profileTheme' | 'avatarColor' | 'animatedEffect'>;
  className?: string;
}) {
  const src = bannerUrl(user);
  const set = useCosmeticSetInfo(userEffectId(user));
  return (
    <div
      className={cn('relative shrink-0 overflow-hidden', className)}
      style={{
        background:
          user.profileTheme?.primary ?? (set ? `linear-gradient(140deg, ${set.from}, ${set.to})` : user.avatarColor),
      }}
    >
      {src && <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
    </div>
  );
}

/**
 * Profil kartının üst kısmı: afiş, avatar (halkası kartın renginde), yanında isteğe bağlı balon, ad ve
 * kullanıcı adı. Avatarın dekorasyonu kart açık olduğu sürece oynar. Kartın zemini (themedCardStyle) ve efekti (ProfileEffectLayer) dıştaki kaba verilir.
 */
export function ProfileCardTop({
  user,
  status,
  mobile,
  aside,
  badge,
  bannerClassName,
}: {
  user: Pick<
    User,
    | 'displayName'
    | 'username'
    | 'avatarColor'
    | 'avatarUrl'
    | 'bannerUrl'
    | 'profileTheme'
    | 'avatarDecoration'
    | 'animatedEffect'
  >;
  status?: DisplayStatus;
  /** Kişi yalnızca telefondan bağlı (nokta telefon biçiminde) */
  mobile?: boolean;
  /** Avatarın yanında (ör. özel durum balonu) */
  aside?: ReactNode;
  /** Adın yanında (ör. sunucu sahibinin tacı) */
  badge?: ReactNode;
  /** Kartın kendisi taşanı kırpmıyorsa afişin köşeleri (ör. rounded-t-lg) */
  bannerClassName?: string;
}) {
  const ring = themedRingColor(user.profileTheme);
  const effect = useCosmeticSetInfo(userEffectId(user));
  return (
    <>
      {/* Hareketli set efekti 106 piksellik afişe göre hazırlandığından efektli kartın afişi resim yokken de uzun */}
      <ProfileBanner user={user} className={cn(user.bannerUrl || effect ? 'h-[106px]' : 'h-[60px]', bannerClassName)} />
      <div className="px-4">
        <div className="-mt-10 mb-2 flex items-start gap-2">
          {/* Efekt avatarın yerini bilmez: avatar (halkası, dekorasyonu ve durum noktasıyla) efekt katmanının üstünde */}
          <div
            className="relative z-[2] w-fit shrink-0 rounded-full border-[6px] border-bg-float"
            style={{ borderColor: ring }}
          >
            <Avatar
              user={user}
              size={80}
              status={status}
              mobile={mobile}
              ringClassName="bg-bg-float"
              ringColor={ring}
              decoration={user.avatarDecoration}
              animateDecoration
            />
          </div>
          {aside}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xl leading-tight font-bold text-text-head">{user.displayName}</span>
          {badge}
        </div>
        <div className="truncate text-sm text-text-normal">{user.username}</div>
      </div>
    </>
  );
}

/** Özel durum: avatarın yanında konuşma balonu */
export function StatusBubble({ custom }: { custom: CustomStatus }) {
  return (
    <div className="relative mt-12 min-w-0 flex-1" title={[custom.emoji, custom.text].filter(Boolean).join(' ')}>
      <span className="absolute top-1 -left-1 h-3 w-3 rounded-full bg-bg-side" />
      <span className="absolute top-3.5 -left-2.5 h-1.5 w-1.5 rounded-full bg-bg-side" />
      <span className="relative line-clamp-3 rounded-2xl bg-bg-side px-3 py-2 text-sm break-words text-text-normal">
        {custom.emoji && <span className="mr-1">{custom.emoji}</span>}
        {custom.text}
      </span>
    </div>
  );
}

/**
 * Kartın üstünde oynayan hareketli set efekti (tıklamaları engellemez; avatar bu katmanın üstünde kalır).
 * "Hareketi azalt" açıkken sabit resmi gösterilir; seti tanınmıyorsa (paketi yayında değil) hiçbir şey çizilmez.
 */
export function ProfileEffectLayer({
  effect,
  className,
}: {
  /** Setin kimliği (userEffectId) */
  effect: CosmeticSetId | null | undefined;
  /** Kart taşanı kırpmıyorsa katmanın köşeleri (ör. rounded-lg) */
  className?: string;
}) {
  return <CardEffect id={effect} className={className} />;
}

