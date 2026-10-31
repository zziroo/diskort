import { DM_CALL_RING_MS, Permission, type DmCall, type Message, type MessageUpdate } from '@diskort/shared';
import type { Store } from './db.js';
import type { Gateway } from './gateway.js';
import type { PermissionService } from './permissions.js';
import type { PushService } from './push.js';
import type { VoiceStateStore } from './voiceState.js';

/**
 * Odaya ilk bağlananın katılma bildirimi (webhook) bu süreden geç gelirse çalınmaz: arama ya eşitlemeyle
 * (kaçan webhook, sunucu yeniden başladı) kurulmuştur ya da zaten sürüyordur.
 */
const FRESH_CALL_MS = 10_000;
/**
 * Sunucu açıldıktan sonra bu süre içinde kurulan arama, konuşmanın bitmemiş kaydını sürdürür (yeniden
 * başlatmada süren aramalar eşitlemeyle hemen geri gelir). Daha sonra bulunan bitmemiş kayıt bayattır:
 * kapatılır ve yeni arama yeni kayıt alır.
 */
const RECOVERY_MS = 120_000;
/**
 * Aynı kişi bu konuşmadaki aramasını bitirip bu süre içinde yeniden başlatırsa (girip çıkıp durursa) yeni
 * kayıt, okunmamış, çalma ve bildirim olmaz: önceki kayıt sürdürülür.
 */
export const RESTART_COOLDOWN_MS = 30_000;

interface CallState {
  channelId: string;
  startedBy: string;
  startedAt: number;
  /** Konuşmadaki arama kaydı (mesaj); silindiyse güncellenmez */
  messageId: string | null;
  /** Çalınan → süresinin dolacağı zamanlayıcı */
  ringing: Map<string, NodeJS.Timeout>;
  /** Çalınan → çalmanın (son) başladığı an */
  ringAt: Map<string, number>;
  /** En az bir kez çalınanlar (cevapsız arama bildirimi bunlara) */
  rung: Set<string>;
  /** Aramaya katılanlar (başlatan dahil), ilk katılma sırasıyla */
  joined: string[];
  /** İlk çalma yapıldı ya da artık yapılmayacak */
  rang: boolean;
}

export interface DmCallDeps {
  store: Store;
  permissions: PermissionService;
  gateway: Pick<Gateway, 'sendDm' | 'dispatchChannel' | 'pushRecipients' | 'sendReadState' | 'statuses'>;
  voice: VoiceStateStore;
  push: Pick<PushService, 'notifyCall' | 'notifyMissedCall'>;
  /** Testler: çalma süresi (varsayılan DM_CALL_RING_MS) ve saat */
  ringMs?: number;
  now?: () => number;
}

/** Gateway'e giden güncelleme: tepkilerin `me` alanı kişiye özel olduğundan çıkarılır */
const toUpdate = ({ reactions: _reactions, ...message }: Message): MessageUpdate => message;

/**
 * Direkt mesaj aramaları (yalnızca bellekte, ses durumu gibi). Arama, konuşmanın ses odasında en az bir kişi
 * olduğu sürece vardır: ses durumu (LiveKit webhook'u ya da eşitleme) odaya ilk kişiyi koyunca kurulur,
 * oda boşalınca biter. Kurulunca konuşmaya arama kaydı yazılır (bitince süresi ya da "cevapsız" olarak
 * güncellenir). Çalma yalnızca odaya ilk bağlananın katılma webhook'uyla başlar (bkz. webhookJoined): jeton
 * alıp hiç bağlanmayan kimseyi çaldırmaz, eşitlemeyle (sunucu yeniden başlarken) kurulan arama kimseyi
 * yeniden çalmaz.
 *
 * Çalınmayanlar: odada olanlar, aramaya bağlanamayanlar (salt okunur konuşma), Rahatsız Etmeyin'dekiler ve
 * çalanı (başlatanı) engellemiş olanlar. Çalma kişi başına DM_CALL_RING_MS sürer; katılınca ya da reddedince
 * biter. Olaylar (DM_CALL_UPDATE / DM_CALL_DELETE) yalnızca konuşmanın katılımcılarının DM tanıyan oturumlarına
 * gider; çalınanların telefonuna (masaüstünde etkin değilse) bildirim gider.
 */
export class DmCallService {
  private readonly calls = new Map<string, CallState>();
  private readonly ringMs: number;
  private readonly now: () => number;
  private stopped = false;
  private readonly createdAt: number;
  /** LiveKit eşitlemesi sürüyor (bkz. duringReconcile) */
  private reconciling = false;
  /**
   * Sunucu açıldı ama ilk eşitleme henüz bitmedi (bkz. expectFirstSync): bu arada gelen katılma webhook'u
   * süren bir aramanın odasına olabilir; bitmemiş kayıt kapatılmaz, sürdürülür ve kimse çalınmaz.
   */
  private awaitingFirstSync = false;
  /** Konuşma → en son biten aramanın başlatanı, bitişi ve kaydı (yeniden başlatma bekleme süresi için) */
  private readonly recent = new Map<string, { userId: string; at: number; messageId: string; participantIds: string[] }>();
  private readonly staleTimer: NodeJS.Timeout;

  constructor(private readonly deps: DmCallDeps) {
    this.ringMs = deps.ringMs ?? DM_CALL_RING_MS;
    this.now = deps.now ?? Date.now;
    this.createdAt = this.now();
    deps.voice.on('update', (state) => this.onVoiceUpdate(state.userId, state.channelId));
    deps.voice.on('delete', ({ channelId }) => this.onVoiceDelete(channelId));
    // Eşitleme hiç başarılı olmasa da (LiveKit kapalı) bayat kayıtlar bir süre sonra kapanır
    this.staleTimer = setTimeout(() => {
      this.awaitingFirstSync = false;
      try {
        this.closeStaleRecords();
      } catch {
        // veritabanı kapanmış olabilir; önemli değil
      }
    }, RECOVERY_MS);
    this.staleTimer.unref?.();
  }

  /** Sunucu kapanıyor: zamanlayıcılar durur (aramaların kaydı açık kalır, açılışta sürdürülür ya da kapanır) */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.staleTimer);
    for (const call of this.calls.values()) for (const timer of call.ringing.values()) clearTimeout(timer);
    this.calls.clear();
  }

  /**
   * LiveKit eşitlemesini sarar: bu sırada (sunucu açıldıktan sonra RECOVERY_MS içinde) kurulan arama
   * konuşmanın bitmemiş kaydını sürdürür. Webhook'la kurulan arama asla sürdürmez (bayat kaydı kapatır).
   */
  duringReconcile<T>(fn: () => T): T {
    this.reconciling = true;
    try {
      const result = fn();
      this.awaitingFirstSync = false;
      return result;
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Sunucu açılırken (dinlemeye başlamadan önce) çağrılır: ilk başarılı eşitlemeye (ya da RECOVERY_MS'e) kadar
   * kurulan aramalar konuşmanın bitmemiş kaydını sürdürür (yeniden başlatmadan önce süren arama olabilir).
   */
  expectFirstSync(): void {
    this.awaitingFirstSync = true;
  }

  /** Konuşmada süren arama */
  get(channelId: string): DmCall | null {
    const call = this.calls.get(channelId);
    return call ? this.toPayload(call) : null;
  }

  /** Kullanıcının katılımcısı olduğu konuşmalardaki aramalar (READY) */
  callsFor(userId: string): DmCall[] {
    const { permissions } = this.deps;
    return [...this.calls.values()]
      .filter((c) => permissions.dmParticipants(c.channelId).includes(userId))
      .map((c) => this.toPayload(c));
  }

  /** Kullanıcı şu an bu aramada çalınıyor mu */
  isRinging(channelId: string, userId: string): boolean {
    return this.calls.get(channelId)?.ringing.has(userId) ?? false;
  }

  /**
   * LiveKit katılma bildirimi (ses durumu güncellendikten sonra). Odaya ilk bağlanan buysa ve arama yeni
   * kurulduysa diğer katılımcılar çalınır.
   */
  webhookJoined(userId: string, channelId: string): void {
    const call = this.calls.get(channelId);
    if (!call || call.rang) return;
    call.rang = true;
    if (call.startedBy !== userId || this.now() - call.startedAt > FRESH_CALL_MS) return;
    this.ringUsers(call, userId, null);
  }

  /**
   * Aramadaki biri (`ringerId`) aramada olmayanları yeniden çalar: `targets` verilmezse bütün katılımcılar.
   * Kimse çalınamadıysa (hepsi odada, Rahatsız Etmeyin'de, engellemiş…) yine de hata yok: dönen sayı.
   */
  ring(channelId: string, ringerId: string, targets: string[] | null): number {
    const call = this.calls.get(channelId);
    if (!call) return 0;
    return this.ringUsers(call, ringerId, targets);
  }

  /** Kullanıcı çalan aramayı reddetti (ya da başka bir cihazda yanıtladı): onun için çalma biter */
  decline(channelId: string, userId: string): boolean {
    const call = this.calls.get(channelId);
    if (!call) return false;
    // Reddeden "cevapsız arama" bildirimi almaz (süresi dolan alır)
    call.rung.delete(userId);
    if (!this.stopRinging(call, userId)) return false;
    this.announce(call);
    return true;
  }

  /** Katılımcı konuşmadan ayrıldı (gruptan çıktı): çalınıyorsa çalma biter */
  participantLeft(channelId: string, userId: string): void {
    this.decline(channelId, userId);
  }

  /**
   * `blocker`, `blocked`'ı engelledi: engellenenin de bulunduğu konuşmanın aramasında engelleyen artık çalınmaz
   * (aramayı kim başlatmış ya da çalmış olursa olsun; bire bir konuşmadaki arama zaten kapanır).
   */
  onBlocked(blocker: string, blocked: string): void {
    for (const call of this.calls.values()) {
      if (call.ringing.has(blocker) && this.deps.permissions.dmParticipants(call.channelId).includes(blocked)) {
        this.decline(call.channelId, blocker);
      }
    }
  }

  /**
   * Eşitlemeden sonra (bir kez, sunucu açılırken): bitmemiş görünen ama artık süren bir araması olmayan
   * kayıtları kapatır (sunucu kapalıyken biten aramalar). Bitiş anı bilinmediğinden şimdiki an yazılır.
   */
  closeStaleRecords(): number {
    if (this.stopped) return 0;
    let closed = 0;
    for (const message of this.deps.store.openCallMessages()) {
      if (this.calls.get(message.channelId)?.messageId === message.id) continue;
      const updated = this.deps.store.updateCallMessage(Number(message.id), {
        participantIds: message.call?.participantIds ?? [],
        endedAt: this.now(),
      });
      if (updated) this.deps.gateway.dispatchChannel(updated.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(updated) });
      closed++;
    }
    return closed;
  }

  // ---------- Ses durumundan ----------

  private onVoiceUpdate(userId: string, channelId: string): void {
    if (this.stopped || !this.deps.permissions.isDm(channelId)) return;
    let call = this.calls.get(channelId);
    if (!call) {
      call = this.start(channelId, userId);
      this.calls.set(channelId, call);
    } else {
      let changed = this.stopRinging(call, userId);
      if (!call.joined.includes(userId)) {
        call.joined.push(userId);
        changed = true;
      }
      if (!changed) return;
    }
    this.announce(call);
  }

  private onVoiceDelete(channelId: string): void {
    const call = this.calls.get(channelId);
    if (!call || this.stopped) return;
    if (this.deps.voice.list().some((v) => v.channelId === channelId)) return;
    this.end(call);
  }

  /**
   * Odaya ilk kişi girdi: arama kurulur. Üç yol:
   * - Sunucu yeniden başladı ve eşitleme süren aramanın odasını geri getirdi (`duringReconcile`, açılıştan
   *   sonra RECOVERY_MS içinde): konuşmanın bitmemiş kaydı sürdürülür, kimse çalınmaz.
   * - Aynı kişi bu konuşmada az önce (RESTART_COOLDOWN_MS) bir arama başlatmıştı (girip çıkıp duruyor): o kayıt
   *   yeniden açılır; yeni kayıt, okunmamış ve bildirim olmaz, kimse yeniden çalınmaz (aramadaki biri
   *   POST /call/ring ile çalabilir).
   * - Yoksa yeni kayıt yazılır (bitmemiş görünen bayat kayıt varsa önce kapatılır); çalma webhook'la başlar.
   */
  private start(channelId: string, userId: string): CallState {
    const { store, permissions, gateway } = this.deps;
    const now = this.now();
    const quiet = (messageId: string, startedBy: string, startedAt: number, joined: string[]): CallState => ({
      channelId,
      startedBy,
      startedAt,
      messageId,
      ringing: new Map(),
      ringAt: new Map(),
      rung: new Set(),
      joined: joined.includes(userId) ? joined : [...joined, userId],
      rang: true,
    });
    const open = store.openCallMessage(channelId);
    if (open && (this.reconciling || this.awaitingFirstSync) && now - this.createdAt <= RECOVERY_MS) {
      return quiet(open.id, open.authorId ?? userId, open.createdAt, [...(open.call?.participantIds ?? [])]);
    }
    if (open) {
      // Bayat kayıt (sunucu kapalıyken bitmiş arama): kapatılır, yeni arama yeni kayıt alır
      const closed = store.updateCallMessage(Number(open.id), { participantIds: open.call?.participantIds ?? [], endedAt: now });
      if (closed) gateway.dispatchChannel(channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(closed) });
    }
    const recent = this.recent.get(channelId);
    this.recent.delete(channelId);
    // Yalnızca kimse açmadıysa (girip çıkıp duruyor): açılmış bir aramanın ardından yeniden arama yeni aramadır
    if (recent && recent.userId === userId && recent.participantIds.length <= 1 && now - recent.at < RESTART_COOLDOWN_MS) {
      const reopened = store.updateCallMessage(Number(recent.messageId), {
        participantIds: recent.participantIds,
        endedAt: null,
      });
      if (reopened) {
        gateway.dispatchChannel(channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(reopened) });
        return quiet(reopened.id, userId, reopened.createdAt, [...recent.participantIds]);
      }
    }
    const others = permissions.dmParticipants(channelId).filter((id) => id !== userId);
    // Başlatanın okunmamışı varsa kayıt onları okunmuş saydırmasın
    const upToDate = store.readUpToDate(userId, channelId);
    const message = store.createCallMessage(channelId, userId, others, now);
    // Konuşmayı listesinden kaldırmış katılımcılarda yeniden görünür (mesajdan önce)
    const reopenedFor = store.reopenDm(channelId);
    if (reopenedFor.length > 0) gateway.sendDm(reopenedFor, { t: 'DM_CHANNEL_CREATE', d: store.getDm(channelId)! });
    gateway.dispatchChannel(channelId, { t: 'MESSAGE_CREATE', d: message });
    // Başlatan kendi kaydını okumuş sayılır (öncesini okumuşsa)
    if (upToDate) gateway.sendReadState(userId, store.ack(userId, channelId, Number(message.id)));
    return {
      channelId,
      startedBy: userId,
      startedAt: now,
      messageId: message.id,
      ringing: new Map(),
      ringAt: new Map(),
      rung: new Set(),
      joined: [userId],
      rang: false,
    };
  }

  private end(call: CallState): void {
    const { store, gateway, push, permissions } = this.deps;
    for (const timer of call.ringing.values()) clearTimeout(timer);
    call.ringing.clear();
    this.calls.delete(call.channelId);
    gateway.sendDm(permissions.dmParticipants(call.channelId), { t: 'DM_CALL_DELETE', d: { channelId: call.channelId } });
    const updated = call.messageId
      ? store.updateCallMessage(Number(call.messageId), { participantIds: call.joined, endedAt: this.now() })
      : null;
    if (updated) gateway.dispatchChannel(updated.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(updated) });
    // Başlatan hemen yeniden girerse bu kayıt sürdürülür (bkz. start)
    if (updated) {
      if (this.recent.size > 1_000) this.recent.clear();
      this.recent.set(call.channelId, {
        userId: call.startedBy,
        at: this.now(),
        messageId: updated.id,
        participantIds: [...call.joined],
      });
    }
    // Kimse açmadı: çalınanlara "cevapsız arama" (gelen arama bildiriminin yerini alır)
    if (call.joined.length <= 1 && call.rung.size > 0) {
      const dm = store.getDm(call.channelId);
      const missed = [...call.rung].filter(
        (id) =>
          !call.joined.includes(id) &&
          permissions.dmParticipants(call.channelId).includes(id) &&
          !permissions.hasBlocked(id, call.startedBy),
      );
      const to = gateway.pushRecipients(missed);
      if (dm && to.length > 0) void push.notifyMissedCall(dm, call.startedBy, call.messageId, to);
    }
  }

  // ---------- Çalma ----------

  private ringUsers(call: CallState, ringerId: string, targets: string[] | null): number {
    const { permissions, voice, gateway, push, store } = this.deps;
    const participants = permissions.dmParticipants(call.channelId);
    const inRoom = new Set(voice.membersOf(call.channelId));
    const candidates = (targets ?? participants).filter(
      (id) =>
        id !== ringerId &&
        participants.includes(id) &&
        !inRoom.has(id) &&
        permissions.can(id, Permission.VIEW_CHANNEL | Permission.CONNECT, call.channelId) &&
        !permissions.hasBlocked(id, ringerId) &&
        !permissions.hasBlocked(id, call.startedBy),
    );
    // Rahatsız Etmeyin: çalınmaz, bildirim de gitmez (aramayı konuşmada yine görür)
    const ringable = gateway.statuses.withoutDnd([...new Set(candidates)]);
    if (ringable.length === 0) return 0;
    for (const id of ringable) {
      clearTimeout(call.ringing.get(id));
      const timer = setTimeout(() => {
        if (call.ringing.get(id) !== timer) return;
        call.ringing.delete(id);
        call.ringAt.delete(id);
        if (this.calls.get(call.channelId) === call) this.announce(call);
      }, this.ringMs);
      timer.unref?.();
      call.ringing.set(id, timer);
      call.ringAt.set(id, this.now());
      call.rung.add(id);
    }
    this.announce(call);
    const dm = store.getDm(call.channelId);
    const to = gateway.pushRecipients(ringable);
    if (dm && to.length > 0) void push.notifyCall(dm, ringerId, call.messageId, to);
    return ringable.length;
  }

  private stopRinging(call: CallState, userId: string): boolean {
    const timer = call.ringing.get(userId);
    if (!timer) return false;
    clearTimeout(timer);
    call.ringing.delete(userId);
    call.ringAt.delete(userId);
    return true;
  }

  private toPayload(call: CallState): DmCall {
    return {
      channelId: call.channelId,
      startedBy: call.startedBy,
      startedAt: call.startedAt,
      ringing: [...call.ringing.keys()],
      ringStartedAt: Object.fromEntries(call.ringAt),
      messageId: call.messageId,
    };
  }

  private announce(call: CallState): void {
    this.deps.gateway.sendDm(this.deps.permissions.dmParticipants(call.channelId), {
      t: 'DM_CALL_UPDATE',
      d: this.toPayload(call),
    });
  }
}
