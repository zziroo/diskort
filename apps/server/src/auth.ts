import { hash, verify } from '@node-rs/argon2';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@diskort/shared';
import type { Store } from './db.js';
import type { PermissionService } from './permissions.js';

/** Oturum jetonunun ömrü (verildiği andan). Bu süre içinde yenilenmeyen oturum düşer. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Bundan eski bir jetonla bağlanan (ya da bağlı kalan) istemciye gateway yeni jeton verir (SESSION_TOKEN):
 * uygulamayı kullanmaya devam eden kişi hiç düşmez, bir ay uğramayan düşer.
 */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly store: Store,
    private readonly permissions: PermissionService,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  hashPassword(password: string): Promise<string> {
    return hash(password);
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Oturum jetonu. `issuedAt` yalnızca testler için (eski tarihli jeton). */
  issueToken(userId: string, issuedAt = Date.now()): Promise<string> {
    const iat = Math.floor(issuedAt / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + Math.floor(SESSION_TTL_MS / 1000))
      .sign(this.key);
  }

  /**
   * Jetonun verildiği an (ms). İmza doğrulanmaz: yalnızca userFromToken'dan geçmiş bir jeton için,
   * yenileme zamanını hesaplamak üzere çağrılır.
   */
  tokenIssuedAt(token: string): number | null {
    try {
      const iat = decodeJwt(token).iat;
      return typeof iat === 'number' ? iat * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Geçerli bir oturum jetonuysa kullanıcıyı döner. Şifre değiştikten önce verilmiş jetonlar geçersizdir.
   * Hesap hiçbir sunucunun üyesi olmasa da giriş yapabilir (sunucu kurar ya da davetle katılır).
   */
  async userFromToken(token: string): Promise<User | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (!payload.sub || payload.iat === undefined) return null;
      const validAfter = this.store.getSessionsValidAfter(payload.sub);
      if (validAfter === null || payload.iat * 1000 < validAfter) return null;
      return this.store.getUser(payload.sub);
    } catch {
      return null;
    }
  }

  /** Fastify preHandler: Authorization: Bearer <token> */
  requireUser = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const user = token ? await this.userFromToken(token) : null;
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Oturum geçersiz, tekrar giriş yap.' });
      return;
    }
    req.user = user;
  };

  /**
   * Fastify preHandler: yoldaki :guildId sunucusunun üyesi olmalı. Üye olmayan için sunucu yokmuş gibi 404
   * (başkalarının sunucularının varlığı bile anlaşılmasın).
   */
  requireMember = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await this.requireUser(req, reply);
    if (reply.sent) return;
    const guildId = (req.params as { guildId?: string } | undefined)?.guildId ?? '';
    if (!this.permissions.isMember(guildId, req.user.id)) {
      await reply.code(404).send({ error: 'not_found', message: 'Sunucu bulunamadı.' });
    }
  };

  /** Fastify preHandler: :guildId sunucusunda verilen yetkiyi ister (sahip ve yöneticiler hepsine sahiptir). */
  requireGuildPermission(flag: number) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await this.requireMember(req, reply);
      if (reply.sent) return;
      const guildId = (req.params as { guildId: string }).guildId;
      if (!this.permissions.canInGuild(guildId, req.user.id, flag)) {
        await reply.code(403).send({ error: 'forbidden', message: 'Bu işlem için yetkin yok.' });
      }
    };
  }

  /** Fastify preHandler: hesap yöneticisi (users.is_admin; sunuculardan bağımsız) */
  requireInstanceAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await this.requireUser(req, reply);
    if (reply.sent) return;
    if (!this.permissions.isInstanceAdmin(req.user.id)) {
      await reply.code(403).send({ error: 'forbidden', message: 'Bu işlem için yetkin yok.' });
    }
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}
