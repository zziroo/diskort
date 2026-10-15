import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useGuild } from '@diskort/client-core';
import { useSettings } from '../stores/settings';
import { useUi } from '../stores/ui';
import { useEscapeLayer } from '../lib/escape';
import { usePresence } from '../lib/motion';
import { cn } from '../lib/utils';
import { Slider } from './ui/Slider';

const MARGIN = 8;

/** Sağ tık menüsü: basit öğeler veya kullanıcı ses ayarları (seviye + yerel susturma). */
export function ContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeContextMenu);
  const { value: shown, closing } = usePresence(menu, 100);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, origin: 'top left' });
  // Esc yalnızca menüyü kapatır (altındaki ayarlar/pencere açık kalır)
  useEscapeLayer(close, Boolean(menu));

  // Sığmıyorsa imlecin soluna/üstüne açılır; animasyon imlecin olduğu noktadan büyür
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { offsetWidth: width, offsetHeight: height } = ref.current;
    const x = menu.x + width > window.innerWidth - MARGIN ? Math.max(MARGIN, menu.x - width) : menu.x;
    const y = Math.max(MARGIN, Math.min(menu.y, window.innerHeight - height - MARGIN));
    setPos({ x, y, origin: `${menu.x - x}px ${menu.y - y}px` });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Klavyeyle öğeler arasında gezinme
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next]!.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);

  if (!shown) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        'fixed z-50 max-h-[calc(100vh-16px)] min-w-[200px] overflow-y-auto rounded-md border border-edge bg-bg-float p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]',
        closing ? 'anim-pop-out pointer-events-none' : 'anim-pop-in',
      )}
      style={{ left: pos.x, top: pos.y, transformOrigin: pos.origin }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {shown.userId && <UserAudioControls userId={shown.userId} />}
      {shown.introVolume && <IntroVolumeControls />}
      {(shown.userId || shown.introVolume) && shown.items?.length && !shown.items[0]?.heading ? (
        <div className="mx-1 my-1 h-px bg-line/70" />
      ) : null}
      {shown.items?.map((item, i) =>
        item.heading ? (
          <div
            key={`${i}-${item.label}`}
            className={cn(
              'px-2 pt-1.5 pb-1 text-[11px] font-bold text-text-muted uppercase',
              (i > 0 || shown.userId || shown.introVolume) && 'mt-1 border-t border-line/60 pt-2',
            )}
          >
            {item.label}
          </div>
        ) : (
          <button
            key={`${i}-${item.label}`}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={cn(
              'group/item flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-sm transition-colors duration-75 outline-none disabled:cursor-default disabled:opacity-40',
              item.danger
                ? 'text-danger enabled:hover:bg-danger enabled:hover:text-white enabled:focus-visible:bg-danger enabled:focus-visible:text-white'
                : 'enabled:hover:bg-brand enabled:hover:text-white enabled:focus-visible:bg-brand enabled:focus-visible:text-white',
            )}
            // Odak olduğu yerde kalsın (ör. sağ tıklanan metin kutusunda "Yapıştır" için)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              close();
              item.onClick?.();
            }}
          >
            {item.color !== undefined && (
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: item.color ?? '#99aab5' }} />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="ml-2 text-xs opacity-60">{item.hint}</span>}
            {item.checked !== undefined && (
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border',
                  item.checked ? 'border-brand bg-brand text-white group-hover/item:border-white' : 'border-text-muted',
                )}
              >
                {item.checked && <Check size={12} strokeWidth={3} />}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

/** Başkalarının (ve kendi) giriş sesinin seviyesi; 0 = kapalı (yerine genel "biri girdi" sesi çalar) */
function IntroVolumeControls() {
  const volume = useSettings((s) => s.introSoundVolume);
  const set = useSettings((s) => s.set);

  return (
    <div className="w-[220px] px-2 py-1.5">
      <div className="mb-1 flex justify-between text-xs font-bold text-text-muted uppercase">
        <span>Giriş Sesleri Ses Seviyesi</span>
        <span className="tabular-nums">{Math.round(volume * 100)}%</span>
      </div>
      <Slider
        className="w-full"
        aria-label="Giriş sesleri ses seviyesi"
        min={0}
        max={100}
        value={Math.round(volume * 100)}
        onValueChange={(v) => set({ introSoundVolume: v / 100 })}
      />
    </div>
  );
}

function UserAudioControls({ userId }: { userId: string }) {
  const user = useGuild((s) => s.users[userId]);
  const volume = useSettings((s) => s.userVolumes[userId] ?? 1);
  const muted = useSettings((s) => s.localMutes[userId] === true);
  const set = useSettings((s) => s.set);

  return (
    <div className="w-[220px] px-2 py-1.5">
      <div className="mb-2 truncate text-sm font-semibold text-text-head">{user?.displayName}</div>
      <div className="mb-1 flex justify-between text-xs font-bold text-text-muted uppercase">
        <span>Kullanıcı Ses Seviyesi</span>
        <span className="tabular-nums">{Math.round(volume * 100)}%</span>
      </div>
      <Slider
        className="w-full"
        aria-label="Kullanıcı ses seviyesi"
        min={0}
        max={200}
        value={Math.round(volume * 100)}
        onValueChange={(v) => {
          const userVolumes = { ...useSettings.getState().userVolumes, [userId]: v / 100 };
          set({ userVolumes });
        }}
      />
      <label className="mt-2 flex cursor-pointer items-center justify-between rounded-[3px] px-1 py-1.5 text-sm transition-colors hover:bg-bg-hover">
        <span>Sustur (yalnızca senin için)</span>
        <input
          type="checkbox"
          checked={muted}
          onChange={(e) => {
            const localMutes = { ...useSettings.getState().localMutes };
            if (e.target.checked) localMutes[userId] = true;
            else delete localMutes[userId];
            set({ localMutes });
          }}
        />
      </label>
    </div>
  );
}
