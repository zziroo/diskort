import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bell,
  Check,
  Gamepad2,
  Globe,
  Inbox,
  Keyboard,
  LogOut,
  MessageSquareHeart,
  Mic,
  MonitorUp,
  Palette,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SunMoon,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { DISPLAY_NAME_MAX_LENGTH } from '@diskort/shared';
import {
  gateway,
  api,
  errorMessage,
  normalizeServerUrl,
  searchSettings,
  settingsGroupsFor,
  useFeedback,
  useSession,
  type SettingsSectionId,
  type SettingsSectionInfo,
} from '@diskort/client-core';
import { SCREEN_CODECS, SCREEN_PRESETS } from '../../features/voice/screenPresets';
import { voice } from '../../features/voice/voiceClient';
import { bridge, isWindows } from '../../lib/bridge';
import { confirmDialog } from '../../lib/dialog';
import { useEscapeLayer } from '../../lib/escape';
import { usePresenceClosing } from '../../lib/motion';
import { THEMES, themeVars } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { DEFAULT_SERVER_URL, useSettings, type ScreenCodec, type ScreenPresetId, type ThemeId } from '../../stores/settings';
import { toast, useUi, type SettingsSection } from '../../stores/ui';
import { Avatar } from '../ui/Avatar';
import { Button, Divider, Field, SectionTitle, Select, TextInput, Toggle } from '../ui/controls';
import { ActivitySettings } from './ActivitySettings';
import { BlockedUsers } from './BlockedUsers';
import { ChangePassword } from './ChangePassword';
import { DeleteAccount } from './DeleteAccount';
import { KeybindInput } from './KeybindInput';
import { ProfileLookSettings } from './ProfileLookSettings';
import { ProfilePhoto } from './ProfilePhoto';
import { SoundSettings, VoiceSettings } from './VoiceSettings';
import { MyFeedback } from '../feedback/MyFeedback';
import { FeedbackAdminSection } from '../feedback/FeedbackAdminSection';
import { CountBadge } from '../ui/CountBadge';
import { AdminSection } from './AdminSection';
import { WhatsNewSection } from './WhatsNewSection';

// Kullanıcı Ayarları (Discord'daki gibi): solda başlıklı gruplar ve arama, sağda seçili bölüm. Grupların ve
// bölümlerin adı, sırası ve simgesi telefonla ortaktır (client-core/settingsSections). Üyeler ve sunucu
// davetleri Sunucu Ayarları'nda (sunucu adının yanındaki menü). Hesap yöneticiliği sunucuya bağlı olmadığından
// geri bildirim yönetimi ve hesap işleri buradadır (yalnızca yöneticilere).

/** Ortak yapıdaki simge adlarının lucide karşılıkları */
const ICONS: Record<string, LucideIcon> = {
  UserRound,
  Palette,
  Mic,
  MonitorUp,
  SunMoon,
  Bell,
  Keyboard,
  Gamepad2,
  SlidersHorizontal,
  Inbox,
  UsersRound,
  Globe,
  MessageSquareHeart,
  Sparkles,
  ShieldCheck,
};

/** Dışarıda (tarayıcıda) açılan bağlantılar */
function openLink(section: SettingsSectionInfo, serverUrl: string): void {
  // Gizlilik sayfası resmî sitede; yönetim paneli bağlı olunan sunucuda
  const base = section.id === 'privacy' ? DEFAULT_SERVER_URL : normalizeServerUrl(serverUrl);
  const url = base + (section.path ?? '');
  if (bridge) void bridge.openExternal(url);
  else window.open(url, '_blank');
}

export function SettingsModal({ initial }: { initial?: SettingsSection }) {
  const close = useUi((s) => s.closeModal);
  const [chosen, setSection] = useState<SettingsSection>(initial ?? 'account');
  const [query, setQuery] = useState('');
  const isAdmin = useSession((s) => s.user?.isAdmin === true);
  const serverUrl = useSettings((s) => s.serverUrl);
  const newFeedback = useFeedback((s) => (isAdmin ? s.newCount : 0));
  const groups = useMemo(() => settingsGroupsFor('desktop', { isAdmin }), [isAdmin]);
  const shown = useMemo(() => searchSettings(groups, query), [groups, query]);
  // Yöneticilik alınırsa yönetim bölümünden Hesabım'a dönülür
  const available = groups.some((g) => g.sections.some((s) => s.id === chosen));
  const section: SettingsSection = available ? chosen : 'account';
  const closing = usePresenceClosing();
  useEscapeLayer(close, !closing);

  const logout = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Çıkış yapılsın mı?',
      message: 'Bu bilgisayarda yeniden giriş yapana kadar oturumun kapalı kalır.',
      confirmLabel: 'Çıkış Yap',
      danger: true,
    });
    if (!ok) return;
    close();
    await voice.leave();
    gateway.disconnect();
    useSession.getState().logout();
  };

  const choose = (item: SettingsSectionInfo): void => {
    if (item.kind === 'link') openLink(item, serverUrl);
    else setSection(item.id as SettingsSection);
  };

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 top-[var(--titlebar-h,0px)] z-40 flex bg-bg-main',
        closing ? 'anim-settings-out pointer-events-none' : 'anim-settings-in',
      )}
    >
      {/* Ortalama: sol bölme 50% - 241px. Gezinme (210) + sağ boşluk (8) = 218 solda biter; içerik 40px girintiyle
          başlar ve 660px'e kadar uzar. Blok (210 + 8 + 40 + 660 = 918px) pencere ortasında durur. */}
      <nav className="flex w-[calc(50%-241px)] min-w-[240px] shrink-0 justify-end overflow-y-auto border-r border-divider bg-bg-side py-14 pr-2">
        <div className="w-[210px]">
          <label className="mb-3 flex h-8 items-center gap-2 rounded bg-bg-rail px-2 text-sm text-text-muted focus-within:ring-2 focus-within:ring-brand/60">
            <Search size={14} className="shrink-0" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Esc önce aramayı temizler, boşsa ayarları kapatır
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
              placeholder="Ara"
              aria-label="Ayarlarda ara"
              className="min-w-0 flex-1 bg-transparent text-text-normal outline-none placeholder:text-text-faint"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Aramayı temizle" className="text-text-muted hover:text-text-head">
                <X size={14} />
              </button>
            )}
          </label>
          {shown.length === 0 && <div className="px-2.5 py-2 text-sm text-text-muted">Eşleşen ayar yok.</div>}
          {shown.map((group, i) => (
            <div key={group.id}>
              {i > 0 && <div className="mx-2.5 my-2 h-px bg-line" />}
              <div className="px-2.5 pb-1.5 text-xs font-bold text-text-muted uppercase">{group.title}</div>
              {group.sections.map((item) => {
                const Icon = ICONS[item.icon.desktop];
                return (
                  <NavItem key={item.id} active={item.kind === 'page' && section === item.id} onClick={() => choose(item)}>
                    {Icon && <Icon size={16} className="shrink-0 opacity-80" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.id === 'feedbackAdmin' && newFeedback > 0 && <CountBadge count={newFeedback} />}
                    {item.kind === 'link' && <span className="text-xs text-text-faint">↗</span>}
                  </NavItem>
                );
              })}
            </div>
          ))}
          <div className="mx-2.5 my-2 h-px bg-line" />
          <NavItem onClick={() => void logout()} danger>
            <LogOut size={16} className="shrink-0" aria-hidden />
            <span className="flex-1">Çıkış Yap</span>
          </NavItem>
          <AppInfo />
        </div>
      </nav>
      <main className="relative min-w-0 flex-1 overflow-y-auto py-14 pr-24 pl-10">
        {/* Bölüm değişince içerik hafifçe yükselerek belirir */}
        <div key={section} className="anim-rise-in max-w-[660px]">
          <SectionContent id={section} />
        </div>
        <button
          onClick={close}
          className="group fixed top-14 right-10 flex flex-col items-center gap-1 text-text-muted transition-colors hover:text-text-head"
          aria-label="Kapat"
        >
          <span className="ico-rotate flex h-9 w-9 items-center justify-center rounded-full border-2 border-current group-active:scale-90">
            <X size={20} />
          </span>
          <span className="text-xs font-semibold">ESC</span>
        </button>
      </main>
    </div>
  );
}

function SectionContent({ id }: { id: SettingsSection }) {
  switch (id) {
    case 'account':
      return <AccountSection />;
    case 'profile':
      return <ProfileSection />;
    case 'voice':
      return <VoiceSettings />;
    case 'stream':
      return <StreamSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'keybinds':
      return <KeybindsSection />;
    case 'activity':
      return <ActivitySettings />;
    case 'advanced':
      return <AdvancedSection />;
    case 'feedbackAdmin':
      return <FeedbackAdminSection />;
    case 'accountAdmin':
      return <AdminSection />;
    case 'feedback':
      return <MyFeedback />;
    case 'whatsNew':
      return <WhatsNewSection />;
  }
}

/** Gezinmenin altındaki sürüm ve sistem bilgisi */
function AppInfo() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void bridge?.getVersion().then(setVersion);
  }, []);
  const platform = bridge?.platform === 'win32' ? 'Windows' : bridge?.platform === 'darwin' ? 'macOS' : bridge?.platform === 'linux' ? 'Linux' : 'Web';
  return (
    <div className="mt-3 px-2.5 text-xs leading-5 text-text-faint">
      <div>Diskort {version ?? 'web'}</div>
      <div>{platform}</div>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  danger,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 flex w-full items-center rounded px-2.5 py-1.5 text-left font-medium transition-colors',
        active ? 'bg-bg-active text-text-head' : 'text-text-muted hover:bg-bg-hover hover:text-text-normal',
        danger && 'text-danger hover:text-danger',
      )}
    >
      {/* Seçili olmayan bölümün adı üstüne gelince hafifçe sağa kayar */}
      <span className={cn('flex min-w-0 flex-1 items-center gap-2', !active && 'ico-nudge-r')}>{children}</span>
    </button>
  );
}

/** Hesabım: görünen ad, kullanıcı adı, engellenenler, şifre değiştirme ve hesabı silme */
function AccountSection() {
  // Hesap düzeyi: hiçbir sunucunun rolü ya da rengi burada gösterilmez
  const user = useSession((s) => s.user);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const updated = await api.updateMe({ displayName });
      useSession.getState().setUser(updated);
      toast('Kaydedildi.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;
  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Hesabım</h2>
      <div className="mb-6 flex items-center gap-4 rounded-lg bg-bg-rail p-4">
        <Avatar user={user} size={72} />
        <div>
          <div className="text-lg font-semibold text-text-head">{user.displayName}</div>
          <div className="text-sm text-text-muted">@{user.username}</div>
        </div>
      </div>
      <Field label="Görünen ad">
        <div className="flex gap-2">
          <TextInput
            value={displayName}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Button
            disabled={busy || !displayName.trim() || displayName === user.displayName}
            onClick={() => void save()}
          >
            Kaydet
          </Button>
        </div>
      </Field>
      <Field label="Kullanıcı adı">
        <TextInput value={user.username} disabled readOnly />
      </Field>
      <Divider />
      <BlockedUsers />
      <Divider />
      <ChangePassword />
      <Divider />
      <DeleteAccount />
    </div>
  );
}

/** Profil: profil fotoğrafı ve süsler (afiş, tema, efekt) */
function ProfileSection() {
  const user = useSession((s) => s.user);

  if (!user) return null;
  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Profil</h2>
      <ProfilePhoto user={user} />
      <Divider />
      <ProfileLookSettings user={user} />
    </div>
  );
}

/** Bildirimler ve Sesler: arayüz sesleri, bildirim sesi, bas-konuş sesleri, sesleri dinle */
function NotificationsSection() {
  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Bildirimler ve Sesler</h2>
      <SoundSettings />
    </div>
  );
}

/**
 * Temanın küçük önizlemesi: sunucu şeridi, kanal listesi, iki mesaj, bağlantı ve yazma kutusu. Kutuya
 * temanın belirteçleri yazılır, içindeki sınıflar (bg-bg-main, text-link…) o temanın renkleriyle çizilir.
 */
function ThemePreview({ theme }: { theme: ThemeId }) {
  return (
    <div
      className="flex h-24 overflow-hidden rounded-md border border-line bg-bg-main"
      style={themeVars(theme)}
      aria-hidden
    >
      <div className="flex w-[13%] flex-col items-center gap-1.5 bg-bg-rail pt-2">
        <div className="h-4 w-4 rounded-[6px] bg-brand" />
        <div className="h-4 w-4 rounded-full bg-bg-raised" />
        <div className="h-4 w-4 rounded-full bg-bg-raised" />
      </div>
      <div className="flex w-[27%] flex-col gap-1.5 bg-bg-side p-2">
        <div className="h-1.5 w-3/5 rounded-full bg-text-muted/50" />
        <div className="h-2.5 w-full rounded-sm bg-bg-active" />
        <div className="h-1.5 w-4/5 rounded-full bg-text-faint/60" />
        <div className="h-1.5 w-2/3 rounded-full bg-text-faint/60" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1.5 p-2">
        <div className="flex items-center gap-1.5">
          <div className="h-3.5 w-3.5 shrink-0 rounded-full bg-ok" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-1.5 w-1/3 rounded-full bg-text-head" />
            <div className="h-1.5 w-4/5 rounded-full bg-text-normal/70" />
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-sm bg-msg-hover">
          <div className="h-3.5 w-3.5 shrink-0 rounded-full bg-warn" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-1.5 w-1/4 rounded-full bg-text-head" />
            <div className="h-1.5 w-1/2 rounded-full bg-link" />
          </div>
        </div>
        <div className="mt-0.5 h-3.5 rounded bg-bg-input" />
      </div>
    </div>
  );
}

function AppearanceSection() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);

  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Görünüm</h2>
      <SectionTitle>Tema</SectionTitle>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3" role="radiogroup" aria-label="Tema">
        {THEMES.map((t) => {
          const selected = theme === t.id;
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={selected}
              onClick={() => set({ theme: t.id })}
              className={cn(
                'press group flex flex-col rounded-lg border-2 bg-bg-side p-2.5 text-left transition-colors',
                selected ? 'border-brand' : 'border-edge hover:border-edge-strong',
              )}
            >
              <ThemePreview theme={t.id} />
              <div className="mt-2.5 flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    selected ? 'border-brand bg-brand text-white' : 'border-text-faint',
                  )}
                >
                  {selected && <Check size={12} strokeWidth={3.5} />}
                </span>
                <span className="font-semibold text-text-head">{t.label}</span>
              </div>
              <div className="mt-0.5 pl-7 text-xs text-text-muted">{t.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StreamSection() {
  const s = useSettings();
  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Yayın (Ekran Paylaşımı)</h2>
      <Field label="Varsayılan kalite">
        <Select<ScreenPresetId>
          value={s.screenPreset}
          onChange={(screenPreset) => s.set({ screenPreset })}
          options={Object.entries(SCREEN_PRESETS).map(([value, p]) => ({
            value: value as ScreenPresetId,
            label: `${p.label} · ${p.bitrate / 1_000_000} Mbps`,
          }))}
        />
      </Field>
      <Field label="Video kodeği">
        <Select<ScreenCodec>
          value={s.screenCodec}
          onChange={(screenCodec) => s.set({ screenCodec })}
          options={Object.entries(SCREEN_CODECS).map(([value, label]) => ({ value: value as ScreenCodec, label }))}
        />
      </Field>
      <Field label="İçerik türü">
        <Select
          value={s.screenContent}
          onChange={(screenContent) => s.set({ screenContent })}
          options={[
            { value: 'motion', label: 'Oyun / Video — akıcılık öncelikli' },
            { value: 'detail', label: 'Metin / Kod — netlik öncelikli' },
          ]}
        />
      </Field>
      <Toggle
        label="Sistem sesini paylaş"
        description={
          isWindows
            ? 'Yayına oyun/video sesi eklenir; sohbetteki sesler otomatik hariç tutulur.'
            : 'Sistem sesi paylaşımı şimdilik yalnızca Windows’ta destekleniyor.'
        }
        checked={s.shareAudio && isWindows}
        disabled={!isWindows}
        onChange={(shareAudio) => s.set({ shareAudio })}
      />
      <p className="mt-4 text-sm text-text-muted">
        Not: seçilen kalite en az o kadar yükleme hızı ister (ör. 1080p60 için 12 Mbps); yetmezse yayın kendiliğinden düşer. Yayını izleyen her kişi için sunucu bu veriyi ayrıca
        gönderir; izlemeyenlere hiç video gitmez.
      </p>
    </div>
  );
}

function KeybindsSection() {
  const hotkeys = useSettings((s) => s.hotkeys);
  const inputMode = useSettings((s) => s.inputMode);
  const set = useSettings((s) => s.set);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    void bridge?.hotkeys.available().then(setAvailable);
  }, []);

  return (
    <div>
      <h2 className="mb-2 text-xl font-bold text-text-head">Kısayollar</h2>
      <p className="mb-5 text-sm text-text-muted">
        Kısayollar uygulama arka plandayken (ör. oyun oynarken) de çalışır. Fare yan tuşları da atanabilir.
      </p>
      {(!bridge || !available) && (
        <div className="mb-4 rounded bg-warn/15 px-3 py-2 text-sm text-warn">
          Global kısayollar bu sistemde kullanılamıyor (ör. Linux Wayland).
        </div>
      )}
      <Field label="Susturmayı aç/kapat">
        <KeybindInput value={hotkeys.toggleMute} onChange={(toggleMute) => set({ hotkeys: { ...hotkeys, toggleMute } })} />
      </Field>
      <Field label="Sağırlaştırmayı aç/kapat">
        <KeybindInput
          value={hotkeys.toggleDeafen}
          onChange={(toggleDeafen) => set({ hotkeys: { ...hotkeys, toggleDeafen } })}
        />
      </Field>
      <Field label="Bas-konuş">
        <KeybindInput value={hotkeys.pushToTalk} onChange={(pushToTalk) => set({ hotkeys: { ...hotkeys, pushToTalk } })} />
      </Field>
      {inputMode !== 'ptt' && (
        <p className="text-xs text-text-muted">Bas-konuş tuşu yalnızca Ses ve Görüntü ayarlarında giriş modu “Bas-Konuş” iken etkindir.</p>
      )}
    </div>
  );
}

/** Gelişmiş: sistem tepsisi, açılışta başlatma, sunucu adresi ve sürüm */
function AdvancedSection() {
  const s = useSettings();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void bridge?.getVersion().then(setVersion);
  }, []);

  return (
    <div>
      <h2 className="mb-5 text-xl font-bold text-text-head">Gelişmiş</h2>
      <Toggle
        label="Kapatınca sistem tepsisine küçült"
        description="Pencereyi kapatınca Diskort arka planda çalışmaya ve sesi iletmeye devam eder."
        checked={s.minimizeToTray}
        disabled={!bridge}
        onChange={(minimizeToTray) => s.set({ minimizeToTray })}
      />
      <Toggle
        label="Bilgisayar açılınca başlat"
        checked={s.openAtLogin}
        disabled={!bridge || bridge.platform === 'linux'}
        onChange={(openAtLogin) => s.set({ openAtLogin })}
      />
      <Divider />
      <div className="text-sm text-text-muted">
        <div>
          Sunucu: <span className="text-text-normal">{s.serverUrl}</span>
        </div>
        <div className="mt-1">Sürüm: {version ?? 'web'}</div>
      </div>
    </div>
  );
}
