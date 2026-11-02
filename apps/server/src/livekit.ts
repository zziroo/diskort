import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
  WebhookReceiver,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { channelIdFromRoom, voiceRoomName, type User } from '@diskort/shared';
import type { Config } from './config.js';
import type { VoiceSnapshotEntry } from './voiceState.js';

const TOKEN_TTL = '12h';

/** Yönetim paneli: bir katılımcının LiveKit'te yayınladığı iz */
export interface LiveTrack {
  kind: 'audio' | 'video';
  source: 'microphone' | 'camera' | 'screen' | 'screen_audio' | 'unknown';
  muted: boolean;
  /** ör. audio/opus, video/VP8 */
  mimeType: string;
  width: number;
  height: number;
}

/** Yönetim paneli: LiveKit'teki bir ses odası */
export interface LiveRoom {
  channelId: string;
  participants: { userId: string; joinedAt: number; tracks: LiveTrack[] }[];
}

const TRACK_SOURCES: Partial<Record<TrackSource, LiveTrack['source']>> = {
  [TrackSource.MICROPHONE]: 'microphone',
  [TrackSource.CAMERA]: 'camera',
  [TrackSource.SCREEN_SHARE]: 'screen',
  [TrackSource.SCREEN_SHARE_AUDIO]: 'screen_audio',
};

/** Yayınlanabilecek kaynaklar: mikrofon (SPEAK), ekran ve sesi (STREAM) */
export type PublishSources = TrackSource[];

/** Katılımcının LiveKit izinleri; güncellemede tüm alanlar birlikte verilmeli (LiveKit hepsini değiştirir) */
function permission(sources: PublishSources) {
  return {
    canSubscribe: true,
    // Boş kaynak listesi LiveKit'te "hepsi" demektir; hiçbir şey yayınlayamayacaksa yayın kapatılır
    canPublish: sources.length > 0,
    canPublishData: true,
    canPublishSources: sources,
    canUpdateMetadata: false,
  };
}

export class LiveKitService {
  private readonly rooms: RoomServiceClient;
  private readonly receiver: WebhookReceiver;

  constructor(private readonly config: Config) {
    this.rooms = new RoomServiceClient(config.livekitApiUrl, config.livekitApiKey, config.livekitApiSecret);
    this.receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
  }

  get publicUrl(): string {
    return this.config.livekitPublicUrl;
  }

  /**
   * Kullanıcının tek bir ses kanalına bağlanmasına izin veren kısa ömürlü jeton. `sources` kanaldaki
   * yetkilerinden gelir (bkz. VoiceModeration).
   */
  createJoinToken(
    user: User,
    channelId: string,
    sources: PublishSources = [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  ): Promise<string> {
    const token = new AccessToken(this.config.livekitApiKey, this.config.livekitApiSecret, {
      identity: user.id,
      name: user.displayName,
      ttl: TOKEN_TTL,
      metadata: JSON.stringify({ avatarColor: user.avatarColor }),
    });
    const p = permission(sources);
    token.addGrant({
      room: voiceRoomName(channelId),
      roomJoin: true,
      canPublish: p.canPublish,
      canSubscribe: p.canSubscribe,
      canPublishData: p.canPublishData,
      canUpdateOwnMetadata: false,
      ...(sources.length > 0 ? { canPublishSources: sources } : {}),
    });
    return token.toJwt();
  }

  /**
   * Bağlı katılımcının yayın izinlerini değiştirir (izni alınan kaynağın yayını LiveKit'te kapanır). Hata çağırana
   * gider: izin uygulanmadıysa yeniden denenmeli (bkz. VoiceModeration.enforce).
   */
  async setPublishSources(channelId: string, userId: string, sources: PublishSources): Promise<void> {
    await this.rooms.updateParticipant(voiceRoomName(channelId), userId, { permission: permission(sources) });
  }

  /** Katılımcının mikrofonunu sunucudan susturur (izin de ayrıca alınır; bu anında sessizlik içindir). */
  async muteMicrophone(channelId: string, userId: string): Promise<void> {
    try {
      const room = voiceRoomName(channelId);
      const participant = await this.rooms.getParticipant(room, userId);
      for (const track of participant.tracks) {
        if (track.source === TrackSource.MICROPHONE && !track.muted) {
          await this.rooms.mutePublishedTrack(room, userId, track.sid, true);
        }
      }
    } catch {
      // Katılımcı ayrılmış ya da mikrofonu hiç açmamış olabilir.
    }
  }

  receiveWebhook(body: string, authHeader: string | undefined): Promise<WebhookEvent> {
    return this.receiver.receive(body, authHeader);
  }

  /** LiveKit'teki tüm ses odalarındaki katılımcıların anlık görüntüsü. */
  async snapshot(): Promise<Map<string, VoiceSnapshotEntry>> {
    const result = new Map<string, VoiceSnapshotEntry>();
    const rooms = await this.rooms.listRooms();
    for (const room of rooms) {
      const channelId = channelIdFromRoom(room.name);
      // numParticipants'a bakılmaz: LiveKit onu gecikmeli günceller, yeni açılan odada birkaç saniye 0 kalır
      // ve içerideki kişi "seste değil" sanılıp durumdan silinirdi
      if (!channelId) continue;
      const participants = await this.rooms.listParticipants(room.name);
      for (const p of participants) {
        result.set(p.identity, {
          channelId,
          streaming: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
        });
      }
    }
    return result;
  }

  /** Yönetim paneli: odalar, katılımcılar ve yayınladıkları izler (LiveKit'e ulaşılamazsa hata atar) */
  async liveRooms(): Promise<LiveRoom[]> {
    const result: LiveRoom[] = [];
    for (const room of await this.rooms.listRooms()) {
      const channelId = channelIdFromRoom(room.name);
      if (!channelId) continue;
      const participants = room.numParticipants === 0 ? [] : await this.rooms.listParticipants(room.name);
      result.push({
        channelId,
        participants: participants.map((p) => ({
          userId: p.identity,
          joinedAt: Number(p.joinedAtMs) || Number(p.joinedAt) * 1000,
          tracks: p.tracks
            .filter((t) => t.type === TrackType.AUDIO || t.type === TrackType.VIDEO)
            .map((t) => ({
              kind: t.type === TrackType.AUDIO ? 'audio' : 'video',
              source: TRACK_SOURCES[t.source] ?? 'unknown',
              muted: t.muted,
              mimeType: t.mimeType,
              width: t.width,
              height: t.height,
            })),
        })),
      });
    }
    return result;
  }

  async removeParticipant(channelId: string, userId: string): Promise<void> {
    try {
      await this.rooms.removeParticipant(voiceRoomName(channelId), userId);
    } catch {
      // Katılımcı zaten ayrılmış olabilir.
    }
  }

  async closeChannelRoom(channelId: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(voiceRoomName(channelId));
    } catch {
      // Oda hiç açılmamış olabilir.
    }
  }
}

export { TrackSource };
