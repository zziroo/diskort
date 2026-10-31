import { useRef, useState } from 'react';
import { Music2, Play, Trash2, X } from 'lucide-react';
import { SOUNDBOARD_MAX_SOUNDS, SOUNDBOARD_NAME_MAX, type GuildSound } from '@diskort/shared';
import { errorMessage, guildSoundUrl, removeGuildSound, soundsOf, updateGuildSound, useGuild } from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { previewSound } from '../../lib/sfx';
import { toast, useUi } from '../../stores/ui';
import { Button, TextInput } from '../ui/controls';

/** Sunucu Ayarları → Sesler: sunucunun ses paneli (MANAGE_SOUNDBOARD). */
export function SoundsSection() {
  const guildId = useGuild((s) => s.activeGuildId) ?? '';
  const sounds = useGuild((s) => soundsOf(s, guildId));
  const openSoundUpload = useUi((s) => s.openSoundUpload);
  const full = sounds.length >= SOUNDBOARD_MAX_SOUNDS;

  return (
    <div>
      {/* pr-14: sağ üstteki sabit kapatma düğmesinin altında kalmasın */}
      <div className="mb-5 flex items-center gap-3 pr-14">
        <h2 className="text-xl font-bold text-text-head">Sesler</h2>
        <span className="text-sm text-text-muted tabular-nums">
          {sounds.length}/{SOUNDBOARD_MAX_SOUNDS}
        </span>
        <Button
          className="ml-auto h-8"
          disabled={full}
          data-tooltip={full ? `Sunucuda en çok ${SOUNDBOARD_MAX_SOUNDS} ses olabilir` : undefined}
          onClick={() => openSoundUpload(guildId)}
        >
          Ses ekle
        </Button>
      </div>
      {sounds.length === 0 ? (
        <div className="text-sm text-text-muted">
          Henüz ses yok. Eklediğin sesleri sunucudaki herkes ses panelinden çalabilir.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {sounds.map((sound) => (
            <SoundRow key={sound.id} sound={sound} />
          ))}
        </div>
      )}
    </div>
  );
}

function SoundRow({ sound }: { sound: GuildSound }) {
  const uploader = useGuild((s) => {
    const u = sound.uploaderId ? s.users[sound.uploaderId] : undefined;
    return u ? u.displayName || u.username : undefined;
  });
  const openEmojiPicker = useUi((s) => s.openEmojiPicker);
  const emojiButton = useRef<HTMLButtonElement>(null);
  // null: düzenlenmiyor
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rename = async (): Promise<void> => {
    if (saving) return;
    const name = (draft ?? '').trim();
    if (!name || name === sound.name) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await updateGuildSound(sound.guildId, sound.id, { name });
      setDraft(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const changeEmoji = (): void => {
    const rect = emojiButton.current?.getBoundingClientRect();
    if (!rect) return;
    openEmojiPicker({
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      onPick: (emoji) => {
        updateGuildSound(sound.guildId, sound.id, { emoji }).catch((err) => toast(errorMessage(err), 'error'));
      },
    });
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Ses silinsin mi?',
      message: `"${sound.name}" ses panelinden kaldırılır. Bu işlem geri alınamaz.`,
      confirmLabel: 'Sil',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeGuildSound(sound.guildId, sound.id);
      toast('Ses silindi.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md bg-bg-side px-3 py-2">
      <button
        ref={emojiButton}
        type="button"
        className="press-icon flex h-8 w-8 shrink-0 items-center justify-center rounded text-xl text-text-muted hover:bg-bg-hover hover:text-text-head"
        aria-label="Emoji değiştir"
        data-tooltip="Emoji değiştir"
        onClick={changeEmoji}
      >
        {sound.emoji ?? <Music2 size={18} aria-hidden />}
      </button>
      {sound.emoji && (
        <button
          type="button"
          className="press-icon -ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-danger-text"
          aria-label={`${sound.name}: emojiyi kaldır`}
          data-tooltip="Emojiyi kaldır"
          onClick={() => {
            updateGuildSound(sound.guildId, sound.id, { emoji: null }).catch((err) => toast(errorMessage(err), 'error'));
          }}
        >
          <X size={12} aria-hidden />
        </button>
      )}
      <div className="min-w-0 flex-1">
        {draft === null ? (
          <button
            type="button"
            className="block h-8 max-w-full truncate text-left font-semibold text-text-head hover:underline"
            aria-label={`${sound.name}: adı değiştir`}
            data-tooltip="Adı değiştir"
            onClick={() => setDraft(sound.name)}
          >
            {sound.name}
          </button>
        ) : (
          <TextInput
            value={draft}
            maxLength={SOUNDBOARD_NAME_MAX}
            readOnly={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (!saving) setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void rename();
              } else if (e.key === 'Escape') {
                e.preventDefault(); // Esc sunucu ayarlarını kapatmasın
                setDraft(null);
              }
            }}
            aria-label="Ses adı"
            className="h-8"
            autoFocus
          />
        )}
      </div>
      <span className="w-32 shrink-0 truncate text-sm text-text-muted" title={uploader}>
        {uploader ?? '—'}
      </span>
      <span className="w-12 shrink-0 text-right text-sm text-text-muted tabular-nums">
        {(sound.durationMs / 1000).toFixed(1)} sn
      </span>
      <button
        type="button"
        className="press-icon flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-head"
        aria-label={`${sound.name}: dinle`}
        data-tooltip="Dinle"
        onClick={() => previewSound(guildSoundUrl(sound))}
      >
        <Play size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="press-icon flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-danger-text"
        aria-label={`${sound.name}: sil`}
        data-tooltip="Sil"
        onClick={() => void remove()}
      >
        <Trash2 size={16} aria-hidden />
      </button>
    </div>
  );
}
