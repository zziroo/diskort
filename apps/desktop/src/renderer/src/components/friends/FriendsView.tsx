import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Check, MessageCircle, UserMinus, UserPlus, Users, X } from 'lucide-react';
import type { FriendEntry } from '@diskort/shared';
import { DM_CONTEXT, loadFriends, sendFriendRequest, useFriends, useGuild } from '@diskort/client-core';
import { startDm } from '../../lib/dm';
import { acceptFriend, cancelFriend, confirmRemoveFriend, declineFriend } from '../../lib/friends';
import { memberMenuItems } from '../../lib/memberMenu';
import { cn } from '../../lib/utils';
import { useUi } from '../../stores/ui';
import { PresenceSubline } from '../status/ActivityCard';
import { PresenceAvatar } from '../ui/Avatar';
import { Button, Field, TextInput } from '../ui/controls';

type Tab = 'all' | 'pending' | 'add';

/**
 * Direkt mesajlar bölümündeki "Arkadaşlar" görünümü: arkadaşlar (mesaj gönder, arkadaşlıktan çıkar),
 * bekleyen istekler (gelen: kabul et / reddet; giden: geri çek) ve kullanıcı adıyla arkadaş ekleme.
 */
export function FriendsView() {
  const list = useFriends();
  const pending = list.incoming.length + list.outgoing.length;
  // Gelen istek varsa "Bekleyen" ile açılır
  const view = useUi((s) => s.view);
  const requestedTab = view.kind === 'friends' ? view.tab : undefined;
  const [tab, setTab] = useState<Tab>(() => requestedTab ?? (list.incoming.length > 0 ? 'pending' : 'all'));

  // Görünüm yeniden istenirse (ör. bildirime tıklama) istenen sekmeye geç; nesne her istekte yenidir
  useEffect(() => {
    if (view.kind === 'friends' && view.tab) setTab(view.tab);
  }, [view]);

  // Yanıtı beklenen satırlar: düğmelere art arda basılınca ikinci istek gitmesin
  const [busy, setBusy] = useState<Record<string, true>>({});
  const run = async (userId: string, action: () => Promise<unknown>): Promise<void> => {
    if (busy[userId]) return;
    setBusy((b) => ({ ...b, [userId]: true }));
    try {
      await action();
    } finally {
      setBusy(({ [userId]: _, ...rest }) => rest);
    }
  };

  // Liste READY ile gelir; görünüm açılınca bir kez tazelenir
  useEffect(() => {
    void loadFriends();
  }, []);

  return (
    <div className="anim-fade-in flex h-full min-w-0 flex-col bg-bg-main">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-4 shadow-sm">
        <Users size={20} className="shrink-0 text-text-muted" />
        <span className="font-semibold text-text-head">Arkadaşlar</span>
        <span className="mx-2 h-6 w-px bg-divider" />
        <nav className="flex min-w-0 items-center gap-1" role="tablist">
          <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
            Tümü
          </TabButton>
          <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>
            Bekleyen
            {list.incoming.length > 0 && (
              <span className="ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
                {list.incoming.length > 99 ? '99+' : list.incoming.length}
              </span>
            )}
          </TabButton>
          <button
            role="tab"
            aria-selected={tab === 'add'}
            className={cn(
              'press flex h-7 items-center rounded px-2 text-sm font-medium whitespace-nowrap transition-colors',
              tab === 'add' ? 'bg-transparent text-ok' : 'bg-ok text-white hover:bg-ok-hover',
            )}
            onClick={() => setTab('add')}
          >
            Arkadaş ekle
          </button>
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === 'all' && (
          <Section title={`Tümü — ${list.friends.length}`} empty="Henüz arkadaşın yok. Arkadaş ekle sekmesinden kullanıcı adıyla istek gönderebilirsin.">
            {list.friends.map((e) => (
              <FriendRow key={e.userId} entry={e}>
                <RowAction label="Mesaj gönder" onClick={() => void startDm(e.userId)}>
                  <MessageCircle size={18} />
                </RowAction>
                <RowAction label="Arkadaşlıktan çıkar" danger disabled={Boolean(busy[e.userId])} onClick={() => void run(e.userId, () => confirmRemoveFriend(e.userId))}>
                  <UserMinus size={18} />
                </RowAction>
              </FriendRow>
            ))}
          </Section>
        )}

        {tab === 'pending' &&
          (pending === 0 ? (
            <Empty>Bekleyen arkadaşlık isteği yok.</Empty>
          ) : (
            <>
              {list.incoming.length > 0 && (
                <Section title={`Gelen — ${list.incoming.length}`}>
                  {list.incoming.map((e) => (
                    <FriendRow key={e.userId} entry={e} note="Sana arkadaşlık isteği gönderdi">
                      <RowAction label="Kabul et" ok disabled={Boolean(busy[e.userId])} onClick={() => void run(e.userId, () => acceptFriend(e.userId))}>
                        <Check size={18} />
                      </RowAction>
                      <RowAction label="Reddet" danger disabled={Boolean(busy[e.userId])} onClick={() => void run(e.userId, () => declineFriend(e.userId))}>
                        <X size={18} />
                      </RowAction>
                    </FriendRow>
                  ))}
                </Section>
              )}
              {list.outgoing.length > 0 && (
                <Section title={`Giden — ${list.outgoing.length}`}>
                  {list.outgoing.map((e) => (
                    <FriendRow key={e.userId} entry={e} note="Arkadaşlık isteği gönderildi">
                      <RowAction label="İsteği geri çek" danger disabled={Boolean(busy[e.userId])} onClick={() => void run(e.userId, () => cancelFriend(e.userId))}>
                        <X size={18} />
                      </RowAction>
                    </FriendRow>
                  ))}
                </Section>
              )}
            </>
          ))}

        {tab === 'add' && <AddFriendForm />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={cn(
        'flex h-7 items-center rounded px-2 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Section({ title, empty, children }: { title: string; empty?: string; children: ReactNode[] }) {
  return (
    <section className="mb-4">
      <h2 className="mb-1 px-2 text-xs font-bold tracking-wide text-text-muted uppercase">{title}</h2>
      {children.length === 0 && empty ? <Empty>{empty}</Empty> : <div className="flex flex-col">{children}</div>}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="anim-fade-in px-2 pt-2 text-sm text-text-muted">{children}</p>;
}

/** Kişi satırı: avatar (çevrimiçi göstergesiyle), ad, durum satırı ya da not; sağda eylemler */
function FriendRow({ entry, note, children }: { entry: FriendEntry; note?: string; children: ReactNode }) {
  // Depodaki profil daha güncel olabilir (ad, avatar değişikliği)
  const user = useGuild((s) => s.users[entry.userId]) ?? entry.user;
  const openContextMenu = useUi((s) => s.openContextMenu);
  return (
    <div
      className="group/row flex h-[60px] items-center gap-3 rounded-lg border-t border-divider px-2 transition-colors first:border-t-transparent hover:border-t-transparent hover:bg-bg-hover"
      onContextMenu={(e) => {
        e.preventDefault();
        const items = memberMenuItems(user.id, DM_CONTEXT);
        if (items.length) openContextMenu({ x: e.clientX, y: e.clientY, items });
      }}
    >
      <PresenceAvatar userId={user.id} user={user} size={32} ringClassName="bg-bg-main" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-semibold text-text-head">{user.displayName}</span>
          <span className="truncate text-sm text-text-muted">@{user.username}</span>
        </div>
        {note ? (
          <div className="truncate text-xs text-text-muted">{note}</div>
        ) : (
          <PresenceSubline userId={user.id} className="text-xs text-text-muted" />
        )}
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}

function RowAction({
  label,
  danger,
  ok,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  ok?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-tooltip={label}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'press-icon flex h-9 w-9 items-center justify-center rounded-full bg-bg-raised text-text-muted transition-colors disabled:opacity-40',
        danger ? 'hover:text-danger' : ok ? 'hover:text-ok' : 'hover:text-text-head',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Kullanıcı adıyla istek; sonuç (hata ya da başarı) alanın altında */
function AddFriendForm() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const name = username.trim();
    if (!name || busy) return;
    setBusy(true);
    const res = await sendFriendRequest(name);
    setBusy(false);
    setAttempt((n) => n + 1);
    if ('error' in res) {
      setResult({ error: res.error });
    } else {
      setResult({ ok: res.status === 'friends' ? 'Artık arkadaşsınız.' : 'İstek gönderildi.' });
      setUsername('');
    }
  };

  return (
    <form className="max-w-xl" noValidate onSubmit={(e) => void submit(e)}>
      <h2 className="mb-1 font-semibold text-text-head">Arkadaş ekle</h2>
      <p className="mb-4 text-sm text-text-muted">
        Kullanıcı adıyla arkadaşlık isteği gönder. Arkadaşınla ortak bir sunucunuz olmasa da mesajlaşabilirsiniz.
      </p>
      <Field
        label="Kullanıcı adı"
        error={result?.error}
        shakeKey={attempt}
        hint={result?.ok ? <span className="text-ok">{result.ok}</span> : undefined}
      >
        <div className="flex gap-2">
          <TextInput
            autoFocus
            value={username}
            placeholder="kullaniciadi"
            maxLength={64}
            onChange={(e) => {
              setUsername(e.target.value);
              if (result) setResult(null);
            }}
          />
          <Button type="submit" disabled={busy || !username.trim()} className="flex shrink-0 items-center gap-1.5">
            <UserPlus size={16} aria-hidden />
            İstek gönder
          </Button>
        </div>
      </Field>
    </form>
  );
}
