import { EventEmitter } from 'node:events';
import { STREAM_WATCH_MAX, type StreamSourceKind, type VoiceState } from '@diskort/shared';

type SelfFlags = { selfMute: boolean; selfDeaf: boolean };
export type StreamSource = { name: string; kind: StreamSourceKind };
export type ServerFlags = { serverMute: boolean; serverDeaf: boolean };

const NO_SERVER_FLAGS: ServerFlags = { serverMute: false, serverDeaf: false };

export interface VoiceSnapshotEntry {
  channelId: string;
  streaming: boolean;
}

interface VoiceEvents {
  update: [VoiceState];
  delete: [{ userId: string; channelId: string }];
}

/**
 * Kimin hangi ses kanalında olduğunu tutar. Katılma/ayrılma bilgisi LiveKit
 * webhook'larından gelir (tek doğruluk kaynağı); mute/deafen bayrakları
 * istemcinin gateway üzerinden bildirdiği değerlerdir. Sunucu tarafı susturma/sağırlaştırma
 * yetkililerce verilir ve kanaldan çıkınca da sürer (veritabanında, sunucu başına saklanır; katılırken
 * kanalın sunucusundaki değer `setFlagResolver` ile okunur).
 */
export class VoiceStateStore extends EventEmitter<VoiceEvents> {
  private readonly states = new Map<string, VoiceState>();
  private readonly selfFlags = new Map<string, SelfFlags>();
  private readonly serverFlags = new Map<string, ServerFlags>();
  /** Kullanıcının geçerli LiveKit oturumu (participant SID) */
  private readonly sessions = new Map<string, string>();
  /** Yayıncının bildirdiği kaynak (yayın webhook'u gelmeden önce de bildirilebilir) */
  private readonly streamSources = new Map<string, StreamSource>();
  /**
   * İzleyicinin bildirdiği izlenen yayınlar (istek). Durumdaki `watching` bundan türetilir: yalnızca aynı ses
   * kanalında o an yayında olanlar. İstek katılma webhook'undan önce de gelebilir (başka kanaldan geçip hemen
   * yayını açınca); bu yüzden kişi sesten çıkınca silinmez. Silindiği anlar: istemci boş liste bildirince,
   * bildiren gateway bağlantısı kapanınca, yayıncı yayını bitirince ya da sesten çıkınca.
   *
   * Kullanıcı → bildiren bağlantı (kaynak) → izlenenler. Her cihaz yalnızca kendi ses bağlantısının durumunu
   * bildirir: seste olmayan ya da sesi başka cihaza geçmiş (LiveKit'te aynı kimlik eskisini düşürür) cihazın
   * listesi boştur. Görünen liste kaynakların birleşimidir; böylece bayat bir cihazın boş listesi seste olan
   * cihazın listesini silmez (eksik izleyici olmaz), boş olmayan liste de yalnızca gerçekten izleyen cihazdan
   * gelir (hayalet olmaz).
   */
  private readonly watchRequests = new Map<string, Map<string, Set<string>>>();
  /** Kanala katılırken kişinin o kanalın sunucusundaki susturma/sağırlaştırma durumu */
  private flagsOf: ((userId: string, channelId: string) => ServerFlags) | null = null;

  setFlagResolver(fn: (userId: string, channelId: string) => ServerFlags): void {
    this.flagsOf = fn;
  }

  list(): VoiceState[] {
    return [...this.states.values()];
  }

  get(userId: string): VoiceState | undefined {
    return this.states.get(userId);
  }

  /** Kanaldaki kullanıcılar */
  membersOf(channelId: string): string[] {
    const out: string[] = [];
    for (const state of this.states.values()) if (state.channelId === channelId) out.push(state.userId);
    return out;
  }

  join(userId: string, channelId: string, streaming = false, sessionId?: string): VoiceState {
    if (sessionId) this.sessions.set(userId, sessionId);
    const prev = this.states.get(userId);
    if (prev && prev.channelId === channelId) return prev;
    if (prev) this.remove(userId);
    const flags = this.selfFlags.get(userId) ?? { selfMute: false, selfDeaf: false };
    const server = this.flagsOf ? this.flagsOf(userId, channelId) : (this.serverFlags.get(userId) ?? NO_SERVER_FLAGS);
    if (this.flagsOf) {
      if (server.serverMute || server.serverDeaf) this.serverFlags.set(userId, server);
      else this.serverFlags.delete(userId);
    }
    const state: VoiceState = { userId, channelId, ...flags, ...server, streaming, joinedAt: Date.now() };
    if (streaming) Object.assign(state, this.streamFields(userId));
    const watching = this.watchingOf(state);
    if (watching.length > 0) state.watching = watching;
    this.states.set(userId, state);
    this.emit('update', state);
    this.refreshViewersOf(userId);
    return state;
  }

  /**
   * Yalnızca kullanıcı hâlâ o kanaldaysa çıkarır (geç gelen webhook'lara karşı). Aynı hesap aynı kanala
   * başka bir cihazdan bağlanınca LiveKit eski oturumu kapatır; o eski oturumun "ayrıldı" bildirimi,
   * oturum kimliği güncel olanla uyuşmadığı için yok sayılır.
   */
  leave(userId: string, channelId: string, sessionId?: string): boolean {
    const prev = this.states.get(userId);
    if (!prev || prev.channelId !== channelId) return false;
    const current = this.sessions.get(userId);
    if (sessionId && current && current !== sessionId) return false;
    this.remove(userId);
    return true;
  }

  leaveChannel(channelId: string): void {
    for (const state of this.list()) {
      if (state.channelId === channelId) this.remove(state.userId);
    }
  }

  setSelf(userId: string, flags: SelfFlags): void {
    this.selfFlags.set(userId, flags);
    const prev = this.states.get(userId);
    if (!prev || (prev.selfMute === flags.selfMute && prev.selfDeaf === flags.selfDeaf)) return;
    const next = { ...prev, ...flags };
    this.states.set(userId, next);
    this.emit('update', next);
  }

  /** Bulunduğu ses kanalının sunucusundaki durumu (seste değilse son bilinen) */
  getServerFlags(userId: string): ServerFlags {
    return this.serverFlags.get(userId) ?? NO_SERVER_FLAGS;
  }

  setServerFlags(userId: string, flags: ServerFlags): void {
    if (flags.serverMute || flags.serverDeaf) this.serverFlags.set(userId, flags);
    else this.serverFlags.delete(userId);
    const prev = this.states.get(userId);
    if (!prev || (prev.serverMute === flags.serverMute && prev.serverDeaf === flags.serverDeaf)) return;
    const next = { ...prev, ...flags };
    this.states.set(userId, next);
    this.emit('update', next);
  }

  setStreaming(userId: string, channelId: string, streaming: boolean): void {
    const prev = this.states.get(userId);
    if (!prev || prev.channelId !== channelId || prev.streaming === streaming) return;
    let next: VoiceState;
    if (streaming) next = { ...withoutStream(prev), streaming, ...this.streamFields(userId) };
    else {
      this.streamSources.delete(userId);
      next = { ...withoutStream(prev), streaming };
    }
    this.states.set(userId, next);
    this.emit('update', next);
    // Yayın bittiyse izleme istekleri de biter (yeniden başlarsa izleyenler yeniden bildirir)
    this.refreshViewersOf(userId, !streaming);
  }

  /**
   * İzleyicinin izlediği yayınları bildirir (tam liste; boş liste izlemeyi bırakır). Kendisi, yinelenenler ve
   * metin olmayanlar atılır. Görünen liste yalnızca aynı ses kanalında yayında olanları içerir; seste
   * değilse kimsenin izleyicisi olarak görünmez. `source`: bildiren bağlantı (her cihaz kendi listesini ezer;
   * boş liste ya da bağlantının kapanması yalnızca o cihazın isteğini siler).
   */
  setWatching(userId: string, userIds: readonly unknown[], source = ''): void {
    const wanted = new Set<string>();
    for (const id of userIds) {
      if (wanted.size >= STREAM_WATCH_MAX) break;
      if (typeof id === 'string' && id.length > 0 && id.length <= 64 && id !== userId) wanted.add(id);
    }
    const sources = this.watchRequests.get(userId) ?? new Map<string, Set<string>>();
    if (wanted.size > 0) sources.set(source, wanted);
    else sources.delete(source);
    if (sources.size > 0) this.watchRequests.set(userId, sources);
    else this.watchRequests.delete(userId);
    this.refreshWatching(userId);
  }

  /** Yayıncıyı izleyenler (durumlardaki `watching` listelerinden) */
  viewersOf(streamerId: string): string[] {
    return this.list()
      .filter((v) => v.watching?.includes(streamerId))
      .map((v) => v.userId);
  }

  /** İzleme isteğinden görünen liste: aynı kanalda, yayında olanlar (sıralı) */
  private watchingOf(state: VoiceState): string[] {
    const sources = this.watchRequests.get(state.userId);
    if (!sources) return [];
    const out = new Set<string>();
    for (const wanted of sources.values()) {
      for (const id of wanted) {
        if (out.size >= STREAM_WATCH_MAX) break;
        const target = this.states.get(id);
        if (target && target.channelId === state.channelId && target.streaming) out.add(id);
      }
    }
    return [...out].sort();
  }

  private refreshWatching(userId: string): void {
    const prev = this.states.get(userId);
    if (!prev) return;
    const watching = this.watchingOf(prev);
    const before = prev.watching ?? [];
    if (watching.length === before.length && watching.every((id, i) => id === before[i])) return;
    const next: VoiceState = { ...prev };
    if (watching.length > 0) next.watching = watching;
    else delete next.watching;
    this.states.set(userId, next);
    this.emit('update', next);
  }

  /**
   * Yayıncının durumu değişti (katıldı, ayrıldı, yayın başladı/bitti): onu izlemek isteyenlerin listesini
   * günceller. `forget`: yayın bitti ya da yayıncı ayrıldı; istekler de silinir.
   */
  private refreshViewersOf(streamerId: string, forget = false): void {
    const viewers: string[] = [];
    for (const [viewerId, sources] of this.watchRequests) {
      let found = false;
      for (const [source, wanted] of sources) {
        if (!wanted.has(streamerId)) continue;
        found = true;
        if (forget) {
          wanted.delete(streamerId);
          if (wanted.size === 0) sources.delete(source);
        }
      }
      if (!found) continue;
      viewers.push(viewerId);
      if (sources.size === 0) this.watchRequests.delete(viewerId);
    }
    for (const viewerId of viewers) this.refreshWatching(viewerId);
  }

  /**
   * Yayıncının paylaştığı kaynak. Kullanıcı seste olmalı; yayın henüz başlamadıysa (webhook gelmediyse)
   * saklanır ve yayın başlayınca durumuna eklenir. Yayın bitince ya da sesten çıkınca unutulur.
   */
  setStreamSource(userId: string, source: StreamSource | null): boolean {
    const prev = this.states.get(userId);
    if (!prev) return false;
    if (source) this.streamSources.set(userId, source);
    else this.streamSources.delete(userId);
    if (!prev.streaming) return true;
    const next: VoiceState = { ...prev };
    delete next.streamSourceName;
    delete next.streamSourceKind;
    if (source) Object.assign(next, { streamSourceName: source.name, streamSourceKind: source.kind });
    this.states.set(userId, next);
    this.emit('update', next);
    return true;
  }

  /** Yeni yayın önizlemesi yüklendi (ya da silindi); yalnızca yayındayken */
  setStreamPreview(userId: string, at: number | null): void {
    const prev = this.states.get(userId);
    if (!prev || !prev.streaming || prev.streamPreviewAt === (at ?? undefined)) return;
    const next: VoiceState = { ...prev };
    if (at === null) delete next.streamPreviewAt;
    else next.streamPreviewAt = at;
    this.states.set(userId, next);
    this.emit('update', next);
  }

  private streamFields(userId: string): Partial<VoiceState> {
    const source = this.streamSources.get(userId);
    return {
      streamStartedAt: Date.now(),
      ...(source ? { streamSourceName: source.name, streamSourceKind: source.kind } : {}),
    };
  }

  /**
   * LiveKit'ten alınan anlık görüntüyle durumu eşitler (sunucu yeniden başlatma, kaçan webhook).
   * `takenAt`: anlık görüntünün istenmeye başladığı an; ondan sonra katılan biri görüntüde olmayabilir, silinmez.
   */
  reconcile(snapshot: Map<string, VoiceSnapshotEntry>, takenAt = Infinity): void {
    for (const state of this.list()) {
      const live = snapshot.get(state.userId);
      if (state.joinedAt >= takenAt) continue;
      if (!live || live.channelId !== state.channelId) this.remove(state.userId);
    }
    for (const [userId, live] of snapshot) {
      const state = this.states.get(userId);
      if (!state) this.join(userId, live.channelId, live.streaming);
      else this.setStreaming(userId, live.channelId, live.streaming);
    }
  }

  private remove(userId: string): void {
    const prev = this.states.get(userId);
    if (!prev) return;
    this.states.delete(userId);
    this.sessions.delete(userId);
    this.streamSources.delete(userId);
    this.emit('delete', { userId, channelId: prev.channelId });
    // Ayrılan yayıncının izleyicileri düşer; ayrılanın kendi isteği kalır (bkz. watchRequests)
    this.refreshViewersOf(userId, true);
  }
}

/** Yayına ait alanlar çıkarılmış durum */
function withoutStream(state: VoiceState): VoiceState {
  const { streamStartedAt: _a, streamSourceName: _b, streamSourceKind: _c, streamPreviewAt: _d, ...rest } = state;
  return rest;
}
