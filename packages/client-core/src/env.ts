import type { ClientPlatform, DmChannel, Message } from '@diskort/shared';

/** Oturum gibi kalıcı verilerin saklandığı yer (masaüstü: localStorage, mobil: güvenli depolama). */
export interface KeyValueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Kullanıcının seçtiği, henüz yüklenmemiş dosya */
export interface LocalFile {
  name: string;
  /** Bayt */
  size: number;
  /** MIME türü (bilinmiyorsa boş) */
  type: string;
  /** Masaüstü: dosyanın kendisi (File) */
  blob?: Blob;
  /** Mobil: dosyanın yerel adresi (file://); resimlerde önizleme için de kullanılır */
  uri?: string;
}

export interface UploadRequest {
  url: string;
  headers: Record<string, string>;
  file: LocalFile;
  /** Şimdiye kadar gönderilen bayt */
  onProgress(sent: number): void;
  signal: AbortSignal;
}

/** status 0: sunucuya ulaşılamadı */
export interface UploadResponse {
  status: number;
  body: string;
}

/**
 * Çekirdeğin platforma bıraktığı işler. Masaüstü ve mobil uygulama açılışta configureClient() ile
 * kendi karşılıklarını verir; çekirdek pencere, bildirim, ses gibi platform ayrıntılarını bilmez.
 */
export interface ClientEnvironment {
  platform: ClientPlatform;
  /** Uygulama sürümü (sunucu eski sürümleri reddeder) */
  version: string;
  storage: KeyValueStorage;
  /** Bağlanılan sohbet sunucusunun adresi */
  serverUrl(): string;
  /** Kullanıcıya kısa bir hata göster (ör. mesaj gönderilemedi) */
  notifyError(message: string): void;
  /** Kullanıcı bu metin kanalını şu an gerçekten görüyor mu (uygulama önde ve kanal açık) */
  isViewingChannel?(channelId: string): boolean;
  /** Görülmeyen bir kanalda kullanıcıdan bahsedildi */
  onMention?(message: Message): void;
  /** Görülmeyen bir direkt mesaj konuşmasına başkasından mesaj geldi */
  onDirectMessage?(message: Message, dm: DmChannel): void;
  /**
   * Kanal `lastReadId`'ye kadar okundu (bu cihazda ya da başka bir cihazda): ör. telefon o kanalın
   * gösterilen bildirimlerini kaldırır. Aynı bilgiyle birden çok kez çağrılabilir.
   */
  onChannelRead?(channelId: string, lastReadId: string): void;
  /**
   * Oturum kapandı: kullanıcı çıktı ya da sunucu oturumu geçersiz saydı (401, gateway 4004,
   * INVALID_SESSION). Ör. telefon yerel bildirim kaydını unutur; sonraki girişte yeniden kaydolur.
   */
  onSessionEnded?(): void;
  /** Sunucu bu sürümü artık kabul etmiyor */
  onUpdateRequired?(version: string): void;
  /** Yeni sürüm yayınlandı */
  onUpdateAvailable?(version: string): void;
  /** Dosyayı ham gövde olarak gönderir (verilmezse XMLHttpRequest ile `blob` gönderilir) */
  upload?(request: UploadRequest): Promise<UploadResponse>;
}

let current: ClientEnvironment | null = null;

export function env(): ClientEnvironment {
  if (!current) throw new Error('İstemci yapılandırılmadı: önce configureClient() çağrılmalı.');
  return current;
}

export function setEnvironment(environment: ClientEnvironment): void {
  current = environment;
}
