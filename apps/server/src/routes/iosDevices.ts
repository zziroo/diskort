import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, sendError, type AppContext } from '../context.js';
import { IOS_DEVICE_STATUSES, isUdid, type IosDeviceService } from '../iosDevices.js';
import { MAX_RECORDS } from './udid.js';

// Yönetim paneli → "iPhone cihazları": /udid sayfasından kaydolan cihazların onayı ve otomatik Ad Hoc
// derlemesi (bkz. iosDevices.ts, docs/ios.md). Yalnızca hesap yöneticilerine; yanıtlar saklanmaz.

const statusBody = z.object({ status: z.enum(IOS_DEVICE_STATUSES) });

export function registerIosDeviceRoutes(app: FastifyInstance, ctx: AppContext, service: IosDeviceService): void {
  const guard = { preHandler: ctx.auth.requireInstanceAdmin };

  const overview = async () => {
    // Etkin derlemenin durumu panel açıkken de tazelenir; GitHub'a ulaşılamazsa son bilinen durum gösterilir
    await service.refreshCi().catch((err: unknown) => app.log.warn({ err }, 'iOS derleme durumu okunamadı'));
    const devices = await service.list();
    return {
      devices,
      /** Kayıt listesinin üst sınırı: dolunca yeni cihaz kaydedilmez */
      recordLimit: MAX_RECORDS,
      automation: {
        enabled: service.automationEnabled,
        /** GITHUB_DISPATCH_TOKEN var ama IOS_DEVICES_KEY yok: derleme başlatılmaz */
        keyMissing: service.keyMissing,
        pendingDispatchAt: service.pendingDispatchAt,
      },
      ci: service.ci,
      manualCommand: service.automationEnabled ? null : await service.manualCommand(),
      generatedAt: Date.now(),
    };
  };

  app.get('/api/admin/ios-devices', guard, async (_req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    return overview();
  });

  app.patch<{ Params: { udid: string } }>('/api/admin/ios-devices/:udid', guard, async (req, reply) => {
    const udid = req.params.udid.toUpperCase();
    if (!isUdid(udid)) return sendError(reply, 400, 'invalid_udid', 'Geçersiz UDID.');
    const body = parseBody(statusBody, req.body, reply);
    if (!body) return reply;
    const device = await service.setStatus(udid, body.status);
    if (!device) return sendError(reply, 404, 'not_found', 'Cihaz bulunamadı.');
    req.log.info({ udid, status: body.status, by: req.user.id }, 'iPhone cihaz durumu değişti');
    return device;
  });

  // Toplama beklemesini atlayıp hemen derlet (ya da başarısız derlemeyi yeniden dene)
  app.post('/api/admin/ios-devices/dispatch', guard, async (_req, reply) => {
    if (service.keyMissing) {
      return sendError(reply, 400, 'devices_key_missing', 'IOS_DEVICES_KEY yok: cihaz listesi şifrelenemediği için derleme başlatılmaz.');
    }
    if (!service.automationEnabled) {
      return sendError(reply, 400, 'automation_disabled', 'Otomatik derleme kapalı (GITHUB_DISPATCH_TOKEN yok).');
    }
    const run = await service.dispatch();
    if (!run) return sendError(reply, 409, 'nothing_approved', 'Derlenecek onaylı cihaz yok.');
    if (run.status === 'hata') return sendError(reply, 502, 'dispatch_failed', `GitHub iş akışı başlatılamadı: ${run.error}`);
    return reply.code(202).send(run);
  });
}
