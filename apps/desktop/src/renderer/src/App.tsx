import { useEffect } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { ContextMenu } from './components/ContextMenu';
import { EmojiPicker } from './components/EmojiPicker';
import { MainLayout } from './components/MainLayout';
import { ProfilePopover } from './components/members/ProfilePopover';
import { ActivityHoverCard } from './components/sidebar/ActivityHoverCard';
import { ActivityPopover } from './components/status/ActivityPopover';
import { StreamPreviewCard } from './components/sidebar/StreamPreviewCard';
import { SelfProfilePopout } from './components/status/SelfProfilePopout';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import { ConfirmDialogHost } from './components/ui/ConfirmDialog';
import { TooltipHost } from './components/ui/Tooltip';
import { UpdateRequired } from './components/UpdateRequired';
import { useDesktopIntegration } from './features/desktop/useDesktopIntegration';
import { bridge, isMac, isWindows } from './lib/bridge';
import { editableField, openEditMenu } from './lib/editMenu';
import { useSession } from '@diskort/client-core';
import { useUpdate } from './stores/update';

const hasTitleBar = Boolean(bridge) && (isWindows || isMac);

export function App() {
  const token = useSession((s) => s.token);
  const requiredVersion = useUpdate((s) => s.required);
  useDesktopIntegration();

  useEffect(() => {
    document.documentElement.style.setProperty('--titlebar-h', hasTitleBar ? '30px' : '0px');
    // Tarayıcının sağ tık menüsü hiç açılmaz; metin kutularında temalı Kes/Kopyala/Yapıştır menüsü açılır.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      const field = editableField(e.target);
      if (field) openEditMenu(e, field);
    };
    window.addEventListener('contextmenu', onContextMenu);
    // Metin kanalı dışına bırakılan dosya pencerede açılmaya çalışılmasın
    const onDrop = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', onDrop);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('dragover', onDrop);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="min-h-0 flex-1">
        {requiredVersion ? (
          <UpdateRequired version={requiredVersion} />
        ) : token ? (
          <MainLayout />
        ) : (
          <AuthScreen />
        )}
      </div>
      <ContextMenu />
      <EmojiPicker />
      <ProfilePopover />
      <StreamPreviewCard />
      <ActivityHoverCard />
      <ActivityPopover />
      <SelfProfilePopout />
      <ConfirmDialogHost />
      <Toasts />
      <TooltipHost />
    </div>
  );
}
