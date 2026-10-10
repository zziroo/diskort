import { useState } from 'react';
import { animatedDecorationId, STATUS_LABELS, type User } from '@diskort/shared';
import { avatarInk, avatarUrl, useOnMobile, useStatus, type DisplayStatus } from '@diskort/client-core';
import { cn, initials } from '../../lib/utils';
import { AvatarDecoration, useAvatarPlaying } from '../cosmetics/Cosmetics';
import { showsPhone, StatusIcon } from './StatusIcon';

interface Props {
  user: Pick<User, 'displayName' | 'avatarColor' | 'avatarUrl'> | undefined;
  size?: number;
  speaking?: boolean;
  /** Eski biçim: çevrimiçi (yeşil) / çevrimdışı (gri halka). `status` verilirse o kullanılır */
  online?: boolean;
  /** Durum noktası (Discord biçimli); verilmezse ve `online` da yoksa nokta çizilmez */
  status?: DisplayStatus;
  /** Kişi yalnızca telefondan bağlı: nokta telefon biçiminde (çevrimdışı/görünmezken yok sayılır) */
  mobile?: boolean;
  /** Noktanın çevresindeki halkanın rengi (avatarın durduğu zemin) */
  ringClassName?: string;
  /** Halkanın rengi sınıfla verilemiyorsa (ör. temalı profil kartı); ringClassName'in önüne geçer */
  ringColor?: string;
  /**
   * Avatar dekorasyonunun kimliği (user.avatarDecoration): avatarın üstüne, yerleşimi değiştirmeden çizilir.
   * Hareketli dekorasyon (anim:<set>) sabit posteridir; avatarın (ya da kapsayan satırın, bkz. PlayScope)
   * üstüne gelinince oynar. Seti tanınmıyorsa (paketi yayında değil) hiçbir şey çizilmez.
   */
  decoration?: string | null;
  /**
   * Dekorasyonun oynaması açıkça belirlenir (true: hep oynar, ör. açık profil kartının avatarı). Verilmezse
   * üstüne gelme kuralı geçerlidir.
   */
  animateDecoration?: boolean;
  className?: string;
}

export function Avatar({
  user,
  size = 32,
  speaking,
  online,
  status,
  mobile,
  ringClassName = 'bg-bg-panel',
  ringColor,
  decoration,
  animateDecoration,
  className,
}: Props) {
  // 32 piksellik avatarda 10 piksellik nokta, 3 piksellik halka; büyük avatarda (profil) orantılı daha küçük
  const dot = size > 40 ? Math.round(size * 0.22) : Math.max(8, Math.round(size * 0.3125));
  const ring = size > 40 ? Math.round(size * 0.075) : Math.max(2, Math.round(size * 0.094));
  const shown: DisplayStatus | undefined = status ?? (online === undefined ? undefined : online ? 'online' : 'offline');
  const phone = shown !== undefined && showsPhone(shown, mobile);
  const name = user?.displayName ?? '?';
  const src = avatarUrl(user);
  // Yüklenemeyen fotoğrafın yerine baş harfler (adres değişince yeniden denenir)
  const [failed, setFailed] = useState<string | null>(null);
  const decorationSet = animatedDecorationId(decoration);
  // Dekorasyon: açık karar, yoksa kapsayan satır, o da yoksa avatarın kendi üstüne gelinmesi (dekorasyonsuz
  // avatara olay tutucusu bağlanmaz)
  const play = useAvatarPlaying(animateDecoration);
  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      {...(decorationSet ? play.bind : undefined)}
    >
      <div
        className={cn(
          'avatar-ring flex h-full w-full items-center justify-center rounded-full font-semibold',
          speaking && 'speaking-ring',
        )}
        style={{
          background: user?.avatarColor ?? '#747f8d',
          color: avatarInk(user?.avatarColor),
          fontSize: Math.max(10, size * 0.38),
        }}
      >
        {src && failed !== src ? (
          <img
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            className="h-full w-full rounded-full object-cover select-none"
            onError={() => setFailed(src)}
          />
        ) : (
          initials(name)
        )}
      </div>
      {decorationSet && <AvatarDecoration id={decorationSet} size={size} animate={play.playing} />}
      {shown !== undefined && (
        <span
          className={cn('absolute flex items-center justify-center', !phone && 'rounded-full', ringClassName)}
          style={{
            padding: ring,
            right: -ring + Math.round(size * 0.03),
            bottom: -ring + Math.round(size * 0.03),
            background: ringColor,
            // Telefonun halkası da köşeleri yuvarlak dikdörtgen (simgenin köşesiyle eş merkezli)
            borderRadius: phone ? ring + dot * 0.2 : undefined,
          }}
          role="img"
          aria-label={phone ? `${STATUS_LABELS[shown]} (telefonda)` : STATUS_LABELS[shown]}
        >
          <StatusIcon status={shown} size={dot} mobile={phone} />
        </span>
      )}
    </div>
  );
}

/** Kişinin güncel durum noktasıyla avatar (kendin için görünmezlik de görünür) */
export function PresenceAvatar({ userId, ...props }: Omit<Props, 'status' | 'online'> & { userId: string }) {
  const status = useStatus(userId);
  const mobile = useOnMobile(userId);
  return <Avatar {...props} status={status} mobile={mobile} />;
}
