import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ActivityState,
  DiskortBridge,
  DownloadResult,
  HotkeyEvent,
  TrayAction,
  UpdateState,
  UpdateSupport,
} from '../shared/bridge';

/** macOS sistem sesi CoreAudio Tap ile yakalanır; bu API 14.2'de geldi, öncesinde yayın başlamayabilir. */
function macHasSystemAudio(): boolean {
  if (process.platform !== 'darwin') return false;
  const [major = 0, minor = 0] = process.getSystemVersion().split('.').map(Number);
  return major > 14 || (major === 14 && minor >= 2);
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: DiskortBridge = {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  setPreferences: (prefs) => ipcRenderer.invoke('app:set-preferences', prefs),
  setTrayState: (state) => ipcRenderer.send('app:tray-state', state),
  onTrayAction: (cb) => listen<TrayAction>('tray-action', cb),
  showWindow: () => ipcRenderer.send('app:show-window'),
  requestAttention: () => ipcRenderer.send('app:request-attention'),
  setBadgeCount: (count) => ipcRenderer.send('app:badge-count', count),
  download: (url) => ipcRenderer.invoke('app:download', url),
  onDownloadDone: (cb) => listen<DownloadResult>('download:done', cb),
  edit: (command) => ipcRenderer.send('app:edit', command),
  setTheme: (theme) => ipcRenderer.send('app:set-theme', theme),
  idle: {
    get: () => ipcRenderer.invoke('presence:get-idle'),
    onChange: (cb) => listen<boolean>('presence:idle', cb),
  },
  activity: {
    supported: process.platform === 'win32',
    getState: () => ipcRenderer.invoke('activity:get-state'),
    onState: (cb) => listen<ActivityState>('activity:state', cb),
    getSettings: () => ipcRenderer.invoke('activity:get-settings'),
    setActive: (active) => ipcRenderer.invoke('activity:set-active', active),
    setEnabled: (enabled) => ipcRenderer.invoke('activity:set-enabled', enabled),
    listPrograms: () => ipcRenderer.invoke('activity:list-programs'),
    addGame: (path) => ipcRenderer.invoke('activity:add-game', path),
    removeGame: (path) => ipcRenderer.invoke('activity:remove-game', path),
    setHidden: (path, hidden) => ipcRenderer.invoke('activity:set-hidden', path, hidden),
    icon: (key) => ipcRenderer.invoke('activity:icon', key),
  },
  invites: {
    take: () => ipcRenderer.invoke('invite:take'),
    onOpen: (cb) => listen<string>('invite:open', cb),
  },

  screen: {
    supportsAudio: process.platform === 'win32' || macHasSystemAudio(),
    getSources: () => ipcRenderer.invoke('screen:get-sources'),
    select: (selection) => ipcRenderer.invoke('screen:select', selection),
    accessDenied: () => ipcRenderer.invoke('screen:access-denied'),
    openAccessSettings: () => ipcRenderer.invoke('screen:open-access-settings'),
  },

  hotkeys: {
    available: () => ipcRenderer.invoke('hotkeys:available'),
    set: (config) => ipcRenderer.invoke('hotkeys:set', config),
    record: () => ipcRenderer.invoke('hotkeys:record'),
    cancelRecord: () => ipcRenderer.invoke('hotkeys:cancel-record'),
    onEvent: (cb) => listen<HotkeyEvent>('hotkey', cb),
  },

  feedback: {
    capture: () => ipcRenderer.invoke('feedback:capture'),
    systemInfo: () => ipcRenderer.invoke('feedback:system-info'),
  },

  crash: {
    setContext: (context) => ipcRenderer.send('crash:context', context),
    pending: () => ipcRenderer.invoke('crash:pending'),
    ack: (ids) => ipcRenderer.invoke('crash:ack', ids),
    onPending: (cb) => listen<void>('crash:pending', () => cb()),
  },

  lineTest: {
    run: (server, token) => ipcRenderer.invoke('linetest:run', server, token),
    onProgress: (cb) => listen<{ sec: number; total: number }>('linetest:progress', cb),
  },

  updates: {
    // Ana süreç, pencere oluşturulurken destek türünü komut satırı argümanıyla bildirir
    support: (process.argv.find((a) => a.startsWith('--diskort-update-support='))?.split('=')[1] ??
      'none') as UpdateSupport,
    getState: () => ipcRenderer.invoke('updates:get-state'),
    onState: (cb) => listen<UpdateState>('updates:state', cb),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
  },
};

contextBridge.exposeInMainWorld('diskort', bridge);
