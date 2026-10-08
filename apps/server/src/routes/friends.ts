import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FRIEND_REQUESTS_OUTGOING_MAX, type FriendRequestResponse } from '@diskort/shared';
import { forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { createRateLimiter } from './messages.js';

/** Aynı gönderen→alıcı çifti için telefon bildirimleri arasındaki en kısa süre */
const FRIEND_PUSH_COOLDOWN_MS = 10 * 60_000;

const requestSchema = z.object({
  username: z
    .string()
    .trim()
    .transform((s) => s.replace(/^@/, '').toLowerCase())
    .pipe(z.string().min(1, 'Kullanıcı adı gerekli.').max(64, 'Kullanıcı adı çok uzun.')),
});

/**
 * Arkadaşlar: kullanıcı adıyla istek, kabul/ret/geri çekme, arkadaşlıktan çıkma. Arkadaşlar ortak sunucuları
 * olmasa da bire bir DM açabilir ve birbirini gruba ekleyebilir (bkz. PermissionService.canReach). Her
 * değişiklikte iki tarafa da kendi güncel listesi gider (FRIENDS_UPDATE); yanıt da isteği yapanın güncel
 * listesidir.
 *
 * Engel: seni engellemiş birine istek gönderilemez; nedeni söylenmez, DM açmadaki gibi genel bir 403 döner
 * (ortak sunucuda gördüğün birine "bulunamadı" demek engeli ele verirdi); senin engellediğine göndermeye
 * çalışırsan nedeni söylenir. Engellemek arkadaşlığı ve istekleri kaldırır
 * (routes/dms.ts).
 */
export function registerFriendRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, permissions, push, moderation } = ctx;
  const allowRequest = createRateLimiter(20, 60_000);
  const allowChange = createRateLimiter(30, 60_000);
  const notifiedAt = new Map<string, number>();

  app.get('/api/friends', { preHandler: auth.requireUser }, async (req) => store.listFriends(req.user.id));

  // Kullanıcı adıyla istek. Karşı tarafın sana bekleyen isteği varsa kabul sayılır; zaten arkadaşsanız ya da
  // istek zaten bekliyorsa bir şey değişmez (tekrarlanabilir).
  app.post('/api/friends/requests', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(requestSchema, req.body, reply);
    if (!body) return reply;
    const me = req.user.id;
    if (!allowRequest(me)) return sendError(reply, 429, 'rate_limited', 'Çok sık istek gönderiyorsun, biraz bekle.');
    const target = store.getUserAuthByUsername(body.username);
    if (!target) return sendError(reply, 404, 'not_found', 'Kullanıcı bulunamadı.');
    if (target.id === me) return sendError(reply, 400, 'invalid_body', 'Kendine arkadaşlık isteği gönderemezsin.');
    if (permissions.hasBlocked(me, target.id)) {
      return forbidden(reply, 'Bu kişiyi engelledin; arkadaş eklemek için önce engeli kaldır.');
    }
    // Seni engellemiş kişi: neden söylenmez (routes/dms.ts ile aynı ileti)
    if (permissions.hasBlocked(target.id, me)) return forbidden(reply, 'Bu kişiye şu an arkadaşlık isteği gönderemezsin.');
    const isNew =
      !store.areFriends(me, target.id) && !store.hasFriendRequest(target.id, me) && !store.hasFriendRequest(me, target.id);
    if (isNew && store.outgoingFriendRequestCount(me) >= FRIEND_REQUESTS_OUTGOING_MAX) {
      return sendError(
        reply,
        400,
        'too_many_requests',
        `En fazla ${FRIEND_REQUESTS_OUTGOING_MAX} bekleyen istek gönderebilirsin; önce bazılarını geri çek.`,
      );
    }
    const result = store.sendFriendRequest(me, target.id);
    if (result === 'accepted') {
      gateway.friendshipChanged(me, target.id);
    } else if (result === 'requested') {
      gateway.sendFriends([me, target.id]);
      // Telefon bildirimi yanıtı bekletmez; Rahatsız Etmeyin'dekilere ve masaüstünde etkin olanlara gitmez.
      // İstek at / geri çek / tekrar at döngüsü telefonu çaldırmasın: aynı çift için en çok 10 dakikada bir
      const pair = `${me}>${target.id}`;
      const now = Date.now();
      if ((notifiedAt.get(pair) ?? 0) <= now - FRIEND_PUSH_COOLDOWN_MS) {
        notifiedAt.set(pair, now);
        if (notifiedAt.size > 5000) for (const [k, t] of notifiedAt) if (t <= now - FRIEND_PUSH_COOLDOWN_MS) notifiedAt.delete(k);
        void push.notifyFriendRequest(me, gateway.pushRecipients([target.id]));
      }
    }
    const response: FriendRequestResponse = {
      status: result === 'friends' || result === 'accepted' ? 'friends' : 'pending',
      ...store.listFriends(me),
    };
    return reply.code(result === 'requested' ? 201 : 200).send(response);
  });

  // Gelen isteği kabul et (zaten arkadaşsanız bir şey değişmez)
  app.post<{ Params: { userId: string } }>(
    '/api/friends/requests/:userId/accept',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const me = req.user.id;
      const other = req.params.userId;
      if (!allowChange(me)) return sendError(reply, 429, 'rate_limited', 'Çok sık değişiklik yapıyorsun, biraz bekle.');
      if (store.areFriends(me, other)) return store.listFriends(me);
      // Engel varken istek kalmaz (engellemek siler); yine de kabul edilmez
      if (permissions.blockedEither(me, other) || !store.acceptFriendRequest(me, other)) {
        return sendError(reply, 404, 'not_found', 'Arkadaşlık isteği bulunamadı.');
      }
      gateway.friendshipChanged(me, other);
      return store.listFriends(me);
    },
  );

  // Gelen isteği reddet ya da gönderdiğin isteği geri çek (tekrarlanabilir). Karşı tarafa yalnızca isteğin
  // listesinden kalktığı gider; reddedildiği ayrıca söylenmez.
  app.delete<{ Params: { userId: string } }>(
    '/api/friends/requests/:userId',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const me = req.user.id;
      if (!allowChange(me)) return sendError(reply, 429, 'rate_limited', 'Çok sık değişiklik yapıyorsun, biraz bekle.');
      if (store.deleteFriendRequest(me, req.params.userId)) gateway.sendFriends([me, req.params.userId]);
      return store.listFriends(me);
    },
  );

  // Arkadaşlıktan çıkar (tekrarlanabilir). Ortak sunucunuz yoksa bire bir konuşmanız salt okunur olur (geçmiş
  // kalır), süren bire bir arama biter; gruplar etkilenmez.
  app.delete<{ Params: { userId: string } }>('/api/friends/:userId', { preHandler: auth.requireUser }, async (req, reply) => {
    const me = req.user.id;
    if (!allowChange(me)) return sendError(reply, 429, 'rate_limited', 'Çok sık değişiklik yapıyorsun, biraz bekle.');
    if (store.removeFriend(me, req.params.userId)) {
      gateway.friendshipChanged(me, req.params.userId);
      void moderation.enforceDmCalls();
    }
    return store.listFriends(me);
  });
}
