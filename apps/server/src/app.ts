import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { CLIENT_FEATURES_HEADER } from '@diskort/shared';
import { ActivityTracker, createErrorLog } from './activity.js';
import { ActivityIconStore } from './activityIcons.js';
import { ApiStats } from './apiStats.js';
import { AuthLog } from './authLog.js';
import { DailyCounters } from './counters.js';
import { InfraMonitor, LiveKitMetrics } from './infraStats.js';
import { VoiceTelemetryStore } from './telemetry.js';
import { ClientTraceStore } from './clientTrace.js';
import { createOutageTraceRequester, createTraceRequester } from './traceRequests.js';
import { registerVoiceTraceRoutes } from './routes/voiceTrace.js';
import { registerAdminTraceRoutes } from './routes/adminTraces.js';
import { FreezeCorrelator } from './freezeDiagnosis.js';
import { DEFAULT_PROBE_TARGETS, parseProbeTargets, ProbeEngine } from './netProbe.js';
import { SecondSampler } from './netSeconds.js';
import type { Outage } from './netOutages.js';
import { LineTestService } from './lineTest/service.js';
import { registerLineTestRoutes } from './routes/lineTest.js';
import { VoiceSessionRecorder } from './voiceHistory.js';
import { registerAdminNetRoutes } from './routes/adminNet.js';
import { registerAdminStatsRoutes } from './routes/adminStats.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { AttachmentService } from './attachments.js';
import { AvatarService } from './avatars.js';
import { AuthService } from './auth.js';
import { ClientVersionPolicy } from './clientVersion.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { knowsCosmeticPacks, withoutPackCosmetics } from './cosmeticCompat.js';
import { CosmeticPackStore } from './cosmeticPacks.js';
import { DashboardService } from './dashboard.js';
import { Store } from './db.js';
import { DmCallService } from './dmCalls.js';
import { PrivateCallIds } from './privateCalls.js';
import { EmbedMediaService, type Fetcher } from './embedMedia.js';
import { FeedbackService } from './feedback.js';
import { FeedbackStore } from './feedbackStore.js';
import { Gateway } from './gateway.js';
import { GifService } from './gifs.js';
import { LinkPreviewService } from './linkPreviews.js';
import { LiveKitService } from './livekit.js';
import { OtaService } from './ota.js';
import { PermissionService } from './permissions.js';
import { createApns } from './apns.js';
import { PushService } from './push.js';
import { ReleaseService } from './releases.js';
import { StreamPreviewStore } from './streamPreview.js';
import { SystemHistory } from './systemHistory.js';
import { SystemMonitor } from './systemStats.js';
import { VoiceModeration } from './voiceModeration.js';
import { VoiceStateStore } from './voiceState.js';
import { registerActivityIconRoutes } from './routes/activityIcons.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClientErrorRoutes } from './routes/clientErrors.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerUdidRoutes } from './routes/udid.js';
import { registerIosDeviceRoutes } from './routes/iosDevices.js';
import { IosDeviceService } from './iosDevices.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerCosmeticRoutes } from './routes/cosmetics.js';
import { registerDmRoutes } from './routes/dms.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerFriendRoutes } from './routes/friends.js';
import { registerEmbedRoutes } from './routes/embeds.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerGifRoutes } from './routes/gifs.js';
import { registerGuildRoutes } from './routes/guilds.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerVoiceRoutes } from './routes/voice.js';

export interface BuildOptions {
  /** Testler için ':memory:' verilebilir. */
  dbFile?: string;
  logger?: boolean;
  livekit?: LiveKitService;
  releases?: ReleaseService;
  push?: PushService;
  /** Testler için sahte GitHub indirmesi */
  otaFetch?: typeof fetch;
  /** Dosya eklerinin klasörü (varsayılan: <DATA_DIR>/attachments) */
  attachmentsDir?: string;
  /** Profil fotoğraflarının klasörü (varsayılan: <DATA_DIR>/avatars) */
  avatarsDir?: string;
  /** Etkinlik (oyun) ikonlarının klasörü (varsayılan: <DATA_DIR>/activity-icons) */
  activityIconsDir?: string;
  /** Kozmetik paketlerinin klasörü (varsayılan: <DATA_DIR>/cosmetic-packs) */
  cosmeticPacksDir?: string;
  /** Testler: paket bildirimine (manifest.json) bakma aralığı (ms; varsayılan 2000) */
  cosmeticPacksRecheckMs?: number;
  /** Testler için sahte GIPHY */
  gifFetch?: typeof fetch;
  /** Geri bildirim ekran görüntülerinin klasörü (varsayılan: <DATA_DIR>/feedback) */
  feedbackDir?: string;
  /** Önizleme resimlerinin önbellek klasörü (varsayılan: <DATA_DIR>/embed-media) */
  embedMediaDir?: string;
  /** Testler için sahte dış istek (verilirse bağlantı önizlemeleri açılır) */
  linkFetch?: Fetcher;
  /** Yönetim paneli: makine ölçümü (testlerde sahte /proc klasörüyle) */
  systemMonitor?: SystemMonitor;
  /** Ses kalitesi ölçümlerinin klasörü (varsayılan: SYSTEM_STATS açıkken <DATA_DIR>/telemetry; null: yalnızca bellek) */
  telemetryDir?: string | null;
  /** Testler için hat testi UDP portları (config.lineTestPorts yerine; [0] rastgele boş port) */
  lineTestPorts?: number[];
  /** Testler için sahte ölçüm uçları (LiveKit ve Caddy Prometheus) */
  metricsFetch?: typeof fetch;
  /** Yönetim paneli: hazır LiveKit ölçümü ve altyapı ölçümü (testler ve ekran görüntüsü düzeneği) */
  livekitMetrics?: LiveKitMetrics;
  infraMonitor?: InfraMonitor;
  /** Testler için sahte GitHub API'si (iPhone cihaz onayında iş akışı başlatma) */
  githubFetch?: typeof fetch;
  /** Testler: iPhone derlemesinin yoklama aralığı (ms) */
  iosPollMs?: number;
  /** Testler: günlüğün yazılacağı akış (verilirse günlük açık olur; hata kayıtları panele de düşer) */
  logStream?: { write(msg: string): void };
  /** Testler: DM aramasının kişi başına çalma süresi (ms; varsayılan DM_CALL_RING_MS) */
  callRingMs?: number;
}

/** Süresi geçmiş yüklemelerin ve artık dosyaların temizlenme aralığı */
const ATTACHMENT_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Süresi dolan durumların temizlenme aralığı */
const STATUS_SWEEP_INTERVAL_MS = 15_000;

export async function buildApp(
  config: Config,
  opts: BuildOptions = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  // Yönetim paneli: istek sayıları ve gecikmeler; günlükteki hata/ölümcül kayıtlar pino kancasıyla yakalanır
  // (günlüğün kendisi değişmez, kayıt yine yazılır)
  const apiStats = new ApiStats();
  const logMethod = function (this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
    apiStats.captureLog(level, args);
    method.apply(this, args);
  };
  const logging = opts.logStream !== undefined || (opts.logger ?? true);
  const app = Fastify({
    logger: logging
      ? { level: 'info', hooks: { logMethod }, ...(opts.logStream ? { stream: opts.logStream } : {}) }
      : false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  const dbFile = opts.dbFile ?? path.join(config.dataDir, 'diskort.db');
  const store = new Store(dbFile);
  const guild = store.ensureGuild(config.guildName);
  const permissions = new PermissionService(store);
  const auth = new AuthService(config.jwtSecret, store, permissions);
  const voice = new VoiceStateStore();
  const livekit = opts.livekit ?? new LiveKitService(config);
  const releases = opts.releases ?? new ReleaseService(config.githubRepo);
  const clientVersions = new ClientVersionPolicy(releases, config.enforceClientVersion, config.minMobileVersions);
  const gifs = new GifService(
    { apiKey: config.giphyApiKey, rating: config.giphyRating, lang: config.giphyLang },
    opts.gifFetch,
    app.log,
  );
  const activityIcons = new ActivityIconStore(opts.activityIconsDir ?? path.join(config.dataDir, 'activity-icons'), {
    log: app.log,
  });
  // Kozmetik paketleri: kullanıcıların seçebildiği setler yerleşik setler ∪ yayında olan paketlerdir
  const cosmeticPacks = new CosmeticPackStore(opts.cosmeticPacksDir ?? path.join(config.dataDir, 'cosmetic-packs'), {
    log: app.log,
    ...(opts.cosmeticPacksRecheckMs !== undefined ? { recheckMs: opts.cosmeticPacksRecheckMs } : {}),
  });
  store.knownCosmeticSet = (id) => cosmeticPacks.knows(id);
  const gateway = new Gateway(
    store,
    auth,
    voice,
    permissions,
    clientVersions,
    config.attachmentMaxBytes,
    { gifs: gifs.enabled },
    undefined,
    activityIcons,
  );
  const moderation = new VoiceModeration(store, voice, livekit, permissions, gateway);
  const push =
    opts.push ?? new PushService(store, config.fcmServiceAccountFile, app.log, fetch, createApns(config, app.log));
  // DM aramaları: ses durumundan kurulur/biter, çalma ve arama kaydı (bkz. dmCalls.ts)
  const calls = new DmCallService({
    store,
    permissions,
    gateway,
    voice,
    push,
    ...(opts.callRingMs !== undefined ? { ringMs: opts.callRingMs } : {}),
  });
  gateway.callsFor = (userId) => calls.callsFor(userId);
  app.addHook('onClose', async () => calls.stop());
  // Yönetim paneli gizliliği: DM aramalarının ölçümleri takma kimliklerle tutulur (bkz. privateCalls.ts)
  const privacy = new PrivateCallIds((channelId) => permissions.isDm(channelId));
  const ota = new OtaService(releases, app.log, opts.otaFetch);
  const attachments = new AttachmentService(
    store,
    opts.attachmentsDir ?? path.join(config.dataDir, 'attachments'),
    config.attachmentMaxBytes,
    app.log,
  );
  const avatars = new AvatarService(store, opts.avatarsDir ?? path.join(config.dataDir, 'avatars'), app.log);
  const embedMedia = new EmbedMediaService(
    opts.embedMediaDir ?? path.join(config.dataDir, 'embed-media'),
    config.jwtSecret,
    opts.linkFetch,
    app.log,
  );
  const linkPreviews =
    config.linkPreviews || opts.linkFetch ? new LinkPreviewService(store, embedMedia, opts.linkFetch, app.log) : null;
  // Yönetim paneli: kalıcı sayaçlar ve kayıtlar yalnızca SYSTEM_STATS açıkken dosyaya yazılır (testlerde kapalı)
  const statsFile = (name: string): string | null => (config.systemStats ? path.join(config.dataDir, name) : null);
  const counters = new DailyCounters(statsFile('counters.json'), config.statsUtcOffsetMin, Date.now(), app.log);
  const authLog = new AuthLog(statsFile('auth-log.jsonl'), app.log);
  push.onDelivery = (platform, result) => counters.inc(`push.${platform}.${result}`);
  const telemetry = new VoiceTelemetryStore({
    dir: opts.telemetryDir !== undefined ? opts.telemetryDir : statsFile('telemetry'),
    offsetMin: config.statsUtcOffsetMin,
    log: app.log,
  });
  const livekitMetrics =
    opts.livekitMetrics ?? new LiveKitMetrics({ url: config.livekitMetricsUrl, fetchImpl: opts.metricsFetch, log: app.log });
  // Bağlantı teşhisi: saniyelik sunucu ağı kaydı (tek NIC örnekleyicisi), dış sondalar ve kesinti kaydı,
  // olay toplayıcı (bkz. netSeconds.ts, netProbe.ts, netOutages.ts, freezeDiagnosis.ts)
  const netDir = opts.telemetryDir !== undefined ? opts.telemetryDir : statsFile('telemetry');
  const netSampler = new SecondSampler({
    procRoot: config.procRoot,
    dir: netDir,
    offsetMin: config.statsUtcOffsetMin,
    livekitCpu: () => livekitMetrics.process().cpu,
    // Doğrulanmış kesinti kaydedilince sesteki herkesten olay kaydı istenir (bkz. aşağıda requestTracesFor)
    onOutage: (o) => requestTracesFor.outage?.(o),
    participants: () => voice.list().length,
    streams: () => voice.list().filter((v) => v.streaming).length,
    log: app.log,
  });
  // Olay kaydı isteği aşağıda (gateway hazır olunca) kurulur; teşhis bileşenleri bu tutucu üzerinden çağırır
  const requestTracesFor: { event?: (channelId: string, reason: string, eventId: string) => void; outage?: (o: Outage) => void } = {};
  const netProbes = new ProbeEngine({
    targets: parseProbeTargets(config.netProbeTargets ?? undefined) ?? DEFAULT_PROBE_TARGETS,
    gateway: () => netSampler.gateway,
    onResult: (label, sentAt, rtt) => netSampler.addProbe(label, sentAt, rtt),
    onOutage: (o) => void netSampler.addProbeOutage(o),
  });
  const freeze = new FreezeCorrelator({
    dir: netDir,
    sampler: netSampler,
    livekit: livekitMetrics,
    traces: { window: (q) => traces.window(q) },
    requestTraces: (channelId, reason, eventId) => requestTracesFor.event?.(channelId, reason, eventId),
    // Olay kalıcı kayda (telemetry/freeze-events.jsonl) yazılır ve sunucu günlüğüne uyarı olarak düşer
    onEvent: (e) =>
      app.log.warn(
        { cause: e.cause, channelId: e.channelId, affected: e.affected, freezes: e.freezes, probe: e.probe },
        `yayın donması: ${e.label}`,
      ),
    log: app.log,
  });
  const lineTest = new LineTestService({
    secret: config.jwtSecret,
    dir: netDir,
    ports: opts.lineTestPorts ?? config.lineTestPorts,
    maxBps: config.lineTestMaxBps,
    adminMaxBps: config.lineTestAdminMaxBps,
    outagesBetween: (from, to) => netSampler.outages.between(from, to),
    // DM aramasındaki yayın da "yayın var" sayılır ama kanalı takma kimlikle kaydedilir
    streamInfo: () => {
      const channels = [...new Set(voice.list().filter((v) => v.streaming).map((v) => privacy.channel(v.channelId)))];
      return { live: channels.length > 0, channels };
    },
    serverTxMbps: () => netSampler.latest()?.tx ?? null,
    log: app.log,
  });
  // Olay kayıtları: istemcilerin sorun anındaki saniyelik bağlantı ölçümleri (telemetry/traces-*.jsonl)
  const traces = new ClientTraceStore({
    dir: opts.telemetryDir !== undefined ? opts.telemetryDir : statsFile('telemetry'),
    offsetMin: config.statsUtcOffsetMin,
    log: app.log,
  });
  if (config.systemStats) traces.start();
  app.addHook('onClose', async () => traces.stop());
  const requestVoiceTraces = createTraceRequester({
    gateway,
    voice,
    onRequest: (r, reason) => {
      counters.inc('trace.requests');
      app.log.info(
        { channelId: privacy.channel(r.channelId), eventId: r.eventId, users: r.users, sessions: r.sessions, reason },
        'olay kaydı istendi',
      );
    },
  });
  // Bağlantı teşhisi → olay kaydı: donma olayı açılınca o kanaldan, doğrulanmış bir kesinti kaydedilince içinde
  // biri bulunan her ses kanalından kayıt istenir. Kesinti kaynaklı istekler ayrıca sınırlıdır (kanal başına 2 dk,
  // toplam saatte 20): bağlantının gidip geldiği dönemde istemcilerin günlük kayıt payı tükenmesin (traceRequests.ts)
  // Donma olayları ölçümlerden gelir: DM aramasınınki takma kimlikle (gerçek odası bu süreçte bilinir)
  requestTracesFor.event = (channelId, reason, eventId) => {
    const real = privacy.resolve(channelId);
    if (real) void ctx.requestVoiceTraces(real, reason, eventId);
  };
  const requestForOutage = createOutageTraceRequester({
    request: (channelId, reason, eventId) => ctx.requestVoiceTraces(channelId, reason, eventId),
    channels: () => voice.list().map((v) => v.channelId),
  });
  requestTracesFor.outage = (o) => void requestForOutage(o.id);
  const ctx: AppContext = {
    config,
    store,
    auth,
    voice,
    livekit,
    gateway,
    releases,
    clientVersions,
    ota,
    push,
    attachments,
    avatars,
    activityIcons,
    cosmeticPacks,
    gifs,
    linkPreviews,
    embedMedia,
    permissions,
    moderation,
    calls,
    privacy,
    streamPreviews: new StreamPreviewStore(voice),
    errors: createErrorLog({ client: statsFile('client-errors.jsonl'), server: statsFile('server-errors.jsonl') }, app.log),
    counters,
    authLog,
    apiStats,
    telemetry,
    traces,
    requestVoiceTraces,
    freeze,
    netSampler,
    netProbes,
    lineTest,
    guild,
  };

  const sweep = (): void => {
    attachments.sweep().catch((err: unknown) => app.log.warn({ err: String(err) }, 'dosya eki temizliği başarısız'));
    avatars.sweep().catch((err: unknown) => app.log.warn({ err: String(err) }, 'profil fotoğrafı temizliği başarısız'));
    embedMedia.sweep().catch((err: unknown) => app.log.warn({ err: String(err) }, 'önizleme resmi temizliği başarısız'));
    try {
      linkPreviews?.sweep();
    } catch (err) {
      app.log.warn({ err: String(err) }, 'bağlantı önizleme önbelleği temizliği başarısız');
    }
  };
  const sweepTimers = [
    setTimeout(sweep, 60_000),
    setInterval(sweep, ATTACHMENT_SWEEP_INTERVAL_MS),
    // Süresi dolan durumlar (ör. "1 saat Rahatsız Etmeyin") ve özel durumlar
    setInterval(() => gateway.expireStatuses(), STATUS_SWEEP_INTERVAL_MS),
  ];
  for (const timer of sweepTimers) timer.unref();
  app.addHook('onClose', async () => sweepTimers.forEach((timer) => clearTimeout(timer)));

  // Yeni sürüm yayınlanınca bağlı istemciler arka planda indirmeye başlasın
  releases.onNewRelease((release) => gateway.broadcast({ t: 'UPDATE_AVAILABLE', d: { version: release.version } }));
  if (!config.isDev) releases.startPolling();
  app.addHook('onClose', async () => releases.stopPolling());

  // Yönetim paneli: ses kalitesi özetleri, ses geçmişi (veritabanı), LiveKit/Caddy ölçümleri, yedekler, TLS
  const infra =
    opts.infraMonitor ??
    new InfraMonitor(
      {
        cgroupRoot: config.cgroupRoot,
        caddyMetricsUrl: config.caddyMetricsUrl,
        backupDir: config.backupDir,
        tlsDomains: config.tlsCheckDomains,
        tlsHost: config.tlsCheckHost,
        fetchImpl: opts.metricsFetch,
        log: app.log,
      },
      livekitMetrics,
    );
  // Ses geçmişine DM aramaları yazılmaz (kim kiminle konuştu yönetim panelinde görünmesin; bkz. privateCalls.ts)
  const voiceSessions = new VoiceSessionRecorder(
    store.db,
    (channelId) => store.getChannel(channelId)?.guildId ?? null,
    app.log,
    (channelId) => permissions.isDm(channelId),
  );
  voiceSessions.attach(voice);
  if (config.systemStats) {
    telemetry.start();
    freeze.start();
    netSampler.start();
    // Geliştirme makinesinde dış sonda gönderilmez
    if (!config.isDev) netProbes.start();
    livekitMetrics.start();
    infra.start();
    voiceSessions.start();
    authLog.start();
    apiStats.startLoopMonitor();
  }
  app.addHook('onClose', async () => {
    livekitMetrics.stop();
    infra.stop();
    apiStats.stop();
    netProbes.stop();
    await Promise.all([telemetry.stop(), authLog.stop(), freeze.stop(), netSampler.stop()]);
  });

  // Yönetim paneli: makine yükü, aylık trafik ve hesapların son görülme anı. Kalıcı sayaçlar ve düzenli
  // ölçüm yalnızca SYSTEM_STATS açıkken (testlerde kapalı; panel istek anında ölçer).
  const feedbackStore = new FeedbackStore(store.db);
  const dashboard = new DashboardService(ctx, {
    monitor:
      opts.systemMonitor ??
      new SystemMonitor({
        procRoot: config.procRoot,
        diskPath: config.dataDir,
        stateFile: statsFile('traffic.json'),
        quotaBytes: config.trafficQuotaBytes,
        // 24 saat / 7 günlük grafikler: 5 dk'lık kovalar, NIC hızı saniyelik örnekleyiciden
        longHistory: new SystemHistory(statsFile('system-history.json'), Date.now(), app.log),
        netRates: (from, to) => netSampler.window(from, to),
        log: app.log,
      }),
    activity: new ActivityTracker(statsFile('activity.json'), Date.now(), app.log),
    feedback: feedbackStore,
    dbFile,
    dirs: {
      avatars: opts.avatarsDir ?? path.join(config.dataDir, 'avatars'),
      feedback: opts.feedbackDir ?? path.join(config.dataDir, 'feedback'),
      linkPreviews: opts.embedMediaDir ?? path.join(config.dataDir, 'embed-media'),
    },
    telemetry,
    livekitMetrics,
  });
  if (config.systemStats) dashboard.start();
  app.addHook('onClose', async () => dashboard.stop());

  // 5xx ile biten istekler panelin hata listesine (hatanın iletisiyle birlikte)
  const failures = new WeakMap<FastifyRequest, string>();
  app.addHook('onError', async (req, _reply, error) => {
    failures.set(req, error.message);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? '(eşleşmeyen)';
    apiStats.record(req.method, route, reply.statusCode, reply.elapsedTime);
    if (reply.statusCode === 429) {
      apiStats.recordRateLimit({
        at: Date.now(),
        method: req.method,
        route,
        ip: req.ip,
        user: (req.user as { username?: string } | null)?.username ?? null,
      });
    }
    if (reply.statusCode < 500) return;
    ctx.errors.server.push({
      at: Date.now(),
      method: req.method,
      route: req.routeOptions.url ?? req.url.split('?')[0]!.slice(0, 200),
      status: reply.statusCode,
      message: (failures.get(req) ?? '').slice(0, 500),
    });
  });

  app.decorateRequest('user', null as never);
  // Arka planda süren önizlemeler veritabanı kapanmadan bitsin
  app.addHook('onClose', async () => {
    await linkPreviews?.idle();
    // Açık ses oturumları "yeniden başlatma" olarak kapanır (açılışta sürdürülür)
    voiceSessions.stop();
    store.close();
  });

  // Masaüstü istemcisi file:// veya localhost kökeninden bağlanır; kimlik jetonla taşınır.
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  // Kozmetik paketlerini tanıdığını bildirmeyen eski istemcilere (0.9.1 ve öncesi) JSON yanıtlardaki
  // kullanıcıların set seçimlerinde yalnızca yerleşik kimlikler gider (bkz. cosmeticCompat.ts; gateway'de
  // aynısını Gateway.out yapar). Karar yalnızca yanıtın metnine bakar (ucuz bir ön tarama), o anki paket
  // listesine değil: yanıt hazırlandıktan sonra paket yayından kalksa da tanınmayan kimlik sızmaz.
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || knowsCosmeticPacks(req.headers[CLIENT_FEATURES_HEADER])) return payload;
    const type = reply.getHeader('content-type');
    return typeof type === 'string' && type.startsWith('application/json') ? withoutPackCosmetics(payload) : payload;
  });

  app.get('/api/health', async () => ({ ok: true }));
  gateway.register(app);
  registerAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerVoiceRoutes(app, ctx);
  registerDownloadRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerDmRoutes(app, ctx);
  registerFriendRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerGuildRoutes(app, ctx);
  registerRoleRoutes(app, ctx);
  registerStatusRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerEmbedRoutes(app, ctx);
  registerAvatarRoutes(app, ctx);
  registerActivityIconRoutes(app, ctx);
  registerCosmeticRoutes(app, ctx);
  registerGifRoutes(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerClientErrorRoutes(app, ctx);
  registerUdidRoutes(app, ctx);
  const iosDevices = new IosDeviceService({
    dataDir: config.dataDir,
    repo: config.githubRepo,
    token: config.githubDispatchToken,
    devicesKey: config.iosDevicesKey,
    delayMs: config.iosDispatchDelayMs,
    ...(opts.iosPollMs !== undefined ? { pollMs: opts.iosPollMs } : {}),
    ...(opts.githubFetch ? { fetch: opts.githubFetch } : {}),
    log: app.log,
  });
  iosDevices.start();
  app.addHook('onClose', async () => iosDevices.stop());
  registerIosDeviceRoutes(app, ctx, iosDevices);
  registerFeedbackRoutes(
    app,
    ctx,
    new FeedbackService(feedbackStore, opts.feedbackDir ?? path.join(config.dataDir, 'feedback'), app.log),
  );
  registerDashboardRoutes(app, ctx, dashboard);
  registerTelemetryRoutes(app, ctx);
  registerVoiceTraceRoutes(app, ctx);
  registerAdminTraceRoutes(app, ctx);
  registerAdminStatsRoutes(app, ctx, { telemetry, livekitMetrics, infra });
  registerAdminNetRoutes(app, ctx, { livekitMetrics });
  registerLineTestRoutes(app, ctx);
  // UDP ucu dinlemeye hazır olunca açılır (listen'den önce); kapanışta soket kapatılır
  app.addHook('onReady', async () => void (await lineTest.start()));
  app.addHook('onClose', async () => lineTest.stop());

  return { app, ctx };
}
