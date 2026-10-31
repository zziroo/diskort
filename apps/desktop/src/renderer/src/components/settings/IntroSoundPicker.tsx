import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Music2, Play, Square } from 'lucide-react';
import { INTRO_SOUND_MAX_BYTES, INTRO_SOUND_MAX_SECONDS, type User } from '@diskort/shared';
import { errorMessage, formatBytes, introSoundUrl, removeIntroSound, uploadIntroSound } from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { PresenceProvider, usePresence } from '../../lib/motion';
import { playIntroSound, stopIntroSound } from '../../lib/sfx';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import { ACCEPT, CLIP_TOO_LONG_TEXT, loadClipBuffer, localFile, SoundClipEditor, type SoundClip } from '../sounds/SoundClipEditor';
import { Button, SectionTitle } from '../ui/controls';

/**
 * Giriş sesi: kullanıcının yüklediği kısa ses (en fazla INTRO_SOUND_MAX_SECONDS); ses kanalına girince
 * kanaldakiler (kendisi dahil) genel katılma sesinin hemen ardından bunu duyar. Düzenleyicide çalınacak kesitin
 * başlangıcı ve uzunluğu seçilir (kısa dosya da kısaltılabilir); kırpma, ses yüksekliği eşitleme ve MP3'e çevirme
 * sunucuda yapılır.
 */
export function IntroSoundPicker({ user }: { user: User }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'decode' | 'upload' | 'remove' | null>(null);
  const [editing, setEditing] = useState<{ file: File; buffer: AudioBuffer } | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const playToken = useRef(0);
  const editor = usePresence(editing);
  const url = introSoundUrl(user);

  const setPlayingBoth = (v: boolean): void => {
    playingRef.current = v;
    setPlaying(v);
  };

  // Sayfadan çıkınca kendi dinlemesi susar (kanaldaki başka bir giriş sesine dokunulmaz)
  useEffect(
    () => () => {
      if (playingRef.current) stopIntroSound();
    },
    [],
  );

  const upload = async (file: File, clip: Partial<SoundClip> = {}): Promise<boolean> => {
    setBusy('upload');
    try {
      await uploadIntroSound(localFile(file), clip);
      toast('Giriş sesi güncellendi.', 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const picked = async (file: File): Promise<void> => {
    if (file.size > INTRO_SOUND_MAX_BYTES) {
      toast(`Ses dosyası çok büyük (en fazla ${formatBytes(INTRO_SOUND_MAX_BYTES)}).`, 'error');
      return;
    }
    setBusy('decode');
    const buffer = await loadClipBuffer(file);
    setBusy(null);
    if (buffer === 'too_long') {
      toast(CLIP_TOO_LONG_TEXT, 'error');
      return;
    }
    // Çözülemeyen ya da en kısa uzunluktan kısa ses doğrudan gider (sunucu kendi kurallarıyla kırpar/reddeder)
    if (!buffer) {
      await upload(file);
      return;
    }
    setEditing({ file, buffer });
  };

  const listen = (): void => {
    if (!url) return;
    if (playing) {
      stopIntroSound();
      setPlayingBoth(false);
      return;
    }
    setPlayingBoth(true);
    const token = ++playToken.current;
    void playIntroSound(url, {
      preview: true,
      onEnd: () => {
        if (token === playToken.current) setPlayingBoth(false); // eski kaynağın bitişi yenisini sıfırlamasın
      },
    }).then((ok) => {
      if (ok || !playingRef.current) return; // çaldı ya da bu arada durduruldu
      setPlayingBoth(false);
      toast('Giriş sesi çalınamadı.', 'error');
    });
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Giriş sesi kaldırılsın mı?',
      message: 'Kanala girince yeniden genel katılma sesi çalar.',
      confirmLabel: 'Kaldır',
      danger: true,
    });
    if (!ok) return;
    if (playingRef.current) stopIntroSound();
    setPlayingBoth(false);
    setBusy('remove');
    try {
      await removeIntroSound();
      toast('Giriş sesi kaldırıldı.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pick = (): void => input.current?.click();

  return (
    <div>
      <SectionTitle>Giriş Sesi</SectionTitle>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
            url ? 'bg-brand/15 text-brand' : 'bg-bg-active text-text-muted',
          )}
          aria-hidden
        >
          <Music2 size={20} />
        </span>
        <span className="min-w-[120px] flex-1 text-sm text-text-normal">
          {url ? 'Kişisel giriş sesin var' : 'Genel katılma sesi çalıyor'}
        </span>
        <div className="flex flex-wrap gap-2">
          {url && (
            <Button type="button" variant="secondary" onClick={listen} disabled={busy !== null}>
              <span className="inline-flex items-center gap-1.5">
                {playing ? <Square size={14} /> : <Play size={14} />}
                {playing ? 'Durdur' : 'Dinle'}
              </span>
            </Button>
          )}
          <Button type="button" onClick={pick} disabled={busy !== null}>
            {busy === 'decode' || busy === 'upload' ? 'Yükleniyor…' : url ? 'Değiştir' : 'Giriş Sesi Yükle'}
          </Button>
          {url && (
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void remove()}>
              Kaldır
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        MP3, WAV, OGG, M4A… En fazla {INTRO_SOUND_MAX_SECONDS} saniye; çalınacak kısmı ve uzunluğu seçersin. Kanala
        girince herkes katılma sesinin ardından duyar.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // aynı dosya yeniden seçilebilsin
          if (file) void picked(file);
        }}
      />
      <PresenceProvider value={editor.closing}>
        {editor.value &&
          createPortal(
            // Ayarlar penceresinin üstünde açılsın
            <div className="relative z-[60]">
              <SoundClipEditor
                title="Giriş sesini seç"
                file={editor.value.file}
                buffer={editor.value.buffer}
                uploading={busy === 'upload'}
                onCancel={() => setEditing(null)}
                onConfirm={async (clip) => {
                  if (await upload(editor.value!.file, clip)) setEditing(null);
                }}
              />
            </div>,
            document.body,
          )}
      </PresenceProvider>
    </div>
  );
}
