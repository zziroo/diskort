import { useEffect } from 'react';
import { gateway, setPendingInvite, useSession, useUnreadBadgeTotal } from '@diskort/client-core';
import type { ActivityState } from '../../../../shared/bridge';
import { bridge } from '../../lib/bridge';
import { useSettings } from '../../stores/settings';
import { toast } from '../../stores/ui';
import { useUpdate } from '../../stores/update';
import { useVoice } from '../../stores/voice';
import { voice } from '../voice/voiceClient';
import { reportActivities } from './activityReporter';

/** Electron ana süreciyle entegrasyon: global kısayollar, tepsi menüsü, tercihler, güncellemeler. */
export function useDesktopIntegration(): void {
  // Otomatik "Boşta": ana süreç girdi yokluğunu ve ekran kilidini izler, sunucuya iletilir (elle seçilen
  // durum değişmez; başka bir cihazda etkinsen "Çevrim içi" kalırsın)
  useEffect(() => {
    const idle = bridge?.idle;
    if (!idle) return;
    void idle.get().then((value) => gateway.setIdle(value), () => undefined);
    return idle.onChange((value) => gateway.setIdle(value));
  }, []);

  // Etkinlik: ana süreç açık oyunları algılar (Windows), sunucuya iletilir; ayar kapalıyken liste boş gelir ve
  // etkinlik silinir. Yalnızca giriş yapılmışken taranır; giriş yapılınca yeniden bildirilir.
  const loggedIn = useSession((s) => s.token !== null);
  useEffect(() => {
    const activity = bridge?.activity;
    if (!activity) return;
    const report = (state: ActivityState): void => reportActivities(state.games, activity.icon);
    void activity.setActive(loggedIn).catch(() => undefined);
    void activity.getState().then(report, () => undefined);
    return activity.onState(report);
  }, [loggedIn]);

  // Uygulama simgesindeki okunmamış rozeti: bahsetmeler + okunmamış DM'ler (DND'de de sayılır). Okununca sayı
  // düşer, 0'da rozet kalkar; oturum kapalıyken ve arayüz kapanırken 0.
  const unreadTotal = useUnreadBadgeTotal();
  const badgeCount = loggedIn ? unreadTotal : 0;
  useEffect(() => {
    bridge?.setBadgeCount(badgeCount);
  }, [badgeCount]);
  useEffect(() => () => bridge?.setBadgeCount(0), []);

  // Davet bağlantısı (diskort://davet/<kod>): kod bekletilir; oturum açıksa katılma penceresi açılır,
  // değilse giriş ekranı "giriş yapınca katılacaksın" notunu gösterir (MainLayout, AuthScreen)
  useEffect(() => {
    const invites = bridge?.invites;
    if (!invites) return;
    const off = invites.onOpen((code) => setPendingInvite(code));
    void invites.take().then((code) => code && setPendingInvite(code), () => undefined);
    return off;
  }, []);

  // Global kısayol olayları → ses motoru
  useEffect(() => {
    if (!bridge) return;
    return bridge.hotkeys.onEvent((event) => {
      if (event.action === 'pushToTalk') voice.setPushToTalk(event.pressed);
      else if (event.action === 'toggleMute') voice.toggleMute();
      else voice.toggleDeafen();
    });
  }, []);

  // Kısayol atamalarını ana sürece bildir (bas-konuş yalnızca PTT modunda dinlenir)
  const hotkeys = useSettings((s) => s.hotkeys);
  const inputMode = useSettings((s) => s.inputMode);
  useEffect(() => {
    void bridge?.hotkeys.set({ ...hotkeys, pushToTalk: inputMode === 'ptt' ? hotkeys.pushToTalk : null });
  }, [hotkeys, inputMode]);

  // Uygulama tercihleri
  const minimizeToTray = useSettings((s) => s.minimizeToTray);
  const openAtLogin = useSettings((s) => s.openAtLogin);
  useEffect(() => {
    void bridge?.setPreferences({ minimizeToTray, openAtLogin });
  }, [minimizeToTray, openAtLogin]);

  // Tepsi menüsü durumu ve eylemleri
  const selfMute = useSettings((s) => s.selfMute);
  const selfDeaf = useSettings((s) => s.selfDeaf);
  const connected = useVoice((s) => s.status !== 'idle');
  useEffect(() => {
    bridge?.setTrayState({ connected, muted: selfMute || selfDeaf, deafened: selfDeaf });
  }, [connected, selfMute, selfDeaf]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onTrayAction((action) => {
      if (action === 'toggleMute') voice.toggleMute();
      else if (action === 'toggleDeafen') voice.toggleDeafen();
      else void voice.leave();
    });
  }, []);

  // Dosya indirmeleri
  useEffect(() => {
    if (!bridge) return;
    return bridge.onDownloadDone(({ name, ok }) =>
      toast(ok ? `İndirildi: ${name}` : `İndirilemedi: ${name}`, ok ? 'success' : 'error'),
    );
  }, []);

  // Güncelleyici durumu (arka planda indirme, "hazır" şeridi, zorunlu güncelleme ekranı)
  useEffect(() => {
    if (!bridge) return;
    void bridge.updates.getState().then((state) => useUpdate.setState({ state }));
    return bridge.updates.onState((state) => useUpdate.setState({ state }));
  }, []);
}
