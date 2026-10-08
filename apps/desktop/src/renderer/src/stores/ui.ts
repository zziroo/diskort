import { create } from 'zustand';
import type { Attachment, Channel, ChannelType, User } from '@diskort/shared';
import { useGuild, type SettingsSectionId } from '@diskort/client-core';
import { useVoice } from './voice';

const voiceChannelId = (): string | null => useVoice.getState().channelId;

export type Modal =
  | { type: 'settings'; section?: SettingsSection }
  | { type: 'serverSettings'; section?: ServerSettingsSection }
  | { type: 'screenPicker' }
  | { type: 'channel'; channel?: Channel; channelType?: ChannelType }
  /** Resim görüntüleyici; `source` bağlantı önizlemesindeki resmin asıl sayfası ("Tarayıcıda aç") */
  | { type: 'image'; attachment: Attachment; source?: string }
  /** Direkt mesaj başlatmak için kişi seçimi; `addTo` verilirse o gruba kişi eklenir */
  | { type: 'newDm'; addTo?: string }
  /** Grup konuşmasının adını değiştirmek */
  | { type: 'renameDm'; channelId: string }
  | { type: 'feedback' }
  /** Sunucu kur ya da davetle katıl */
  | { type: 'addGuild'; tab?: 'create' | 'join'; code?: string }
  /** Seçili sunucuya arkadaş davet et (bağlantı oluşturup gösterir) */
  | { type: 'invite' }
  /** Özel durum (emoji + kısa metin) */
  | { type: 'customStatus' }
  /** Mesajdaki tepkiler ve tepki verenler; `emoji` verilirse o sekme açılır */
  | { type: 'reactions'; channelId: string; messageId: string; emoji?: string }
  | null;

/**
 * Kullanıcı Ayarları'nın kendi sayfası olan bölümleri (yapı telefonla ortak: client-core/settingsSections).
 * Bağlantılar (web yönetim paneli, gizlilik) tarayıcıda açılır, bölüm değildir.
 */
export type SettingsSection = Exclude<SettingsSectionId, 'webAdmin' | 'privacy'>;

export type ServerSettingsSection = 'overview' | 'roles' | 'members' | 'invites' | 'bans';

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  /** Sağda soluk gösterilen kısayol (ör. "Ctrl+C") */
  hint?: string;
  disabled?: boolean;
  /** Onay kutusu gibi gösterilir (ör. üyenin rolü, sunucuda susturma) */
  checked?: boolean;
  /** Etiketin önündeki renkli nokta (rol rengi) */
  color?: string | null;
  /** Tıklanamayan küçük başlık (öğe grubu) */
  heading?: boolean;
  onClick?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  /** Özel içerik (ör. ses seviyesi kaydırıcısı) veya basit menü öğeleri */
  userId?: string;
  items?: ContextMenuItem[];
}

export interface EmojiPickerAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Emoji seçici: açıldığı öğenin ekrandaki konumu ve seçilince ne yapılacağı */
export interface EmojiPickerState {
  anchor: EmojiPickerAnchor;
  onPick: (emoji: string) => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

/**
 * Ana alanda gösterilen: bir metin kanalı, bağlı olunan ses kanalının sahnesi ya da direkt mesajlar
 * (`dm`: bir konuşma, `dms`: konuşma seçilmemiş liste, `friends`: arkadaşlar). İlk üçü seçili sunucu, son
 * üçü "ana sayfa" bölümüdür. Başka sunucunun kanalı açılınca (bildirim, ses) o sunucu seçilir.
 */
export type View =
  | { kind: 'text'; channelId: string }
  /**
   * Ses sahnesi. `channelId`: katılınmakta olan kanal (katılma sürerken useVoice hâlâ eski kanalı gösterir;
   * verilmezse bağlı olunan kanal)
   */
  | { kind: 'voice'; channelId?: string }
  | { kind: 'home' }
  | { kind: 'dm'; channelId: string }
  | { kind: 'dms' }
  /** `tab`: açılışta seçilecek sekme (ör. bildirimden "pending") */
  | { kind: 'friends'; tab?: 'all' | 'pending' | 'add' };

interface UiStore {
  /** Metin kanalının sağındaki üye listesi açık mı */
  memberListOpen: boolean;
  toggleMemberList: () => void;
  /** Ses sahnesinde odaklanmış yayının altındaki katılımcı şeridi gizli mi */
  stageStripCollapsed: boolean;
  toggleStageStrip: () => void;
  /** Yasaklama penceresi (açık pencerenin, ör. sunucu ayarlarının, üstünde açılır) */
  banUser: User | null;
  setBanUser: (user: User | null) => void;
  view: View;
  /** Ses sahnesinden dönülecek metin kanalı (seçili sunucunun; bkz. lastTextByGuild) */
  lastTextChannelId: string | null;
  /** Sunucu başına son açılan metin kanalı (sunucuya dönünce o açılır) */
  lastTextByGuild: Record<string, string>;
  /** Direkt mesajlar bölümüne dönülünce açılacak konuşma */
  lastDmId: string | null;
  setView: (view: View) => void;
  modal: Modal;
  contextMenu: ContextMenuState | null;
  emojiPicker: EmojiPickerState | null;
  toasts: Toast[];
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  openEmojiPicker: (picker: EmojiPickerState) => void;
  closeEmojiPicker: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

const LAST_TEXT_CHANNEL_KEY = 'diskort-last-text-channel';
const LAST_TEXT_BY_GUILD_KEY = 'diskort-last-text-by-guild';
const LAST_DM_KEY = 'diskort-last-dm';
const MEMBER_LIST_KEY = 'diskort-member-list';
const STAGE_STRIP_KEY = 'diskort-stage-strip';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // depolama kullanılamıyor
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // depolama kullanılamıyor
  }
}

const initialTextChannel = stored(LAST_TEXT_CHANNEL_KEY);

function storedMap(key: string): Record<string, string> {
  try {
    const value = JSON.parse(stored(key) ?? '{}') as unknown;
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Kanal başka bir sunucudaysa o sunucuyu seçer; kanalın sunucusunu döner */
function selectGuildOf(channelId: string | null | undefined): string | null {
  if (!channelId) return null;
  const guild = useGuild.getState();
  const guildId = guild.channelGuild[channelId] ?? null;
  if (guildId && guildId !== guild.activeGuildId) guild.selectGuild(guildId);
  return guildId;
}

export const useUi = create<UiStore>()((set, get) => ({
  memberListOpen: stored(MEMBER_LIST_KEY) !== '0',
  toggleMemberList: () => {
    const memberListOpen = !get().memberListOpen;
    store(MEMBER_LIST_KEY, memberListOpen ? '1' : '0');
    set({ memberListOpen });
  },
  stageStripCollapsed: stored(STAGE_STRIP_KEY) === '0',
  toggleStageStrip: () => {
    const stageStripCollapsed = !get().stageStripCollapsed;
    store(STAGE_STRIP_KEY, stageStripCollapsed ? '0' : '1');
    set({ stageStripCollapsed });
  },
  banUser: null,
  setBanUser: (banUser) => set({ banUser, contextMenu: null }),
  view: initialTextChannel ? { kind: 'text', channelId: initialTextChannel } : { kind: 'home' },
  lastTextChannelId: initialTextChannel,
  lastTextByGuild: storedMap(LAST_TEXT_BY_GUILD_KEY),
  lastDmId: stored(LAST_DM_KEY),
  setView: (view) => {
    if (view.kind === 'text') {
      const guildId = selectGuildOf(view.channelId);
      store(LAST_TEXT_CHANNEL_KEY, view.channelId);
      const lastTextByGuild = guildId ? { ...get().lastTextByGuild, [guildId]: view.channelId } : get().lastTextByGuild;
      store(LAST_TEXT_BY_GUILD_KEY, JSON.stringify(lastTextByGuild));
      set({ view, lastTextChannelId: view.channelId, lastTextByGuild });
    } else if (view.kind === 'voice') {
      const channelId = view.channelId ?? voiceChannelId();
      // DM aramasının sahnesi konuşmanın içindedir: konuşma açılır
      if (channelId && useGuild.getState().dms[channelId]) {
        get().setView({ kind: 'dm', channelId });
        return;
      }
      // Bağlı olunan ses kanalının sunucusu seçilir
      selectGuildOf(channelId);
      set({ view });
    } else if (view.kind === 'dm') {
      store(LAST_DM_KEY, view.channelId);
      set({ view, lastDmId: view.channelId });
    } else {
      set({ view });
    }
  },
  modal: null,
  contextMenu: null,
  emojiPicker: null,
  toasts: [],
  openModal: (modal) => set({ modal, contextMenu: null, emojiPicker: null }),
  closeModal: () => set({ modal: null }),
  openContextMenu: (contextMenu) => set({ contextMenu, emojiPicker: null }),
  closeContextMenu: () => set({ contextMenu: null }),
  openEmojiPicker: (emojiPicker) => set({ emojiPicker, contextMenu: null }),
  closeEmojiPicker: () => set({ emojiPicker: null }),
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, kind }].slice(-4) });
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text: string, kind?: Toast['kind']): void => useUi.getState().toast(text, kind);
