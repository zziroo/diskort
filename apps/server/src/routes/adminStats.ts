import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { User } from '@diskort/shared';
import type { AuthEvent } from '../authLog.js';
import { sendError, type AppContext } from '../context.js';
import { computeGuildStats, type GuildStats } from '../guildStats.js';
import { isPrivateId, PRIVATE_CALL_NAME, PRIVATE_PARTICIPANT_NAME } from '../privateCalls.js';
import { groupSuites } from '../lineTest/service.js';
import type { InfraMonitor, LiveKitMetrics } from '../infraStats.js';
import type { VoiceTelemetryStore } from '../telemetry.js';
import { voiceHistory } from '../voiceHistory.js';

// Yönetim panelinin ağır/ayrıntılı verileri: panel yalnızca ilgili sekme açıkken ister (5 sn'lik ana
// yoklamayı şişirmesin). Hepsi yalnızca hesap yöneticilerine; yanıtlar saklanmaz (no-store).

export interface AdminStatsServices {
  telemetry: VoiceTelemetryStore;
  livekitMetrics: LiveKitMetrics;
  infra: InfraMonitor;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const tz = z.coerce.number().int().min(-900).max(900).optional();
const telemetryQuery = z.object({
  user: z.string().min(1).max(64),
  minutes: z.coerce.number().int().min(5).max(65).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const daysQuery = (max: number, def: number) =>
  z.object({ days: z.coerce.number().int().min(1).max(max).optional().default(def), tz });

/** Panelde gösterilecek kadar kullanıcı bilgisi */
type UserLite = Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'avatarColor' | 'isAdmin'>;

/** Davet kodunun yalnızca başı (panel açık bir ekranda görülse de kod kullanılamasın) */
const maskCode = (code: string): string => `${code.slice(0, 3)}${'•'.repeat(Math.max(0, code.length - 3))}`;

export function registerAdminStatsRoutes(app: FastifyInstance, ctx: AppContext, services: AdminStatsServices): void {
  const { store } = ctx;
  const { telemetry, livekitMetrics, infra } = services;
  const guard = { preHandler: ctx.auth.requireInstanceAdmin };

  const usersOf = (ids: Iterable<string | null | undefined>): Record<string, UserLite> => {
    const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id !== ''))];
    const out: Record<string, UserLite> = {};
    for (const u of store.usersByIds(unique)) {
      out[u.id] = { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, avatarColor: u.avatarColor, isAdmin: u.isAdmin };
    }
    // DM aramalarının takma kimlikli kişileri: adsız (bkz. privateCalls.ts)
    for (const id of unique) {
      if (isPrivateId(id)) {
        out[id] = { id, username: '', displayName: PRIVATE_PARTICIPANT_NAME, avatarUrl: null, avatarColor: '#747f8d', isAdmin: false };
      }
    }
    return out;
  };
  const channelNames = (ids: Iterable<string | null | undefined>): Record<string, { name: string; guildId: string | null }> => {
    const out: Record<string, { name: string; guildId: string | null }> = {};
    for (const id of new Set(ids)) {
      if (!id) continue;
      if (isPrivateId(id)) {
        out[id] = { name: PRIVATE_CALL_NAME, guildId: null };
        continue;
      }
      const c = store.getChannel(id);
      if (c) out[id] = { name: c.name, guildId: c.guildId };
    }
    return out;
  };
  const guildNames = (): Record<string, string> =>
    Object.fromEntries(
      (store.db.prepare('SELECT id, name FROM guilds').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]),
    );
  const bad = (reply: FastifyReply): FastifyReply => sendError(reply, 400, 'invalid_query', 'Geçersiz istek.');
  const noStore = (reply: FastifyReply): void => void reply.header('Cache-Control', 'no-store');

  // ---------- Ses kalitesi: bir kullanıcının son bir saati ya da geçmiş bir günü ----------
  app.get('/api/admin/telemetry', guard, async (req, reply) => {
    const q = telemetryQuery.safeParse(req.query);
    if (!q.success) return bad(reply);
    noStore(reply);
    const now = Date.now();
    const { user, date } = q.data;
    let entries;
    let truncated = false;
    if (date) ({ entries, truncated } = await telemetry.readDay(user, date));
    else entries = telemetry.historyOf(user, now - (q.data.minutes ?? 60) * 60_000);
    const incidents = telemetry.incidentList(now - 14 * DAY).filter((i) => i.userId === user).slice(0, 50);
    return {
      now,
      user: usersOf([user])[user] ?? null,
      date: date ?? null,
      entries,
      truncated,
      incidents,
      days: (await telemetry.days()).map((d) => d.day),
      channels: channelNames(entries.map((e) => e.channelId)),
    };
  });

  // ---------- Ses kalitesi olayları ----------
  app.get('/api/admin/telemetry/incidents', guard, async (req, reply) => {
    const q = daysQuery(30, 7).safeParse(req.query);
    if (!q.success) return bad(reply);
    noStore(reply);
    const now = Date.now();
    const incidents = telemetry.incidentList(now - q.data.days * DAY).slice(0, 300);
    const days = await telemetry.days();
    const freezes = ctx.freeze.list(now - q.data.days * DAY).slice(0, 100);
    const sampler = ctx.netSampler;
    // Olaylarla çakışan hat testleri (özet; ayrıntı hat testleri ucundan)
    const suites = groupSuites(ctx.lineTest.list(now - q.data.days * DAY), freezes)
      .filter((s) => s.freezeIds.length > 0)
      .map((s) => ({ id: s.id, at: s.at, end: s.end, who: s.who, freezeIds: s.freezeIds, findings: s.findings.slice(0, 4) }));
    return {
      now,
      days: q.data.days,
      incidents,
      // Yayın donmaları (arızalı bölüm, kanıt, eksik kanıt); saniyelik satırlar ayrıntı ucundan
      freezes,
      lineTests: suites,
      netSampler: {
        readable: sampler.readable,
        iface: sampler.iface,
        gateway: sampler.gateway,
        persistedRows: sampler.persistedRows,
        latest: sampler.latest(),
        ring: sampler.size,
      },
      users: usersOf([
        ...incidents.map((i) => i.userId),
        ...freezes.flatMap((f) => f.users.map((u) => u.userId)),
        ...suites.map((s) => s.who.userId),
      ]),
      channels: channelNames([...incidents.map((i) => i.channelId), ...freezes.map((f) => f.channelId)]),
      storage: {
        retentionDays: telemetry.retentionDays,
        files: days.length,
        bytes: days.reduce((n, d) => n + d.size, 0),
        received: telemetry.received,
        dropped: telemetry.dropped,
        reports24h: ctx.counters.sum('telemetry.reports', 1),
      },
    };
  });

  // ---------- Yayın donması olayının saniyelik kanıtı (sunucu ağı + sondalar + LiveKit ölçümleri) ----------
  app.get('/api/admin/telemetry/freezes/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const event = ctx.freeze.list(0).find((e) => e.id === id);
    if (!event) return sendError(reply, 404, 'not_found', 'Olay bulunamadı.');
    noStore(reply);
    const detail = await ctx.freeze.detailOf(id);
    return { event, rows: detail.rows, lk: detail.lk, serverIp: ctx.netSampler.serverIp() };
  });

  // ---------- Ses geçmişi ----------
  app.get('/api/admin/voice-history', guard, async (req, reply) => {
    const q = daysQuery(90, 7).safeParse(req.query);
    if (!q.success) return bad(reply);
    noStore(reply);
    const history = voiceHistory(store.db, q.data.days, q.data.tz ?? 0);
    const since = store.db.prepare('SELECT MIN(started_at) AS t FROM voice_sessions').get() as { t: number | null };
    return {
      ...history,
      trackingSince: since.t,
      users: usersOf([...history.users.map((u) => u.userId), ...history.recent.map((r) => r.userId)]),
      userStats: history.users,
      channelNames: channelNames([...history.channels.map((c) => c.channelId), ...history.recent.map((r) => r.channelId)]),
      guildNames: guildNames(),
    };
  });

  // ---------- Altyapı: LiveKit ölçümleri, kapsayıcılar, yedekler, sertifikalar, sayaçlar ----------
  app.get('/api/admin/infra', guard, async (_req, reply) => {
    noStore(reply);
    const now = Date.now();
    const [metrics, snapshot] = await Promise.all([livekitMetrics.status(now), infra.snapshot(now)]);
    const c = ctx.counters;
    const pushTokens = store.db
      .prepare('SELECT platform, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM push_tokens GROUP BY platform')
      .all() as { platform: string; n: number; users: number }[];
    const windows = { day: 1, week: 7, month: 30 } as const;
    const sums = (prefix: string): Record<keyof typeof windows, Record<string, number>> => ({
      day: c.sumsByPrefix(prefix, windows.day),
      week: c.sumsByPrefix(prefix, windows.week),
      month: c.sumsByPrefix(prefix, windows.month),
    });
    return {
      now,
      // Olay sırasında 2 sn'de bir ölçülür; panel grafikleri için 10 sn'ye seyreltilir
      livekit: { ...metrics, history: livekitMetrics.historySince(now - HOUR, 9_000) },
      ...snapshot,
      push: {
        enabled: ctx.push.enabled,
        tokens: pushTokens,
        counts: sums('push.'),
        daily: {
          sent: c.series('push.android.sent', 14).map((d, i) => ({ day: d.day, count: d.count + c.series('push.ios.sent', 14)[i]!.count })),
          failed: c.series('push.android.failed', 14).map((d, i) => ({ day: d.day, count: d.count + c.series('push.ios.failed', 14)[i]!.count })),
        },
      },
      downloads: { counts: sums('download.'), daily: c.series('download.page', 14) },
      updates: {
        desktop: sums('update.desktop.'),
        ota: sums('ota.'),
        version: sums('version.'),
        daily: c.series('update.desktop.check', 14),
      },
      countersSince: c.since,
    };
  });

  // ---------- API sağlığı ----------
  app.get('/api/admin/api-stats', guard, async (_req, reply) => {
    noStore(reply);
    const now = Date.now();
    const s = ctx.apiStats;
    return {
      now,
      ...s.snapshot(now),
      gateway: { ...ctx.gateway.traffic, openSockets: ctx.gateway.openSockets(), sessions: ctx.gateway.sessionsInfo().length },
      logs: { total: s.logs.total, recent: s.logs.recent(50) },
      rateLimited: { total: s.rateLimited.total, recent: s.rateLimited.recent(50) },
    };
  });

  // ---------- Güvenlik: girişler, başarısız denemeler, davetler ----------
  app.get('/api/admin/security', guard, async (_req, reply) => {
    noStore(reply);
    const now = Date.now();
    const log = ctx.authLog;
    const events = log.recent(150);
    const failed = log.recent(100, (e: AuthEvent) => e.kind === 'login_failed' || e.kind === 'rate_limited');
    const invites = store.db
      .prepare(
        `SELECT code, guild_id, created_by, max_uses, uses, expires_at, created_at, grants_admin FROM invites
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all() as {
      code: string;
      guild_id: string | null;
      created_by: string | null;
      max_uses: number | null;
      uses: number;
      expires_at: number | null;
      created_at: number;
      grants_admin: number;
    }[];
    const uses = store.db
      .prepare('SELECT code, guild_id, inviter_id, user_id, kind, used_at FROM invite_uses ORDER BY used_at DESC LIMIT 100')
      .all() as { code: string; guild_id: string | null; inviter_id: string | null; user_id: string | null; kind: string; used_at: number }[];
    const recentAccounts = store.db
      .prepare('SELECT id, created_at FROM users ORDER BY created_at DESC LIMIT 15')
      .all() as { id: string; created_at: number }[];
    const pushTokens = store.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM push_tokens').get() as {
      n: number;
      users: number;
    };
    const admins = store.db.prepare('SELECT id FROM users WHERE is_admin = 1').all() as { id: string }[];
    const ids = [
      ...events.map((e) => e.userId),
      ...invites.map((i) => i.created_by),
      ...uses.flatMap((u) => [u.user_id, u.inviter_id]),
      ...recentAccounts.map((a) => a.id),
      ...admins.map((a) => a.id),
    ];
    return {
      now,
      counts: {
        login24h: log.countSince(now - DAY, 'login'),
        failed24h: log.countSince(now - DAY, 'login_failed'),
        limited24h: log.countSince(now - DAY, 'rate_limited'),
        login7d: log.countSince(now - 7 * DAY, 'login'),
        failed7d: log.countSince(now - 7 * DAY, 'login_failed'),
      },
      events,
      failed,
      failuresByIp: log.failuresByIp(now - DAY),
      sessions: {
        gatewaySessions: ctx.gateway.sessionsInfo().length,
        onlineUsers: ctx.gateway.connectedUserIds().length,
        pushDevices: pushTokens.n,
        pushUsers: pushTokens.users,
        gatewayAuthFailures: ctx.gateway.traffic.authFailures,
        // Oturum jetonları durumsuz (JWT, 30 gün): sunucu verilen jetonları saklamaz, yalnızca şifre değişince
        // öncekiler geçersiz olur. Açık oturum sayısı bu yüzden bağlı cihazlardan ve bildirim kayıtlarından bilinir.
        tokenTtlDays: 30,
      },
      invites: invites.map((i) => ({
        code: maskCode(i.code),
        guildId: i.guild_id,
        createdBy: i.created_by,
        maxUses: i.max_uses,
        uses: i.uses,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
        accountInvite: i.guild_id === null,
        grantsAdmin: i.grants_admin === 1,
        active: (i.expires_at === null || i.expires_at > now) && (i.max_uses === null || i.uses < i.max_uses),
      })),
      inviteUses: uses.map((u) => ({
        code: maskCode(u.code),
        guildId: u.guild_id,
        inviterId: u.inviter_id,
        userId: u.user_id,
        kind: u.kind,
        at: u.used_at,
      })),
      recentAccounts: recentAccounts.map((a) => ({ userId: a.id, createdAt: a.created_at })),
      admins: admins.map((a) => a.id),
      users: usersOf(ids),
      guildNames: guildNames(),
    };
  });

  // ---------- Sunucular (topluluklar) ----------
  let guildCache: { at: number; value: GuildStats } | null = null;
  app.get('/api/admin/guilds', guard, async (_req, reply) => {
    noStore(reply);
    const now = Date.now();
    if (!guildCache || now - guildCache.at > 30_000) guildCache = { at: now, value: computeGuildStats(store.db, now) };
    const stats = guildCache.value;
    return {
      ...stats,
      users: usersOf(stats.guilds.flatMap((g) => [g.ownerId, ...g.topPosters.map((p) => p.userId)])),
    };
  });
}
