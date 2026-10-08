import type { FeedbackContext } from '@diskort/shared';
import { baseFeedbackContext, useGuild } from '@diskort/client-core';
import { bridge, platform } from '../../lib/bridge';
import { currentView } from '../../lib/mainView';
import { useVoice } from '../../stores/voice';

/**
 * Açık görünümün yalnızca türü: kanal ya da konuşma adı, kimliği, katılımcıları ve mesaj içeriği
 * gönderilmez (direkt mesajlar özeldir).
 */
function describeView(): string {
  const view = currentView();
  switch (view.kind) {
    case 'voice':
      return 'ses sahnesi';
    case 'dm':
      return 'direkt mesaj';
    case 'dms':
      return 'direkt mesajlar';
    case 'friends':
      return 'arkadaşlar';
    case 'text':
      return useGuild.getState().channels.some((c) => c.id === view.channelId) ? 'metin kanalı' : 'ana ekran';
    default:
      return 'ana ekran';
  }
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

/**
 * Masaüstünün teknik bilgileri: sürüm, işletim sistemi, ekran ve pencere boyutu, açık görünümün türü,
 * sese bağlı olup olmadığı ve bu oturumdaki son hatalar. Kullanıcı gönderimden önce görür.
 */
export async function desktopFeedbackContext(): Promise<FeedbackContext> {
  const info = await bridge?.feedback?.systemInfo().catch(() => null);
  return {
    ...baseFeedbackContext(),
    os: info?.os ?? platform,
    ...(info?.osVersion ? { osVersion: info.osVersion } : {}),
    ...(info ? { device: `${info.arch} · Electron ${info.electron}` } : {}),
    screen: `${window.screen.width}×${window.screen.height} @${fmt(window.devicePixelRatio)}x`,
    window: `${window.innerWidth}×${window.innerHeight}`,
    view: describeView(),
    inVoice: useVoice.getState().channelId !== null,
  };
}

/** Teknik bilgilerin kullanıcıya gösterilen adları */
export const CONTEXT_LABELS: Record<Exclude<keyof FeedbackContext, 'recentErrors'>, string> = {
  platform: 'Platform',
  appVersion: 'Uygulama sürümü',
  nativeVersion: 'APK sürümü',
  os: 'İşletim sistemi',
  osVersion: 'Sistem sürümü',
  device: 'Cihaz',
  screen: 'Ekran',
  window: 'Pencere',
  view: 'Açık görünüm',
  inVoice: 'Seste',
};

/** Teknik bilgileri gösterilecek satırlara çevirir (boş olanlar atlanır) */
export function contextRows(context: FeedbackContext): { label: string; value: string }[] {
  return (Object.keys(CONTEXT_LABELS) as (keyof typeof CONTEXT_LABELS)[])
    .filter((key) => context[key] !== undefined && context[key] !== '')
    .map((key) => {
      const value = context[key];
      return { label: CONTEXT_LABELS[key], value: typeof value === 'boolean' ? (value ? 'Evet' : 'Hayır') : String(value) };
    });
}
