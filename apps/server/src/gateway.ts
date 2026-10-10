import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  CLIENT_FEATURE_DM,
  CLIENT_FEATURE_PRESENCE,
  CLIENT_FEATURE_VOICE_TRACE,
  OFFLINE_PRESENCE,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  GATEWAY_CLOSE_UPDATE_REQUIRED,
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  Permission,
  STREAM_WATCH_MAX,
  sameActivities,
  sortRoles,
  type Activity,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type GuildCreatePayload,
  type GuildData,
  type ClientPlatform,
  type DmCall,
  type Presence,
  type PresenceStatus,
  type ReadStateUpdate,
  type ServerFeatures,
  type User,
  type VoiceTraceRequest,
} from '@diskort/shared';
import type { GatewayTraffic } from './apiStats.js';
import type { AuthService } from './auth.js';
import type { ClientVersionPolicy } from './clientVersion.js';
import { knowsCosmeticPacks, withoutPackCosmetics } from './cosmeticCompat.js';
import type { Store } from './db.js';
import type { PermissionService } from './permissions.js';
import { StatusStore, combineActivities, mergeActivities, parseActivityReports } from './presence.js';
import type { VoiceStateStore } from './voiceState.js';

const IDENTIFY_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
/** Aynı kanal için "yazıyor" bildirimleri arasındaki en kısa süre (sel koruması) */
const TYPING_MIN_INTERVAL_MS = 1_000;
/** Boşta ve ses (susturma/sağırlaştırma) durumu: art arda en fazla bu kadar anında uygulanır... */
const STATE_BURST = 5;
/** ...sonra en fazla bu aralıkla bir tane (fazlası birleştirilir; en son istenen durum mutlaka uygulanır) */
const STATE_MIN_INTERVAL_MS = 500;
/** Kapatılan (ör. oturumu iptal edilen) bağlantı bu sürede kapanma el sıkışmasını bitirmezse koparılır */
const CLOSE_GRACE_MS = 2_000;
/** Etkinlik listesi seyrek değişir (oyun açılır/kapanır): art arda en fazla bu kadar anında uygulanır... */
const ACTIVITY_BURST = 3;
/** ...sonra en fazla bu aralıkla bir tane (her değişiklik ortak sunuculardaki herkese yayılır) */
const ACTIVITY_MIN_INTERVAL_MS = 5_000;

/**
 * Sel koruması, son durumu kaybetmeden: kova doluyken değer hemen uygulanır; boşken yalnızca en son değer
 * saklanır ve kovada yer açılınca uygulanır (ara değerler atlanır). Böylece sık değişiklikler yayını
 * sınırlar ama kullanıcının son hâli (ör. susturmayı açması) asla kaybolmaz.
 */
export class Coalescer<T> {
  private tokens: number;
  private at: number;
  private pending: { value: T } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly apply: (value: T) => void,
    private readonly burst = STATE_BURST,
    private readonly intervalMs = STATE_MIN_INTERVAL_MS,
  ) {
    this.tokens = burst;
    this.at = Date.now();
  }

  push(value: T): void {
    this.refill();
    if (!this.timer && this.tokens >= 1) {
      this.tokens--;
      this.apply(value);
      return;
    }
    this.pending = { value };
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), Math.ceil((1 - this.tokens) * this.intervalMs));
      this.timer.unref?.();
    }
  }

  /** Bekleyen değer atılır (oturum kapandı) */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / this.intervalMs);
    this.at = now;
  }

  private flush(): void {
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.refill();
    this.tokens--; // zamanlayıcı biraz erken çalışmışsa hafif eksiye düşebilir; sonraki bekleme uzar
    this.apply(pending.value);
  }
}

interface Session {
  socket: WebSocket;
  userId: string | null;
  /** IDENTIFY'da kullanılan oturum jetonu (şifre değişince bu cihazın bağlantısı açık kalır) */
  token: string | null;
  /** IDENTIFY sürüyor (ikinci bir IDENTIFY yok sayılır) */
  identifying: boolean;
  /** Oturum kapandı ya da iptal edildi: artık hiçbir mesajı işlenmez, hiçbir listede yer almaz */
  closed: boolean;
  alive: boolean;
  /** Boşta bildirimi sel koruması */
  idleUpdates: Coalescer<boolean>;
  /** Ses durumu (susturma/sağırlaştırma) sel koruması */
  voiceUpdates: Coalescer<{ selfMute: boolean; selfDeaf: boolean }>;
  /** İzlenen yayınlar bildirimi sel koruması */
  watchUpdates: Coalescer<unknown[]>;
  /** Etkinlik bildirimi sel koruması */
  activityUpdates: Coalescer<Activity[]>;
  /** Bağlantının kimliği (izleme istekleri bağlantı başına tutulur) */
  id: string;
  /** Bu bağlantı izlediği yayınları bildirdi (kapanınca isteği silinir) */
  reportsWatching: boolean;
  /** Kanal başına son "yazıyor" bildirimi (sel koruması) */
  lastTyping: Map<string, number>;
  /** İstemci direkt mesajları tanıyor (IDENTIFY'da bildirdi); tanımayana DM verisi ve olayı gitmez */
  dm: boolean;
  /** İstemci kozmetik paketlerini tanıyor (IDENTIFY'da bildirdi); tanımayana yalnızca yerleşik set kimlikleri gider */
  packs: boolean;
  /** İstemci olay kaydı isteğini tanıyor (IDENTIFY'da bildirdi); tanımayana VOICE_TRACE_REQUEST gitmez */
  trace: boolean;
  /** İstemcinin bildirdiği platform (bildirmeyen eski masaüstü sürümleri 'desktop') */
  platform: ClientPlatform;
  /** İstemcinin bildirdiği uygulama sürümü (yönetim paneli için) */
  version: string | null;
  /** Bağlantının açıldığı an */
  connectedAt: number;
  /** İstemci boşta olduğunu bildirebiliyor (CLIENT_FEATURE_PRESENCE) */
  reportsIdle: boolean;
  /** Oturum boşta (masaüstünde girdi yok / ekran kilitli, telefonda uygulama arka planda) */
  idle: boolean;
  /** Bu cihazda açık oyunlar, en son başlayan ilk sırada (yalnızca bellekte; bağlantı kapanınca kaybolur) */
  activities: Activity[];
}

type IdentifyData = Extract<GatewayClientMessage, { t: 'IDENTIFY' }>['d'];

const OFFLINE_KEY = JSON.stringify(OFFLINE_PRESENCE);
/** Son bağlantısı kapanan hesap bu süre içinde yeniden bağlanırsa "yeniden bağlanma" sayılır */
const RECONNECT_WINDOW_MS = 60_000;

/** Kullanıcı → gördüğü kanallar (yetki değişikliğinden önceki durum) */
export type Visibility = Map<string, Set<string>>;

/**
 * Gerçek zamanlı olay kanalı: kanal/kullanıcı/ses durumu değişikliklerini bağlı istemcilere iletir
 * (Discord "gateway" benzeri). Her olay yalnızca onu görmesi gerekenlere gider: bir kanala ait olaylar
 * (mesajlar, tepkiler, "yazıyor", ses durumları, kanalın kendisi) o kanalı görebilenlere, bir sunucuya ait
 * olaylar (üyeler, roller, sunucunun kendisi) o sunucunun üyelerine, profil ve çevrimiçi bilgisi ortak
 * sunucusu (ya da direkt mesaj konuşması) olanlara.
 */
export class Gateway {
  private readonly sessions = new Set<Session>();
  private readonly byUser = new Map<string, Set<Session>>();
  private pingTimer: NodeJS.Timeout | null = null;
  /** Sunucu kapanıyor: kapanan bağlantılar için artık veritabanına bakılmaz */
  private closing = false;
  /** Kullanıcı → en son duyurulan durum (JSON); çevrimdışı görünenler yok. Aynı durum tekrar duyurulmaz. */
  private readonly announced = new Map<string, string>();
  /** Yönetim paneli: mesaj ve bağlantı sayaçları (sunucu açıldığından beri) */
  readonly traffic: GatewayTraffic = {
    messagesIn: 0,
    messagesOut: 0,
    bytesOut: 0,
    connections: 0,
    identified: 0,
    reconnects: 0,
    authFailures: 0,
    updateRequired: 0,
    closes: {},
  };
  /** Hesap → son bağlantısının kapandığı an (yeniden bağlanma sayımı) */
  private readonly lastClosed = new Map<string, number>();
  /** Kullanıcının konuşmalarındaki süren aramalar (READY); arama hizmeti kurulunca bağlanır */
  callsFor: ((userId: string) => DmCall[]) | null = null;
  /** Bağlantılara verilen sıra numarası (izleme isteklerinin kaynağı) */
  private nextSessionId = 0;

  constructor(
    private readonly store: Store,
    private readonly auth: AuthService,
    private readonly voice: VoiceStateStore,
    private readonly permissions: PermissionService,
    private readonly clientVersions?: ClientVersionPolicy,
    private readonly attachmentMaxBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
    private readonly features: ServerFeatures = { gifs: false },
    readonly statuses: StatusStore = new StatusStore(store),
    /** Sunucuda saklanan etkinlik ikonları (olmayan ikon bildirilirse etkinlik ikonsuz görünür) */
    private readonly activityIcons: { has(key: string): boolean } = { has: () => false },
  ) {
    // Kişi kendi ses durumunu her zaman alır (kanalı görme yetkisini kaybedip çıkarılırken de)
    voice.on('update', (state) =>
      this.dispatchChannel(state.channelId, { t: 'VOICE_STATE_UPDATE', d: state }, { include: state.userId }),
    );
    voice.on('delete', (d) => this.dispatchChannel(d.channelId, { t: 'VOICE_STATE_DELETE', d }, { include: d.userId }));
  }

  register(app: FastifyInstance): void {
    app.get('/gateway', { websocket: true }, (socket) => this.accept(socket));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    app.addHook('onClose', async () => {
      this.closing = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      for (const s of this.sessions) s.socket.terminate();
    });
  }

  /** Gateway'e bağlı (görünmez olsa da) */
  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  /**
   * Kullanıcının başkalarına görünen durumu: bağlı değilse ya da görünmezse çevrimdışı. Seçtiği durum
   * "Çevrim içi" iken tüm oturumları boştaysa "Boşta" (bir cihazda etkin olmak otomatik boştayı yener);
   * elle seçilen Boşta / Rahatsız Etmeyin olduğu gibi kalır. Etkinlikler, oturumlarının bildirdiklerinin
   * birleşimidir (bkz. combineActivities); görünmez kullanıcınınkiler de görünmez. Bütün oturumları telefondaysa
   * `mobile: true` (masaüstünde de bağlıysa alan hiç yok: eski istemciler ve testler aynı nesneyi görür).
   */
  presenceOf(userId: string): Presence {
    const sessions = this.byUser.get(userId);
    if (!sessions || sessions.size === 0) return OFFLINE_PRESENCE;
    const self = this.statuses.get(userId);
    if (self.status === 'invisible') return OFFLINE_PRESENCE;
    let status: PresenceStatus = self.status;
    if (status === 'online' && [...sessions].every((s) => s.idle)) status = 'idle';
    const activities = combineActivities([...sessions].map((s) => s.activities));
    const mobile = [...sessions].every((s) => s.platform !== 'desktop');
    return { status, customStatus: self.customStatus, activities, ...(mobile ? { mobile: true } : {}) };
  }

  /** Başkalarına çevrimiçi görünüyor (bağlı ve görünmez değil) */
  isVisible(userId: string): boolean {
    return this.presenceOf(userId).status !== 'offline';
  }

  /** Verilen kişilerden çevrimiçi görünenlerin durumları */
  private presences(userIds: Iterable<string>): Record<string, Presence> {
    const result: Record<string, Presence> = {};
    for (const id of userIds) {
      if (!this.byUser.has(id)) continue;
      const p = this.presenceOf(id);
      if (p.status !== 'offline') result[id] = p;
    }
    return result;
  }

  /**
   * Kullanıcının durum ayarı değişti (kendisi değiştirdi ya da süresi doldu): tüm cihazlarına yeni ayar,
   * görünen durumu değiştiyse onu görebilenlere PRESENCE_UPDATE.
   */
  statusChanged(userId: string): void {
    this.sendToUsers([userId], { t: 'USER_STATUS_UPDATE', d: this.statuses.get(userId) });
    this.announcePresence(userId);
  }

  /** Süresi dolan durumları ve özel durumları temizler (düzenli aralıkla çağrılır) */
  expireStatuses(now = Date.now()): void {
    if (this.closing) return;
    for (const id of this.statuses.expire(now)) this.statusChanged(id);
  }

  /**
   * Kişi şu an masaüstünde etkin mi: boşta olduğunu bildirebilen (yeni) bir masaüstü oturumu açık ve boşta
   * değil. Öyleyse mesajı zaten canlı görüyor; telefonuna bildirim gitmez. Boşta bildirmeyen eski masaüstü
   * sürümleri sayılmaz (tepside açık kalan uygulama bildirimleri sonsuza dek kesmesin).
   */
  activeOnDesktop(userId: string): boolean {
    for (const s of this.byUser.get(userId) ?? []) {
      if (s.platform === 'desktop' && s.reportsIdle && !s.idle) return true;
    }
    return false;
  }

  /**
   * Telefon bildirimi gidecekler: Rahatsız Etmeyin'de olanlar (hiç bildirim yok) ve o an masaüstünde etkin
   * olanlar çıkarılır. Okunmamış sayıları ve bahsetme sayıları bundan etkilenmez.
   */
  pushRecipients(userIds: string[]): string[] {
    return this.statuses.withoutDnd(userIds).filter((id) => !this.activeOnDesktop(id));
  }

  /**
   * Kullanıcının açık bağlantılarını kapatır (4004: istemci oturumu kapatır). `exceptToken` verilirse o
   * jetonla bağlanmış oturumlar (şifreyi değiştiren cihaz) açık kalır. Oturumlar hemen listelerden düşer
   * (çevrimdışı duyurulur, olay almaz); karşı taraf kapanmayı onaylamazsa bağlantı kısa süre sonra koparılır.
   */
  disconnectUser(userId: string, reason: string, opts: { exceptToken?: string } = {}): void {
    for (const s of [...(this.byUser.get(userId) ?? [])]) {
      if (opts.exceptToken !== undefined && s.token === opts.exceptToken) continue;
      this.send(s, { t: 'INVALID_SESSION', d: { reason } });
      this.drop(s);
      s.socket.close(4004, 'session revoked');
      const socket = s.socket;
      setTimeout(() => {
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      }, CLOSE_GRACE_MS).unref?.();
    }
  }

  /** Tüm bağlı istemcilere gönderir (yalnızca herkesi ilgilendiren olaylar: ör. yeni sürüm). */
  broadcast(msg: GatewayServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.sessions) {
      if (!s.userId) continue;
      if (s.socket.readyState === s.socket.OPEN) this.out(s, data);
    }
  }

  /**
   * Yalnızca kanalı görebilen kullanıcılara gönderir. Direkt mesaj konuşmasında bu, katılımcılardır (ve
   * yalnızca DM'leri tanıyan istemcileri).
   */
  dispatchChannel(
    channelId: string,
    msg: GatewayServerMessage,
    opts: { except?: string; include?: string } = {},
  ): void {
    const data = JSON.stringify(msg);
    const allowed = new Map<string, boolean>();
    const dm = this.permissions.isDm(channelId);
    for (const s of this.sessions) {
      if (!s.userId || s.userId === opts.except || (dm && !s.dm)) continue;
      let ok = allowed.get(s.userId);
      if (ok === undefined) {
        ok = s.userId === opts.include || this.permissions.canView(s.userId, channelId);
        allowed.set(s.userId, ok);
      }
      if (ok && s.socket.readyState === s.socket.OPEN) this.out(s, data);
    }
  }

  /** Belirli kullanıcılara gönderir (ör. kanal silinmeden önce onu görebilenler). */
  sendToUsers(userIds: Iterable<string>, msg: GatewayServerMessage): void {
    const data = JSON.stringify(msg);
    for (const userId of new Set(userIds)) {
      for (const s of this.byUser.get(userId) ?? []) {
        if (s.socket.readyState === s.socket.OPEN) this.out(s, data);
      }
    }
  }

  /** Sunucunun şu anki üyelerine gönderir */
  sendToGuild(guildId: string, msg: GatewayServerMessage, exceptUserId?: string): void {
    this.sendToUsers(
      this.store.guildMemberIds(guildId).filter((id) => id !== exceptUserId),
      msg,
    );
  }

  /** Profil değişikliği: kullanıcıyı görebilen herkese (ortak sunucu, eski üyelik ya da DM) */
  sendUserUpdate(user: User): void {
    this.sendToUsers(this.store.observerIds(user.id), { t: 'USER_UPDATE', d: user });
  }

  /** Direkt mesaj olayını (DM_CHANNEL_*) belirli kullanıcıların DM'leri tanıyan oturumlarına gönderir. */
  sendDm(userIds: Iterable<string>, msg: GatewayServerMessage): void {
    const data = JSON.stringify(msg);
    for (const userId of new Set(userIds)) {
      for (const s of this.byUser.get(userId) ?? []) {
        if (s.dm && s.socket.readyState === s.socket.OPEN) this.out(s, data);
      }
    }
  }

  /** Engellediklerin listesi değişti: yalnızca engelleyenin kendi oturumlarına (tam liste) */
  sendBlocks(userId: string): void {
    this.sendToUsers([userId], { t: 'USER_BLOCKS_UPDATE', d: { userIds: this.store.blockedUserIds(userId) } });
  }

  /** Arkadaş listesi ya da istekler değişti: verilen kullanıcıların her birine kendi güncel listesi (tam liste) */
  sendFriends(userIds: Iterable<string>): void {
    for (const userId of new Set(userIds)) {
      if (!this.byUser.has(userId)) continue;
      this.sendToUsers([userId], { t: 'FRIENDS_UPDATE', d: this.store.listFriends(userId) });
    }
  }

  /**
   * İki kişinin arkadaşlığı kuruldu ya da kalktı: ikisine güncel listeleri; birbirini hâlâ görüyorlarsa (ortak
   * sunucu ya da arkadaşlık) çevrimiçi durumları, artık görmüyorlarsa "çevrimdışı" (bkz. announceLeave).
   * Görünmez olanın durumu hiç gönderilmez (zaten çevrimdışı görünür).
   */
  friendshipChanged(a: string, b: string): void {
    this.sendFriends([a, b]);
    const linked = this.permissions.canReach(a, b);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!this.isVisible(from)) continue;
      const presence = linked ? this.presenceOf(from) : OFFLINE_PRESENCE;
      this.sendToUsers([to], { t: 'PRESENCE_UPDATE', d: { userId: from, online: linked, ...presence } });
    }
  }

  /**
   * Olay kaydı isteği (bkz. traceRequests.ts): verilen kullanıcıların yalnızca isteği tanıyan oturumlarına
   * gider. Seste olmayan cihaz (ör. aynı hesabın telefonu) isteği yok sayar. Dönen: gönderilen oturum sayısı.
   */
  sendVoiceTraceRequest(userIds: Iterable<string>, d: VoiceTraceRequest): number {
    const data = JSON.stringify({ t: 'VOICE_TRACE_REQUEST', d } satisfies GatewayServerMessage);
    let sent = 0;
    for (const userId of new Set(userIds)) {
      for (const s of this.byUser.get(userId) ?? []) {
        if (!s.trace || s.socket.readyState !== s.socket.OPEN) continue;
        this.out(s, data);
        sent++;
      }
    }
    return sent;
  }

  /**
   * Okunma durumu ilerledi: kullanıcının bütün oturumlarına (onaylayan cihaz dahil; olay tekrarlansa da
   * zararsızdır). Direkt mesaj konuşmasındaysa yalnızca DM'leri tanıyan oturumlara.
   */
  sendReadState(userId: string, update: ReadStateUpdate | null): void {
    if (!update) return;
    const msg: GatewayServerMessage = { t: 'READ_STATE_UPDATE', d: update };
    if (this.permissions.isDm(update.channelId)) this.sendDm([userId], msg);
    else this.sendToUsers([userId], msg);
  }

  /** Bağlı kullanıcıların kimlikleri */
  connectedUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  /** Kimliği doğrulanmış açık bağlantılar (yönetim paneli: platform, sürüm, boşta mı) */
  sessionsInfo(): { userId: string; platform: ClientPlatform; version: string | null; idle: boolean; connectedAt: number }[] {
    const result = [];
    for (const s of this.sessions) {
      if (!s.userId) continue;
      result.push({ userId: s.userId, platform: s.platform, version: s.version, idle: s.idle, connectedAt: s.connectedAt });
    }
    return result;
  }

  /** Bağlı kullanıcıların şu an gördüğü kanallar; yetkileri değiştirmeden önce alınır (bkz. syncVisibility). */
  visibility(): Visibility {
    const result: Visibility = new Map();
    for (const userId of this.byUser.keys()) result.set(userId, this.permissions.visibleChannelIds(userId));
    return result;
  }

  /**
   * Yetki değişikliğinden sonra her bağlı kullanıcının görünümünü günceller: görmeyi kaybettiği kanal
   * için CHANNEL_DELETE (+ oradaki ses durumlarının silinmesi), yeni gördüğü kanal için CHANNEL_CREATE
   * (+ oradaki ses durumları). `updated` kanallar (izinleri değişen) görmeye devam edenlere CHANNEL_UPDATE
   * olarak gider.
   */
  syncVisibility(before: Visibility, updated: Iterable<string> = []): void {
    const updatedIds = new Set(updated);
    const states = this.voice.list();
    for (const userId of this.byUser.keys()) {
      const prev = before.get(userId);
      if (!prev) continue; // değişiklik sırasında bağlandı: READY zaten güncel
      const next = this.permissions.visibleChannelIds(userId);
      const out: GatewayServerMessage[] = [];
      for (const id of prev) {
        if (next.has(id)) continue;
        for (const v of states) {
          if (v.channelId === id && v.userId !== userId) {
            out.push({ t: 'VOICE_STATE_DELETE', d: { userId: v.userId, channelId: id } });
          }
        }
        out.push({ t: 'CHANNEL_DELETE', d: { id } });
      }
      for (const id of next) {
        const channel = this.permissions.channel(id);
        if (!channel) continue;
        if (!prev.has(id)) {
          out.push({ t: 'CHANNEL_CREATE', d: channel });
          for (const v of states) if (v.channelId === id) out.push({ t: 'VOICE_STATE_UPDATE', d: v });
        } else if (updatedIds.has(id)) {
          out.push({ t: 'CHANNEL_UPDATE', d: channel });
        }
      }
      for (const msg of out) this.sendToUsers([userId], msg);
    }
  }

  /** Sunucunun kullanıcıya görünen hâli: görebildiği kanallar, roller, üyeler */
  guildData(guildId: string, userId: string): GuildData | null {
    const guild = this.store.getGuild(guildId);
    if (!guild) return null;
    return {
      guild,
      channels: this.permissions.visibleChannels(guildId, userId),
      roles: sortRoles(this.store.guildRoles(guildId)),
      members: this.store.listMembers(guildId),
    };
  }

  /**
   * Kullanıcı sunucuya katıldı (ya da kurdu): kendisine sunucunun tamamı (GUILD_CREATE), diğer üyelere
   * yeni üye (GUILD_MEMBER_ADD ve çevrimiçiyse PRESENCE_UPDATE).
   */
  announceJoin(guildId: string, userId: string): void {
    const payload = this.guildCreatePayload(guildId, userId);
    if (!payload) return;
    this.sendToUsers([userId], { t: 'GUILD_CREATE', d: payload });
    const member = this.store.getMember(guildId, userId);
    const user = this.store.getUser(userId);
    if (!member || !user) return;
    this.sendToGuild(guildId, { t: 'GUILD_MEMBER_ADD', d: { guildId, member, user } }, userId);
    const presence = this.presenceOf(userId);
    if (presence.status !== 'offline') {
      this.sendToGuild(guildId, { t: 'PRESENCE_UPDATE', d: { userId, online: true, ...presence } }, userId);
    }
  }

  /**
   * Kullanıcı sunucudan çıktı (ayrıldı, atıldı, yasaklandı): kendisinin listesinden kalkar (GUILD_DELETE),
   * diğer üyeler eski üye olarak görür (GUILD_MEMBER_REMOVE).
   */
  announceLeave(guildId: string, userId: string, reason?: string): void {
    this.sendToUsers([userId], { t: 'GUILD_DELETE', d: { id: guildId, ...(reason ? { reason } : {}) } });
    this.sendToGuild(guildId, { t: 'GUILD_MEMBER_REMOVE', d: { guildId, userId } }, userId);
    // Artık ortak sunucusu (ya da arkadaşlığı) kalmayanlar birbirinin çevrimiçi durumunu görmez: son bilinen
    // durum "çevrimdışı"
    const still = this.permissions.contacts(userId);
    const parted = this.store.guildMemberIds(guildId).filter((id) => !still.has(id));
    const offline = { online: false, ...OFFLINE_PRESENCE };
    if (this.isVisible(userId)) this.sendToUsers(parted, { t: 'PRESENCE_UPDATE', d: { userId, ...offline } });
    for (const id of parted) {
      if (this.isVisible(id)) this.sendToUsers([userId], { t: 'PRESENCE_UPDATE', d: { userId: id, ...offline } });
    }
  }

  /** Üyenin rolleri değişti */
  announceMember(guildId: string, userId: string): void {
    const member = this.store.getMember(guildId, userId);
    if (member) this.sendToGuild(guildId, { t: 'GUILD_MEMBER_UPDATE', d: { guildId, member } });
  }

  private guildCreatePayload(guildId: string, userId: string): GuildCreatePayload | null {
    const data = this.guildData(guildId, userId);
    if (!data) return null;
    const visible = new Set(data.channels.map((c) => c.id));
    const onlyVisible = <T>(byChannel: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(byChannel).filter(([channelId]) => visible.has(channelId)));
    const memberIds = data.members.map((m) => m.userId);
    const current = new Set(data.members.filter((m) => !m.removed).map((m) => m.userId));
    const presences = this.presences(current);
    return {
      ...data,
      users: this.store.usersByIds(memberIds),
      voiceStates: this.voice.list().filter((v) => visible.has(v.channelId)),
      online: Object.keys(presences),
      presences,
      lastMessageIds: onlyVisible(this.store.lastMessageIds()),
      readStates: onlyVisible(this.store.readStates(userId)),
      mentionCounts: onlyVisible(this.store.mentionCounts(userId)),
    };
  }

  private send(s: Session, msg: GatewayServerMessage): void {
    if (s.socket.readyState === s.socket.OPEN) this.out(s, JSON.stringify(msg));
  }

  /**
   * Son giden mesajın eski istemcilere uygun hali: aynı mesaj art arda birçok oturuma gider, metin bir kez
   * taranır (süzülecek bir şey yoksa "aynısı" sonucu da hatırlanır).
   */
  private lastLegacy: { full: string; legacy: string } | null = null;

  /**
   * Tek giden mesaj (sayılarak). Kozmetik paketlerini tanımayan eski istemciye kullanıcıların set seçimlerinde
   * yalnızca yerleşik kimlikler gider (bkz. cosmeticCompat.ts). Karar yalnızca giden metne bakar, o anki paket
   * listesine değil: kullanıcı serileştirildikten sonra paket yayından kalksa da tanınmayan kimlik sızmaz.
   */
  private out(s: Session, data: string): void {
    if (!s.packs) {
      if (this.lastLegacy?.full !== data) this.lastLegacy = { full: data, legacy: withoutPackCosmetics(data) };
      data = this.lastLegacy.legacy;
    }
    this.traffic.messagesOut++;
    this.traffic.bytesOut += data.length;
    s.socket.send(data);
  }

  /** Açık WebSocket bağlantıları (kimliği doğrulanmamışlar dahil) */
  openSockets(): number {
    return this.sessions.size;
  }

  private accept(socket: WebSocket): void {
    const session: Session = {
      socket,
      userId: null,
      token: null,
      identifying: false,
      closed: false,
      alive: true,
      idleUpdates: new Coalescer((idle) => {
        if (session.closed || !session.userId || session.idle === idle) return;
        session.idle = idle;
        this.announcePresence(session.userId);
      }),
      voiceUpdates: new Coalescer((flags) => {
        if (!session.closed && session.userId) this.voice.setSelf(session.userId, flags);
      }),
      watchUpdates: new Coalescer((userIds) => {
        if (session.closed || !session.userId) return;
        session.reportsWatching = true;
        this.voice.setWatching(session.userId, userIds, session.id);
      }),
      activityUpdates: new Coalescer(
        (reported) => {
          if (session.closed || !session.userId) return;
          // Önce bu oturumun önceki listesi, sonra kişinin öteki oturumları (yeniden bağlanmada eskisi düşmeden)
          const others = [...(this.byUser.get(session.userId) ?? [])].filter((o) => o !== session);
          const known = [session.activities, ...others.map((o) => o.activities)].flat();
          const activities = mergeActivities(known, reported);
          if (sameActivities(session.activities, activities)) return;
          session.activities = activities;
          this.announcePresence(session.userId);
        },
        ACTIVITY_BURST,
        ACTIVITY_MIN_INTERVAL_MS,
      ),
      id: String(++this.nextSessionId),
      reportsWatching: false,
      lastTyping: new Map(),
      dm: false,
      packs: false,
      trace: false,
      platform: 'desktop',
      version: null,
      connectedAt: Date.now(),
      reportsIdle: false,
      idle: false,
      activities: [],
    };
    this.sessions.add(session);
    this.traffic.connections++;
    this.send(session, { t: 'HELLO', d: { heartbeatInterval: GATEWAY_HEARTBEAT_INTERVAL_MS } });

    const identifyTimer = setTimeout(() => {
      if (!session.userId) socket.close(4001, 'identify timeout');
    }, IDENTIFY_TIMEOUT_MS);

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (raw) => {
      this.traffic.messagesIn++;
      if (session.closed) return;
      let msg: GatewayClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as GatewayClientMessage;
      } catch {
        socket.close(4002, 'invalid payload');
        return;
      }
      void this.handle(session, msg).catch(() => socket.close(4000, 'internal error'));
    });

    socket.on('close', (code) => {
      clearTimeout(identifyTimer);
      const key = String(code);
      this.traffic.closes[key] = (this.traffic.closes[key] ?? 0) + 1;
      this.drop(session);
    });
    // Hata sonrası da 'close' gelir; yine de oturum hemen düşsün
    socket.on('error', () => this.drop(session));
  }

  /**
   * Oturumu tüm listelerden çıkarır (tekrar çağrılması zararsızdır). Kullanıcının son oturumuysa çevrimdışı,
   * kalan oturumların hepsi boştaysa "Boşta" duyurulur; bu oturumun bildirdiği etkinlikler de kalkar.
   */
  private drop(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    session.idleUpdates.cancel();
    session.voiceUpdates.cancel();
    session.watchUpdates.cancel();
    session.activityUpdates.cancel();
    session.activities = [];
    this.sessions.delete(session);
    const userId = session.userId;
    if (!userId) return;
    // Bu bağlantının izleme isteği silinir (uygulama çöktü, ağ koptu); diğer cihazlarınki kalır. İstemci
    // yeniden bağlanınca (seste ise) yeniden bildirir: hayalet izleyici kalmaz.
    if (session.reportsWatching && !this.closing) this.voice.setWatching(userId, [], session.id);
    const set = this.byUser.get(userId);
    if (!set?.delete(session)) return;
    if (set.size === 0) {
      this.byUser.delete(userId);
      if (this.lastClosed.size > 5_000) this.lastClosed.clear();
      this.lastClosed.set(userId, Date.now());
    }
    this.announcePresence(userId);
  }

  /**
   * Görünen durum değiştiyse ortak sunucusu olanlara, arkadaşlarına (ve kişinin kendisine) duyurur. Görünmez kullanıcı
   * hep çevrimdışı görünür: bağlanması, boşta olması, özel durumu ya da etkinlikleri hiçbir olay üretmez.
   */
  private announcePresence(userId: string, except?: Session): void {
    if (this.closing) return;
    const presence = this.presenceOf(userId);
    const key = JSON.stringify(presence);
    if (key === (this.announced.get(userId) ?? OFFLINE_KEY)) return;
    if (presence.status === 'offline') this.announced.delete(userId);
    else this.announced.set(userId, key);
    const data = JSON.stringify({
      t: 'PRESENCE_UPDATE',
      d: { userId, online: presence.status !== 'offline', ...presence },
    } satisfies GatewayServerMessage);
    for (const id of this.permissions.contacts(userId)) {
      for (const s of this.byUser.get(id) ?? []) {
        if (s !== except && s.socket.readyState === s.socket.OPEN) this.out(s, data);
      }
    }
  }

  private async handle(s: Session, msg: GatewayClientMessage): Promise<void> {
    if (msg.t === 'IDENTIFY') {
      if (s.userId || s.identifying) return;
      s.identifying = true;
      try {
        await this.identifyMessage(s, msg.d);
      } finally {
        s.identifying = false;
      }
      return;
    }
    if (!s.userId) {
      s.socket.close(4003, 'not identified');
      return;
    }
    switch (msg.t) {
      case 'HEARTBEAT':
        this.send(s, { t: 'HEARTBEAT_ACK' });
        break;
      case 'VOICE_STATE_SET':
        s.voiceUpdates.push({ selfMute: Boolean(msg.d?.selfMute), selfDeaf: Boolean(msg.d?.selfDeaf) });
        break;
      case 'IDLE_SET':
        s.idleUpdates.push(Boolean(msg.d?.idle));
        break;
      case 'STREAM_WATCH_SET': {
        // Doğrulama ses durumunda: kendisi, aynı kanalda olmayanlar ve yayında olmayanlar görünmez
        const ids: unknown = msg.d?.userIds;
        s.watchUpdates.push(Array.isArray(ids) ? ids.slice(0, STREAM_WATCH_MAX * 2) : []);
        break;
      }
      case 'ACTIVITY_SET': {
        // Liste olmayan bildirim yok sayılır (önceki etkinlikler kalır); listedeki geçersiz öğeler atlanır
        const activities = parseActivityReports((msg.d as { activities?: unknown } | null)?.activities, (key) =>
          this.activityIcons.has(key),
        );
        if (activities) s.activityUpdates.push(activities);
        break;
      }
      case 'TYPING_START': {
        const channelId = String(msg.d?.channelId ?? '');
        const now = Date.now();
        if (now - (s.lastTyping.get(channelId) ?? 0) < TYPING_MIN_INTERVAL_MS) break;
        const dm = this.permissions.isDm(channelId);
        if (dm ? !s.dm : this.permissions.channel(channelId)?.type !== 'text') break;
        if (!this.permissions.can(s.userId, Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES, channelId)) break;
        s.lastTyping.set(channelId, now);
        this.dispatchChannel(channelId, { t: 'TYPING_START', d: { channelId, userId: s.userId } }, { except: s.userId });
        break;
      }
    }
  }

  /** Bağlantı hâlâ açık ve listede mi (beklemelerden sonra: bu arada kapanmış olabilir) */
  private live(s: Session): boolean {
    return !s.closed && this.sessions.has(s) && s.socket.readyState === s.socket.OPEN;
  }

  /**
   * IDENTIFY: sürüm ve jeton denetimi beklenirken bağlantı kapanabilir; kapandıysa oturum hiç açılmaz
   * (yoksa kapanmış bağlantı byUser'da kalır, kişi sonsuza dek çevrimiçi görünürdü).
   */
  private async identifyMessage(s: Session, d: IdentifyData): Promise<void> {
    // Zorunlu güncelleme: eski istemci önce güncellemeli (0.1.3 öncesi sürümler bu mesajı yok sayar
    // ve yeniden bağlanmayı dener; kendi güncelleyicileri yeni sürümü indirip kurar).
    const required = await this.clientVersions?.outdated(d?.version, d?.platform);
    if (!this.live(s)) return;
    if (required) {
      this.traffic.updateRequired++;
      this.send(s, { t: 'UPDATE_REQUIRED', d: { version: required } });
      s.socket.close(GATEWAY_CLOSE_UPDATE_REQUIRED, 'update required');
      return;
    }
    const token = typeof d?.token === 'string' ? d.token : '';
    const user = token ? await this.auth.userFromToken(token) : null;
    if (!this.live(s)) return;
    if (!user) {
      this.traffic.authFailures++;
      this.send(s, { t: 'INVALID_SESSION', d: { reason: 'Oturum geçersiz.' } });
      s.socket.close(4004, 'authentication failed');
      return;
    }
    const features = Array.isArray(d.features) ? d.features : [];
    s.dm = features.includes(CLIENT_FEATURE_DM);
    s.reportsIdle = features.includes(CLIENT_FEATURE_PRESENCE);
    s.packs = knowsCosmeticPacks(features);
    s.trace = features.includes(CLIENT_FEATURE_VOICE_TRACE);
    const platform = d.platform;
    s.platform = platform === 'android' || platform === 'ios' ? platform : 'desktop';
    s.version = typeof d.version === 'string' && d.version ? d.version.slice(0, 32) : null;
    s.token = token;
    this.identify(s, user);
  }

  private identify(s: Session, user: User): void {
    s.userId = user.id;
    this.traffic.identified++;
    const closedAt = this.lastClosed.get(user.id);
    if (closedAt !== undefined && Date.now() - closedAt <= RECONNECT_WINDOW_MS) this.traffic.reconnects++;
    this.lastClosed.delete(user.id);
    let set = this.byUser.get(user.id);
    if (!set) this.byUser.set(user.id, (set = new Set()));
    set.add(s);

    // Kullanıcı yalnızca üye olduğu sunucuları, oralarda görebildiği kanalları ve onlara ait bilgileri
    // alır. Direkt mesajlar ayrı alandadır ve yalnızca tanıyan istemciye gider.
    const guilds = this.store
      .userGuildIds(user.id)
      .map((id) => this.guildData(id, user.id))
      .filter((g): g is GuildData => g !== null);
    const dms = s.dm ? this.store.listDms(user.id) : undefined;
    const visible = new Set([
      ...guilds.flatMap((g) => g.channels.map((c) => c.id)),
      ...(dms ?? []).map((d) => d.id),
    ]);
    const onlyVisible = <T>(byChannel: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(byChannel).filter(([channelId]) => visible.has(channelId)));
    const contacts = this.permissions.contacts(user.id);
    const presences = this.presences([...this.byUser.keys()].filter((id) => contacts.has(id)));
    this.send(s, {
      t: 'READY',
      d: {
        user,
        guilds,
        users: this.store.usersByIds(this.store.visibleUserIds(user.id)),
        voiceStates: this.voice.list().filter((v) => visible.has(v.channelId)),
        online: Object.keys(presences),
        presences,
        status: this.statuses.get(user.id),
        primaryGuildId: this.permissions.primaryGuildId,
        lastMessageIds: onlyVisible(this.store.lastMessageIds()),
        readStates: onlyVisible(this.store.readStates(user.id)),
        mentionCounts: onlyVisible(this.store.mentionCounts(user.id)),
        attachmentMaxBytes: this.attachmentMaxBytes,
        features: this.features,
        ...(dms ? { dms, dmCalls: this.callsFor?.(user.id) ?? [] } : {}),
        blockedUserIds: this.store.blockedUserIds(user.id),
        friends: this.store.listFriends(user.id),
      },
    });
    // Yeni oturum kendi durumunu READY'de aldı
    this.announcePresence(user.id, s);
  }

  private pingAll(): void {
    for (const s of this.sessions) {
      if (!s.alive) {
        s.socket.terminate();
        continue;
      }
      s.alive = false;
      s.socket.ping();
    }
  }
}
