import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CHANNEL_LINKS_MAX_PAGE_SIZE,
  CHANNEL_LINKS_PAGE_SIZE,
  CHANNEL_MEDIA_MAX_PAGE_SIZE,
  CHANNEL_MEDIA_PAGE_SIZE,
  extractEmbedUrls,
  hasPermission,
  linkEmbedsOf,
  mentionsEveryone,
  mentionsHere,
  MESSAGE_MAX_ATTACHMENTS,
  MESSAGE_MAX_LENGTH,
  MESSAGE_MAX_REACTIONS,
  MESSAGE_PAGE_SIZE,
  MAX_PINS_PER_CHANNEL,
  Permission,
  REACTION_USERS_MAX_PAGE_SIZE,
  REACTION_USERS_PAGE_SIZE,
  type Channel,
  type ChannelLinkItem,
  type ChannelMediaItem,
  type ChannelPanelPage,
  type Embed,
  type LinkEmbed,
  type Message,
  type MessageUpdate,
} from '@diskort/shared';
import { ATTACHMENT_ID } from '../attachments.js';
import { forbidden, parseBody, sendError, type AppContext } from '../context.js';
import { normalizeEmoji } from '../emoji.js';

// Kontrol karakterlerini (satır sonu ve sekme hariç) temizler.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Boş metin ancak mesajda dosya varsa kabul edilir (aşağıda denetlenir)
const content = z
  .string()
  .transform((s) => s.replace(CONTROL_CHARS, '').trim())
  .pipe(z.string().max(MESSAGE_MAX_LENGTH, `Mesaj en fazla ${MESSAGE_MAX_LENGTH} karakter olabilir.`));

const EMPTY_MESSAGE = 'Mesaj boş olamaz.';

const createSchema = z
  .object({
    content: content.optional(),
    attachmentIds: z
      .array(z.string().regex(ATTACHMENT_ID, 'Geçersiz dosya.'))
      .max(MESSAGE_MAX_ATTACHMENTS, `Bir mesaja en fazla ${MESSAGE_MAX_ATTACHMENTS} dosya eklenebilir.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Aynı dosya iki kez eklenemez.')
      .optional(),
    replyToId: z.string().regex(/^\d+$/, 'Geçersiz yanıt.').nullish(),
    replyMention: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.content) || Boolean(b.attachmentIds?.length), EMPTY_MESSAGE);
const editSchema = z.object({ content });
const ackSchema = z.object({ messageId: z.string().regex(/^\d+$/) });
const listQuery = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Kanal panelinin "Medya" sayfası: before = önceki sayfanın son öğesi (<mesaj kimliği>_<dosya sırası>) */
const mediaQuery = z.object({
  before: z.string().regex(/^\d{1,15}_\d{1,3}$/).optional(),
  limit: z.coerce.number().int().min(1).max(CHANNEL_MEDIA_MAX_PAGE_SIZE).optional(),
});
/** Kanal panelinin "Bağlantılar" sayfası: before = taranan en eski mesajın kimliği */
const linksQuery = z.object({
  before: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(CHANNEL_LINKS_MAX_PAGE_SIZE).optional(),
});

const reactionUsersQuery = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}_[^\s]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(REACTION_USERS_MAX_PAGE_SIZE).optional(),
});

/** Gateway'e giden güncelleme: tepkilerin `me` alanı kişiye özel olduğundan çıkarılır. */
const toUpdate = ({ reactions: _reactions, ...message }: Message): MessageUpdate => message;

/** Sınırlayıcıda bu kadar anahtar birikince süresi dolanlar temizlenir... */
const LIMITER_SWEEP_AT = 10_000;
/** ...temizlikten sonra da bundan fazlası kalırsa en uzun süredir istek atmayanlar unutulur */
const LIMITER_MAX_KEYS = 50_000;

/**
 * Kullanıcı (ya da IP) başına istek sınırı (varsayılan: 10 saniyede en fazla 10). Anahtarlar son isteğe
 * göre sıralı tutulur; çok birikince süresi dolanlar silinir, bellek sınırsız büyümez.
 */
export function createRateLimiter(max = 10, windowMs = 10_000) {
  const hits = new Map<string, number[]>();
  let nextSweep = 0;
  const allow = (key: string): boolean => {
    const now = Date.now();
    if (hits.size > LIMITER_SWEEP_AT && (now >= nextSweep || hits.size > LIMITER_MAX_KEYS)) {
      nextSweep = now + Math.min(windowMs, 60_000);
      for (const [k, times] of hits) {
        if (now - (times[times.length - 1] ?? 0) >= windowMs) hits.delete(k);
      }
      // Hâlâ çoksa (ör. çok sayıda adresten sel) en eskiler: Map ekleme sırasında, en eski baştadır
      if (hits.size > LIMITER_MAX_KEYS) {
        for (const k of hits.keys()) {
          if (hits.size <= LIMITER_SWEEP_AT) break;
          hits.delete(k);
        }
      }
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    // Silip yeniden eklemek anahtarı sona taşır (en son istek atanlar sonda)
    hits.delete(key);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
  return Object.assign(allow, {
    /** Tutulan anahtar sayısı (testler için) */
    size: () => hits.size,
  });
}

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, auth, gateway, push, attachments, permissions, gifs, linkPreviews } = ctx;
  const allowMessage = createRateLimiter();
  const allowReaction = createRateLimiter(30);

  /**
   * Salt okunur DM'de yazılamadığının iletisi: engelleyene kendi engeli hatırlatılır; engellenene (ve ortak
   * sunucusu kalmayana) yalnızca genel ileti (engel söylenmez).
   */
  const dmReadOnlyMessage = (userId: string, channelId: string): string =>
    permissions.blockedPartnerOf(userId, channelId) === 'self'
      ? 'Bu kişiyi engelledin; mesaj göndermek için önce engeli kaldır.'
      : 'Bu konuşmaya artık mesaj gönderemezsin.';

  /** Yeni mesaja gömülü içeriği (GIF) yazar */
  const withEmbeds = (message: Message, embeds: Embed[]): Message => {
    store.setMessageEmbeds(Number(message.id), embeds);
    return { ...message, embeds };
  };

  /** Önizlenecek bağlantılar: önizleme kapalıysa, kaldırıldıysa ya da mesaj bir GIF ise yok */
  const previewUrls = (content: string, suppressed: boolean | undefined, embeds: Embed[]): string[] =>
    linkPreviews && !suppressed && !embeds.some((e) => e.type === 'gif') ? extractEmbedUrls(content) : [];

  /**
   * Hemen eklenebilecek önizlemeler: önbellekte olanlar, yoksa mesajda zaten olanlar (düzenlemede, yenisi
   * hazırlanana kadar). Metinden çıkarılan bağlantıların önizlemeleri böylece hemen kalkar.
   */
  const knownLinks = (urls: string[], current: LinkEmbed[] = []): LinkEmbed[] =>
    urls
      .map((url) => {
        const cached = linkPreviews?.cached(url);
        return cached === undefined ? current.find((e) => e.url === url) : cached;
      })
      .filter((e): e is LinkEmbed => Boolean(e));

  /**
   * Bağlantı önizlemelerini arka planda hazırlar; hazır olunca (mesaj bu arada değişmediyse) mesaja yazar
   * ve kanalı görenlere MESSAGE_UPDATE gönderir. Önbellekte olanlar hemen gelir.
   */
  const scheduleLinkEmbeds = (message: Message): void => {
    const urls = previewUrls(message.content, message.suppressEmbeds, message.embeds ?? []);
    if (!linkPreviews || urls.length === 0) return;
    linkPreviews.track(
      (async () => {
        const links = await linkPreviews.embedsFor(urls);
        const current = store.getMessage(Number(message.id));
        // Silindi, düzenlendi (yeni metnin önizlemesi ayrıca hazırlanır) ya da önizleme kaldırıldı
        if (!current || current.content !== message.content || current.suppressEmbeds) return;
        const next = [...(current.embeds ?? []).filter((e) => e.type !== 'link'), ...links];
        if (JSON.stringify(next) === JSON.stringify(current.embeds ?? [])) return;
        store.setMessageEmbeds(Number(current.id), next);
        const updated = store.getMessage(Number(current.id))!;
        gateway.dispatchChannel(updated.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(updated) });
      })(),
    );
  };

  /**
   * Kullanıcının görebildiği, mesaj yazılan kanal: metin kanalı ya da katıldığı direkt mesaj konuşması
   * (`channel` null). Göremiyorsa kanal yokmuş gibi 404; yönetici de başkasının konuşmasını göremez.
   */
  const textChannel = (id: string, userId: string, reply: FastifyReply): { id: string; channel: Channel | null } | null => {
    // Görülmeyen konuşma olmayan kanaldan ayırt edilemez (aşağıda getChannel DM'leri döndürmez: aynı 404)
    if (permissions.isDm(id) && permissions.canView(userId, id)) return { id, channel: null };
    const channel = store.getChannel(id);
    if (!channel || channel.type !== 'text' || !permissions.canView(userId, channel)) {
      void sendError(reply, 404, 'not_found', 'Metin kanalı bulunamadı.');
      return null;
    }
    return { id, channel };
  };

  /** Mesajın bulunduğu kanalı görebiliyorsa mesaj */
  const visibleMessage = (id: string, userId: string, reply: FastifyReply): Message | null => {
    const message = /^\d+$/.test(id) ? store.getMessage(Number(id)) : null;
    if (!message || !permissions.canView(userId, message.channelId)) {
      void sendError(reply, 404, 'not_found', 'Mesaj bulunamadı.');
      return null;
    }
    return message;
  };

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/channels/:id/messages',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      if (!textChannel(req.params.id, req.user.id, reply)) return reply;
      const query = listQuery.safeParse(req.query);
      if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz sorgu.');
      const before = query.data.before ? Number(query.data.before) : null;
      return store.listMessages(req.params.id, before, query.data.limit ?? MESSAGE_PAGE_SIZE, req.user.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/channels/:id/messages',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const target = textChannel(req.params.id, req.user.id, reply);
      if (!target) return reply;
      const { channel } = target;
      const perms = permissions.inChannel(req.user.id, channel ?? target.id);
      if (!hasPermission(perms, Permission.SEND_MESSAGES)) {
        // DM salt okunur: ortak sunucu kalmadı ya da engel var. Engellenen kişiye neden söylenmez (genel ileti);
        // engelleyene kendi engeli hatırlatılır.
        return forbidden(reply, channel ? 'Bu kanala mesaj gönderme iznin yok.' : dmReadOnlyMessage(req.user.id, target.id));
      }
      if (!allowMessage(req.user.id)) {
        return sendError(reply, 429, 'rate_limited', 'Çok hızlı mesaj gönderiyorsun, biraz yavaşla.');
      }
      const body = parseBody(createSchema, req.body, reply);
      if (!body) return reply;
      if (body.attachmentIds?.length && !hasPermission(perms, Permission.ATTACH_FILES)) {
        return forbidden(reply, 'Bu kanala dosya gönderme iznin yok.');
      }
      // Yanıt: asıl mesaj aynı kanalda/konuşmada olmalı (onu görebildiği için asıl mesajı da görebilir).
      // "@ AÇIK"sa asıl yazar da bahsedilmiş sayılır (kendi mesajına yanıtta bildirim yok).
      let replyTo: { toId: number; mentionUserId: string | null } | null = null;
      if (body.replyToId) {
        const original = store.replyTarget(target.id, Number(body.replyToId));
        if (!original) {
          return sendError(reply, 400, 'invalid_reply', 'Yanıt verilen mesaj bulunamadı; silinmiş olabilir.');
        }
        const ping = (body.replyMention ?? true) && original.authorId !== null && original.authorId !== req.user.id;
        replyTo = { toId: original.id, mentionUserId: ping ? original.authorId : null };
      }
      const content = body.content ?? '';
      // Metin yalnızca bir GIPHY bağlantısıysa GIF gömülür (seçiciden gönderilen GIF önbellekte hazırdır)
      const gifEmbeds = await gifs.embedsFor(content);
      const embeds = [...gifEmbeds, ...knownLinks(previewUrls(content, false, gifEmbeds))];
      // @everyone ve @here yalnızca kanalda MENTION_EVERYONE yetkisi olan yazarda bildirim olur (kod içindekiler
      // sayılmaz): @everyone kanalı gören herkese, @here kanalı gören ve şu an çevrimiçi olanlara (gateway'e
      // bağlı; çevrimdışı olanların okunmamış sayısı artmaz, telefonlarına da bildirim gitmez). Bahsedilenlerden
      // kanalı göremeyenler sayılmaz (başka sunucuların üyeleri hiç sayılmaz). Direkt mesajda @everyone/@here
      // yoktur; diğer katılımcıların her mesajı bahsetme sayılır: okunmamış sayısı ve bildirim onlara gider.
      // Bildirimli yanıtta asıl yazar da (kanalı görüyorsa) bahsedilir; direkt mesajda zaten katılımcıdır,
      // konuşmadan ayrıldıysa bildirilmez.
      const broadcast = channel !== null && hasPermission(perms, Permission.MENTION_EVERYONE);
      const everyone = broadcast && mentionsEveryone(content);
      const here = broadcast && mentionsHere(content);
      let mentioned: string[];
      if (channel) {
        const candidates = new Set(
          everyone
            ? store.guildMemberIds(channel.guildId).filter((id) => id !== req.user.id)
            : store.resolveMentions(content, req.user.id, channel.guildId),
        );
        // Rol etiketi (<@&kimlik>): o role sahip üyeler, ek yetki gerekmez (@everyone zaten herkesi kapsar)
        if (!everyone) for (const id of store.resolveRoleMentions(content, req.user.id, channel.guildId)) candidates.add(id);
        if (here && !everyone) {
          for (const id of gateway.connectedUserIds()) if (id !== req.user.id) candidates.add(id);
        }
        if (replyTo?.mentionUserId) candidates.add(replyTo.mentionUserId);
        mentioned = permissions.viewersOf(channel, candidates);
      } else {
        mentioned = permissions.dmParticipants(target.id).filter((id) => id !== req.user.id);
        if (replyTo?.mentionUserId && !mentioned.includes(replyTo.mentionUserId)) replyTo.mentionUserId = null;
      }
      const created = store.createMessage(
        target.id,
        req.user.id,
        content,
        body.attachmentIds,
        { userIds: mentioned, everyone, here },
        replyTo,
      );
      if (!created) {
        return sendError(reply, 400, 'invalid_attachment', 'Dosya bulunamadı ya da süresi doldu; yeniden eklemeyi dene.');
      }
      const message = embeds.length ? withEmbeds(created, embeds) : created;
      // Yazar kendi mesajını okumuş sayılır.
      const readState = store.ack(req.user.id, target.id, Number(message.id));
      if (!channel) {
        // Konuşmayı listesinden kaldırmış katılımcılarda yeniden görünür (mesajdan önce)
        const reopened = store.reopenDm(target.id);
        if (reopened.length > 0) gateway.sendDm(reopened, { t: 'DM_CHANNEL_CREATE', d: store.getDm(target.id)! });
      }
      gateway.dispatchChannel(target.id, { t: 'MESSAGE_CREATE', d: message });
      // Diğer cihazlarda da okunmuş sayılır (mesajdan sonra: orada okunmamış görünmesin)
      gateway.sendReadState(req.user.id, readState);
      scheduleLinkEmbeds(message);
      // Telefonlara bildirim yanıtı bekletmez. Rahatsız Etmeyin'dekilere ve o an masaüstünde etkin olanlara
      // (mesajı zaten canlı görüyorlar) gitmez; okunmamış/bahsetme sayıları yine de artar.
      const pushTo = gateway.pushRecipients(mentioned);
      if (channel) void push.notifyMention(message, pushTo, channel.name, channel.guildId);
      else void push.notifyDm(message, pushTo, store.getDm(target.id)!);
      return reply.code(201).send(message);
    },
  );

  app.patch<{ Params: { id: string } }>('/api/messages/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const existing = visibleMessage(req.params.id, req.user.id, reply);
    if (!existing) return reply;
    if (existing.authorId !== req.user.id) {
      return sendError(reply, 403, 'forbidden', 'Yalnızca kendi mesajını düzenleyebilirsin.');
    }
    // Arama kaydını sunucu yazar ve günceller
    if (existing.type === 'call') return sendError(reply, 400, 'not_editable', 'Arama kaydı düzenlenemez.');
    // Salt okunur DM'de (ortak sunucu yok ya da engel) eski mesajlar da düzenlenemez; ileti göndermedeki gibi
    // (engellenene neden söylenmez). Silmek serbest kalır.
    if (permissions.isDm(existing.channelId) && !permissions.can(req.user.id, Permission.SEND_MESSAGES, existing.channelId)) {
      return forbidden(reply, dmReadOnlyMessage(req.user.id, existing.channelId));
    }
    const body = parseBody(editSchema, req.body, reply);
    if (!body) return reply;
    if (!body.content && existing.attachments.length === 0) return sendError(reply, 400, 'invalid_body', EMPTY_MESSAGE);
    if (body.content === existing.content) return store.getMessage(Number(existing.id), req.user.id);
    // Metin değişince GIF de yeniden belirlenir (bağlantı silindiyse GIF kalkar). Metinde kalan bağlantıların
    // önizlemeleri yenileri hazırlanana kadar durur; çıkarılan bağlantılarınki hemen kalkar.
    const gifEmbeds = await gifs.embedsFor(body.content);
    const urls = previewUrls(body.content, existing.suppressEmbeds, gifEmbeds);
    const embeds = [...gifEmbeds, ...knownLinks(urls, linkEmbedsOf(existing))];
    if (embeds.length || existing.embeds?.length) store.setMessageEmbeds(Number(existing.id), embeds);
    const message = store.updateMessage(Number(existing.id), body.content, req.user.id)!;
    gateway.dispatchChannel(message.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(message) });
    scheduleLinkEmbeds(message);
    return message;
  });

  // Kendi mesajını herkes, başkasınınkini kanalda MANAGE_MESSAGES yetkisi olan siler
  app.delete<{ Params: { id: string } }>('/api/messages/:id', { preHandler: auth.requireUser }, async (req, reply) => {
    const existing = visibleMessage(req.params.id, req.user.id, reply);
    if (!existing) return reply;
    if (existing.authorId !== req.user.id && !permissions.can(req.user.id, Permission.MANAGE_MESSAGES, existing.channelId)) {
      return forbidden(reply, 'Bu mesajı silemezsin.');
    }
    const files = store.deleteMessage(Number(existing.id));
    await attachments.remove(files);
    gateway.dispatchChannel(existing.channelId, { t: 'MESSAGE_DELETE', d: { id: existing.id, channelId: existing.channelId } });
    // Sabitli mesaj silinince sabitlemesi de gider (veritabanında kendiliğinden)
    if (existing.pinned) pinsChanged(existing.channelId);
    return reply.code(204).send();
  });

  // ---------- Sabitlenmiş mesajlar ----------
  // Metin kanalında PIN_MESSAGES yetkisi olan, direkt mesajda her katılımcı sabitler ve kaldırır. Kanalı
  // göremeyen için kanal da mesaj da yokmuş gibi 404 (sunucular ve DM'ler birbirinden yalıtılır). İkisi de
  // tekrarlanabilir; yalnızca gerçek değişiklik duyurulur: mesaj MESSAGE_UPDATE (pinned) ile, kanalın
  // listesi CHANNEL_PINS_UPDATE ile kanalı görenlere gider. Sistem mesajı yazılmaz.

  const pinsChanged = (channelId: string): void => {
    gateway.dispatchChannel(channelId, { t: 'CHANNEL_PINS_UPDATE', d: { channelId, lastPinAt: store.lastPinAt(channelId) } });
  };

  const pinTarget = (params: { id: string; messageId: string }, userId: string, reply: FastifyReply): Message | null => {
    const target = textChannel(params.id, userId, reply);
    if (!target) return null;
    const message = /^\d+$/.test(params.messageId) ? store.getMessage(Number(params.messageId), userId) : null;
    if (!message || message.channelId !== target.id) {
      void sendError(reply, 404, 'not_found', 'Mesaj bulunamadı.');
      return null;
    }
    if (!permissions.can(userId, Permission.PIN_MESSAGES, target.channel ?? target.id)) {
      void forbidden(reply, 'Bu kanalda mesaj sabitleme iznin yok.');
      return null;
    }
    return message;
  };

  app.get<{ Params: { id: string } }>('/api/channels/:id/pins', { preHandler: auth.requireUser }, async (req, reply) => {
    if (!textChannel(req.params.id, req.user.id, reply)) return reply;
    return store.listPins(req.params.id, req.user.id);
  });

  // Kanal paneli (telefon): kanalda paylaşılan resim/videolar ve bağlantılar. Mesajları okuyabilen herkes
  // (metin kanalını görebilen ya da konuşmanın katılımcısı) görür; ses kanalında yok (404).
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/channels/:id/media',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      if (!textChannel(req.params.id, req.user.id, reply)) return reply;
      const query = mediaQuery.safeParse(req.query);
      if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz sorgu.');
      const cursor = query.data.before?.split('_').map(Number);
      const page = store.listChannelMedia(
        req.params.id,
        cursor ? { messageId: cursor[0]!, position: cursor[1]! } : null,
        query.data.limit ?? CHANNEL_MEDIA_PAGE_SIZE,
      );
      const last = page.items[page.items.length - 1];
      const result: ChannelPanelPage<ChannelMediaItem> = {
        items: page.items.map(({ position: _position, ...item }) => item),
        nextCursor: page.more && last ? `${last.messageId}_${last.position}` : null,
      };
      return result;
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/channels/:id/files',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      if (!textChannel(req.params.id, req.user.id, reply)) return reply;
      const query = mediaQuery.safeParse(req.query);
      if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz sorgu.');
      const cursor = query.data.before?.split('_').map(Number);
      const page = store.listChannelFiles(
        req.params.id,
        cursor ? { messageId: cursor[0]!, position: cursor[1]! } : null,
        query.data.limit ?? CHANNEL_MEDIA_PAGE_SIZE,
      );
      const last = page.items[page.items.length - 1];
      const result: ChannelPanelPage<ChannelMediaItem> = {
        items: page.items.map(({ position: _position, ...item }) => item),
        nextCursor: page.more && last ? `${last.messageId}_${last.position}` : null,
      };
      return result;
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/channels/:id/links',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      if (!textChannel(req.params.id, req.user.id, reply)) return reply;
      const query = linksQuery.safeParse(req.query);
      if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz sorgu.');
      const page = store.listChannelLinks(
        req.params.id,
        query.data.before ? Number(query.data.before) : null,
        query.data.limit ?? CHANNEL_LINKS_PAGE_SIZE,
      );
      const result: ChannelPanelPage<ChannelLinkItem> = {
        items: page.items,
        nextCursor: page.more && page.last !== null ? String(page.last) : null,
      };
      return result;
    },
  );

  app.put<{ Params: { id: string; messageId: string } }>(
    '/api/channels/:id/pins/:messageId',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const message = pinTarget(req.params, req.user.id, reply);
      if (!message) return reply;
      const result = store.pinMessage(Number(message.id), req.user.id);
      if (result === 'limit') {
        return sendError(
          reply,
          400,
          'too_many_pins',
          `Bir kanalda en fazla ${MAX_PINS_PER_CHANNEL} sabitlenmiş mesaj olabilir. Yenisini sabitlemek için önce birinin sabitlemesini kaldır.`,
        );
      }
      if (result === 'missing') return sendError(reply, 404, 'not_found', 'Mesaj bulunamadı.');
      if (result === 'pinned') {
        const updated = store.getMessage(Number(message.id))!;
        gateway.dispatchChannel(updated.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(updated) });
        pinsChanged(updated.channelId);
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; messageId: string } }>(
    '/api/channels/:id/pins/:messageId',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const message = pinTarget(req.params, req.user.id, reply);
      if (!message) return reply;
      if (store.unpinMessage(Number(message.id))) {
        const updated = store.getMessage(Number(message.id))!;
        gateway.dispatchChannel(updated.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(updated) });
        pinsChanged(updated.channelId);
      }
      return reply.code(204).send();
    },
  );

  // Bağlantı önizlemelerini kaldırır ("Önizlemeyi kaldır"): kendi mesajında herkes, başkasınınkinde
  // kanalda MANAGE_MESSAGES yetkisi olan. Mesaj düzenlense de önizleme yeniden eklenmez. GIF kalır.
  app.delete<{ Params: { id: string } }>('/api/messages/:id/embeds', { preHandler: auth.requireUser }, async (req, reply) => {
    const existing = visibleMessage(req.params.id, req.user.id, reply);
    if (!existing) return reply;
    if (existing.authorId !== req.user.id && !permissions.can(req.user.id, Permission.MANAGE_MESSAGES, existing.channelId)) {
      return forbidden(reply, 'Bu mesajın önizlemesini kaldıramazsın.');
    }
    if (existing.suppressEmbeds) return existing;
    store.suppressEmbeds(Number(existing.id));
    const message = store.getMessage(Number(existing.id), req.user.id)!;
    gateway.dispatchChannel(message.channelId, { t: 'MESSAGE_UPDATE', d: toUpdate(message) });
    return message;
  });

  // ---------- Tepkiler ----------
  // Kullanıcı yalnızca kendi tepkisini ekler/kaldırır. İkisi de tekrarlanabilir (aynı istek ikinci
  // kez bir şey değiştirmez); yalnızca gerçek değişiklik tüm istemcilere duyurulur.

  const reactionTarget = (
    params: { id: string; emoji: string },
    userId: string,
    reply: FastifyReply,
  ): { messageId: number; channelId: string; emoji: string; exists: boolean } | null => {
    const message = visibleMessage(params.id, userId, reply);
    if (!message) return null;
    const emoji = normalizeEmoji(params.emoji);
    if (!emoji) {
      void sendError(reply, 400, 'invalid_emoji', 'Tepki olarak yalnızca tek bir emoji kullanılabilir.');
      return null;
    }
    if (!allowReaction(userId)) {
      void sendError(reply, 429, 'rate_limited', 'Çok hızlı tepki veriyorsun, biraz yavaşla.');
      return null;
    }
    return {
      messageId: Number(message.id),
      channelId: message.channelId,
      emoji,
      exists: message.reactions.some((r) => r.emoji === emoji),
    };
  };

  // Bu emojiyle tepki verenler (Discord'daki "Tepkiler" penceresi). Mesajın kanalını gören herkes
  // görebilir; göremeyen için mesaj yokmuş gibi 404 (sunucular ve DM'ler birbirinden yalıtılır).
  app.get<{ Params: { id: string; emoji: string }; Querystring: Record<string, string> }>(
    '/api/messages/:id/reactions/:emoji',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const message = visibleMessage(req.params.id, req.user.id, reply);
      if (!message) return reply;
      const emoji = normalizeEmoji(req.params.emoji);
      if (!emoji) return sendError(reply, 400, 'invalid_emoji', 'Tepki olarak yalnızca tek bir emoji kullanılabilir.');
      const query = reactionUsersQuery.safeParse(req.query);
      if (!query.success) return sendError(reply, 400, 'invalid_query', 'Geçersiz sorgu.');
      const cursor = query.data.after;
      const split = cursor ? cursor.indexOf('_') : -1;
      const after = cursor ? { at: Number(cursor.slice(0, split)), userId: cursor.slice(split + 1) } : null;
      return store.reactionUsers(Number(message.id), emoji, query.data.limit ?? REACTION_USERS_PAGE_SIZE, after);
    },
  );

  app.put<{ Params: { id: string; emoji: string } }>(
    '/api/messages/:id/reactions/:emoji',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const target = reactionTarget(req.params, req.user.id, reply);
      if (!target) return reply;
      // Yeni tepki eklemek yetki ister; var olan tepkiye katılmak serbest (Discord gibi)
      if (!target.exists && !permissions.can(req.user.id, Permission.ADD_REACTIONS, target.channelId)) {
        return forbidden(reply, 'Bu kanalda yeni tepki ekleme iznin yok.');
      }
      // Salt okunur DM'de (ortak sunucu yok ya da engel) var olan tepkiye de katılınamaz
      if (permissions.isDm(target.channelId) && !permissions.can(req.user.id, Permission.SEND_MESSAGES, target.channelId)) {
        return forbidden(reply, 'Bu konuşmada artık tepki verilemez.');
      }
      const result = store.addReaction(target.messageId, req.user.id, target.emoji);
      if (result === 'limit') {
        return sendError(
          reply,
          400,
          'too_many_reactions',
          `Bir mesaja en fazla ${MESSAGE_MAX_REACTIONS} farklı tepki verilebilir.`,
        );
      }
      if (result === 'added') {
        gateway.dispatchChannel(target.channelId, {
          t: 'MESSAGE_REACTION_ADD',
          d: { messageId: String(target.messageId), channelId: target.channelId, userId: req.user.id, emoji: target.emoji },
        });
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; emoji: string } }>(
    '/api/messages/:id/reactions/:emoji',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      const target = reactionTarget(req.params, req.user.id, reply);
      if (!target) return reply;
      if (store.removeReaction(target.messageId, req.user.id, target.emoji)) {
        gateway.dispatchChannel(target.channelId, {
          t: 'MESSAGE_REACTION_REMOVE',
          d: { messageId: String(target.messageId), channelId: target.channelId, userId: req.user.id, emoji: target.emoji },
        });
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/channels/:id/ack',
    { preHandler: auth.requireUser },
    async (req, reply) => {
      if (!textChannel(req.params.id, req.user.id, reply)) return reply;
      const body = parseBody(ackSchema, req.body, reply);
      if (!body) return reply;
      // Okunma ilerlediyse kullanıcının diğer cihazlarındaki okunmamış işaretleri de temizlenir
      gateway.sendReadState(req.user.id, store.ack(req.user.id, req.params.id, Number(body.messageId)));
      return reply.code(204).send();
    },
  );
}
