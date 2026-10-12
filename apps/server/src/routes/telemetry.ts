import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VoiceTelemetryReport } from '@diskort/shared';
import { parseBody, sendError, type AppContext } from '../context.js';
import { createRateLimiter } from './messages.js';

/** Aralık dışı ölçüm tüm özeti düşürmez: 0–max'a sıkıştırılır (gövde zaten 8 KB ile sınırlı) */
const clamp = (max: number) => (v: number): number => Math.min(max, Math.max(0, v));
const num = (max: number) => z.number().finite().transform(clamp(max)).nullable();
/** dBFS seviye: -200..0'a sıkıştırılır */
const dbfs = z
  .number()
  .finite()
  .transform((v) => Math.min(0, Math.max(-200, v)))
  .nullable();
/** Uzun metin reddedilmez, kısaltılır */
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.slice(0, max))
    .nullable();

const reportSchema = z.object({
  v: z.literal(1),
  platform: z.enum(['desktop', 'android', 'ios']),
  version: z.string().max(32),
  channelId: z.string().max(64),
  windowSec: z.number().int().min(1).max(600),
  samples: z.number().int().min(0).max(1_000),
  quality: z.enum(['good', 'fair', 'poor', 'unknown']),
  poorSec: z.number().int().min(0).max(600),
  serverQuality: text(16),
  rttMs: z.object({ avg: num(60_000), max: num(60_000) }),
  jitterInMs: num(60_000),
  jitterOutMs: num(60_000),
  lossOutPct: num(100),
  lossInPct: num(100),
  concealedPct: num(100),
  bitrateOut: num(1e10),
  bitrateIn: num(1e10),
  availableOut: num(1e11),
  candidate: text(16),
  protocol: text(16),
  reconnects: z.number().int().min(0).max(1_000),
  mic: z
    .object({
      noise: z.string().max(32),
      model: text(48),
      load: num(100),
      avgFrameMs: num(10_000),
      p99FrameMs: num(10_000),
      maxFrameMs: num(10_000),
      underruns: num(1e9),
      droppedSamples: num(1e12),
      muted: z.boolean(),
      // Yeni istemcilerde (eskiler göndermez)
      modelFrameMs: num(10_000).optional(),
      core: text(48).optional(),
      noiseFallback: text(80).optional(),
      effectiveNoise: text(32).optional(),
      fallback: z
        .object({
          from: z.string().max(32),
          to: z.string().max(32),
          reason: z.string().max(32),
          transient: z.boolean(),
          at: z.number().finite(),
          retryAt: z.number().finite().nullable(),
        })
        .nullable()
        .optional(),
      speechRmsDb: dbfs.optional(),
      speechRmsDbP90: dbfs.optional(),
      speechRmsDbOut: dbfs.optional(),
      speechRmsDbOutP90: dbfs.optional(),
      effectiveAgc: z.boolean().nullable().optional(),
      digitalAgc: z.boolean().nullable().optional(),
    })
    .nullable(),
  screen: z
    .object({
      width: num(20_000),
      height: num(20_000),
      fps: num(1_000),
      bitrate: num(1e10),
      encoder: text(80),
      codec: text(32),
      limitation: z.enum(['none', 'cpu', 'bandwidth', 'other']),
      limitedRatio: num(1),
      encodeMs: num(10_000).optional(),
      hardware: z.boolean().nullable().optional(),
    })
    .nullable(),
  // İzlenen yayın ve cihaz durumu (yeni istemcilerde; eskiler göndermez)
  watch: z
    .object({
      codec: text(32),
      decoder: text(80),
      hardware: z.boolean().nullable(),
      powerEfficient: z.boolean().nullable(),
      width: num(20_000),
      height: num(20_000),
      fps: num(1_000),
      decodeMs: num(10_000),
      decodeMsMax: num(10_000),
      bitrate: num(1e10),
      framesDropped: num(1e9),
      freezes: num(1e6),
      freezeSec: num(1e6),
      jitterBufferMs: num(60_000),
      view: z
        .object({
          mode: z.enum(['fullscreen', 'inline']),
          width: z.number().finite().transform(clamp(20_000)),
          height: z.number().finite().transform(clamp(20_000)),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  device: z
    .object({
      appState: text(16),
      soc: text(48),
      // Yeni APK'larda (eskiler göndermez)
      thermal: text(16).optional(),
      thermalHeadroom: num(10).optional(),
    })
    .nullable()
    .optional(),
  // Gelen seslerin ayrıntısı, JS takılması ve ses ayarları (yeni istemcilerde; eskiler göndermez)
  audioIn: z
    .object({
      streams: z.number().int().transform(clamp(1_000)),
      jitterMaxMs: num(60_000),
      lossPct: num(100),
      concealEvents: num(1e9),
      jitterBufferMs: num(60_000),
      bitrate: num(1e10),
    })
    .nullable()
    .optional(),
  jsLag: z
    .object({
      maxMs: num(3_600_000),
      p95Ms: num(3_600_000),
      stalls: z.number().int().transform(clamp(1e6)),
    })
    .nullable()
    .optional(),
  settings: z
    .object({
      echoCancellation: z.boolean().nullable().optional(),
      autoGainControl: z.boolean().nullable().optional(),
      voiceActivity: z.boolean().nullable().optional(),
      vadAuto: z.boolean().nullable().optional(),
      // dBFS: negatif; sıkıştırma -200–0
      vadThresholdDb: z
        .number()
        .finite()
        .transform((v) => Math.min(0, Math.max(-200, v)))
        .nullable()
        .optional(),
      noiseMode: text(16).optional(),
      noiseStrengthDb: num(1_000).optional(),
      speaker: z.boolean().nullable().optional(),
      userVolumesChanged: num(1e5).optional(),
      userVolumeMax: num(100).optional(),
      inputMode: text(16).optional(),
      inputVolume: num(100).optional(),
      outputVolume: num(100).optional(),
      audioBitrateKbps: num(10_000).optional(),
    })
    .nullable()
    .optional(),
  // Giden kayıp ses/görüntü ayrı; aralığın bitişi, gönderim anı (istemci saati) ve saat farkı (yeni istemciler)
  lossOutAudioPct: num(100).optional(),
  lossOutVideoPct: num(100).optional(),
  endAt: z.number().finite().min(1e12).max(1e13).optional(),
  sentAt: z.number().finite().min(1e12).max(1e13).optional(),
  offsetMs: z.number().finite().nullable().optional(),
});

/** Kullanıcı başına dakikada en fazla özet (normalde 2; kalite düşünce birkaç erken özet) */
const REPORTS_PER_MINUTE = 8;

/**
 * Ses kalitesi özetleri (bkz. telemetry.ts ve client-core voiceTelemetry.ts). Yalnızca giriş yapmış
 * kullanıcılar, kullanıcı başına sınırlı; kaydedilen kanal sunucunun bildiği ses durumundan alınır.
 */
export function registerTelemetryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { telemetry } = ctx;
  const allow = createRateLimiter(REPORTS_PER_MINUTE, 60_000);

  app.post('/api/telemetry/voice', { preHandler: ctx.auth.requireUser, bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!allow(req.user.id)) return sendError(reply, 429, 'rate_limited', 'Çok sık ölçüm gönderiliyor.');
    const body = parseBody(reportSchema, req.body, reply);
    if (!body) return reply;
    const state = ctx.voice.get(req.user.id);
    const channelId = state?.channelId ?? null;
    // DM aramasının ölçümü tutulur ama kişi ve konuşma takma kimlikle (yönetim paneli kimin kiminle
    // konuştuğunu göremez; bkz. privateCalls.ts)
    const entry = telemetry.ingest(ctx.privacy.user(req.user.id, channelId), body as VoiceTelemetryReport, {
      channelId: ctx.privacy.channel(channelId),
      guildId: channelId ? (ctx.store.getChannel(channelId)?.guildId ?? null) : null,
    });
    try {
      ctx.freeze.observe(entry);
    } catch (err) {
      req.log.warn({ err: String(err) }, 'yayın donma toplayıcısı hata verdi');
    }
    ctx.counters.inc('telemetry.reports');
    return reply.code(204).send();
  });
}
