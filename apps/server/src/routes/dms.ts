import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DM_GROUP_MAX_PARTICIPANTS,
  DM_NAME_MAX_LENGTH,
  hasPermission,
  Permission,
  type DmChannel,
} from '@diskort/shared';
import { forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { createRateLimiter } from './messages.js';

const dmName = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().max(DM_NAME_MAX_LENGTH, `Grup adı en fazla ${DM_NAME_MAX_LENGTH} karakter olabilir.`))
  .nullable();

const createSchema = z.object({
  userIds: z
    .array(z.string().min(1).max(64))
    .min(1, 'En az bir kişi seçmelisin.')
    .max(DM_GROUP_MAX_PARTICIPANTS - 1, `Bir grupta en fazla ${DM_GROUP_MAX_PARTICIPANTS} kişi olabilir.`),
  name: dmName.optional(),
});
const updateSchema = z.object({ name: dmName });
const ringSchema = z.object({ userId: z.string().min(1).max(64).optional() });

/**
 * Direkt mesajlar: bire bir ve küçük grup konuşmaları. Mesajlar metin kanallarıyla aynı uçlardan
 * gider (/api/channels/:id/messages); burada konuşmaların kendisi yönetilir. Yalnızca katılımcılar
 * erişir; yönetici ya da sahip de başkasının konuşmasını göremez (yokmuş gibi 404). Konuşma yalnızca
 * ortak bir sunucusu olan kişilerle ya da arkadaşlarla başlatılır, gruba da yalnızca onlar eklenir; başkası
 * yokmuş gibi 404.
 */
export function registerDmRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, permissions, attachments, calls, voice, moderation } = ctx;
  const allowCreate = createRateLimiter(10, 60_000);
  const allowRing = createRateLimiter(10, 60_000);
  const allowBlock = createRateLimiter(30, 60_000);

  /** Kullanıcının katıldığı konuşma; değilse yokmuş gibi 404 */
  const ownDm = (id: string, userId: string, reply: FastifyReply): DmChannel | null => {
    const dm = permissions.isDm(id) && permissions.canView(userId, id) ? store.getDm(id) : null;
    if (!dm) void sendError(reply, 404, 'not_found', 'Konuşma bulunamadı.');
    return dm;
  };

  /** Konuşmayı katılımcılarına güncel hâliyle duyurur */
  const announce = (dm: DmChannel, except?: string): void => {
    gateway.sendDm(
      dm.participantIds.filter((id) => id !== except),
      { t: 'DM_CHANNEL_UPDATE', d: dm },
    );
  };

  app.get('/api/dms', { preHandler: auth.requireUser }, async (req) => store.listDms(req.user.id));

  // Tek kişi: bire bir konuşma (varsa aynısı); birden çok kişi: yeni grup
  app.post('/api/dms', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(createSchema, req.body, reply);
    if (!body) return reply;
    const others = [...new Set(body.userIds)].filter((id) => id !== req.user.id);
    if (others.length === 0) return sendError(reply, 400, 'invalid_body', 'Kendine mesaj gönderemezsin.');
    for (const id of others) {
      if (!permissions.canReach(req.user.id, id) || !store.getUser(id)) {
        return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
      }
    }
    // Sınır yalnızca yeni konuşmaya: var olan bire bir konuşmayı açmak serbest
    const existing = others.length === 1 ? store.directDmId(req.user.id, others[0]!) : null;
    // Engel: yeni bire bir konuşma açılamaz (var olan salt okunur açılır), engelli çiftle grup kurulamaz.
    // Engellenen kişiye neden söylenmez.
    const blocked = others.filter((id) => permissions.blockedEither(req.user.id, id));
    if (blocked.length > 0 && !existing) {
      const mine = blocked.some((id) => permissions.hasBlocked(req.user.id, id));
      return forbidden(
        reply,
        others.length === 1
          ? mine
            ? 'Bu kişiyi engelledin; mesaj göndermek için önce engeli kaldır.'
            : 'Bu kişiye şu an mesaj gönderemezsin.'
          : mine
            ? 'Engellediğin biriyle grup kuramazsın.'
            : 'Seçtiğin kişilerden biri bu gruba eklenemiyor.',
      );
    }
    if (!existing && !allowCreate(req.user.id)) {
      return sendError(reply, 429, 'rate_limited', 'Çok hızlı konuşma başlatıyorsun, biraz bekle.');
    }
    if (others.length === 1) {
      const { dm, created, opened } = store.openDirectDm(req.user.id, others[0]!);
      if (opened) gateway.sendDm([req.user.id], { t: 'DM_CHANNEL_CREATE', d: dm });
      return reply.code(created ? 201 : 200).send(dm);
    }
    const dm = store.createGroupDm(req.user.id, others, body.name || null);
    gateway.sendDm(dm.participantIds, { t: 'DM_CHANNEL_CREATE', d: dm });
    return reply.code(201).send(dm);
  });

  // Grubun adı (her katılımcı değiştirebilir)
  app.patch<{ Params: { id: string } }>('/api/dms/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const dm = ownDm(req.params.id, req.user.id, reply);
    if (!dm) return reply;
    if (!dm.group) return sendError(reply, 400, 'not_group', 'Yalnızca grupların adı olur.');
    const body = parseBody(updateSchema, req.body, reply);
    if (!body) return reply;
    const updated = store.renameDm(dm.id, body.name || null)!;
    announce(updated);
    return updated;
  });

  // Bire bir konuşma listeden kaldırılır (yeni mesaj gelince yeniden görünür); gruptan ayrılınır
  app.delete<{ Params: { id: string } }>('/api/dms/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const dm = ownDm(req.params.id, req.user.id, reply);
    if (!dm) return reply;
    if (!dm.group) {
      if (store.closeDm(dm.id, req.user.id)) gateway.sendDm([req.user.id], { t: 'DM_CHANNEL_DELETE', d: { id: dm.id } });
      return reply.code(204).send();
    }
    const { deleted, files } = store.leaveDm(dm.id, req.user.id);
    gateway.sendDm([req.user.id], { t: 'DM_CHANNEL_DELETE', d: { id: dm.id } });
    if (!deleted) announce(store.getDm(dm.id)!);
    // Gruptan ayrılan, grubun aramasındaysa çıkarılır; çalınıyorsa çalma biter
    calls.participantLeft(dm.id, req.user.id);
    // Ayrılan artık katılımcı değil, aramanın sonraki olaylarını almaz: aramayı kendi listesinden kaldırsın
    if (calls.get(dm.id)) gateway.sendDm([req.user.id], { t: 'DM_CALL_DELETE', d: { channelId: dm.id } });
    if (voice.get(req.user.id)?.channelId === dm.id) await moderation.disconnect(req.user.id);
    await attachments.remove(files);
    return reply.code(204).send();
  });

  // Gruba kişi eklemek (her katılımcı); eklenen, geçmişin tamamını görür
  app.put<{ Params: { id: string; userId: string } }>(
    '/api/dms/:id/participants/:userId',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const dm = ownDm(req.params.id, req.user.id, reply);
      if (!dm) return reply;
      if (!dm.group) {
        return sendError(reply, 400, 'not_group', 'Bire bir konuşmaya kişi eklenemez; yeni bir grup başlat.');
      }
      if (!hasPermission(permissions.inChannel(req.user.id, dm.id), Permission.SEND_MESSAGES)) return forbidden(reply);
      const target = store.getUser(req.params.userId);
      if (!target || !permissions.canReach(req.user.id, target.id)) {
        return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
      }
      if (dm.participantIds.includes(target.id)) return dm;
      // Ekleyenle eklenen arasında engel varsa eklenemez (engellenen kişiye neden söylenmez)
      if (permissions.blockedEither(req.user.id, target.id)) {
        return forbidden(
          reply,
          permissions.hasBlocked(req.user.id, target.id)
            ? 'Engellediğin kişiyi gruba ekleyemezsin.'
            : 'Bu kişi gruba eklenemiyor.',
        );
      }
      if (dm.participantIds.length >= DM_GROUP_MAX_PARTICIPANTS) {
        return sendError(reply, 400, 'group_full', `Bir grupta en fazla ${DM_GROUP_MAX_PARTICIPANTS} kişi olabilir.`);
      }
      store.addDmParticipant(dm.id, target.id);
      const updated = store.getDm(dm.id)!;
      gateway.sendDm([target.id], { t: 'DM_CHANNEL_CREATE', d: updated });
      announce(updated, target.id);
      // Grupta arama sürüyorsa yeni katılımcı da onu görür (çalınmaz; aramadakiler çalabilir)
      // Ses durumları yalnızca değişince dağıtıldığından aramadakiler de ayrıca gönderilir
      const call = calls.get(dm.id);
      if (call) {
        for (const state of voice.list()) {
          if (state.channelId === dm.id) gateway.sendDm([target.id], { t: 'VOICE_STATE_UPDATE', d: state });
        }
        gateway.sendDm([target.id], { t: 'DM_CALL_UPDATE', d: call });
      }
      return updated;
    },
  );

  // ---------- Aramalar ----------
  // Arama, konuşmanın ses odasına (POST /api/voice/:id/join) ilk kişi bağlanınca başlar; burada yalnızca
  // çalmanın yönetimi var (bkz. dmCalls.ts).

  // Çalan aramayı reddet (ya da başka cihazda yanıtlandı): yalnızca senin için çalma biter. Tekrarlanabilir.
  app.post<{ Params: { id: string } }>('/api/dms/:id/call/decline', { preHandler: auth.requireUser }, async (req, reply) => {
    const dm = ownDm(req.params.id, req.user.id, reply);
    if (!dm) return reply;
    calls.decline(dm.id, req.user.id);
    return reply.code(204).send();
  });

  // Aramadaki biri, aramada olmayan bir katılımcıyı (userId yoksa hepsini) yeniden çalar. Çalınamayan
  // (Rahatsız Etmeyin, engel, zaten aramada) sessizce atlanır.
  app.post<{ Params: { id: string } }>('/api/dms/:id/call/ring', { preHandler: auth.requireUser }, async (req, reply) => {
    const dm = ownDm(req.params.id, req.user.id, reply);
    if (!dm) return reply;
    const body = parseBody(ringSchema, req.body, reply);
    if (!body) return reply;
    if (voice.get(req.user.id)?.channelId !== dm.id || !calls.get(dm.id)) {
      return sendError(reply, 409, 'not_in_call', 'Bu konuşmanın aramasında değilsin.');
    }
    if (body.userId !== undefined && !dm.participantIds.includes(body.userId)) {
      return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    }
    if (!allowRing(req.user.id)) return sendError(reply, 429, 'rate_limited', 'Çok sık çalıyorsun, biraz bekle.');
    calls.ring(dm.id, req.user.id, body.userId !== undefined ? [body.userId] : null);
    return reply.code(204).send();
  });

  // ---------- Engellemeler ----------
  // Engelleyen kendi listesini görür; engellenen hiçbir yanıttan engellendiğini öğrenmez (yalnızca bire bir
  // konuşma salt okunur olur, bkz. DmChannel.readOnly). Sunucu kanallarında hiçbir şeyi değiştirmez. Engellemek
  // arkadaşlığı ve iki yöndeki bekleyen arkadaşlık isteklerini kaldırır.

  app.get('/api/me/blocks', { preHandler: auth.requireUser }, async (req) => store.listBlocks(req.user.id));

  /** Engel değişti: engelleyenin listesi, bire bir konuşmanın salt okunur durumu, süren bire bir arama */
  const blocksChanged = async (userId: string, otherId: string, readOnlyBefore: boolean): Promise<void> => {
    gateway.sendBlocks(userId);
    const dmId = store.directDmId(userId, otherId);
    if (!dmId) return;
    if (permissions.blockedEither(userId, otherId) !== readOnlyBefore) {
      // Yalnızca konuşmayı listesinde açık tutanlara (kapatmış olanın listesine geri eklenmesin)
      gateway.sendDm(store.openDmParticipants(dmId), { t: 'DM_CHANNEL_UPDATE', d: store.getDm(dmId)! });
    }
    if (!permissions.blockedEither(userId, otherId)) return;
    // Bire bir arama iki taraf için de biter (konuşma salt okunur: arama yetkisi de kalmadı)
    for (const v of voice.list()) if (v.channelId === dmId) await moderation.disconnect(v.userId);
  };

  app.put<{ Params: { userId: string } }>('/api/me/blocks/:userId', { preHandler: auth.requireUser }, async (req, reply) => {
    const targetId = req.params.userId;
    if (targetId === req.user.id) return sendError(reply, 400, 'invalid_body', 'Kendini engelleyemezsin.');
    if (!store.getUser(targetId)) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (!allowBlock(req.user.id)) return sendError(reply, 429, 'rate_limited', 'Çok sık değişiklik yapıyorsun, biraz bekle.');
    const before = permissions.blockedEither(req.user.id, targetId);
    // Engel arkadaşlığı ve bekleyen istekleri de kaldırır (store.block)
    const wasFriend = store.areFriends(req.user.id, targetId);
    const hadRequest = store.hasFriendRequest(req.user.id, targetId) || store.hasFriendRequest(targetId, req.user.id);
    if (store.block(req.user.id, targetId)) {
      calls.onBlocked(req.user.id, targetId);
      await blocksChanged(req.user.id, targetId, before);
    }
    if (wasFriend) gateway.friendshipChanged(req.user.id, targetId);
    else if (hadRequest) gateway.sendFriends([req.user.id, targetId]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { userId: string } }>('/api/me/blocks/:userId', { preHandler: auth.requireUser }, async (req, reply) => {
    const targetId = req.params.userId;
    if (!allowBlock(req.user.id)) return sendError(reply, 429, 'rate_limited', 'Çok sık değişiklik yapıyorsun, biraz bekle.');
    const before = permissions.blockedEither(req.user.id, targetId);
    if (store.unblock(req.user.id, targetId)) await blocksChanged(req.user.id, targetId, before);
    return reply.code(204).send();
  });
}
