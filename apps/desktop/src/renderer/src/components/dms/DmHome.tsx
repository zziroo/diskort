import { useMemo } from 'react';
import { MessageCircle, MessagesSquare } from 'lucide-react';
import { useGuild, useSession } from '@diskort/client-core';
import { startDm } from '../../lib/dm';
import { useUi } from '../../stores/ui';
import { PresenceSubline } from '../status/ActivityCard';
import { PresenceAvatar } from '../ui/Avatar';
import { Button } from '../ui/controls';

const QUICK_MAX = 12;

/** Direkt mesajlar bölümünde konuşma seçilmemişken ana alan: açıklama ve hızlı başlatma. */
export function DmHome() {
  const selfId = useSession((s) => s.user?.id);
  const users = useGuild((s) => s.users);
  const reachable = useGuild((s) => s.reachable);
  const online = useGuild((s) => s.online);
  const openModal = useUi((s) => s.openModal);
  // Önce çevrimiçi olanlar, sonra ada göre
  const members = useMemo(
    () =>
      Object.values(users)
        .filter((u) => reachable[u.id] && u.id !== selfId)
        .sort(
          (a, b) =>
            Number(Boolean(online[b.id])) - Number(Boolean(online[a.id])) ||
            a.displayName.localeCompare(b.displayName, 'tr'),
        )
        .slice(0, QUICK_MAX),
    [users, reachable, online, selfId],
  );

  return (
    <div className="anim-fade-in flex h-full flex-col items-center overflow-y-auto bg-bg-main p-8 text-center">
      <div className="mt-[8vh] mb-4 flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl bg-brand text-white">
        <MessagesSquare size={40} />
      </div>
      <h1 className="text-2xl font-bold text-text-head">Direkt Mesajlar</h1>
      <p className="mt-2 max-w-md text-text-muted">
        Bir kişiyle ya da küçük bir grupla ayrı yazış. Mesajları yalnızca konuşmadakiler görür; sunucu yöneticileri de
        okuyamaz.
      </p>
      <Button className="mt-5" onClick={() => openModal({ type: 'newDm' })}>
        Yeni Mesaj
      </Button>

      {members.length > 0 && (
        <div className="mt-10 w-full max-w-2xl text-left">
          <h2 className="mb-2 px-1 text-xs font-bold tracking-wide text-text-muted uppercase">Kime yazmak istersin?</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
            {members.map((u) => (
              <button
                key={u.id}
                className="group flex items-center gap-3 rounded-lg bg-bg-side px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
                onClick={() => void startDm(u.id)}
              >
                <PresenceAvatar userId={u.id} user={u} size={32} ringClassName="bg-bg-side" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate font-medium text-text-normal">{u.displayName}</span>
                  {/* Oynuyorsa oyun simgesi; özel durum, yoksa oynadığı oyun, o da yoksa kullanıcı adı */}
                  <PresenceSubline
                    userId={u.id}
                    interactive={false}
                    className="text-xs text-text-muted"
                    fallback={<span className="block truncate text-xs text-text-muted">@{u.username}</span>}
                  />
                </span>
                <MessageCircle size={18} className="ico-pop shrink-0 text-text-muted group-hover:text-text-head" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
