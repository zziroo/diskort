import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  compareVersions,
  FEEDBACK_STATUSES,
  type ClientPlatform,
  type FeedbackStatus,
  type StreamSourceKind,
  type User,
} from '@diskort/shared';
import type { ActivityTracker, ClientErrorEntry, ServerErrorEntry } from './activity.js';
import { latestMobile } from './clientVersion.js';
import type { AppContext } from './context.js';
import type { FeedbackStore } from './feedbackStore.js';
import type { LiveRoom, LiveTrack } from './livekit.js';
import type { LiveKitMetrics, LiveKitMetricsStatus } from './infraStats.js';
import { PRIVATE_CALL_NAME } from './privateCalls.js';
import type { SystemMonitor, SystemSample, SystemSnapshot } from './systemStats.js';
import type { TelemetryEntry, VoiceTelemetryStore } from './telemetry.js';

// Yönetim paneli (GET /api/admin/dashboard, yalnızca hesap yöneticilerine): kullanım, ses, sunucu yükü,
// istemci sürümleri, son hatalar ve geri bildirim özeti tek yanıtta. Pahalı parçalar önbelleklidir;
// panel birkaç saniyede bir sorar.

const DAY_MS = 86_400_000;
/** Mesaj grafiğindeki gün sayısı (bugün dahil) */
export const DASHBOARD_DAYS = 14;
/** Veritabanı sayımlarının önbellek süresi */
const DB_CACHE_MS = 30_000;
/** Klasör boyutlarının önbellek süresi (dosyalar tek tek sayılır) */
const DIR_CACHE_MS = 5 * 60_000;
/** LiveKit oda bilgisinin önbellek süresi ve en uzun bekleme */
const LIVEKIT_CACHE_MS = 4_000;
const LIVEKIT_TIMEOUT_MS = 2_500;
/** Klasör taramasında en fazla bakılan dosya (çok büyükse yaklaşık kalır) */
const DIR_SCAN_LIMIT = 20_000;
/** Yanıttaki en fazla hesap ve hata */
const USERS_LIMIT = 200;
const ERRORS_LIMIT = 50;

export interface DashboardVoiceParticipant {
  userId: string;
  user: User | null;
  joinedAt: number;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  streaming: boolean;
  streamStartedAt: number | null;
  streamSourceKind: StreamSourceKind | null;
  /** Bağlı cihazlarının platformları (gateway) */
  platforms: ClientPlatform[];
  /** LiveKit'te yayınladığı izler; LiveKit'e ulaşılamadıysa null */
  tracks: LiveTrack[] | null;
}

export interface DashboardVoiceChannel {
  channelId: string;
  name: string;
  guildId: string | null;
  guildName: string | null;
  /**
   * DM araması ("Özel arama"): channelId ve katılımcıların userId'si takma kimliktir, user null (yönetici
   * kimin kiminle konuştuğunu göremez; bkz. privateCalls.ts). Sunucu kanallarında gelmez.
   */
  private?: true;
  participants: DashboardVoiceParticipant[];
}

export interface DashboardUserActivity {
  user: User;
  /** Gateway'e bağlı (görünmez olsa da) */
  online: boolean;
  /** Şu an bağlı cihazları */
  devices: { platform: ClientPlatform; version: string | null; idle: boolean; since: number }[];
  /** En son bağlı görüldüğü an (bağlıysa şimdi); takip başlamadan önce bağlanmadıysa null */
  lastSeen: number | null;
  lastPlatform: ClientPlatform | null;
  lastVersion: string | null;
}

export interface AdminDashboard {
  generatedAt: number;
  overview: {
    users: number;
    admins: number;
    /** Gateway'e bağlı hesaplar */
    online: number;
    /** Açık gateway bağlantıları (bir hesabın birden çok cihazı olabilir) */
    sessions: number;
    /** Son 24 saatte / 7 günde bağlanan ya da mesaj yazan hesaplar */
    active24h: number;
    active7d: number;
    /** Bağlantı takibinin başladığı an (öncesi yalnızca mesaj yazanlardan bilinir) */
    activitySince: number;
    guilds: number;
    channels: { text: number; voice: number; dm: number };
    messages: {
      total: number;
      /** İstemcinin saat dilimine göre bugün */
      today: number;
      last24h: number;
      last7d: number;
      /** Son 14 gün, eskiden yeniye; `day` günün başı (ms) */
      perDay: { day: number; count: number }[];
    };
    storage: {
      /** Veritabanı (ve WAL) boyutu */
      database: number;
      /** Dosya eklerinin toplam boyutu (veritabanındaki kayıtlardan) */
      attachments: number;
      attachmentCount: number;
      /** Klasör boyutları; henüz ölçülmediyse null */
      avatars: number | null;
      feedback: number | null;
      linkPreviews: number | null;
    };
  };
  voice: {
    participants: number;
    streams: number;
    channels: DashboardVoiceChannel[];
    livekit: {
      ok: boolean;
      /** Oda listesinin alınma süresi */
      latencyMs: number | null;
      rooms: number;
      participants: number;
      /** Yayınlanan ses ve görüntü izleri */
      tracks: number;
      error: string | null;
    };
    /** Seste olanların son ses kalitesi özeti (istemci ölçümleri; son 90 sn) */
    quality: TelemetryEntry[];
    /** LiveKit'in Prometheus ölçümleri (son değerler; geçmiş /api/admin/infra'da) */
    metrics: Omit<LiveKitMetricsStatus, 'raw'> | null;
  };
  /** API sağlığının kısa özeti (ayrıntılar /api/admin/api-stats) */
  health: {
    requestsLastHour: number;
    errors5xxLastHour: number;
    limitedLastHour: number;
    openSockets: number;
    serverLogErrors: number;
  };
  system: SystemSnapshot & {
    process: { rss: number; heapUsed: number; heapTotal: number; uptimeSec: number; node: string };
    /** Son ölçümler (5 sn aralıklı), eskiden yeniye */
    history: SystemSample[];
  };
  clients: {
    /** Platforma göre açık bağlantılar */
    platforms: Record<ClientPlatform, number>;
    /** Platform ve sürüme göre açık bağlantılar; `current`: en son sürüm mü (bilinmiyorsa null) */
    versions: { platform: ClientPlatform; version: string | null; sessions: number; current: boolean | null }[];
    /** En son yayınlanan sürümler (GitHub'dan okunmadıysa null) */
    latest: Record<ClientPlatform, string | null>;
    /** Hesaplar: bağlı olanlar önce, sonra en son görülen */
    users: DashboardUserActivity[];
  };
  errors: {
    /** Sunucunun açıldığı an (kısa grafikler bu andan beri; hata kayıtları dosyadan geri yüklenir, daha eski olabilir) */
    since: number;
    client: { total: number; last24h: number; capped: boolean; recent: ClientErrorEntry[] };
    server: { total: number; last24h: number; capped: boolean; recent: ServerErrorEntry[] };
  };
  feedback: { counts: Record<FeedbackStatus, number>; total: number };
}

interface DbStats {
  users: User[];
  admins: number;
  guilds: number;
  guildNames: Map<string, string>;
  channels: { text: number; voice: number; dm: number };
  messages: AdminDashboard['overview']['messages'];
  authors24h: string[];
  authors7d: string[];
  database: number;
  attachments: number;
  attachmentCount: number;
}

type DirSizes = { avatars: number; feedback: number; linkPreviews: number };

interface LiveKitStatus {
  rooms: LiveRoom[] | null;
  latencyMs: number | null;
  error: string | null;
}

/** Kullanıcının saat dilimine göre (Date#getTimezoneOffset, dk) günün başı */
export function startOfDay(now: number, tzOffsetMin: number): number {
  const shift = tzOffsetMin * 60_000;
  return Math.floor((now - shift) / DAY_MS) * DAY_MS + shift;
}

/** Klasördeki dosyaların toplam boyutu (alt klasörler dahil; en fazla DIR_SCAN_LIMIT dosya) */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ >= DIR_SCAN_LIMIT) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('zaman aşımı')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface DashboardOptions {
  monitor: SystemMonitor;
  activity: ActivityTracker;
  feedback: FeedbackStore;
  /** Veritabanı dosyası (':memory:' olabilir; WAL boyutu için) */
  dbFile: string;
  dirs: { avatars: string; feedback: string; linkPreviews: string };
  /** Ses kalitesi özetleri (canlı tablo) */
  telemetry?: VoiceTelemetryStore;
  /** LiveKit'in Prometheus ölçümleri */
  livekitMetrics?: LiveKitMetrics;
}

export class DashboardService {
  private readonly startedAt = Date.now();
  private dbCache: { key: number; at: number; value: DbStats } | null = null;
  private dirCache: { at: number; value: DirSizes } | null = null;
  private dirInflight: Promise<DirSizes> | null = null;
  private liveCache: { at: number; value: LiveKitStatus } | null = null;
  private liveInflight: Promise<LiveKitStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: DashboardOptions,
  ) {}

  /** Düzenli ölçüm: sistem yükü (grafikler, aylık trafik) ve bağlı hesapların son görülme anı */
  start(intervalMs = 5_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.opts.monitor.persist(Date.now());
    await this.opts.activity.persist(Date.now(), true);
    await this.ctx.counters.persist(Date.now(), true);
  }

  async tick(now = Date.now()): Promise<void> {
    const { gateway, voice } = this.ctx;
    this.opts.activity.touch(gateway.sessionsInfo(), now);
    try {
      await this.opts.monitor.sample({ online: gateway.connectedUserIds().length, voice: voice.list().length }, now);
    } catch {
      // Ölçüm alınamadı; panel son bilineni gösterir
    }
    await this.opts.activity.persist(now);
    // API sağlığı: gateway mesaj hızı ve olay döngüsü gecikmesi; gün sayaçları dakikada bir dosyaya
    this.ctx.apiStats.sampleGateway(gateway.traffic, gateway.openSockets(), now);
    await this.ctx.counters.persist(now);
  }

  async build(tzOffsetMin = 0, now = Date.now()): Promise<AdminDashboard> {
    // Düzenli ölçüm çalışmıyorsa (testler) ya da gecikmişse şimdi ölç
    if (!this.opts.monitor.fresh(7_000, now)) await this.tick(now);
    else this.opts.activity.touch(this.ctx.gateway.sessionsInfo(), now);

    const [dirs, live, metrics] = await Promise.all([
      this.dirSizes(now),
      this.liveKit(now),
      this.opts.livekitMetrics?.status(now) ?? Promise.resolve(null),
    ]);
    const db = this.dbStats(tzOffsetMin, now);
    const { gateway, voice } = this.ctx;
    const sessions = gateway.sessionsInfo();
    const userIds = new Set(db.users.map((u) => u.id));

    // ---------- Genel bakış ----------
    const active = (since: number, authors: string[]): number =>
      new Set([...this.opts.activity.idsSince(since), ...authors].filter((id) => userIds.has(id))).size;

    // ---------- Ses ----------
    const liveTracks = new Map<string, LiveTrack[]>();
    for (const room of live.rooms ?? []) for (const p of room.participants) liveTracks.set(p.userId, p.tracks);
    const platformsOf = new Map<string, ClientPlatform[]>();
    for (const s of sessions) platformsOf.set(s.userId, [...(platformsOf.get(s.userId) ?? []), s.platform]);
    const usersById = new Map(db.users.map((u) => [u.id, u]));
    const byChannel = new Map<string, DashboardVoiceChannel>();
    const { privacy } = this.ctx;
    for (const state of voice.list()) {
      // DM araması: konuşma, adı ve katılımcıların kimliği gösterilmez (takma kimlikler; bkz. privateCalls.ts)
      const isPrivate = privacy.isPrivate(state.channelId);
      const channelId = privacy.channel(state.channelId);
      let entry = byChannel.get(channelId);
      if (!entry) {
        const channel = isPrivate ? null : this.ctx.store.getChannel(state.channelId);
        const guildId = channel?.guildId ?? null;
        entry = {
          channelId,
          name: isPrivate ? PRIVATE_CALL_NAME : (channel?.name ?? 'Bilinmeyen kanal'),
          guildId,
          guildName: guildId ? (db.guildNames.get(guildId) ?? null) : null,
          ...(isPrivate ? { private: true } : {}),
          participants: [],
        };
        byChannel.set(channelId, entry);
      }
      const userId = privacy.user(state.userId, state.channelId);
      entry.participants.push({
        userId,
        user: isPrivate ? null : (usersById.get(state.userId) ?? null),
        joinedAt: state.joinedAt,
        selfMute: state.selfMute,
        selfDeaf: state.selfDeaf,
        serverMute: state.serverMute,
        serverDeaf: state.serverDeaf,
        streaming: state.streaming,
        streamStartedAt: state.streamStartedAt ?? null,
        streamSourceKind: state.streamSourceKind ?? null,
        // Cihazlar ve LiveKit izleri DM aramasında da gösterilir (kimliksiz)
        platforms: [...new Set(platformsOf.get(state.userId) ?? [])],
        tracks: live.rooms ? (liveTracks.get(state.userId) ?? []) : null,
      });
    }
    const voiceChannels = [...byChannel.values()].sort(
      (a, b) => b.participants.length - a.participants.length || a.name.localeCompare(b.name, 'tr'),
    );
    for (const c of voiceChannels) c.participants.sort((a, b) => a.joinedAt - b.joinedAt);
    const states = voice.list();

    // ---------- İstemciler ----------
    const release = this.ctx.releases.known();
    const latest: Record<ClientPlatform, string | null> = {
      desktop: release?.version ?? null,
      android: release ? latestMobile(release, 'android').js : null,
      ios: release ? latestMobile(release, 'ios').js : null,
    };
    const platforms: Record<ClientPlatform, number> = { desktop: 0, android: 0, ios: 0 };
    const versionCounts = new Map<string, { platform: ClientPlatform; version: string | null; sessions: number }>();
    for (const s of sessions) {
      platforms[s.platform]++;
      const key = `${s.platform} ${s.version ?? ''}`;
      const v = versionCounts.get(key) ?? { platform: s.platform, version: s.version, sessions: 0 };
      v.sessions++;
      versionCounts.set(key, v);
    }
    const versions = [...versionCounts.values()]
      .map((v) => {
        const newest = latest[v.platform];
        return { ...v, current: v.version && newest ? compareVersions(v.version, newest) >= 0 : null };
      })
      .sort(
        (a, b) =>
          a.platform.localeCompare(b.platform) ||
          compareVersions(b.version ?? '0.0.0', a.version ?? '0.0.0') ||
          b.sessions - a.sessions,
      );
    const devicesOf = new Map<string, DashboardUserActivity['devices']>();
    for (const s of sessions) {
      const list = devicesOf.get(s.userId) ?? [];
      list.push({ platform: s.platform, version: s.version, idle: s.idle, since: s.connectedAt });
      devicesOf.set(s.userId, list);
    }
    const users: DashboardUserActivity[] = db.users.map((user) => {
      const devices = devicesOf.get(user.id) ?? [];
      const seen = this.opts.activity.get(user.id);
      const online = devices.length > 0;
      return {
        user,
        online,
        devices,
        lastSeen: online ? now : (seen?.at ?? null),
        lastPlatform: seen?.platform ?? null,
        lastVersion: seen?.version ?? null,
      };
    });
    users.sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (b.lastSeen ?? 0) - (a.lastSeen ?? 0) ||
        a.user.displayName.localeCompare(b.user.displayName, 'tr'),
    );

    // ---------- Hatalar ----------
    const { client, server } = this.ctx.errors;
    const clientDay = client.countSince(now - DAY_MS);
    const serverDay = server.countSince(now - DAY_MS);

    // ---------- Geri bildirim ----------
    const counts = this.opts.feedback.countByStatus();

    const { system, history } = this.opts.monitor.snapshot();
    const mem = process.memoryUsage();
    return {
      generatedAt: now,
      overview: {
        users: db.users.length,
        admins: db.admins,
        online: gateway.connectedUserIds().length,
        sessions: sessions.length,
        active24h: active(now - DAY_MS, db.authors24h),
        active7d: active(now - 7 * DAY_MS, db.authors7d),
        activitySince: this.opts.activity.since,
        guilds: db.guilds,
        channels: db.channels,
        messages: db.messages,
        storage: {
          database: db.database,
          attachments: db.attachments,
          attachmentCount: db.attachmentCount,
          avatars: dirs?.avatars ?? null,
          feedback: dirs?.feedback ?? null,
          linkPreviews: dirs?.linkPreviews ?? null,
        },
      },
      voice: {
        participants: states.length,
        streams: states.filter((s) => s.streaming).length,
        channels: voiceChannels,
        livekit: {
          ok: live.rooms !== null,
          latencyMs: live.latencyMs,
          rooms: live.rooms?.length ?? 0,
          participants: live.rooms?.reduce((n, r) => n + r.participants.length, 0) ?? 0,
          tracks: live.rooms?.reduce((n, r) => n + r.participants.reduce((m, p) => m + p.tracks.length, 0), 0) ?? 0,
          error: live.error,
        },
        quality: this.opts.telemetry?.liveEntries(now) ?? [],
        metrics: metrics ? (({ raw: _raw, ...rest }) => rest)(metrics) : null,
      },
      health: (() => {
        const hour = this.ctx.apiStats.lastHour(now);
        return {
          requestsLastHour: hour.total,
          errors5xxLastHour: hour.s5,
          limitedLastHour: hour.limited,
          openSockets: gateway.openSockets(),
          serverLogErrors: this.ctx.apiStats.logs.total,
        };
      })(),
      system: {
        ...system,
        process: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          uptimeSec: Math.round(process.uptime()),
          node: process.version,
        },
        history,
      },
      clients: { platforms, versions, latest, users: users.slice(0, USERS_LIMIT) },
      errors: {
        since: this.startedAt,
        client: { total: client.total, last24h: clientDay.count, capped: clientDay.capped, recent: client.recent(ERRORS_LIMIT) },
        server: { total: server.total, last24h: serverDay.count, capped: serverDay.capped, recent: server.recent(ERRORS_LIMIT) },
      },
      feedback: { counts, total: FEEDBACK_STATUSES.reduce((n, s) => n + counts[s], 0) },
    };
  }

  // ---------- Veritabanı sayımları (önbellekli) ----------

  private dbStats(tzOffsetMin: number, now: number): DbStats {
    const cached = this.dbCache;
    if (cached && cached.key === tzOffsetMin && now - cached.at < DB_CACHE_MS) return cached.value;
    const value = computeDbStats(this.ctx.store.db, this.ctx.store.listUsers(), this.opts.dbFile, tzOffsetMin, now);
    this.dbCache = { key: tzOffsetMin, at: now, value };
    return value;
  }

  // ---------- Klasör boyutları (arka planda, önbellekli) ----------

  private async dirSizes(now: number): Promise<DirSizes | null> {
    if (this.dirCache && now - this.dirCache.at < DIR_CACHE_MS) return this.dirCache.value;
    this.dirInflight ??= (async () => {
      const { avatars, feedback, linkPreviews } = this.opts.dirs;
      const [a, f, l] = await Promise.all([dirSize(avatars), dirSize(feedback), dirSize(linkPreviews)]);
      const value = { avatars: a, feedback: f, linkPreviews: l };
      this.dirCache = { at: Date.now(), value };
      return value;
    })().finally(() => {
      this.dirInflight = null;
    });
    // İlk ölçümü bekle; sonrakilerde eski değer dururken arka planda yenilenir
    if (!this.dirCache) return this.dirInflight;
    return this.dirCache.value;
  }

  // ---------- LiveKit (önbellekli, zaman aşımlı) ----------

  private async liveKit(now: number): Promise<LiveKitStatus> {
    if (this.liveCache && now - this.liveCache.at < LIVEKIT_CACHE_MS) return this.liveCache.value;
    this.liveInflight ??= (async (): Promise<LiveKitStatus> => {
      const started = Date.now();
      try {
        const rooms = await withTimeout(this.ctx.livekit.liveRooms(), LIVEKIT_TIMEOUT_MS);
        return { rooms, latencyMs: Date.now() - started, error: null };
      } catch (err) {
        return { rooms: null, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
      }
    })()
      .then((value) => {
        this.liveCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.liveInflight = null;
      });
    return this.liveInflight;
  }
}

/**
 * `since`ten sonraki ilk mesajın kimliği. Kimlikler zamanla arttığından (AUTOINCREMENT) created_at'e dizin
 * gerekmeden ikili aramayla bulunur: yalnızca birkaç düzine birincil anahtar araması.
 */
export function firstMessageIdSince(db: DatabaseSync, since: number): number | null {
  const bounds = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM messages').get() as {
    lo: number | null;
    hi: number | null;
  };
  if (bounds.lo === null || bounds.hi === null) return null;
  const next = db.prepare('SELECT id, created_at FROM messages WHERE id >= ? ORDER BY id LIMIT 1');
  let lo = bounds.lo;
  let hi = bounds.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = next.get(mid) as { id: number; created_at: number } | undefined;
    if (!row || row.created_at >= since) hi = mid;
    else lo = row.id + 1;
  }
  // `lo` bir sınır: altındaki mesajlar daha eski; kendisi silinmiş olabilir
  const first = next.get(lo) as { id: number } | undefined;
  return first?.id ?? null;
}

function computeDbStats(db: DatabaseSync, users: User[], dbFile: string, tzOffsetMin: number, now: number): DbStats {
  const count = (sql: string, ...params: number[]): number => (db.prepare(sql).get(...params) as { n: number }).n;
  const channels = { text: 0, voice: 0, dm: 0 };
  for (const r of db.prepare('SELECT type, COUNT(*) AS n FROM channels GROUP BY type').all() as { type: string; n: number }[]) {
    if (r.type === 'text' || r.type === 'voice' || r.type === 'dm') channels[r.type] = r.n;
  }
  const guildNames = new Map(
    (db.prepare('SELECT id, name FROM guilds').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]),
  );

  // Mesajlar: son 14 günün günlük sayıları ve son 24 saat / 7 gün (kimlik aralığıyla, taramasız başlangıç)
  const today = startOfDay(now, tzOffsetMin);
  const firstDay = today - (DASHBOARD_DAYS - 1) * DAY_MS;
  const perDay = Array.from({ length: DASHBOARD_DAYS }, (_, i) => ({ day: firstDay + i * DAY_MS, count: 0 }));
  const fromDays = firstMessageIdSince(db, firstDay);
  if (fromDays !== null) {
    const rows = db
      .prepare('SELECT CAST((created_at - ?) / ? AS INTEGER) AS d, COUNT(*) AS n FROM messages WHERE id >= ? GROUP BY d')
      .all(firstDay, DAY_MS, fromDays) as { d: number; n: number }[];
    for (const r of rows) {
      const slot = perDay[Math.max(0, Math.min(DASHBOARD_DAYS - 1, Math.floor(r.d)))];
      if (slot) slot.count += r.n;
    }
  }
  const windowStats = (since: number): { count: number; authors: string[] } => {
    const from = firstMessageIdSince(db, since);
    if (from === null) return { count: 0, authors: [] };
    const rows = db
      .prepare('SELECT author_id AS id, COUNT(*) AS n FROM messages WHERE id >= ? GROUP BY author_id')
      .all(from) as { id: string | null; n: number }[];
    return {
      count: rows.reduce((n, r) => n + r.n, 0),
      authors: rows.flatMap((r) => (r.id ? [r.id] : [])),
    };
  };
  const day = windowStats(now - DAY_MS);
  const week = windowStats(now - 7 * DAY_MS);

  // Veritabanı boyutu: sayfalar + WAL dosyası
  const page = db.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get() as {
    n: number;
  };
  let wal = 0;
  if (dbFile !== ':memory:') {
    try {
      wal = fs.statSync(`${dbFile}-wal`).size;
    } catch {
      // WAL dosyası yok
    }
  }
  const files = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS size FROM attachments').get() as {
    n: number;
    size: number;
  };

  return {
    users,
    admins: users.filter((u) => u.isAdmin).length,
    guilds: guildNames.size,
    guildNames,
    channels,
    messages: {
      total: count('SELECT COUNT(*) AS n FROM messages'),
      today: perDay.at(-1)!.count,
      last24h: day.count,
      last7d: week.count,
      perDay,
    },
    authors24h: day.authors,
    authors7d: week.authors,
    database: page.n + wal,
    attachments: files.size,
    attachmentCount: files.n,
  };
}
