import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AVATAR_COLORS,
  HEX_COLOR,
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RESERVED_USERNAMES,
  USERNAME_PATTERN,
  type AuthResponse,
} from '@diskort/shared';
import { removeAccount } from '../accounts.js';
import type { AuthEventKind } from '../authLog.js';
import { parseBody, sendError, type AppContext } from '../context.js';

const displayName = z
  .string()
  .trim()
  .min(1, 'Görünen ad boş olamaz.')
  .max(DISPLAY_NAME_MAX_LENGTH, `Görünen ad en fazla ${DISPLAY_NAME_MAX_LENGTH} karakter olabilir.`);

const registerSchema = z.object({
  inviteCode: z.string().trim().min(1, 'Davet kodu gerekli.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_PATTERN, 'Kullanıcı adı 3-32 karakter; küçük harf, rakam, _ ve . içerebilir.')
    .refine((name) => !RESERVED_USERNAMES.includes(name), 'Bu kullanıcı adı kullanılamaz.'),
  password: z.string().min(PASSWORD_MIN_LENGTH, `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`).max(256),
  displayName: displayName.optional(),
});

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Kullanıcı adı gerekli.'),
  password: z.string().min(1, 'Şifre gerekli.'),
});

const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`)
  .max(256);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mevcut şifre gerekli.'),
  newPassword,
  /** İsteğe bağlı: bu cihazın bildirim jetonu (verilirse silinmez; verilmezse cihaz açılışta yeniden kaydeder) */
  pushToken: z.string().min(10).max(4096).optional(),
});

const resetPasswordSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Kullanıcı adı gerekli.'),
  code: z.string().trim().min(1, 'Sıfırlama kodu gerekli.'),
  newPassword,
});

const deleteAccountSchema = z.object({ password: z.string().min(1, 'Şifre gerekli.') });
const pushTokenSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(['android', 'ios']),
});
const removePushTokenSchema = z.object({ token: z.string().min(10).max(4096) });

const themeColor = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(HEX_COLOR, 'Geçersiz renk.'));

/**
 * Profil güncelleme şeması. Kaldırılan profil kozmetikleri (profileEffect, avatarDecoration, nameplate,
 * profileFrame) şemada yok: eski istemciler (0.11.3 ve öncesi) bunları hâlâ gönderebilir; zod nesnesi
 * bilinmeyen alanları sessizce atar (strip), istek reddedilmez ve aynı istekteki diğer alanlar kaydedilir.
 */
const updateMeSchema = z.object({
  displayName: displayName.optional(),
  avatarColor: z.enum(AVATAR_COLORS, { message: 'Geçersiz renk.' }).optional(),
  profileTheme: z.object({ primary: themeColor, accent: themeColor }).nullable().optional(),
});

/** Basit bellek içi deneme sınırlayıcı (kaba kuvvet girişimlerine karşı). */
function createLimiter(maxAttempts: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= maxAttempts;
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, push, authLog, counters } = ctx;
  const limit = createLimiter(20, 60_000);

  /** Yönetim panelinin giriş kayıtları (şifre ya da hesabı olmayan kullanıcı adı yazılmaz) */
  const audit = (
    req: FastifyRequest,
    kind: AuthEventKind,
    user: { id: string; username: string } | null,
    detail?: string,
  ): void => {
    authLog.record({
      kind,
      userId: user?.id ?? null,
      username: user?.username ?? null,
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
      ...(detail ? { detail } : {}),
    });
    counters.inc(`auth.${kind}`);
  };
  const limited = (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    audit(req, 'rate_limited', null, req.routeOptions.url ?? undefined);
    return sendError(reply, 429, 'rate_limited', 'Çok fazla deneme. Biraz bekle.');
  };

  app.post('/api/auth/register', async (req, reply) => {
    if (!limit(req.ip)) return limited(req, reply);
    const body = parseBody(registerSchema, req.body, reply);
    if (!body) return reply;

    // Hesabı olan biri sunucu davetiyle "Kayıt ol" ekranından kendi kullanıcı adı ve şifresiyle gelirse
    // (ör. eskiden atılıp geri dönen) giriş yapılır ve davetin sunucusuna katılır.
    const existing = store.getUserAuthByUsername(body.username);
    if (existing && (await auth.verifyPassword(existing.passwordHash, body.password))) {
      const invite = store.checkInvite(body.inviteCode);
      if (!invite.ok) return sendError(reply, 400, 'invite', invite.reason);
      if (!invite.invite.guild_id) return sendError(reply, 409, 'username', 'Bu kullanıcı adı alınmış.');
      const joined = store.joinWithInvite(body.inviteCode, existing.id);
      if (!joined.ok) {
        const banned = joined.reason === 'banned';
        return sendError(reply, banned ? 403 : 400, banned ? 'banned' : 'invite', joined.message);
      }
      if (!joined.alreadyMember) gateway.announceJoin(joined.guildId, existing.id);
      audit(req, 'join', existing);
      const user = store.getUser(existing.id)!;
      const response: AuthResponse = { token: await auth.issueToken(user.id), user };
      return reply.code(201).send(response);
    }
    const result = store.registerWithInvite({
      code: body.inviteCode,
      username: body.username,
      displayName: body.displayName ?? body.username,
      passwordHash: await auth.hashPassword(body.password),
    });
    if (!result.ok) {
      const status = result.reason === 'username' ? 409 : result.reason === 'banned' ? 403 : 400;
      return sendError(reply, status, result.reason, result.message);
    }
    // İlk kayıtla ana sunucunun sahibi belli olur
    if (!ctx.guild.ownerId) Object.assign(ctx.guild, store.getGuild(ctx.guild.id));
    // Ana sunucuya katıldıysa (ilk hesap ya da yönetici daveti) oranın üyeleri yeni üyeyi görür
    if (result.guildId) gateway.announceJoin(result.guildId, result.user.id);
    audit(req, 'register', result.user);
    const response: AuthResponse = { token: await auth.issueToken(result.user.id), user: result.user };
    return reply.code(201).send(response);
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!limit(req.ip)) return limited(req, reply);
    const body = parseBody(loginSchema, req.body, reply);
    if (!body) return reply;

    const record = store.getUserAuthByUsername(body.username);
    const valid = record ? await auth.verifyPassword(record.passwordHash, body.password) : false;
    if (!record || !valid) {
      audit(req, 'login_failed', record, record ? 'şifre hatalı' : 'böyle bir hesap yok');
      return sendError(reply, 401, 'invalid_credentials', 'Kullanıcı adı veya şifre hatalı.');
    }
    audit(req, 'login', record);
    const { passwordHash: _omit, ...user } = record;
    const response: AuthResponse = { token: await auth.issueToken(user.id), user };
    return response;
  });

  // Yöneticinin verdiği tek kullanımlık kodla şifre sıfırlama; başarılı olursa giriş yapılmış olur.
  app.post('/api/auth/reset', async (req, reply) => {
    if (!limit(req.ip)) return limited(req, reply);
    const body = parseBody(resetPasswordSchema, req.body, reply);
    if (!body) return reply;
    const userId = store.consumeResetCode(body.username, body.code);
    if (!userId) {
      audit(req, 'login_failed', store.getUserAuthByUsername(body.username), 'sıfırlama kodu hatalı');
      return sendError(reply, 400, 'invalid_code', 'Kullanıcı adı veya sıfırlama kodu hatalı ya da kodun süresi dolmuş.');
    }
    store.setPassword(userId, await auth.hashPassword(body.newPassword));
    // Hesap başkasının elinde olabilir: açık bağlantıların hepsi kapanır, hiçbir cihaza bildirim gitmez
    // (kişinin kendi telefonu giriş yapınca ya da uygulama açılınca jetonunu yeniden kaydeder)
    gateway.disconnectUser(userId, 'Şifren sıfırlandı. Yeniden giriş yap.');
    store.removeUserPushTokens(userId);
    const user = store.getUser(userId)!;
    audit(req, 'reset', user);
    const response: AuthResponse = { token: await auth.issueToken(user.id), user };
    return response;
  });

  app.get('/api/me', { preHandler: auth.requireUser }, async (req) => req.user);

  // Şifre değişince eski jetonlar geçersizleşir (setPassword) ve diğer cihazların açık gateway bağlantıları
  // hemen kapanır (INVALID_SESSION + 4004). Bu cihaz yanıttaki yeni jetonla devam eder; açık bağlantısı
  // (aynı jetonla bağlanmış olan) kapanmaz, yeniden bağlanırken yeni jetonu kullanır. Bildirim jetonları
  // hangi cihaza ait olduğu bilinmediğinden silinir; istek bu cihazın jetonunu (pushToken) taşıyorsa o kalır,
  // taşımıyorsa uygulama bir sonraki açılışta ya da girişte jetonunu yeniden kaydeder.
  app.post('/api/me/password', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!limit(req.ip)) return limited(req, reply);
    const body = parseBody(changePasswordSchema, req.body, reply);
    if (!body) return reply;
    const record = store.getUserAuthByUsername(req.user.username);
    if (!record || !(await auth.verifyPassword(record.passwordHash, body.currentPassword))) {
      audit(req, 'login_failed', req.user, 'şifre değiştirirken mevcut şifre hatalı');
      return sendError(reply, 400, 'invalid_password', 'Mevcut şifre hatalı.');
    }
    store.setPassword(req.user.id, await auth.hashPassword(body.newPassword));
    const header = req.headers.authorization;
    gateway.disconnectUser(req.user.id, 'Şifren değiştirildi. Yeniden giriş yap.', {
      exceptToken: header?.startsWith('Bearer ') ? header.slice(7) : '',
    });
    store.removeUserPushTokens(req.user.id, body.pushToken);
    audit(req, 'password', req.user);
    const response: AuthResponse = { token: await auth.issueToken(req.user.id), user: req.user };
    return response;
  });

  // Telefon bildirimleri için cihaz jetonu (uygulama açılışta ve jeton yenilenince gönderir)
  app.post('/api/me/push-tokens', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(pushTokenSchema, req.body, reply);
    if (!body) return reply;
    store.savePushToken(req.user.id, body.token, body.platform);
    return reply.code(204).send();
  });

  // Çıkış yaparken: bu cihaza artık bu hesabın bildirimleri gitmesin
  app.delete('/api/me/push-tokens', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(removePushTokenSchema, req.body, reply);
    if (!body) return reply;
    store.removePushToken(body.token);
    return reply.code(204).send();
  });

  // Ayarlardaki "Test bildirimi gönder"
  app.post('/api/me/push-test', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!limit(req.ip)) return sendError(reply, 429, 'rate_limited', 'Çok fazla deneme. Biraz bekle.');
    if (!push.enabled) return sendError(reply, 503, 'push_disabled', 'Sunucuda telefon bildirimleri kapalı.');
    return { devices: await push.sendTest(req.user.id) };
  });

  // Kullanıcı kendi hesabını siler (şifre onayıyla). Bir sunucunun sahibi, sunucu sahipsiz kalmasın diye
  // önce sahipliği devretmeli ya da sunucuyu silmelidir.
  app.delete('/api/me', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!limit(req.ip)) return sendError(reply, 429, 'rate_limited', 'Çok fazla deneme. Biraz bekle.');
    const body = parseBody(deleteAccountSchema, req.body, reply);
    if (!body) return reply;
    const record = store.getUserAuthByUsername(req.user.username);
    if (!record || !(await auth.verifyPassword(record.passwordHash, body.password))) {
      return sendError(reply, 400, 'invalid_password', 'Şifre hatalı.');
    }
    if (store.ownedGuildIds(req.user.id).length > 0) {
      return sendError(
        reply,
        400,
        'owner',
        'Bir sunucunun sahibi hesabını silemez. Önce Sunucu Ayarları > Genel bölümünden sahipliği başka birine devret ya da sunucuyu sil.',
      );
    }
    await removeAccount(ctx, req.user.id, 'Hesabın silindi.');
    return reply.code(204).send();
  });

  app.patch('/api/me', { preHandler: auth.requireUser }, async (req, reply) => {
    const body = parseBody(updateMeSchema, req.body, reply);
    if (!body) return reply;
    const user = store.updateUser(req.user.id, body)!;
    gateway.sendUserUpdate(user);
    return user;
  });
}
