import { useRef, useState } from 'react';
import { Smile, Upload, X } from 'lucide-react';
import { SOUNDBOARD_NAME_MAX, SOUNDBOARD_SOUND_MAX_BYTES, SOUNDBOARD_SOUND_MAX_SECONDS } from '@diskort/shared';
import { uploadGuildSound, useGuild } from '@diskort/client-core';
import { PresenceProvider, usePresence } from '../../lib/motion';
import { toast, useUi } from '../../stores/ui';
import { Button, Field, TextInput } from '../ui/controls';
import { Modal } from '../ui/Modal';
import {
  ACCEPT,
  CLIP_TOO_LONG_TEXT,
  loadClipBuffer,
  localFile,
  SoundClipEditor,
  type SoundClip,
} from './SoundClipEditor';
import { defaultSoundName, SOUND_TOO_LARGE_TEXT, soundUploadError } from './soundUploadView';

/**
 * Sunucunun ses paneline ses ekleme penceresi (`useUi.soundUpload` dolunca açılır). Sarmalayıcı z katmanı verilmez:
 * Modal'ın z-40'ı sunucu ayarlarından sonra çizildiği için üstünde kalır, EmojiPicker (z-50) de bunun üstünde açılır.
 */
export function SoundUploadModal() {
  const { value, closing } = usePresence(useUi((s) => s.soundUpload));
  return <PresenceProvider value={closing}>{value && <SoundUploadFlow guildId={value.guildId} />}</PresenceProvider>;
}

/** Dosya seç → kesit seç, ad ve emoji ver → yükle */
function SoundUploadFlow({ guildId }: { guildId: string }) {
  const closeModal = useUi((s) => s.closeSoundUpload);
  const openEmojiPicker = useUi((s) => s.openEmojiPicker);
  const guildName = useGuild((s) => s.guilds[guildId]?.guild.name);
  const input = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const [decoding, setDecoding] = useState(false);
  // buffer null: tarayıcı çözemedi ya da ses çok kısa, kesit seçilmez
  const [picked, setPicked] = useState<{ file: File; buffer: AudioBuffer | null } | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const validName = name.trim().length > 0;

  const close = (): void => {
    // Açık emoji seçicinin dışına tıklamak pencereyi (ve seçilen dosyayı) değil yalnız seçiciyi kapatır
    if (uploading || useUi.getState().emojiPicker) return;
    closeModal();
  };

  const choose = async (file: File): Promise<void> => {
    if (file.size > SOUNDBOARD_SOUND_MAX_BYTES) {
      toast(SOUND_TOO_LARGE_TEXT, 'error');
      return;
    }
    setDecoding(true);
    const buffer = await loadClipBuffer(file);
    setDecoding(false);
    if (buffer === 'too_long') {
      toast(CLIP_TOO_LONG_TEXT, 'error');
      return;
    }
    setName(defaultSoundName(file.name));
    setPicked({ file, buffer });
  };

  const upload = async (clip?: SoundClip): Promise<void> => {
    if (!picked || !validName || uploading) return;
    setUploading(true);
    try {
      await uploadGuildSound(localFile(picked.file), { guildId, name, emoji, ...clip });
      toast('Ses eklendi.', 'success');
      closeModal();
    } catch (err) {
      toast(soundUploadError(err), 'error');
      setUploading(false);
    }
  };

  const pickEmoji = (): void => {
    const rect = emojiButton.current?.getBoundingClientRect();
    if (!rect) return;
    openEmojiPicker({ anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, onPick: setEmoji });
  };

  if (!picked) {
    return (
      <Modal title="Ses ekle" subtitle={guildName} onClose={close}>
        <button
          type="button"
          disabled={decoding}
          className="flex w-full flex-col items-center gap-2 rounded-md border-2 border-dashed border-edge px-4 py-8 text-center text-text-normal transition-colors hover:bg-bg-hover disabled:opacity-60"
          onClick={() => input.current?.click()}
        >
          <Upload size={28} className="text-text-muted" aria-hidden />
          <span className="font-medium">{decoding ? 'Ses okunuyor…' : 'Ses dosyası seç'}</span>
          <span className="text-xs text-text-muted">
            MP3, WAV, OGG, M4A… En çok 8 MB. Çalınacak kısmı (en fazla {SOUNDBOARD_SOUND_MAX_SECONDS} saniye) sonra seçersin.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // aynı dosya yeniden seçilebilsin
            if (file) void choose(file);
          }}
        />
      </Modal>
    );
  }

  const fields = (
    <Field label="Ses adı" className="mt-4">
      {/* Alan önce gelir: etikete tıklamak emoji seçiciyi değil metin kutusunu açsın */}
      <div className="relative flex items-center">
        <TextInput
          value={name}
          maxLength={SOUNDBOARD_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          disabled={uploading}
          className="pr-9 pl-10"
          autoFocus
        />
        <button
          ref={emojiButton}
          type="button"
          disabled={uploading}
          className="press-icon absolute left-1.5 flex h-7 w-7 items-center justify-center rounded text-lg text-text-muted hover:text-text-head"
          aria-label="Emoji seç"
          data-tooltip="Emoji seç"
          onClick={pickEmoji}
        >
          {emoji ?? <Smile size={20} className="ico-bounce" />}
        </button>
        {emoji && (
          <button
            type="button"
            disabled={uploading}
            className="press-icon absolute right-2 rounded p-0.5 text-text-muted hover:text-text-head"
            aria-label="Emojiyi kaldır"
            data-tooltip="Emojiyi kaldır"
            onClick={() => setEmoji(null)}
          >
            <X size={16} className="ico-rotate" />
          </button>
        )}
      </div>
    </Field>
  );

  if (picked.buffer) {
    return (
      <SoundClipEditor
        title="Ses ekle"
        file={picked.file}
        buffer={picked.buffer}
        uploading={uploading}
        onCancel={close}
        onConfirm={upload}
        confirmDisabled={!validName}
        below={fields}
      />
    );
  }

  return (
    <Modal
      title="Ses ekle"
      subtitle={`Bu ses burada önizlenemiyor; ilk ${SOUNDBOARD_SOUND_MAX_SECONDS} saniyesi yüklenir.`}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" disabled={uploading} onClick={close}>
            Vazgeç
          </Button>
          <Button disabled={uploading || !validName} onClick={() => void upload()}>
            {uploading ? 'Yükleniyor…' : 'Yükle'}
          </Button>
        </>
      }
    >
      <div className="truncate text-sm text-text-muted" title={picked.file.name}>
        {picked.file.name}
      </div>
      {fields}
    </Modal>
  );
}
