import { useMemo, useState, type RefObject } from 'react';
import { Headphones, Music2, Plus, Volume2, VolumeX } from 'lucide-react';
import { hasPermission, Permission, SOUNDBOARD_MAX_SOUNDS, type GuildSound } from '@diskort/shared';
import {
  allSounds,
  guildSoundUrl,
  permissionsInGuild,
  playGuildSound,
  useGuild,
  useSession,
  useSoundboardCooling,
} from '@diskort/client-core';
import { previewSound } from '../../lib/sfx';
import { cn } from '../../lib/utils';
import { getSettings, useSettings } from '../../stores/settings';
import { toast, useUi } from '../../stores/ui';
import { TextInput } from '../ui/controls';
import { MenuSeparator, PanelMenu } from '../ui/PanelMenu';
import { Slider } from '../ui/Slider';
import { soundboardGroups, soundboardPlayError, type SoundboardGroup } from './soundboardView';

/** Bundan çok ses varsa arama kutusu gösterilir */
const SEARCH_ABOVE = 12;

/** Hoparlör düğmesiyle kapatılınca seviye; yeniden açınca bu seviyeye döner (uygulama ömrü boyunca) */
let volumeBeforeOff = 1;

/** Sesleri kapatır (seviye 0) ya da önceki seviyesine geri açar */
function toggleSoundboardVolume(): void {
  const { soundboardVolume, set } = getSettings();
  if (soundboardVolume > 0) {
    volumeBeforeOff = soundboardVolume;
    set({ soundboardVolume: 0 });
  } else {
    set({ soundboardVolume: volumeBeforeOff > 0 ? volumeBeforeOff : 1 });
  }
}

function play(sound: GuildSound): void {
  playGuildSound(sound).catch((err: unknown) => {
    const text = soundboardPlayError(err);
    if (text) toast(text, 'error');
  });
}

/**
 * Ses paneli: giriş sesleri ve ses paneli seslerinin seviyesi, üyesi olunan sunucuların sesleri (bulunulan
 * sunucu üstte) ve giriş sesi ayarına bağlantı. Bağlantı kartının üstünde açılır.
 */
export function SoundboardPopover({
  open,
  anchorRef,
  placeAboveRef,
  onClose,
  guildId,
  canPlay,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Panelin üstünde açılacağı öğe (bağlantı kartı) */
  placeAboveRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Bulunulan ses kanalının sunucusu */
  guildId: string | null;
  /** Çalma düğmeleri açık mı (ses bağlantısı kurulu) */
  canPlay: boolean;
}) {
  return (
    <PanelMenu open={open} anchorRef={anchorRef} placeAboveRef={placeAboveRef} onClose={onClose} label="Ses paneli" width={340}>
      <div className="flex max-h-[60vh] flex-col">
        <VolumeStrip />
        <SoundList guildId={guildId} canPlay={canPlay} onClose={onClose} />
        <MenuSeparator />
        <IntroLink onClose={onClose} />
      </div>
    </PanelMenu>
  );
}

/** Üst şerit: başlık ve tüm genişlikte ses seviyesi (giriş sesleri dahil) */
function VolumeStrip() {
  const volume = useSettings((s) => s.soundboardVolume);
  const set = useSettings((s) => s.set);
  const off = volume <= 0;
  const percent = Math.round(volume * 100);
  const toggleLabel = off ? 'Sesleri aç' : 'Sesleri kapat';

  return (
    <div className="shrink-0 px-1 pt-1 pb-2">
      <div className="mb-1.5 px-1 text-sm font-semibold text-text-head">Ses Paneli</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-menu-item
          data-tooltip={toggleLabel}
          aria-label={toggleLabel}
          aria-pressed={off}
          className="press-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-normal outline-none transition-colors hover:bg-bg-hover hover:text-text-head focus-visible:bg-bg-hover"
          onClick={toggleSoundboardVolume}
        >
          {off ? <VolumeX size={18} className="text-danger-text" /> : <Volume2 size={18} />}
        </button>
        <Slider
          data-menu-item
          className="min-w-0 flex-1"
          aria-label="Ses paneli ses seviyesi"
          aria-valuetext={`%${percent}`}
          min={0}
          max={100}
          value={percent}
          onValueChange={(v) => set({ soundboardVolume: v / 100 })}
        />
        <span className="w-9 shrink-0 text-right text-xs text-text-muted tabular-nums">%{percent}</span>
      </div>
      <p className="mt-1 px-1 text-xs text-text-muted">Giriş sesleri de bu seviyede çalar.</p>
    </div>
  );
}

function SoundList({ guildId, canPlay, onClose }: { guildId: string | null; canPlay: boolean; onClose: () => void }) {
  const guilds = useGuild((s) => s.guilds);
  const selfId = useSession((s) => s.user?.id);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => allSounds({ guilds }), [guilds]);
  const total = useMemo(() => groups.reduce((sum, g) => sum + g.sounds.length, 0), [groups]);
  const shown = useMemo(
    () =>
      soundboardGroups(groups, {
        currentGuildId: guildId,
        query,
        canAdd: (id) => hasPermission(permissionsInGuild(guilds[id], selfId), Permission.MANAGE_SOUNDBOARD),
      }),
    [groups, guilds, guildId, selfId, query],
  );

  return (
    <>
      {total > SEARCH_ABOVE && (
        <div className="shrink-0 px-1 pb-2">
          <TextInput
            data-menu-item
            placeholder="Ses ara"
            aria-label="Ses ara"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Home/End metin içinde kalsın (menüde ilk/son öğeye gitmesin)
            onKeyDown={(e) => {
              if (e.key === 'Home' || e.key === 'End') e.stopPropagation();
            }}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {shown.length === 0 && (
          <p className="py-4 text-center text-sm text-text-muted">{query.trim() ? 'Sonuç yok.' : 'Henüz ses yok.'}</p>
        )}
        {shown.map((group) => (
          <Group key={group.guild.id} group={group} canPlay={canPlay} onClose={onClose} />
        ))}
      </div>
    </>
  );
}

function Group({ group, canPlay, onClose }: { group: SoundboardGroup; canPlay: boolean; onClose: () => void }) {
  const openSoundUpload = useUi((s) => s.openSoundUpload);
  const { guild, sounds, canAdd, full } = group;

  return (
    <section className="pb-2">
      <div className="flex min-h-6 items-center justify-between gap-2 pb-1">
        <h4 className="min-w-0 truncate text-[11px] font-bold text-text-muted uppercase">{guild.name}</h4>
        {canAdd && (
          <button
            type="button"
            data-menu-item
            data-tooltip={full ? `Sunucuda en çok ${SOUNDBOARD_MAX_SOUNDS} ses olabilir` : undefined}
            aria-disabled={full || undefined}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium outline-none transition-colors',
              full
                ? 'cursor-not-allowed text-text-muted opacity-50'
                : 'text-text-muted hover:text-text-head focus-visible:text-text-head',
            )}
            onClick={() => {
              if (full) return;
              onClose();
              openSoundUpload(guild.id);
            }}
          >
            <Plus size={14} aria-hidden />
            Ses ekle
          </button>
        )}
      </div>
      {sounds.length === 0 ? (
        <p className="pb-1 text-sm text-text-muted">Henüz ses yok.</p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {sounds.map((sound) => (
            <SoundTile key={sound.id} sound={sound} canPlay={canPlay} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Tık: kanaldaki herkese çalar (çalınan ses bitene dek kapalı); sağ üstteki kulaklık (fareyle üstüne gelince) yalnız
 * kendine dinletir, her zaman çalışır.
 */
function SoundTile({ sound, canPlay }: { sound: GuildSound; canPlay: boolean }) {
  const cooling = useSoundboardCooling();
  const playable = canPlay && !cooling;
  const tooltip = !canPlay ? 'Önce bir ses kanalına katıl' : cooling ? 'Sesin bitince yeniden çalabilirsin' : sound.name;
  return (
    <div className="group/tile relative">
      <button
        type="button"
        data-menu-item
        data-tooltip={tooltip}
        aria-label={sound.name}
        aria-disabled={playable ? undefined : true}
        className={cn(
          'flex h-16 w-full flex-col items-center justify-center gap-1 rounded-md bg-bg-active px-1 outline-none transition-colors',
          playable
            ? 'press text-text-normal hover:bg-control hover:text-text-head focus-visible:bg-control'
            : 'cursor-not-allowed text-text-muted opacity-50',
        )}
        onClick={playable ? () => play(sound) : undefined}
      >
        <span className="flex h-6 items-center text-xl leading-none" aria-hidden>
          {sound.emoji ?? <Music2 size={20} />}
        </span>
        <span className="w-full truncate text-center text-xs">{sound.name}</span>
      </button>
      <button
        type="button"
        data-menu-item
        data-tooltip="Kendine dinle"
        aria-label={`${sound.name}: kendine dinle`}
        className="press-icon absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded bg-bg-float text-text-muted opacity-0 outline-none transition-opacity group-hover/tile:opacity-100 hover:text-text-head focus-visible:opacity-100"
        onClick={() => previewSound(guildSoundUrl(sound))}
      >
        <Headphones size={12} aria-hidden />
      </button>
    </div>
  );
}

function IntroLink({ onClose }: { onClose: () => void }) {
  const openModal = useUi((s) => s.openModal);
  return (
    <button
      type="button"
      data-menu-item
      className="w-full shrink-0 rounded px-2 py-1 text-left text-xs text-text-muted outline-none transition-colors hover:text-text-head hover:underline focus-visible:text-text-head focus-visible:underline"
      onClick={() => {
        onClose();
        openModal({ type: 'settings', section: 'voice', anchor: 'soundboard' });
      }}
    >
      Giriş sesini değiştir
    </button>
  );
}
