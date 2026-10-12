import { useMemo, useState, type MouseEvent } from 'react';
import { ChevronDown, Crown, MoreHorizontal, Plus, ShieldCheck, X } from 'lucide-react';
import { Permission } from '@diskort/shared';
import {
  activeGuildContext,
  canAssignRole,
  effectivePermissions,
  guildVoiceStateOf,
  memberColorOf,
  moderation,
  PERMISSION_GROUPS,
  useCan,
  useGuild,
  useSession,
  type MemberUser,
} from '@diskort/client-core';
import { memberMenuItems } from '../../lib/memberMenu';
import { cn } from '../../lib/utils';
import { toast, useUi, type ContextMenuItem } from '../../stores/ui';
import { PresenceAvatar } from '../ui/Avatar';
import { TextInput } from '../ui/controls';

/**
 * Üyeler: roller, sesli sohbet, atma, yasaklama (yetkiye göre). Hesaplarla ilgili işler (şifre sıfırlama
 * kodu, hesap silme) sunucuya bağlı değildir: Kullanıcı Ayarları > Yönetim.
 */
export function MembersSection() {
  const users = useGuild((s) => s.users);
  const online = useGuild((s) => s.online);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    return Object.values(users)
      .filter((u) => !u.removed)
      .filter((u) => !q || u.username.includes(q) || u.displayName.toLocaleLowerCase('tr').includes(q))
      .sort(
        (a, b) =>
          Number(Boolean(online[b.id])) - Number(Boolean(online[a.id])) ||
          a.displayName.localeCompare(b.displayName, 'tr'),
      );
  }, [users, online, query]);
  const total = useMemo(() => Object.values(users).filter((u) => !u.removed).length, [users]);

  return (
    <div>
      <h2 className="mb-2 text-xl font-bold text-text-head">Üyeler</h2>
      <p className="mb-4 text-sm text-text-muted">
        {total} üye · {list.filter((u) => online[u.id]).length} çevrimiçi. Bir üyeye sağ tıklayarak ya da “…” düğmesiyle
        rollerini, sesli sohbetini ve üyeliğini yönetebilirsin. Atma ve yasaklama yalnızca en üst rolü seninkinden
        aşağıda olanlara; rol verme ise rolün senin en üst rolünden aşağıda olmasına bakar.
      </p>
      <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Üye ara" className="mb-4" />

      <div className="flex flex-col gap-1">
        {list.map((u) => (
          <MemberRow key={u.id} user={u} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ user }: { user: MemberUser }) {
  const selfId = useSession((s) => s.user?.id);
  const isSelf = user.id === selfId;
  const color = useGuild((s) => memberColorOf(s, user.id));
  const roles = useGuild((s) => s.roles);
  const ownerId = useGuild((s) => s.guild?.ownerId);
  const voiceChannel = useGuild((s) => {
    // DM aramasındaki kişi sunucuda seste görünmez
    const state = guildVoiceStateOf(s, user.id);
    return state ? s.channels.find((c) => c.id === state.channelId)?.name : undefined;
  });
  const openContextMenu = useUi((s) => s.openContextMenu);
  const [showPermissions, setShowPermissions] = useState(false);

  const held = user.roles.map((id) => roles[id]).filter((r) => r !== undefined).sort((a, b) => b.position - a.position);

  /** Yönetim menüsü: seste yönetim, roller, atma/yasaklama */
  const menuItems = (): ContextMenuItem[] => memberMenuItems(user.id, activeGuildContext(useGuild.getState()));

  const openMenu = (e: MouseEvent, x: number, y: number): void => {
    e.preventDefault();
    const items = menuItems();
    if (items.length === 0) {
      toast('Bu üye için yapabileceğin bir şey yok.');
      return;
    }
    openContextMenu({ x, y, items });
  };

  /** Verilebilecek (henüz sahip olmadığı) roller */
  const addableRoles = (): ContextMenuItem[] => {
    const s = useGuild.getState();
    return Object.values(s.roles)
      .filter((r) => !user.roles.includes(r.id) && canAssignRole(s, selfId, user.id, r))
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ label: r.name, color: r.color, onClick: () => void moderation.setRole(user.id, r.id, true) }));
  };

  return (
    <div className="rounded-md bg-bg-side" onContextMenu={(e) => openMenu(e, e.clientX, e.clientY)}>
      <div className="group flex items-center gap-3 px-3 py-2">
        <PresenceAvatar userId={user.id} user={user} size={36} ringClassName="bg-bg-side" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-text-head" style={color ? { color } : undefined}>
              {user.displayName}
            </span>
            {user.id === ownerId && <Crown size={14} aria-label="Sunucunun sahibi" className="shrink-0 text-warn" />}
            {isSelf && <span className="text-xs text-text-muted">(sen)</span>}
          </div>
          <div className="truncate text-xs text-text-muted">
            @{user.username}
            {voiceChannel && ` · 🔊 ${voiceChannel}`}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {held.map((role) => {
              const removable = canAssignRole(useGuild.getState(), selfId, user.id, role);
              return (
                <span
                  key={role.id}
                  className="flex h-6 items-center gap-1.5 rounded bg-bg-main px-1.5 text-xs text-text-normal"
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: role.color ?? '#99aab5' }} />
                  {role.name}
                  {removable && (
                    <button
                      data-tooltip={`${role.name} rolünü al`}
                      aria-label={`${role.name} rolünü al`}
                      className="text-text-muted hover:text-danger"
                      onClick={() => void moderation.setRole(user.id, role.id, false)}
                    >
                      <X size={12} className="ico-rotate" />
                    </button>
                  )}
                </span>
              );
            })}
            <AddRoleButton items={addableRoles} />
            <button
              aria-expanded={showPermissions}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-text-muted hover:text-text-head"
              onClick={() => setShowPermissions((v) => !v)}
            >
              <ShieldCheck size={12} /> Etkin izinler
              <ChevronDown size={12} className={cn('ico-nudge-d', showPermissions && 'rotate-180')} />
            </button>
          </div>
        </div>
        <button
          data-tooltip="Üyeyi yönet"
          aria-label="Üyeyi yönet"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hover hover:text-text-head',
            'opacity-70 group-hover:opacity-100',
          )}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            openMenu(e, rect.left, rect.bottom + 4);
          }}
        >
          <MoreHorizontal size={18} className="ico-pop" />
        </button>
      </div>
      {showPermissions && <EffectivePermissionsPanel userId={user.id} />}
    </div>
  );
}

/**
 * Üyenin sunucu genelindeki etkin yetkileri ve her birinin hangi rolden geldiği: yetkiler birleştiği için
 * (@everyone + rolleri) bir rolde kapatılan yetkinin üyede neden hâlâ olduğunu görmeye yarar.
 */
function EffectivePermissionsPanel({ userId }: { userId: string }) {
  const guild = useGuild((s) => s.guild);
  const roles = useGuild((s) => s.roles);
  const users = useGuild((s) => s.users);
  const summary = useMemo(() => effectivePermissions({ guild, roles, users }, userId), [guild, roles, users, userId]);
  const granted = new Map(summary.granted.map((g) => [g.info.flag, g]));

  if (summary.all) {
    const via = granted.get(Permission.ADMINISTRATOR)?.roles.map((r) => r.name).join(', ');
    return (
      <div className="border-t border-line/60 px-3 py-2 text-sm text-text-muted">
        {summary.all === 'owner' ? 'Sunucunun sahibi' : `Yönetici yetkisi${via ? ` (${via})` : ''}`}: bütün yetkilere
        sahip ve kanal izinlerinden etkilenmez.
      </div>
    );
  }
  return (
    <div className="border-t border-line/60 px-3 py-2">
      {summary.granted.length === 0 && <div className="text-sm text-text-muted">Hiçbir yetkisi yok.</div>}
      {PERMISSION_GROUPS.map((group) => {
        const items = group.permissions.flatMap((p) => granted.get(p.flag) ?? []);
        if (items.length === 0) return null;
        return (
          <div key={group.title} className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="mr-1 w-28 shrink-0 text-[11px] font-bold tracking-wide text-text-muted uppercase">
              {group.title}
            </span>
            {items.map(({ info, roles: from }) => {
              // Yalnızca @everyone'dan gelen yetki herkeste var: soluk gösterilir
              const everyoneOnly = from.length === 1 && from[0]!.id === guild?.id;
              return (
                <span
                  key={info.name}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs',
                    everyoneOnly ? 'bg-bg-main text-text-muted' : 'bg-brand/20 text-text-normal',
                  )}
                  data-tooltip={`Kaynak: ${from.map((r) => r.name).join(', ')}`}
                >
                  {info.label}
                </span>
              );
            })}
          </div>
        );
      })}
      <div className="mt-1 text-xs text-text-faint">
        Soluk olanlar @everyone rolünden gelir (herkeste var). Kaynağını görmek için üzerine gel; kanal izinleri bir
        kanalda bunları değiştirebilir.
      </div>
    </div>
  );
}

function AddRoleButton({ items }: { items: () => ContextMenuItem[] }) {
  const openContextMenu = useUi((s) => s.openContextMenu);
  // Verilebilecek rol yoksa düğme hiç görünmez
  if (items().length === 0) return null;
  return (
    <button
      className="flex h-6 items-center gap-1 rounded bg-bg-main px-1.5 text-xs text-text-muted hover:text-text-head"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openContextMenu({ x: rect.left, y: rect.bottom + 4, items: [{ label: 'Rol ver', heading: true }, ...items()] });
      }}
    >
      <Plus size={12} className="ico-rotate" /> Rol
    </button>
  );
}
