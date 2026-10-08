import { useEffect } from 'react';
import { AudioLines } from 'lucide-react';
import { dmTitle, gateway, takePendingInvite, useGuild, usePendingInvite, useSession } from '@diskort/client-core';
import { voice } from '../features/voice/voiceClient';
import { toast, useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { isDmSection, useMainView } from '../lib/mainView';
import { DURATION, PresenceProvider, usePresence } from '../lib/motion';
import { IncomingCall } from './calls/IncomingCall';
import { ImageViewer } from './text/ImageViewer';
import { TextChannelView } from './text/TextChannelView';
import { UpdateReadyBar } from './UpdateRequired';
import { ChannelSidebar } from './sidebar/ChannelSidebar';
import { DmHome } from './dms/DmHome';
import { NewDmModal, RenameDmModal } from './dms/DmModals';
import { DmSidebar } from './dms/DmSidebar';
import { FriendsView } from './friends/FriendsView';
import { GuildRail } from './GuildRail';
import { LeftColumn } from './sidebar/LeftColumn';
import { VoiceStage } from './stage/VoiceStage';
import { Welcome } from './stage/Welcome';
import { AddGuildModal } from './modals/AddGuildModal';
import { BanModal } from './modals/BanModal';
import { InviteModal } from './modals/InviteModal';
import { ReactionsModal } from './modals/ReactionsModal';
import { NoGuilds, NoGuildsSidebar } from './NoGuilds';
import { ChannelModal } from './modals/ChannelModal';
import { ScreenSharePicker } from './modals/ScreenSharePicker';
import { ServerSettingsModal } from './serverSettings/ServerSettingsModal';
import { SettingsModal } from './settings/SettingsModal';
import { CustomStatusModal } from './status/CustomStatusModal';
import { FeedbackModal } from './feedback/FeedbackModal';
import { useFeedbackToasts } from '../features/feedback/useFeedbackToasts';

export function MainLayout() {
  const token = useSession((s) => s.token);
  const status = useGuild((s) => s.status);
  // İlk READY gelene kadar "Bağlanıyor…"; sonra sunucu olmasa da arayüz açılır
  const ready = useGuild((s) => s.status === 'ready' || s.guildOrder.length > 0);
  const hasGuild = useGuild((s) => s.guild !== null);
  const view = useMainView();
  const textChannel = useGuild((s) =>
    view.kind === 'text' ? s.channels.find((c) => c.id === view.channelId) : undefined,
  );
  const dm = useGuild((s) => (view.kind === 'dm' ? s.dms[view.channelId] : undefined));
  const selfId = useSession((s) => s.user?.id);
  const dmName = useGuild((s) => (dm ? dmTitle(dm, s.users, selfId) : ''));
  const voiceError = useVoice((s) => s.error);
  useFeedbackToasts();
  // Kapanan pencere, kapanış animasyonu bitene kadar ekranda kalır
  const { value: modal, closing: modalClosing } = usePresence(
    useUi((s) => s.modal),
    DURATION.base,
  );

  useEffect(() => {
    gateway.connect();
    return () => {
      void voice.leave();
      gateway.disconnect();
    };
  }, [token]);

  // Davet bağlantısıyla açıldıysa (diskort://davet/<kod>) katılma penceresi kodla hazır açılır; katılmak
  // için yine Katıl'a basılır
  const pendingInvite = usePendingInvite((s) => s.code);
  useEffect(() => {
    if (!ready || !pendingInvite) return;
    const code = takePendingInvite();
    if (code) useUi.getState().openModal({ type: 'addGuild', tab: 'join', code });
  }, [ready, pendingInvite]);

  useEffect(() => {
    if (!voiceError) return;
    toast(voiceError, 'error');
    voice.clearError();
  }, [voiceError]);

  if (!ready) {
    return (
      <div className="anim-fade-in flex h-full flex-col items-center justify-center gap-4 bg-bg-main text-text-muted">
        <AudioLines size={48} className="animate-pulse text-brand" />
        <div>{status === 'reconnecting' ? 'Sunucuya ulaşılamıyor, tekrar deneniyor…' : 'Bağlanıyor…'}</div>
        <button
          className="text-sm text-link hover:underline"
          onClick={() => {
            gateway.disconnect();
            useSession.getState().logout();
          }}
        >
          Çıkış yap
        </button>
      </div>
    );
  }

  const modals = (
    <>
      <PresenceProvider value={modalClosing}>
        {modal?.type === 'settings' && <SettingsModal initial={modal.section} />}
        {modal?.type === 'serverSettings' && hasGuild && <ServerSettingsModal initial={modal.section} />}
        {modal?.type === 'screenPicker' && <ScreenSharePicker />}
        {modal?.type === 'channel' && <ChannelModal channel={modal.channel} channelType={modal.channelType} />}
        {modal?.type === 'image' && <ImageViewer attachment={modal.attachment} source={modal.source} />}
        {modal?.type === 'newDm' && <NewDmModal addTo={modal.addTo} />}
        {modal?.type === 'renameDm' && <RenameDmModal channelId={modal.channelId} />}
        {modal?.type === 'feedback' && <FeedbackModal />}
        {modal?.type === 'addGuild' && <AddGuildModal key={modal.code} tab={modal.tab} code={modal.code} />}
        {modal?.type === 'invite' && hasGuild && <InviteModal />}
        {modal?.type === 'customStatus' && <CustomStatusModal />}
        {modal?.type === 'reactions' && (
          <ReactionsModal channelId={modal.channelId} messageId={modal.messageId} emoji={modal.emoji} />
        )}
      </PresenceProvider>
      <BanModal />
      <IncomingCall />
    </>
  );

  // Hiç sunucu yok: direkt mesajlar açılabilir, yoksa "sunucu kur / katıl" ekranı
  if (!hasGuild && !isDmSection(view)) {
    return (
      <div className="relative flex h-full min-h-0">
        <LeftColumn>
          <GuildRail />
          <NoGuildsSidebar />
        </LeftColumn>
        <NoGuilds />
        {modals}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0">
      <LeftColumn>
        <GuildRail />
        {isDmSection(view) ? <DmSidebar /> : <ChannelSidebar />}
      </LeftColumn>
      <main className="flex min-w-0 flex-1 flex-col">
        <UpdateReadyBar />
        {status === 'reconnecting' && (
          <div className="anim-bar-in bg-warn px-4 py-1 text-center text-sm font-medium text-black">
            Sunucu bağlantısı koptu, yeniden bağlanılıyor…
          </div>
        )}
        {/* Kanal/görünüm değişince yeni içerik hafifçe belirir */}
        <div className="min-h-0 flex-1 bg-bg-main">
          {view.kind === 'voice' ? (
            <div key="voice" className="anim-fade-in h-full">
              <VoiceStage />
            </div>
          ) : dm ? (
            <TextChannelView key={dm.id} channel={{ id: dm.id, name: dmName }} dm={dm} />
          ) : view.kind === 'dms' ? (
            <DmHome key="dms" />
          ) : view.kind === 'friends' ? (
            <FriendsView key="friends" />
          ) : textChannel ? (
            <TextChannelView key={textChannel.id} channel={textChannel} />
          ) : (
            <div key="home" className="anim-fade-in h-full">
              <Welcome />
            </div>
          )}
        </div>
      </main>

      {modals}
    </div>
  );
}
