import { feedback, haptic, soundCue } from '../haptics';
import { getSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { useVoice, voice } from './voice';

/**
 * Düğmelerden yapılan ses işlemleri: işlemi yapar ve sonucuna göre dokunma geri bildirimi verir
 * (susturunca çift tık, açınca tek tık; yapılamadıysa hata titreşimi). Ses istemcisinin kendisi
 * titreşmez: bildirimden, bağlantı kopunca ya da çıkış yaparken kendiliğinden olan işlemler sessiz kalır.
 */

const micOff = (): boolean => {
  const s = getSettings();
  return s.selfMute || s.selfDeaf;
};

export function toggleMute(): void {
  const before = micOff();
  voice.toggleMute();
  const after = micOff();
  feedback(before === after ? 'error' : after ? 'mute' : 'unmute');
}

export function toggleDeafen(): void {
  voice.toggleDeafen();
  feedback(getSettings().selfDeaf ? 'deafen' : 'undeafen');
}

export function toggleSpeaker(): void {
  const on = !getSettings().speaker;
  feedback(on ? 'speakerOn' : 'speakerOff');
  void voice.setSpeaker(on);
}

/** Ekran paylaşımı: izin yoksa hata; varsa başlat/durdur (başlatırken Android izin penceresi ya da iOS yayın seçicisi açılır) */
export function toggleScreenShare(canStream: boolean): void {
  const sharing = useVoice.getState().sharing;
  if (!sharing && !canStream) {
    feedback('error');
    toast('Bu kanalda ekran paylaşma iznin yok.', 'error');
    return;
  }
  // Ses paylaşım gerçekten başlayınca / bitince çalınır (onay penceresinde vazgeçilirse ses yok)
  haptic(sharing ? 'shareStop' : 'shareStart');
  void voice.toggleScreenShare();
}

/** Ses kanalına katıl (zaten oradaysa bir şey yapmaz) */
export function joinVoice(channelId: string): void {
  if (useVoice.getState().channelId === channelId) return;
  // Katılma sesi bağlantı kurulunca çalınır (voice.ts): önce çalınca ses oturumu görüşme kipine geçerken
  // kesiliyordu
  haptic('join');
  voice.join(channelId).catch((err: Error) => {
    feedback('error');
    toast(err.message, 'error');
  });
}

export function leaveVoice(): void {
  haptic('leave');
  // Ayrılma sesi ses oturumu kapandıktan sonra (normal kipte) çalınır; görüşme kipinden çıkarken kesilmez
  void voice.leave().then(() => soundCue('leave'));
}
