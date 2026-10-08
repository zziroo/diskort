import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import {
  GIF_SNIPPET,
  isGifMessage,
  PUSH_CHANNEL_CALL,
  PUSH_CHANNEL_DM,
  PUSH_CHANNEL_MENTIONS,
  PUSH_TYPE_FRIEND_REQUEST,
  pushTag,
  type DmChannel,
  type Message,
} from '@diskort/shared';
import type { ApnsClient } from './apns.js';
import type { Store } from './db.js';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface PushLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const BODY_MAX = 180;

/** Yalnızca dosya içeren mesajın bildirim metni */
const attachmentSummary = (count: number): string =>
  count > 1 ? `📎 ${count} dosya gönderdi` : count === 1 ? '📎 Bir dosya gönderdi' : '';

/** Platformdan bağımsız bildirim: Android'e FCM, iOS'a APNs biçiminde gönderilir */
interface Outgoing {
  title: string;
  body: string;
  data: Record<string, string>;
  /** Android bildirim kanalı */
  channelId: string;
  /**
   * Konuşma (kanal kimliği): iOS aynı konuşmanın bildirimlerini gruplar (thread-id). Her mesaj ayrı
   * bildirimdir, yenisi eskisinin yerini almaz (apns-collapse-id yok).
   */
  thread?: string;
  /**
   * Android etiketi: mesaja özgü (pushTag), bu yüzden bildirimler üst üste binmez; Android aynı
   * uygulamanın bildirimlerini kendisi gruplar. Telefon, okunan kanalın bildirimlerini bununla bulup kaldırır.
   */
  tag?: string;
  /**
   * iOS: aynı kimlikli bildirim öncekinin yerini alır (aramalarda: cevapsız arama gelen aramanın yerine;
   * arkadaşlık isteğinde: aynı kişinin yeni isteği eskisinin yerine)
   */
  collapseId?: string;
}

/**
 * Telefonlara bildirim. Android: Google'ın FCM HTTP v1 arayüzüne doğrudan istek (Firebase sunucu
 * kütüphanesi gerekmez). iOS: Apple'ın APNs arayüzüne doğrudan (apns.ts). Firebase/Apple yalnızca
 * teslimatı yapar; kime, ne zaman, ne gideceğine bu sunucu karar verir. Anahtarı olmayan platform
 * sessizce devre dışıdır.
 */
/** Teslimat sonucu (yönetim paneli sayaçları) */
export type PushResult = 'sent' | 'failed' | 'unregistered';

export class PushService {
  private readonly account: ServiceAccount | null;
  private accessToken: { value: string; expiresAt: number } | null = null;
  /** Yönetim paneli: her teslimatın sonucu (sayaçlar; son hata) */
  onDelivery: ((platform: 'android' | 'ios', result: PushResult, detail?: string) => void) | null = null;

  constructor(
    private readonly store: Store,
    serviceAccountFile: string | null,
    private readonly log: PushLogger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apns: ApnsClient | null = null,
  ) {
    this.account = serviceAccountFile ? PushService.load(serviceAccountFile, log) : null;
  }

  get enabled(): boolean {
    return this.account !== null || this.apns !== null;
  }

  private static load(file: string, log: PushLogger): ServiceAccount | null {
    try {
      const account = JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount;
      if (!account.project_id || !account.client_email || !account.private_key) throw new Error('eksik alan');
      log.info({ project: account.project_id }, 'telefon bildirimleri açık (FCM)');
      return account;
    } catch (err) {
      log.warn({ err: String(err) }, 'FCM hizmet hesabı okunamadı; telefon bildirimleri kapalı');
      return null;
    }
  }

  /** Bahsedilen kullanıcıların telefonlarına bildirim gönderir. */
  async notifyMention(message: Message, mentionedUserIds: string[], channelName: string, guildId?: string): Promise<void> {
    if (!this.enabled || mentionedUserIds.length === 0) return;
    const tokens = this.store.pushTokens(mentionedUserIds);
    if (tokens.length === 0) return;

    const author = message.authorId ? this.store.getUser(message.authorId) : null;
    const guild = guildId ? this.store.getGuild(guildId) : null;
    // Yalnızca dosyalı bir yanıtın metni boş olabilir
    const body = this.text(message) || (message.attachments.length ? '📎 Dosya gönderdi' : '');
    await Promise.all(
      tokens.map((t) =>
        this.deliver(t, {
          title: `${author?.displayName ?? 'Biri'} · #${channelName}${guild ? ` (${guild.name})` : ''}`,
          body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body,
          data: { type: 'mention', channelId: message.channelId, messageId: message.id, ...(guildId ? { guildId } : {}) },
          channelId: PUSH_CHANNEL_MENTIONS,
          thread: message.channelId,
          tag: pushTag(message.channelId, message.id),
        }),
      ),
    );
  }

  /**
   * Direkt mesaj: konuşmanın diğer katılımcılarının telefonlarına, her mesajda. Her mesaj ayrı bildirimdir
   * (iOS konuşmaya göre gruplar); ayrı Android kanalındadır, kullanıcı ayrıca kapatabilir.
   */
  async notifyDm(message: Message, recipientIds: string[], dm: DmChannel): Promise<void> {
    if (!this.enabled || recipientIds.length === 0) return;
    const tokens = this.store.pushTokens(recipientIds);
    if (tokens.length === 0) return;

    const author = message.authorId ? this.store.getUser(message.authorId) : null;
    const authorName = author?.displayName ?? 'Biri';
    const text = this.text(message) || attachmentSummary(message.attachments.length);
    const body = text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}…` : text;
    await Promise.all(
      tokens.map((t) =>
        this.deliver(t, {
          title: dm.group ? `${authorName} · ${this.groupTitle(dm, t.userId)}` : authorName,
          body,
          data: { type: 'dm', channelId: message.channelId, messageId: message.id },
          channelId: PUSH_CHANNEL_DM,
          thread: message.channelId,
          tag: pushTag(message.channelId, message.id),
        }),
      ),
    );
  }

  /**
   * Gelen arama: çalınan katılımcıların telefonlarına (ayrı, yüksek öncelikli Android kanalı). Dokununca
   * konuşma açılır. Etiket arama kaydına özgüdür: cevapsız kalırsa "cevapsız arama" bildirimi bunun yerini
   * alır, konuşma okununca kalkar.
   */
  async notifyCall(dm: DmChannel, callerId: string, messageId: string | null, recipientIds: string[]): Promise<void> {
    await this.notifyCallEvent(dm, callerId, messageId, recipientIds, false);
  }

  /** Arama cevapsız kaldı: çalınan ama katılmayanlara (gelen arama bildiriminin yerini alır) */
  async notifyMissedCall(dm: DmChannel, callerId: string, messageId: string | null, recipientIds: string[]): Promise<void> {
    await this.notifyCallEvent(dm, callerId, messageId, recipientIds, true);
  }

  private async notifyCallEvent(
    dm: DmChannel,
    callerId: string,
    messageId: string | null,
    recipientIds: string[],
    missed: boolean,
  ): Promise<void> {
    if (!this.enabled || recipientIds.length === 0) return;
    const tokens = this.store.pushTokens(recipientIds);
    if (tokens.length === 0) return;
    const caller = this.store.getUser(callerId)?.displayName ?? 'Biri';
    const tag = messageId ? pushTag(dm.id, messageId) : undefined;
    await Promise.all(
      tokens.map((t) =>
        this.deliver(t, {
          title: dm.group ? `${caller} · ${this.groupTitle(dm, t.userId)}` : caller,
          body: missed ? '📞 Cevapsız arama' : dm.group ? '📞 Grup araması: seni çağırıyor' : '📞 Seni arıyor',
          data: {
            type: missed ? 'missed_call' : 'call',
            channelId: dm.id,
            ...(messageId ? { messageId } : {}),
          },
          channelId: PUSH_CHANNEL_CALL,
          thread: dm.id,
          ...(tag ? { tag, collapseId: tag } : {}),
        }),
      ),
    );
  }

  /**
   * Gelen arkadaşlık isteği: alıcının telefonlarına (DM bildirim kanalında). Veride tür 'friend-request' ve
   * isteği gönderenin kimliği (`userId`); dokununca uygulama arkadaşlar listesini açabilir. Aynı kişinin
   * tekrarlanan isteği aynı etiketle öncekinin yerini alır.
   */
  async notifyFriendRequest(fromId: string, recipientIds: string[]): Promise<void> {
    if (!this.enabled || recipientIds.length === 0) return;
    const tokens = this.store.pushTokens(recipientIds);
    if (tokens.length === 0) return;
    const name = this.store.getUser(fromId)?.displayName ?? 'Biri';
    const tag = `friend-request:${fromId}`;
    await Promise.all(
      tokens.map((t) =>
        this.deliver(t, {
          title: 'Arkadaşlık isteği',
          body: `${name} seni arkadaş olarak ekledi`,
          data: { type: PUSH_TYPE_FRIEND_REQUEST, userId: fromId },
          channelId: PUSH_CHANNEL_DM,
          tag,
          collapseId: tag,
        }),
      ),
    );
  }

  /** Grubun adı; yoksa alıcı dışındaki katılımcıların adları */
  private groupTitle(dm: DmChannel, recipientId: string): string {
    if (dm.name) return dm.name;
    const names = dm.participantIds
      .filter((id) => id !== recipientId)
      .map((id) => this.store.getUser(id)?.displayName)
      .filter((n): n is string => Boolean(n));
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  }

  /** Ayarlardaki "Test bildirimi gönder": kullanıcının kendi cihazlarına. Gönderilen cihaz sayısını döner. */
  async sendTest(userId: string): Promise<number> {
    const tokens = this.store.pushTokens([userId]).filter((t) => this.canDeliver(t.platform));
    await Promise.all(
      tokens.map((t) =>
        this.deliver(t, {
          title: 'Diskort',
          body: 'Bildirimler çalışıyor ✓',
          data: { type: 'test' },
          channelId: PUSH_CHANNEL_MENTIONS,
        }),
      ),
    );
    return tokens.length;
  }

  /** @kullanıcıadı yerine görünen ad */
  /** Bildirimde gösterilen metin: GIF mesajında bağlantı yerine "GIF" */
  private text(message: Message): string {
    return isGifMessage(message) ? GIF_SNIPPET : this.readable(message.content);
  }

  private readable(content: string): string {
    return content.replace(/(?<![\w.@])@([a-z0-9_.]*[a-z0-9_])/gi, (raw, name: string) => {
      const user = this.store.getUserAuthByUsername(name.toLowerCase());
      return user ? `@${user.displayName}` : raw;
    });
  }

  /** Bu platformun anahtarı var mı (iOS: APNs, diğerleri: FCM) */
  private canDeliver(platform: string): boolean {
    return platform === 'ios' ? this.apns !== null : this.account !== null;
  }

  private async deliver(target: { token: string; platform: string }, o: Outgoing): Promise<void> {
    if (!this.canDeliver(target.platform)) return;
    if (target.platform === 'ios') {
      const result = await this.apns!.send(target.token, {
        title: o.title,
        body: o.body,
        data: o.data,
        threadId: o.thread,
        ...(o.collapseId ? { collapseId: o.collapseId } : {}),
      });
      // Uygulama silinmiş ya da jeton yenilenmiş: artık geçersiz jetonu unut
      if (result === 'unregistered') this.store.removePushToken(target.token);
      this.onDelivery?.('ios', result === 'ok' ? 'sent' : result);
      return;
    }
    await this.send(target.token, {
      notification: { title: o.title, body: o.body },
      data: o.data,
      android: {
        priority: 'HIGH',
        // Etiket mesaja özgü: aynı konuşmanın bildirimleri birbirinin yerini almaz, her mesaj ayrı görünür
        notification: { channel_id: o.channelId, ...(o.tag ? { tag: o.tag } : {}), color: '#5865f2' },
      },
    });
  }

  private async send(token: string, message: Record<string, unknown>): Promise<void> {
    try {
      const res = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.account!.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${await this.getAccessToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, ...message } }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        this.onDelivery?.('android', 'sent');
        return;
      }
      const text = await res.text();
      // Uygulama kaldırılmış ya da jeton yenilenmiş: artık geçersiz jetonu unut
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(text)) {
        this.store.removePushToken(token);
        this.onDelivery?.('android', 'unregistered');
        return;
      }
      if (res.status === 401) this.accessToken = null;
      this.log.warn({ status: res.status, body: text.slice(0, 300) }, 'FCM bildirimi gönderilemedi');
      this.onDelivery?.('android', 'failed', `HTTP ${res.status}`);
    } catch (err) {
      this.log.warn({ err: String(err) }, 'FCM bildirimi gönderilemedi');
      this.onDelivery?.('android', 'failed', String(err).slice(0, 200));
    }
  }

  /** Hizmet hesabıyla imzalanmış JWT karşılığında Google'dan 1 saatlik erişim jetonu alır (önbellekli). */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 60_000) return this.accessToken.value;
    const account = this.account!;
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const key = await importPKCS8(account.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Google erişim jetonu alınamadı (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
