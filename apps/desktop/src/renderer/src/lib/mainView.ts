import { useMemo } from 'react';
import type { Channel, DmChannel } from '@diskort/shared';
import { useGuild } from '@diskort/client-core';
import { useUi, type View } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { voiceViewTarget } from '../features/calls/callLogic';

/** Ana alanda gerçekte gösterilen içerik (istenen görünüm artık geçerli değilse makul bir yedeğe düşer). */
export type ResolvedView =
  | { kind: 'voice' }
  | { kind: 'text'; channelId: string }
  | { kind: 'home' }
  | { kind: 'dm'; channelId: string }
  | { kind: 'dms' }
  | { kind: 'friends'; tab?: 'all' | 'pending' | 'add' };

/** Direkt mesajlar bölümünde mi (sol çubukta konuşma listesi gösterilir) */
export const isDmSection = (view: ResolvedView): boolean =>
  view.kind === 'dm' || view.kind === 'dms' || view.kind === 'friends';

export function resolveView(
  view: View,
  lastTextChannelId: string | null,
  channels: Channel[],
  voiceChannelId: string | null,
  dms: Record<string, DmChannel>,
): ResolvedView {
  const inVoice = voiceChannelId !== null;
  // DM aramasının sahnesi konuşmanın içindedir. İstenen kanal (katılma sürüyor olabilir) bağlı olunandan önce gelir.
  if (view.kind === 'voice' && inVoice) return voiceViewTarget(view.channelId ?? voiceChannelId, dms);
  // Kapatılan ya da ayrılınan konuşma: konuşma listesi açık kalır
  if (view.kind === 'dm') return dms[view.channelId] ? view : { kind: 'dms' };
  if (view.kind === 'dms' || view.kind === 'friends') return view;
  const text = channels.filter((c) => c.type === 'text');
  const wanted = view.kind === 'text' ? view.channelId : lastTextChannelId;
  const channel = text.find((c) => c.id === wanted) ?? text[0];
  if (channel) return { kind: 'text', channelId: channel.id };
  return inVoice ? { kind: 'voice' } : { kind: 'home' };
}

/** Seçili sunucuda son açılan metin kanalı */
function lastTextOf(lastTextByGuild: Record<string, string>, activeGuildId: string | null): string | null {
  return activeGuildId ? (lastTextByGuild[activeGuildId] ?? null) : null;
}

export function useMainView(): ResolvedView {
  const view = useUi((s) => s.view);
  const activeGuildId = useGuild((s) => s.activeGuildId);
  const lastText = useUi((s) => lastTextOf(s.lastTextByGuild, activeGuildId) ?? s.lastTextChannelId);
  const channels = useGuild((s) => s.channels);
  const dms = useGuild((s) => s.dms);
  const voiceChannelId = useVoice((s) => s.channelId);
  return useMemo(
    () => resolveView(view, lastText, channels, voiceChannelId, dms),
    [view, lastText, channels, voiceChannelId, dms],
  );
}

export function currentView(): ResolvedView {
  const ui = useUi.getState();
  const guild = useGuild.getState();
  const lastText = lastTextOf(ui.lastTextByGuild, guild.activeGuildId) ?? ui.lastTextChannelId;
  return resolveView(ui.view, lastText, guild.channels, useVoice.getState().channelId, guild.dms);
}

/** Direkt mesajlar bölümüne geç: son açık konuşma hâlâ listedeyse o, yoksa konuşma listesi */
export function openDmSection(): void {
  const ui = useUi.getState();
  const last = ui.lastDmId;
  ui.setView(last && useGuild.getState().dms[last] ? { kind: 'dm', channelId: last } : { kind: 'dms' });
}

/** Sunucuya geç (verilmezse seçili sunucu): o sunucuda son açılan metin kanalı (ya da ilk kanal) */
export function openGuildSection(guildId?: string): void {
  const guild = useGuild.getState();
  if (guildId && guildId !== guild.activeGuildId) guild.selectGuild(guildId);
  const target = guildId ?? useGuild.getState().activeGuildId;
  const ui = useUi.getState();
  const last = target ? ui.lastTextByGuild[target] : undefined;
  const channels = target ? (useGuild.getState().guilds[target]?.channels ?? []) : [];
  const channel = channels.find((c) => c.id === last && c.type === 'text') ?? channels.find((c) => c.type === 'text');
  ui.setView(channel ? { kind: 'text', channelId: channel.id } : { kind: 'home' });
}
