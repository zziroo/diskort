import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, KeyRound, ShieldCheck, ShieldOff, Trash2, UserCheck, UserMinus, UserX } from 'lucide-react';
import type { Invite, User } from '@diskort/shared';
import { api, errorMessage, useSession } from '@diskort/client-core';
import { confirmDialog } from '../../lib/dialog';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/ui';
import { Avatar } from '../ui/Avatar';
import { Skeleton } from '../ui/Skeleton';
import { Button, Field, SectionTitle, Select, TextInput } from '../ui/controls';

/**
 * Kullanıcı Ayarları > Yönetim (hesap yöneticilerine; indirgenmiş hâli hesap yardımcılarına). Hesap
 * yöneticiliği hiçbir sunucuya bağlı değildir: hesap yöneticileri, hesap yardımcıları, yalnızca hesap
 * açtıran davetler, şifre sıfırlama kodu ve hesap silme. Hesap yardımcısı yalnızca davetleri ve sıradan
 * hesapların sıfırlama kodunu görür (sunucu da aynı sınırı uygular). Sunucuya ait işler (roller, üyeler,
 * sunucu davetleri) Sunucu Ayarları'nda kalır.
 */
export function AdminSection() {
  const selfId = useSession((s) => s.user?.id);
  const isAdmin = useSession((s) => s.user?.isAdmin === true);
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    api
      .listUsers()
      .then(setUsers)
      .catch((err: unknown) => setError(errorMessage(err)));
  };
  useEffect(reload, []);

  return (
    <div>
      <h2 className="mb-2 text-xl font-bold text-text-head">Yönetim</h2>
      <p className="mb-5 text-sm text-text-muted">
        {isAdmin
          ? 'Hesap yöneticileri tüm hesaplardan sorumludur; hiçbir sunucunun rolü ya da sahipliği bu yetkiyi vermez. Geri bildirimleri de hesap yöneticileri yönetir.'
          : 'Hesap yardımcısısın: hesap daveti oluşturabilir, sıradan hesaplar için şifre sıfırlama kodu üretebilirsin. Hesap silme ve yönetici işleri hesap yöneticilerindedir.'}
      </p>
      {error ? (
        <div className="text-sm text-danger-text">{error}</div>
      ) : users === null ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Yükleniyor">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : (
        <>
          {isAdmin && <AdminsBlock users={users} selfId={selfId} onChange={reload} />}
          {isAdmin && <HelpersBlock users={users} selfId={selfId} onChange={reload} />}
          <AccountInvitesBlock users={users} selfId={selfId} isAdmin={isAdmin} />
          <AccountsBlock users={users} selfId={selfId} isAdmin={isAdmin} onChange={reload} />
        </>
      )}
    </div>
  );
}

const byName = (a: User, b: User): number => a.displayName.localeCompare(b.displayName, 'tr');

function matches(user: User, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('tr');
  return !q || user.username.includes(q) || user.displayName.toLocaleLowerCase('tr').includes(q);
}

function UserLine({ user, selfId, children }: { user: User; selfId?: string; children?: ReactNode }) {
  return (
    <div className="anim-rise-in flex items-center gap-3 rounded-md bg-bg-side px-3 py-2">
      <Avatar user={user} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-text-head">
          {user.displayName}
          {user.id === selfId && <span className="ml-1.5 text-xs text-text-muted">(sen)</span>}
        </div>
        <div className="truncate text-xs text-text-muted">@{user.username}</div>
      </div>
      {children}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      data-tooltip={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'press-icon rounded p-1.5 text-text-muted hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-40',
        danger ? 'hover:text-danger' : 'hover:text-text-head',
      )}
    >
      {children}
    </button>
  );
}

// ---------- Hesap yöneticileri ----------

function AdminsBlock({ users, selfId, onChange }: { users: User[]; selfId?: string; onChange: () => void }) {
  const [query, setQuery] = useState('');
  const admins = useMemo(() => users.filter((u) => u.isAdmin).sort(byName), [users]);
  const candidates = useMemo(
    () => (query.trim() ? users.filter((u) => !u.isAdmin && matches(u, query)).sort(byName).slice(0, 8) : []),
    [users, query],
  );

  const grant = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap yöneticisi yapılsın mı?',
      message: `${user.displayName} (@${user.username}) tüm hesapları yönetebilir: geri bildirimler, hesap davetleri, şifre sıfırlama kodları ve hesap silme. Başka yönetici de ekleyip çıkarabilir.`,
      confirmLabel: 'Yönetici Yap',
    });
    if (!ok) return;
    try {
      await api.grantAdmin(user.id);
      toast(`${user.displayName} artık hesap yöneticisi.`, 'success');
      setQuery('');
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const revoke = async (user: User): Promise<void> => {
    const self = user.id === selfId;
    const ok = await confirmDialog({
      title: self ? 'Yöneticiliği bırakmak istiyor musun?' : 'Yöneticilik alınsın mı?',
      message: self
        ? 'Geri bildirimleri ve hesapları artık yönetemezsin. Geri almak için başka bir yöneticinin seni yeniden eklemesi gerekir.'
        : `${user.displayName} (@${user.username}) artık hesapları ve geri bildirimleri yönetemez.`,
      confirmLabel: self ? 'Bırak' : 'Yöneticiliği Al',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeAdmin(user.id);
      toast(self ? 'Artık hesap yöneticisi değilsin.' : `${user.displayName} artık hesap yöneticisi değil.`, 'success');
      if (!self) onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const last = admins.length <= 1;
  return (
    <>
      <SectionTitle>Hesap yöneticileri</SectionTitle>
      <div className="flex flex-col gap-1">
        {admins.map((u) => (
          <UserLine key={u.id} user={u} selfId={selfId}>
            <IconButton
              label={last ? 'Son yönetici çıkarılamaz' : u.id === selfId ? 'Yöneticiliği bırak' : 'Yöneticiliği al'}
              danger
              disabled={last}
              onClick={() => void revoke(u)}
            >
              <ShieldOff size={16} />
            </IconButton>
          </UserLine>
        ))}
      </div>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Yönetici eklemek için hesap ara"
        className="mt-3"
      />
      {candidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {candidates.map((u) => (
            <UserLine key={u.id} user={u} selfId={selfId}>
              <Button variant="secondary" className="flex h-8 items-center gap-1.5 px-3" onClick={() => void grant(u)}>
                <ShieldCheck size={15} className="ico-pop" /> Yönetici yap
              </Button>
            </UserLine>
          ))}
        </div>
      )}
      {query.trim() && candidates.length === 0 && <div className="mt-2 text-sm text-text-muted">Eşleşen hesap yok.</div>}
    </>
  );
}

// ---------- Hesap yardımcıları (yalnızca yönetici atar) ----------

function HelpersBlock({ users, selfId, onChange }: { users: User[]; selfId?: string; onChange: () => void }) {
  const [query, setQuery] = useState('');
  const helpers = useMemo(() => users.filter((u) => u.isAccountHelper).sort(byName), [users]);
  const candidates = useMemo(
    () =>
      query.trim()
        ? users.filter((u) => !u.isAdmin && !u.isAccountHelper && matches(u, query)).sort(byName).slice(0, 8)
        : [],
    [users, query],
  );

  const grant = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap yardımcısı yapılsın mı?',
      message: `${user.displayName} (@${user.username}) hesap daveti oluşturabilir ve sıradan hesaplar için şifre sıfırlama kodu üretebilir. Hesap silemez, yönetici ya da yardımcı ekleyemez; yöneticilerin ve diğer yardımcıların şifresini sıfırlayamaz.`,
      confirmLabel: 'Yardımcı Yap',
    });
    if (!ok) return;
    try {
      await api.grantHelper(user.id);
      toast(`${user.displayName} artık hesap yardımcısı.`, 'success');
      setQuery('');
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const revoke = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Yardımcılık alınsın mı?',
      message: `${user.displayName} (@${user.username}) artık hesap daveti oluşturamaz ve şifre sıfırlama kodu üretemez.`,
      confirmLabel: 'Yardımcılığı Al',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeHelper(user.id);
      toast(`${user.displayName} artık hesap yardımcısı değil.`, 'success');
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <SectionTitle>Hesap yardımcıları</SectionTitle>
      <p className="mb-3 text-sm text-text-muted">
        Hesap yardımcısı hesap daveti oluşturur ve sıradan hesaplar için şifre sıfırlama kodu üretir; başka bir yetkisi yoktur.
      </p>
      <div className="flex flex-col gap-1">
        {helpers.length === 0 && <div className="text-sm text-text-muted">Hesap yardımcısı yok.</div>}
        {helpers.map((u) => (
          <UserLine key={u.id} user={u} selfId={selfId}>
            <IconButton label="Yardımcılığı al" danger onClick={() => void revoke(u)}>
              <UserMinus size={16} />
            </IconButton>
          </UserLine>
        ))}
      </div>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Yardımcı eklemek için hesap ara"
        className="mt-3"
      />
      {candidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {candidates.map((u) => (
            <UserLine key={u.id} user={u} selfId={selfId}>
              <Button variant="secondary" className="flex h-8 items-center gap-1.5 px-3" onClick={() => void grant(u)}>
                <UserCheck size={15} className="ico-pop" /> Yardımcı yap
              </Button>
            </UserLine>
          ))}
        </div>
      )}
      {query.trim() && candidates.length === 0 && <div className="mt-2 text-sm text-text-muted">Eşleşen hesap yok.</div>}
    </>
  );
}

// ---------- Hesap davetleri ----------

function AccountInvitesBlock({ users, selfId, isAdmin }: { users: User[]; selfId?: string; isAdmin: boolean }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState<number>(1);
  const [expires, setExpires] = useState<number>(168);
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users]);
  // Yardımcı yalnızca kendi oluşturduğu daveti silebilir (sunucu da denetler)
  const canDelete = (inv: Invite): boolean => isAdmin || inv.createdBy === selfId;

  const load = (): void => {
    api
      .listAccountInvites()
      .then((list) => setInvites(list.sort((a, b) => b.createdAt - a.createdAt)))
      .catch((err) => toast(errorMessage(err), 'error'));
  };
  useEffect(load, []);

  const copy = (code: string): void => {
    void navigator.clipboard.writeText(code).catch(() => undefined);
    toast('Davet kodu kopyalandı.');
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const invite = await api.createAccountInvite({
        maxUses: maxUses === 0 ? null : maxUses,
        expiresInHours: expires === 0 ? null : expires,
      });
      copy(invite.code);
      load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (inv: Invite): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Daveti sil',
      message: `${inv.code} daveti silinsin mi? Bu kodla artık hesap açılamaz.`,
      confirmLabel: 'Sil',
      danger: true,
    });
    if (!ok) return;
    api
      .deleteAccountInvite(inv.code)
      .then(load)
      .catch((err) => toast(errorMessage(err), 'error'));
  };

  return (
    <>
      <SectionTitle>Hesap davetleri</SectionTitle>
      <p className="mb-3 text-sm text-text-muted">
        Kişi bu kodla giriş ekranında <b>Davet koduyla kaydol</b> seçeneğinden hesap açar ama hiçbir sunucuya
        katılmaz; kendi sunucusunu kurabilir ya da bir sunucu davetiyle katılır.
      </p>
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
        <Field label="Kullanım hakkı">
          <Select
            value={maxUses}
            onChange={setMaxUses}
            options={[
              { value: 1, label: '1 kişi' },
              { value: 5, label: '5 kişi' },
              { value: 10, label: '10 kişi' },
              { value: 0, label: 'Sınırsız' },
            ]}
          />
        </Field>
        <Field label="Geçerlilik">
          <Select
            value={expires}
            onChange={setExpires}
            options={[
              { value: 1, label: '1 saat' },
              { value: 24, label: '1 gün' },
              { value: 168, label: '7 gün' },
              { value: 0, label: 'Süresiz' },
            ]}
          />
        </Field>
        <div className="mb-4">
          <Button disabled={busy} onClick={() => void create()}>
            Davet Oluştur
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {invites.length === 0 && <div className="text-sm text-text-muted">Hesap daveti yok.</div>}
        {invites.map((inv) => {
          const expired = inv.expiresAt !== null && inv.expiresAt < Date.now();
          const used = inv.maxUses !== null && inv.uses >= inv.maxUses;
          const creator = names.get(inv.createdBy);
          return (
            <div key={inv.code} className="anim-rise-in flex items-center gap-3 rounded bg-bg-side px-3 py-2">
              <code className={cn('font-mono text-base text-text-head', (expired || used) && 'line-through opacity-50')}>
                {inv.code}
              </code>
              <span className="flex-1 text-xs text-text-muted">
                {inv.uses}/{inv.maxUses ?? '∞'} kullanım ·{' '}
                {inv.expiresAt ? `${new Date(inv.expiresAt).toLocaleString('tr-TR')} tarihine kadar` : 'süresiz'}
                {creator ? ` · ${creator}` : ''}
              </span>
              <IconButton label="Kodu kopyala" onClick={() => copy(inv.code)}>
                <Copy size={16} className="ico-pop" />
              </IconButton>
              <IconButton
                label={canDelete(inv) ? 'Daveti sil' : 'Yalnızca kendi oluşturduğun daveti silebilirsin'}
                danger
                disabled={!canDelete(inv)}
                onClick={() => void remove(inv)}
              >
                <Trash2 size={16} className="ico-shake" />
              </IconButton>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- Hesaplar: şifre sıfırlama kodu, hesap silme ----------

function AccountsBlock({
  users,
  selfId,
  isAdmin,
  onChange,
}: {
  users: User[];
  selfId?: string;
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [query, setQuery] = useState('');
  const [resetCode, setResetCode] = useState<{ user: User; code: string; expiresAt: number } | null>(null);
  const list = useMemo(() => users.filter((u) => matches(u, query)).sort(byName), [users, query]);

  const createCode = (user: User): void => {
    api
      .createResetCode(user.id)
      .then((r) => setResetCode({ user, code: r.code, expiresAt: r.expiresAt }))
      .catch((err) => toast(errorMessage(err), 'error'));
  };

  const remove = async (user: User): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hesap silinsin mi?',
      message: `${user.displayName} (@${user.username}) hesabı kalıcı olarak silinir; mesajları "Silinmiş Kullanıcı" adıyla kalır. Yalnızca bir sunucudan uzaklaştırmak istiyorsan o sunucudan atman yeterli.`,
      confirmLabel: 'Hesabı Sil',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(user.id);
      toast(`${user.displayName} silindi.`, 'success');
      if (resetCode?.user.id === user.id) setResetCode(null);
      onChange();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <SectionTitle>Hesaplar ({users.length})</SectionTitle>
      <p className="mb-3 text-sm text-text-muted">
        {isAdmin
          ? 'Şifresini unutan için tek kullanımlık sıfırlama kodu üret. Başka bir hesap yöneticisinin şifresini sıfırlayamaz, hesabını silemezsin; önce yöneticiliğini al.'
          : 'Şifresini unutan için tek kullanımlık sıfırlama kodu üret. Hesap yöneticilerinin, diğer hesap yardımcılarının ve bir sunucunun sahibi ya da yöneticisi olan hesapların şifresini sıfırlayamazsın.'}
      </p>
      {resetCode && <ResetCodeCard {...resetCode} />}
      <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Hesap ara" className="mb-3" />
      <div className="flex flex-col gap-1">
        {list.map((u) => {
          const self = u.id === selfId;
          const protectedAdmin = u.isAdmin && !self;
          // Yardımcı başka bir yardımcının da şifresini sıfırlayamaz
          const protectedHelper = !isAdmin && u.isAccountHelper === true && !self;
          return (
            <UserLine key={u.id} user={u} selfId={selfId}>
              {u.isAdmin && <span className="rounded bg-brand/20 px-1.5 text-xs text-brand">Yönetici</span>}
              {u.isAccountHelper && <span className="rounded bg-bg-hover px-1.5 text-xs text-text-muted">Yardımcı</span>}
              <IconButton
                label={
                  protectedAdmin
                    ? 'Başka bir yöneticinin şifresi sıfırlanamaz'
                    : protectedHelper
                      ? 'Başka bir yardımcının şifresi sıfırlanamaz'
                      : 'Şifre sıfırlama kodu üret'
                }
                disabled={protectedAdmin || protectedHelper}
                onClick={() => createCode(u)}
              >
                <KeyRound size={16} className="ico-tilt" />
              </IconButton>
              {isAdmin && (
                <IconButton
                  label={
                    self
                      ? 'Kendi hesabını Hesabım bölümünden silebilirsin'
                      : protectedAdmin
                        ? 'Önce yöneticiliğini al'
                        : 'Hesabı kalıcı olarak sil'
                  }
                  danger
                  disabled={self || protectedAdmin}
                  onClick={() => void remove(u)}
                >
                  <UserX size={16} className="ico-shake" />
                </IconButton>
              )}
            </UserLine>
          );
        })}
      </div>
    </>
  );
}

function ResetCodeCard({ user, code, expiresAt }: { user: User; code: string; expiresAt: number }) {
  return (
    <div className="mb-4 rounded-md border border-brand/60 bg-brand/10 p-4">
      <div className="text-sm text-text-muted">
        <strong className="text-text-head">{user.displayName}</strong> için şifre sıfırlama kodu (tek kullanımlık,{' '}
        {new Date(expiresAt).toLocaleString('tr-TR')} tarihine kadar geçerli):
      </div>
      <div className="mt-2 flex items-center gap-3">
        <code className="font-mono text-2xl tracking-widest text-text-head">{code}</code>
        <button
          className="flex items-center gap-1.5 rounded bg-bg-hover px-2.5 py-1.5 text-sm hover:bg-bg-active"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            toast('Kopyalandı.');
          }}
        >
          <Copy size={14} className="ico-pop" /> Kopyala
        </button>
      </div>
      <div className="mt-2 text-xs text-text-muted">
        Kullanıcı adı: <strong>@{user.username}</strong> — ikisini birlikte gönder. Giriş ekranında “Sıfırlama
        koduyla yenile” ile yeni şifre belirlenir.
      </div>
    </div>
  );
}
