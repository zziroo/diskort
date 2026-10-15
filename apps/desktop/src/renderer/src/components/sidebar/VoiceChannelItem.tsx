import { useMemo } from 'react';
import { Lock, Volume2 } from 'lucide-react';
import { Permission, type Channel } from '@diskort/shared';
import { voice } from '../../features/voice/voiceClient';
import { membersOf, streamersFirst, useCan, useGuild } from '@diskort/client-core';
import type { VoiceState } from '@diskort/shared';
import { channelMenuItems, isPrivateChannel } from '../../lib/channelMenu';
import { collapseClass, usePresenceList } from '../../lib/motion';
import { channelDropState, startSidebarDrag, useSidebarDrag, voiceDropState } from '../../lib/sidebarDrag';
import { cn } from '../../lib/utils';
import { DropLine } from './TextChannelItem';
import { toast, useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { VoiceMemberRow } from './VoiceMemberRow';
import { ElapsedTime } from './ElapsedTime';

export function VoiceChannelItem({ channel }: { channel: Channel }) {
  const voiceStates = useGuild((s) => s.voiceStates);
  // Yayın açanlar üstte, gerisi katılış sırasında (geri bildirim #35)
  const members = useMemo(() => streamersFirst(membersOf(voiceStates, channel.id)), [voiceStates, channel.id]);
  const activeChannel = useVoice((s) => s.channelId);
  const canConnect = useCan(Permission.CONNECT, channel.id);
  const locked = useGuild((s) => isPrivateChannel(channel, s.guild?.id));
  const openContextMenu = useUi((s) => s.openContextMenu);
  const setView = useUi((s) => s.setView);
  const isActive = activeChannel === channel.id;
  // Kanalın ne zamandır dolu olduğu: içerideki en eski katılım. Girmeden de görünür (geri bildirim #35)
  const activeSince = members.length ? Math.min(...members.map((m) => m.joinedAt)) : null;
  // Katılan üye satırı aşağı doğru açılarak, ayrılan kapanarak görünür
  const rows = usePresenceList(members, (m: VoiceState) => m.userId, 180);
  // Sürükle-bırak: üye bırakma hedefi ve kanal sıralama
  const drop = useSidebarDrag((s) => voiceDropState(s, channel.id));
  const order = useSidebarDrag((s) => channelDropState(s, channel.id));
  const canReorder = useCan(Permission.MANAGE_CHANNELS);

  return (
    <div
      className={cn('relative mb-0.5 rounded transition-[background-color,opacity] duration-150', order === 'source' && 'opacity-40', drop === 'valid' && 'bg-bg-hover')}
      data-drop-voice={channel.id}
      data-drop-channel={channel.id}
      data-channel-type="voice"
    >
      {(order === 'before' || order === 'after') && <DropLine after={order === 'after'} />}
      <button
        className={cn(
          'group flex h-8 w-full items-center gap-1.5 rounded px-2 text-left transition-[color,background-color,box-shadow,opacity] duration-150',
          isActive ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
          !canConnect && !isActive && 'opacity-60',
          drop === 'valid' && 'bg-bg-active text-text-head ring-2 ring-brand ring-inset',
          drop === 'candidate' && 'text-text-normal',
          drop === 'invalid' && 'opacity-40',
        )}
        onPointerDown={
          canReorder
            ? (e) => startSidebarDrag(e, () => ({ kind: 'channel', channelId: channel.id, channelType: 'voice', name: channel.name }))
            : undefined
        }
        onMouseEnter={() => canConnect && voice.prefetch(channel.id)}
        onClick={() => {
          if (!isActive) {
            if (!canConnect) {
              toast('Bu ses kanalına bağlanma iznin yok.', 'error');
              return;
            }
            void voice.join(channel.id);
          }
          setView({ kind: 'voice', channelId: channel.id });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = channelMenuItems(channel);
          if (items.length) openContextMenu({ x: e.clientX, y: e.clientY, items });
        }}
      >
        <span className="relative shrink-0 opacity-80">
          <Volume2 size={20} />
          {(locked || !canConnect) && (
            <Lock
              size={10}
              strokeWidth={3}
              aria-label={canConnect ? 'Özel kanal' : 'Bağlanma iznin yok'}
              className="absolute -top-0.5 -right-1 rounded-sm bg-bg-side"
            />
          )}
        </span>
        <span className="truncate font-medium">{channel.name}</span>
        {activeSince !== null && <ElapsedTime since={activeSince} />}
      </button>
      {rows.length > 0 && (
        <div className="mt-0.5 mb-1 ml-6 flex flex-col">
          {rows.map(({ key, item, phase }) => (
            <div key={key} className={collapseClass(phase)}>
              <div className={cn(phase !== 'static' && 'collapse-inner', 'pb-px')}>
                <VoiceMemberRow state={item} inMyChannel={isActive} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
