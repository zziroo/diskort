import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, type AppContext } from '../context.js';
import type { DashboardService } from '../dashboard.js';

const querySchema = z.object({
  /** İstemcinin Date#getTimezoneOffset() değeri: "bugün" ve günlük mesaj sayıları onun gününe göre */
  tz: z.coerce.number().int().min(-900).max(900).optional(),
});

/**
 * Yönetim paneli (site: /admin), yalnızca hesap yöneticilerine: kullanım, ses, sunucu yükü, istemci
 * sürümleri, son hatalar ve geri bildirim özeti tek yanıtta. Panel açıkken birkaç saniyede bir istenir;
 * pahalı parçalar önbelleklidir (bkz. dashboard.ts).
 */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext, dashboard: DashboardService): void {
  app.get('/api/admin/dashboard', { preHandler: ctx.auth.requireInstanceAdmin }, async (req, reply) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz istek.');
    // Yanıt her istekte yenidir; ara katmanlar saklamasın
    void reply.header('Cache-Control', 'no-store');
    return dashboard.build(query.data.tz ?? 0);
  });
}
