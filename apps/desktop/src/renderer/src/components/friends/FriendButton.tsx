import { useState } from 'react';
import { Check, Clock, UserCheck, UserPlus } from 'lucide-react';
import { useFriendStatus, useIsBlocked } from '@diskort/client-core';
import { acceptFriend, addFriend, cancelFriend, openFriendMenu } from '../../lib/friends';
import { cn } from '../../lib/utils';

/**
 * Kişiyle arkadaşlık durumuna göre tek düğme: "Arkadaş ekle", "İstek gönderildi" (basınca geri çekilir),
 * "Kabul et" ya da "Arkadaş" (basınca menüden çıkarılır). Kendin ve engellediğin kişi için gösterilmez.
 * `card`: profil kartında tam genişlik; `header`: konuşma başlığında küçük hap.
 */
export function FriendButton({
  userId,
  variant,
  onAction,
}: {
  userId: string;
  variant: 'card' | 'header';
  /** Düğmeye basılınca (ör. profil kartını kapatmak için; kart menünün üstünde kalmasın diye menüde de) */
  onAction?: () => void;
}) {
  const status = useFriendStatus(userId);
  const blocked = useIsBlocked(userId);
  const [busy, setBusy] = useState(false);
  if (status === 'self' || blocked) return null;

  const run = (action: (id: string) => Promise<void>): void => {
    if (busy) return;
    onAction?.();
    setBusy(true);
    void action(userId).finally(() => setBusy(false));
  };

  const config = {
    none: { label: 'Arkadaş ekle', tip: undefined, Icon: UserPlus, tone: 'success' as const, click: () => run(addFriend) },
    outgoing: { label: 'İstek gönderildi', tip: 'İsteği geri çek', Icon: Clock, tone: 'neutral' as const, click: () => run(cancelFriend) },
    incoming: { label: 'Kabul et', tip: 'Arkadaşlık isteğini kabul et', Icon: Check, tone: 'success' as const, click: () => run(acceptFriend) },
    friend: { label: 'Arkadaş', tip: 'Arkadaşlık seçenekleri', Icon: UserCheck, tone: 'neutral' as const, click: null },
  }[status];

  const tones = {
    success: 'bg-ok text-white hover:bg-ok-hover',
    neutral: 'bg-bg-side text-text-normal hover:bg-bg-hover',
  };

  return (
    <button
      type="button"
      disabled={busy}
      data-tooltip={config.tip}
      aria-label={config.tip ? `${config.label}: ${config.tip}` : config.label}
      className={cn(
        'press flex items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        variant === 'card' ? 'w-full rounded px-3 py-2 text-sm' : 'h-7 shrink-0 rounded-full px-3 text-sm',
        tones[config.tone],
      )}
      onClick={(e) => {
        if (config.click) return config.click();
        const r = e.currentTarget.getBoundingClientRect();
        onAction?.();
        openFriendMenu(userId, r.left, r.bottom + 4);
      }}
    >
      <config.Icon size={16} aria-hidden />
      {config.label}
    </button>
  );
}
