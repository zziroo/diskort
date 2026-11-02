import { hasPermission, Permission, type User } from '@diskort/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Store } from './db.js';
import type { Gateway } from './gateway.js';
import { TrackSource, type LiveKitService, type PublishSources } from './livekit.js';
import type { PermissionService } from './permissions.js';
import type { ServerFlags, VoiceStateStore } from './voiceState.js';

/**
 * Sesli sohbette yetkilerin LiveKit'e yansıması:
 * - Jeton ve bağlı katılımcının izni kanaldaki yetkilerden gelir: SPEAK → mikrofon, STREAM → ekran.
 * - Sunucuda (guild başına) susturulan/sağırlaştırılan üyenin mikrofonu susturulur ve yayın izni alınır; sağırlaştırma
 *   dinlemeyi istemci uygular (LiveKit'te dinleme izni alınıp geri verilince abonelikler geri gelmiyor).
 * - Kanalı görme ya da bağlanma yetkisini kaybeden (veya atılan) sesten çıkarılır.
 * - Başka kanala taşıma istemci aracılığıyla yapılır (bkz. move).
 */
export class VoiceModeration {
  /** Kullanıcıya en son uygulanan izin (kanal + kaynaklar); gereksiz LiveKit çağrısı yapılmasın */
  private readonly applied = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly voice: VoiceStateStore,
    private readonly livekit: LiveKitService,
    private readonly permissions: PermissionService,
    private readonly gateway: Pick<Gateway, 'sendToUsers'>,
    private readonly log?: Pick<FastifyBaseLogger, 'warn'>,
  ) {
    // Susturmalar sunucu başına saklanır: kişi hangi sunucunun kanalına girerse oradaki durumu geçerlidir
    voice.setFlagResolver((userId, channelId) => this.flagsIn(userId, channelId));
  }

  private flagsIn(userId: string, channelId: string): ServerFlags {
    const guildId = this.permissions.guildOf(channelId);
    return guildId ? this.store.serverVoiceFlags(guildId, userId) : { serverMute: false, serverDeaf: false };
  }

  canConnect(userId: string, channelId: string): boolean {
    return this.permissions.can(userId, Permission.VIEW_CHANNEL | Permission.CONNECT, channelId);
  }

  /** Kullanıcının bu kanalda yayınlayabileceği kaynaklar */
  sources(userId: string, channelId: string): PublishSources {
    const perms = this.permissions.inChannel(userId, channelId);
    const flags = this.flagsIn(userId, channelId);
    const sources: PublishSources = [];
    if (hasPermission(perms, Permission.SPEAK) && !flags.serverMute && !flags.serverDeaf) {
      sources.push(TrackSource.MICROPHONE);
    }
    if (hasPermission(perms, Permission.STREAM)) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    return sources;
  }

  joinToken(user: User, channelId: string): Promise<string> {
    return this.livekit.createJoinToken(user, channelId, this.sources(user.id, channelId));
  }

  /**
   * Katılma bildirimi (webhook): jeton alındıktan sonra yetkiler değişmiş ya da katılımcı eski bir jetonla
   * yeniden bağlanmış olabilir; izin her katılışta güncel duruma getirilir. Çağıran beklemez, hata burada
   * loglanır: yakalanmayan ret süreci düşürürdü. İzin sonraki eşitlemede (enforceAll) yine denetlenir.
   */
  async onJoined(userId: string, channelId: string): Promise<void> {
    this.applied.delete(userId);
    await this.enforce(userId, channelId).catch((err: unknown) => this.log?.warn({ err: String(err) }, 'katılan üyenin izni uygulanamadı'));
  }

  /** Yetkiler değişince (rol, kanal izni, üyelik) seste olan herkesi yeni duruma getirir. */
  async enforceAll(): Promise<void> {
    await Promise.all(this.voice.list().map((s) => this.enforce(s.userId, s.channelId)));
  }

  /**
   * Yalnızca DM aramalarındakiler: bire bir konuşma salt okunur olduysa (ortak sunucu kalmadı) aramadan
   * çıkarılır. Sunucu kanallarındaki susturma/izinler DM'ye uygulanmaz (flagsIn DM'de hep boştur). Çağıranlar
   * beklemez, hata burada loglanır: yakalanmayan ret süreci düşürürdü. Sonraki eşitleme (enforceAll) yine denetler.
   */
  async enforceDmCalls(): Promise<void> {
    try {
      await Promise.all(
        this.voice
          .list()
          .filter((s) => this.permissions.isDm(s.channelId))
          .map((s) => this.enforce(s.userId, s.channelId)),
      );
    } catch (err) {
      this.log?.warn({ err: String(err) }, 'DM aramaları denetlenemedi');
    }
  }

  private async enforce(userId: string, channelId: string): Promise<void> {
    if (!this.canConnect(userId, channelId)) {
      await this.disconnect(userId);
      return;
    }
    const sources = this.sources(userId, channelId);
    const key = `${channelId}:${sources.join(',')}`;
    if (this.applied.get(userId) === key) return;
    this.applied.set(userId, key);
    try {
      await this.livekit.setPublishSources(channelId, userId, sources);
    } catch (err) {
      // Uygulanmadı: kayıt silinir, sonraki eşitleme (enforceAll) yeniden dener. Katılımcı ayrılmışsa durumu da düşer.
      if (this.applied.get(userId) === key) this.applied.delete(userId);
      this.log?.warn({ err: String(err) }, 'ses izni uygulanamadı');
    }
  }

  /** Sunucu tarafı susturma/sağırlaştırma: o sunucuda kalıcıdır, kanaldan çıkıp girince de sürer. */
  async setServerFlags(guildId: string, userId: string, flags: ServerFlags): Promise<void> {
    this.store.setServerVoiceFlags(guildId, userId, flags);
    const state = this.voice.get(userId);
    if (!state || this.permissions.guildOf(state.channelId) !== guildId) return;
    this.voice.setServerFlags(userId, flags);
    if (flags.serverMute || flags.serverDeaf) await this.livekit.muteMicrophone(state.channelId, userId);
    await this.enforce(userId, state.channelId);
  }

  /** Kişi bu sunucunun bir ses kanalındaysa sesten çıkarır (sunucudan ayrılınca, atılınca). */
  async disconnectFromGuild(guildId: string, userId: string): Promise<boolean> {
    const state = this.voice.get(userId);
    if (!state || this.permissions.guildOf(state.channelId) !== guildId) return false;
    return this.disconnect(userId);
  }

  /** Sesten çıkarır; seste değilse false. */
  async disconnect(userId: string): Promise<boolean> {
    const state = this.voice.get(userId);
    this.applied.delete(userId);
    if (!state) return false;
    await this.livekit.removeParticipant(state.channelId, userId);
    this.voice.leave(userId, state.channelId);
    return true;
  }

  /**
   * Bağlı üyeyi başka kanala taşır. Kendi sunucumuzdaki LiveKit katılımcı taşımayı desteklemediği için
   * istemcisine VOICE_MOVE gönderilir, istemci yeni kanala kendisi geçer (hedef kanala bağlanma yetkisi
   * önceden denetlenir). Olayı tanımayan eski istemci bir süre sonra hâlâ eski kanaldaysa sesten çıkarılır.
   */
  move(userId: string, channelId: string, graceMs = MOVE_GRACE_MS): void {
    const state = this.voice.get(userId);
    if (!state || state.channelId === channelId) return;
    this.gateway.sendToUsers([userId], { t: 'VOICE_MOVE', d: { channelId } });
    const timer = setTimeout(() => {
      const now = this.voice.get(userId);
      if (now?.channelId !== state.channelId || now.joinedAt !== state.joinedAt) return;
      this.disconnect(userId).catch((err: unknown) => this.log?.warn({ err: String(err) }, 'taşınan üye sesten çıkarılamadı'));
    }, graceMs);
    timer.unref();
  }
}

/** Taşınan istemcinin yeni kanala geçmesi için beklenen süre */
const MOVE_GRACE_MS = 8000;
