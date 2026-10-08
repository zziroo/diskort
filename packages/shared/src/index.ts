// Sunucu ve istemciler (masaüstü, mobil) arasında paylaşılan tipler ve sabitler.

import type { Feedback } from './feedback';
import type { PermissionOverwrite, Role } from './permissions';
import type { ActivityReport } from './activity';
import type { Presence, SelfStatus } from './presence';
import type { VoiceTraceRequest } from './voiceTrace';
import {
  COSMETIC_SET_LABELS,
  COSMETIC_SETS,
  isCosmeticSet,
  isCosmeticSetId,
  type CosmeticSet,
  type CosmeticSetId,
} from './cosmetics';

export * from './permissions';
export * from './feedback';
export * from './presence';
export * from './activity';
export * from './search';
export * from './telemetry';
export * from './cosmetics';
export * from './voiceTrace';

// ---------- Modeller ----------

export interface User {
  id: string;
  username: string;
  displayName: string;
  /**
   * Baş harf avatarının zemin rengi (profil kartında yedek renk). Ayrı bir seçim yok: sunucu, profil teması
   * varsa onun ana rengini, yoksa hesapta saklı rengi gönderir; istemci olduğu gibi kullanır.
   */
  avatarColor: string;
  /**
   * Profil fotoğrafı: sunucu köküne göre adres (/api/avatars/<kullanıcı>/<özet>.webp; 256×256 WebP).
   * Kimlik doğrulaması istemez ve içerik değişince adres de değişir (süresiz önbelleklenebilir).
   * Fotoğraf yoksa null; bu alanı bilmeyen eski sunucularda hiç gelmez. Yoksa baş harfler gösterilir.
   */
  avatarUrl?: string | null;
  /**
   * Profil afişi: sunucu köküne göre adres (/api/banners/<kullanıcı>/<özet>.webp; 1020×360
   * WebP). Profil kartının üstünde; yoksa null (tema rengi ya da avatarColor gösterilir). Eski sunucularda yok.
   */
  bannerUrl?: string | null;
  /** Profil teması: kartın iki rengi (üstten alta degrade). Yoksa null: varsayılan kart */
  profileTheme?: ProfileTheme | null;
  /**
   * Kaldırılan eski (parçacıklı) profil efektinin alanı: sunucu her zaman null gönderir. 0.8.x istemciler
   * bu alanı okur ve tanımadıkları kimlikte çöker; null onlarda "efekt yok" demektir. Efekt animatedEffect'te.
   */
  profileEffect?: null;
  /**
   * Profil kartında oynayan hareketli set efekti: setin kimliği (yerleşik setlerden biri ya da yayınlanmış
   * bir paket, bkz. CosmeticSetId); efekt yoksa null. Eski sunucularda hiç gelmez. Sunucu yalnızca o an
   * bilinen (yerleşik ya da yayında olan) kimliği gönderir; paketleri tanımayan eski istemcilere yalnızca
   * yerleşik kimlikler gider (bkz. CLIENT_FEATURE_COSMETIC_PACKS). Aynısı avatarDecoration ve nameplate
   * için de geçerlidir. İstemciler userEffectId() ile okur.
   */
  animatedEffect?: CosmeticSetId | null;
  /**
   * Avatar dekorasyonunun kimliği: hareketli dekorasyon (`anim:<set kimliği>`, bkz. animatedDecorationId).
   * Yoksa null; istemci tanımadığı kimliği göstermez.
   */
  avatarDecoration?: string | null;
  /** Kaldırılan profil çerçevesinin alanı: sunucu her zaman null gönderir (0.8.x istemciler okur). */
  profileFrame?: null;
  /**
   * İsim plakası: üye listesinde satırın arkasında oynayan hareketli zemin; setin kimliği (yerleşik ya da
   * paket). Yoksa null; eski sunucularda hiç gelmez. İstemciler userNameplateId() ile okur.
   */
  nameplate?: CosmeticSetId | null;
  /**
   * Hesap yöneticisi: hesabın kendi bayrağı (users.is_admin); hiçbir sunucunun sahipliğine ya da rolüne bağlı
   * değildir. Hesaplarla ilgili işleri yapar (şifre sıfırlama kodu, hesap silme, hesap daveti, geri bildirimler).
   * Sunuculardaki yetkiler rollerden gelir (bkz. GuildMember).
   */
  isAdmin: boolean;
}

export interface Guild {
  id: string;
  name: string;
  /** Sahip: herkesin üstündedir, her yetkiye sahiptir */
  ownerId: string | null;
  /**
   * Sunucu simgesi: sunucu köküne göre adres (/api/guild-icons/<sunucu>/<özet>.webp; 256×256 WebP).
   * Kimlik doğrulaması istemez, içerik değişince adres de değişir. Yoksa null: adın baş harfleri gösterilir.
   */
  iconUrl?: string | null;
}

/**
 * Bir hesabın bir sunucudaki üyeliği. Sunucudan ayrılan, atılan ya da yasaklanan eski üyeler de listede
 * kalır (`removed`): mesajlarında adları görünsün diye; üye listesinde gösterilmezler.
 */
export interface GuildMember {
  userId: string;
  /** Rollerinin kimlikleri (@everyone hariç); eski üyede boş */
  roles: string[];
  joinedAt: number;
  /** Artık üye değil (ayrıldı, atıldı ya da yasaklandı) */
  removed: boolean;
}

/** Bir sunucunun kullanıcıya görünen hâli (READY'de ve GUILD_CREATE'te) */
export interface GuildData {
  guild: Guild;
  /** Yalnızca kullanıcının görebildiği kanallar */
  channels: Channel[];
  /** @everyone dahil tüm roller */
  roles: Role[];
  /** Üyeler (eski üyeler `removed` olarak) */
  members: GuildMember[];
}

/**
 * Kullanıcı bir sunucuya katıldı (ya da sunucu kurdu): sunucunun verisi ve ona ait anlık durum. `users`,
 * kullanıcının henüz tanımadığı üyelerin profillerini de içerir.
 */
export interface GuildCreatePayload extends GuildData {
  users: User[];
  voiceStates: VoiceState[];
  /** Bu sunucunun çevrimiçi üyeleri */
  online: string[];
  /** Çevrimiçi üyelerin durumları (eski sunucularda gelmez: hepsi 'online' sayılır) */
  presences?: Record<string, Presence>;
  lastMessageIds: Record<string, string>;
  readStates: Record<string, string>;
  mentionCounts: Record<string, number>;
}

export type ChannelType = 'voice' | 'text';

export interface Channel {
  id: string;
  guildId: string;
  name: string;
  type: ChannelType;
  position: number;
  /** Rol başına kanal izinleri (özel, salt okunur kanallar için) */
  overwrites: PermissionOverwrite[];
}

/**
 * Direkt mesaj konuşması: bire bir ya da küçük bir grup. Mesajları, dosyaları, tepkileri ve okunma
 * durumu metin kanallarınınkiyle aynıdır (mesajın `channelId`'si konuşmanın kimliğidir), ama topluluğun
 * kanal listesinde yer almaz; yalnızca katılımcılar görür (rol, kanal izni ve yöneticilik uygulanmaz).
 */
export interface DmChannel {
  id: string;
  /** Katılımcılar (sen dahil), katılma sırasıyla. Hesabı silinen katılımcı listeden düşer. */
  participantIds: string[];
  /** Grup konuşması mı. Bire bir konuşma aynı iki kişi için tektir ve ona katılımcı eklenemez. */
  group: boolean;
  /** Grubun adı; verilmemişse (ve bire bir konuşmada) null: katılımcıların adları gösterilir */
  name: string | null;
  /** Grubu kuran (ayrılırsa sıradaki katılımcıya geçer); bire bir konuşmada null */
  ownerId: string | null;
  createdAt: number;
  /** Son mesajın kimliği; mesaj yoksa null */
  lastMessageId: string | null;
  /** Son mesajın zamanı, mesaj yoksa oluşturulma zamanı (liste buna göre sıralanır) */
  lastActivityAt: number;
  /**
   * Bire bir konuşma salt okunur: iki taraftan biri diğerini engelledi. Geçmiş okunur; mesaj, tepki ve arama
   * yok. Yalnızca true iken gelir (eski sunucularda hiç gelmez). Engelin yönü bilerek söylenmez: engellenen
   * kişi yalnızca konuşmanın salt okunur olduğunu görür (engelleyen kendi listesinden bilir, bkz.
   * ReadyPayload.blockedUserIds). Ortak sunucu ya da arkadaşlık kalmaması bu alanı değiştirmez (istemci onu
   * kendisi bilir).
   */
  readOnly?: boolean;
}

/**
 * Direkt mesajda süren sesli arama (bire bir ya da grup). Arama, konuşmanın ses odasında (ch_<konuşma>) en
 * az bir kişi olduğu sürece vardır; oda boşalınca biter (DM_CALL_DELETE). İlk kişi bağlanınca diğer
 * katılımcılar çalınır (`ringing`): katılınca, reddedince (POST /api/dms/:id/call/decline) ya da
 * DM_CALL_RING_MS dolunca listeden çıkar. Kimin seste olduğu her zamanki gibi VOICE_STATE_* olaylarından
 * okunur. Rahatsız Etmeyin'deki ve aramayı başlatanı engellemiş kişi çalınmaz (yine de aramaya katılabilir).
 */
export interface DmCall {
  /** Konuşmanın kimliği (ses odası voiceRoomName(channelId)) */
  channelId: string;
  /** Aramayı başlatan (odaya ilk bağlanan) */
  startedBy: string;
  /** Başladığı an (ms, sunucu saati) */
  startedAt: number;
  /** Şu an çalınanlar: aranan ama henüz katılmamış, reddetmemiş ve süresi dolmamış katılımcılar */
  ringing: string[];
  /**
   * Çalınan → çalmanın (son) başladığı an (ms, sunucu saati). Yeniden çalınınca değişir: istemci kendi çalma
   * süresini (bağlantı koptuğunda da biten) bununla yeniler. Eski sunucularda yok.
   */
  ringStartedAt?: Record<string, number>;
  /** Aramanın konuşmadaki kaydı (type 'call' mesajı); yoksa null */
  messageId: string | null;
}

/** Çalan aramanın her kişi için en uzun süresi (ms): sonra o kişi için çalma durur */
export const DM_CALL_RING_MS = 30_000;

/** POST /api/dms/:id/call/ring: aramadaki biri, aramada olmayan bir katılımcıyı (yoksa hepsini) yeniden çalar */
export interface DmCallRingRequest {
  userId?: string;
}

/** Engellenen bir kişi (GET /api/me/blocks); yalnızca engelleyen kendi listesini görür */
export interface UserBlock {
  userId: string;
  /** Engellendiği an */
  createdAt: number;
  /** Profili (hesap silindiyse ya da artık tanınmıyorsa null) */
  user: User | null;
}

// ---------- Arkadaşlar ----------
// Arkadaşlar, ortak sunucuları olmasa da birbirine bire bir DM açabilir, birbirini gruba ekleyebilir,
// birbirinin profilini ve çevrimiçi durumunu görür (ortak sunucudakiler gibi). Arkadaşlık kullanıcı adıyla
// istek gönderip karşı tarafın kabul etmesiyle kurulur; iki yönlüdür. Engelleme arkadaşlığı ve bekleyen
// istekleri kaldırır; seni engellemiş birine istek gönderilemez (kullanıcı yokmuş gibi 404).

/** Arkadaş ya da bekleyen istek (gelen/giden) */
export interface FriendEntry {
  userId: string;
  /** Arkadaşlıkta arkadaş olunduğu an; istekte isteğin gönderildiği an */
  createdAt: number;
  /** Profili */
  user: User;
}

/** GET /api/friends ve FRIENDS_UPDATE: kullanıcının arkadaşları ve bekleyen istekleri (tam liste) */
export interface FriendsList {
  /** Arkadaşlar, görünen ada göre sıralı */
  friends: FriendEntry[];
  /** Sana gelen, yanıt bekleyen istekler (en yeni önce) */
  incoming: FriendEntry[];
  /** Gönderdiğin, yanıt bekleyen istekler (en yeni önce) */
  outgoing: FriendEntry[];
}

/** POST /api/friends/requests: kullanıcı adıyla arkadaşlık isteği ("@" ile başlayabilir) */
export interface FriendRequestBody {
  username: string;
}

/**
 * POST /api/friends/requests yanıtı: güncel liste ve sonuç. 'pending': istek gönderildi (ya da zaten
 * bekliyordu); 'friends': artık arkadaşsınız (karşı tarafın sana bekleyen isteği vardı) ya da zaten
 * arkadaştınız.
 */
export interface FriendRequestResponse extends FriendsList {
  status: 'pending' | 'friends';
}

/** Aynı anda yanıt bekleyen en fazla giden istek */
export const FRIEND_REQUESTS_OUTGOING_MAX = 100;

/** Telefon bildirimi verisindeki tür: gelen arkadaşlık isteği (veride `userId`: isteği gönderen) */
export const PUSH_TYPE_FRIEND_REQUEST = 'friend-request';

export interface VoiceState {
  userId: string;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Yetkili biri tarafından sunucuda susturuldu (kendisi açamaz) */
  serverMute: boolean;
  /** Yetkili biri tarafından sunucuda sağırlaştırıldı */
  serverDeaf: boolean;
  streaming: boolean;
  joinedAt: number;
  /** Yayının başladığı an (ms, sunucu saati); yalnızca yayındayken, eski sunucularda gelmez */
  streamStartedAt?: number;
  /** Paylaşılan pencerenin ya da ekranın adı (yayıncının bildirdiği, en çok 64 karakter) */
  streamSourceName?: string;
  /** Paylaşılan kaynağın türü */
  streamSourceKind?: StreamSourceKind;
  /**
   * Son yayın önizlemesinin zamanı (ms); önizleme yoksa gelmez. Değiştikçe istemci önizlemeyi yeniden
   * indirir (GET /api/voice/:channelId/stream-preview/:userId).
   */
  streamPreviewAt?: number;
  /**
   * İzlediği yayınların sahipleri (aynı ses kanalında yayında olanlar; kendisi hariç). İstemcinin
   * STREAM_WATCH_SET ile bildirdiğinden sunucu türetir; boşsa gelmez, eski sunucularda hiç gelmez.
   */
  watching?: string[];
}

/** STREAM_WATCH_SET'te aynı anda izlenebilecek en fazla yayın (fazlası yok sayılır) */
export const STREAM_WATCH_MAX = 25;

export type StreamSourceKind = 'screen' | 'window';

/** PUT /api/voice/stream-source: yayıncı paylaştığı kaynağın adını bildirir */
export interface StreamSourceRequest {
  name: string;
  kind: StreamSourceKind;
}

/** Yayın önizlemesinin yüklenebilecek en büyük boyutu (bayt) */
export const STREAM_PREVIEW_MAX_BYTES = 256 * 1024;
/** Yayın önizlemesi kaynak adının en büyük uzunluğu */
export const STREAM_SOURCE_NAME_MAX_LENGTH = 64;

/** Mesaja eklenmiş dosya */
export interface Attachment {
  /** 128 bit rastgele kimlik (32 onaltılık karakter); adresin tahmin edilemeyen kısmı */
  id: string;
  /** Temizlenmiş dosya adı */
  name: string;
  /** Bayt */
  size: number;
  /**
   * Resim ve videolarda sunucunun dosya içeriğinden belirlediği tür (INLINE_IMAGE_TYPES,
   * INLINE_VIDEO_TYPES); diğerlerinde yükleyenin bildirdiği
   */
  contentType: string;
  /** Resim ve videolarda (okunabildiyse); resimde EXIF yönü, videoda döndürme uygulanmış hâliyle */
  width: number | null;
  height: number | null;
  /** Videolarda süre (saniye, okunabildiyse); eski sunucularda hiç gelmez */
  duration?: number | null;
  /**
   * Sunucu köküne göre adres: /api/attachments/<id>/<ad>. Kimlik doğrulaması istemez (resimler
   * <img> ile yüklenebilsin diye); adresi bilen herkes dosyayı alabilir, Discord'daki gibi.
   */
  url: string;
}

/**
 * Mesajdaki hareketli GIF (GIPHY). Metni yalnızca bir GIPHY bağlantısı olan mesaja sunucu ekler (GIF
 * seçiciden gönderilen ya da yapıştırılan bağlantı); bilgiler GIPHY'den alınır, istemci gönderemez.
 * Bu alanı bilmeyen eski istemciler mesajı düz bağlantı olarak görür. Medya GIPHY'nin sunucularından
 * doğrudan yüklenir (adresler https://media*.giphy.com / i.giphy.com ile sınırlıdır).
 */
export interface GifEmbed {
  type: 'gif';
  provider: 'giphy';
  /** GIPHY kimliği */
  id: string;
  /** GIPHY sayfası: mesajın metni bu bağlantıdır */
  url: string;
  title: string;
  /** Özgün boyut (yer ayırmak ve en-boy oranı için) */
  width: number;
  height: number;
  /** Hareketli GIF (2 MB'a kadar küçültülmüş hâli) */
  gif: string;
  /** Aynı görüntünün MP4 videosu (çok daha hafif; masaüstü bunu oynatır) */
  mp4: string | null;
  /** Hareketli WebP */
  webp: string | null;
  /** Durağan ilk kare */
  still: string | null;
}

/** Bağlantı önizlemesindeki resim: her zaman sunucumuz üzerinden (/api/embed-media/...) yüklenir */
export interface LinkEmbedImage {
  /** Sunucu köküne göre adres (imzalı; istemci asıl siteye bağlanmaz) */
  url: string;
  width: number;
  height: number;
}

/** Bağlantı önizlemesinin türü: sayfa kartı, doğrudan resim/GIF, doğrudan video ya da YouTube videosu */
export type LinkEmbedKind = 'article' | 'image' | 'video' | 'youtube';

/**
 * Mesajdaki bir bağlantının önizlemesi (Discord'daki "embed"). Mesaj gönderilince/düzenlenince sunucu
 * bağlantıları arka planda açar (OpenGraph, YouTube oEmbed) ve MESSAGE_UPDATE ile ekler; istemci
 * gönderemez. Metinler sunucuda temizlenir ve kısaltılır; düz metin olarak gösterilmelidir. Resimler
 * sunucumuz üzerinden gelir (kullanıcının IP'si sitelere gitmez). Bunu bilmeyen eski istemciler yok sayar
 * (yalnızca `type: 'gif'` gösterirler).
 */
export interface LinkEmbed {
  type: 'link';
  kind: LinkEmbedKind;
  /** Mesajdaki bağlantı (başlığa tıklanınca açılır) */
  url: string;
  /** Site adı (og:site_name; ör. "YouTube", "GitHub") */
  siteName: string | null;
  title: string | null;
  description: string | null;
  /** Yazar / kanal adı (YouTube kanalı, tweet yazarı) */
  author: string | null;
  /** Sol şeridin rengi (#rrggbb; sitenin theme-color'ı) */
  color: string | null;
  image: LinkEmbedImage | null;
  /** Resim kartın altında büyük mü (yoksa sağda küçük) gösterilsin */
  largeImage: boolean;
  /** kind 'youtube': video kimliği ve başlangıç saniyesi */
  youtubeId?: string | null;
  youtubeStart?: number | null;
  /** kind 'video': doğrudan video dosyası (asıl adres; yalnızca kullanıcı oynatınca yüklenir) */
  video?: { url: string } | null;
}

export type Embed = GifEmbed | LinkEmbed;

/** Bir mesajda en fazla bu kadar bağlantı önizlenir */
export const MESSAGE_MAX_LINK_EMBEDS = 5;

export const isLinkEmbed = (embed: Embed): embed is LinkEmbed => embed.type === 'link';

/** Mesajın bağlantı önizlemeleri (GIF'ler hariç) */
export const linkEmbedsOf = (message: { embeds?: readonly Embed[] | null }): LinkEmbed[] =>
  message.embeds?.filter(isLinkEmbed) ?? [];

/** GIF seçicideki bir sonuç: mesajdaki gösterimi ve ızgaradaki küçük önizlemesi */
export interface GifResult extends Omit<GifEmbed, 'type' | 'provider'> {
  /** 200 piksel genişliğinde önizleme */
  preview: { gif: string; webp: string | null; mp4: string | null; width: number; height: number };
}

/** GIF araması/popüler GIF'ler: bir sayfa sonuç; `next` sonraki sayfanın başlangıcı (yoksa null) */
export interface GifPage {
  results: GifResult[];
  next: number | null;
}

/** Sunucunun açık olan isteğe bağlı özellikleri (READY'de; eski sunucularda hiç gelmez) */
export interface ServerFeatures {
  /** GIF araması (sunucuda GIPHY anahtarı tanımlı) */
  gifs: boolean;
}

/** Bir mesajdaki tek bir emoji tepkisinin özeti */
export interface Reaction {
  /** Tek bir Unicode emoji (özel emoji yok) */
  emoji: string;
  count: number;
  /** İsteği yapan kullanıcı bu tepkiyi vermiş mi */
  me: boolean;
}

export interface Message {
  /** Kanal içinde artan sayısal kimlik (metin olarak) */
  id: string;
  channelId: string;
  /** Yazarın hesabı silindiyse null */
  authorId: string | null;
  content: string;
  createdAt: number;
  editedAt: number | null;
  /** Dosya ekleri, eklendiği sırayla (mesajda dosya varsa metin boş olabilir) */
  attachments: Attachment[];
  /** Tepkiler, ilk verilme sırasına göre */
  reactions: Reaction[];
  /** Sunucunun eklediği gömülü içerik (GIPHY GIF'i, bağlantı önizlemeleri); eski sunucularda hiç gelmez */
  embeds?: Embed[];
  /**
   * Bağlantı önizlemeleri kaldırıldı ("Önizlemeyi kaldır"; yazar ya da MANAGE_MESSAGES): düzenlense de
   * yeniden eklenmez. Eski sunucularda hiç gelmez.
   */
  suppressEmbeds?: boolean;
  /** Yazarın yetkisi olan bir @everyone bahsetmesi: kanalı gören herkese bildirim gider */
  mentionEveryone: boolean;
  /**
   * Yazarın yetkisi olan (MENTION_EVERYONE) bir @here bahsetmesi: kanalı gören ve mesaj gönderildiğinde
   * çevrimiçi olan (gateway'e bağlı) herkese bildirim gider; çevrimdışı olanlar sayılmaz. Bunu bilmeyen
   * eski sunucularda hiç gelmez. İstemci vurgularken bunu @everyone gibi sayar (Discord gibi).
   */
  mentionHere?: boolean;
  /**
   * Yanıt verilen mesajın kimliği (Discord'daki "message_reference"); yanıt değilse null. Asıl mesaj
   * silinse de kalır. Yanıtları bilmeyen eski sunucularda hiç gelmez.
   */
  replyToId?: string | null;
  /**
   * Yanıt verilen mesajın kısa özeti; asıl mesaj silindiyse (ya da yanıt değilse) null. Sunucu bunu
   * saklamaz, her okumada asıl mesajdan yeniden üretir; bu yüzden asıl mesaj düzenlenince ya da
   * silinince yeniden yüklenen yanıtlar hep günceldir. Ekrandaki yanıtları istemci, asıl mesajın
   * MESSAGE_UPDATE / MESSAGE_DELETE olaylarıyla kendisi günceller (ayrı bir olay gönderilmez).
   */
  referencedMessage?: ReferencedMessage | null;
  /**
   * Yanıtta asıl mesajın yazarı bildirildiyse ("@ AÇIK") onun kimliği: o kişi için bahsetme sayılır
   * (bildirim gider, mesaj vurgulanır). Asıl mesaj sonradan silinse de kalır.
   */
  replyMentionUserId?: string | null;
  /**
   * Mesaj kanala sabitlenmiş ("Sabitlenmiş mesajlar" listesinde). Sabitleme değişince MESSAGE_UPDATE ile
   * gelir. Bunu bilmeyen eski sunucularda hiç gelmez.
   */
  pinned?: boolean;
  /**
   * Mesajın türü: yoksa sıradan mesaj. 'call': sunucunun DM'ye yazdığı arama kaydı (`call` alanıyla; yazarı
   * aramayı başlatandır, düzenlenemez). Bunu bilmeyen eski istemciler `content`'i (callMessageText) yazarın
   * düz metni olarak gösterir. İstemci tanımadığı türü düz mesaj gibi göstermelidir.
   */
  type?: MessageType;
  /** type 'call' ise aramanın bilgisi */
  call?: MessageCall | null;
}

/** Mesajın türü (bkz. Message.type) */
export type MessageType = 'default' | 'call';

/**
 * Arama kaydı (type 'call'): mesajın createdAt'i aramanın başladığı andır. Arama sürerken endedAt null;
 * bitince MESSAGE_UPDATE ile endedAt ve aramaya katılanların tamamı gelir.
 */
export interface MessageCall {
  /** Aramaya katılanlar (başlatan dahil), ilk katılma sırasıyla */
  participantIds: string[];
  /** Bittiği an (ms); sürüyorsa null */
  endedAt: number | null;
}

export const isCallMessage = (m: Pick<Message, 'type'>): boolean => m.type === 'call';

/** Cevapsız arama: bitti ve başlatandan başka kimse katılmadı */
export const isMissedCall = (m: Pick<Message, 'type' | 'call'>): boolean =>
  m.type === 'call' && !!m.call && m.call.endedAt !== null && m.call.participantIds.length <= 1;

/** Aramanın süresi (ms): bittiyse başlangıçtan bitişe, sürüyorsa `now`a kadar; arama kaydı değilse null */
export function callDurationMs(m: Pick<Message, 'type' | 'call' | 'createdAt'>, now: number = Date.now()): number | null {
  if (m.type !== 'call' || !m.call) return null;
  return Math.max(0, (m.call.endedAt ?? now) - m.createdAt);
}

/** Arama süresi okunur biçimde: "45 sn", "5 dk", "1 sa 5 dk" */
export function formatCallDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} sn`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}

/**
 * Arama kaydının metni (mesajın `content`'i; eski istemciler bunu gösterir, aramada bunu bilen istemciler
 * kendi görünümünü çizebilir): sürerken "Arama başlattı.", cevapsızsa "Cevapsız arama.", bitince süresiyle.
 */
export function callMessageText(call: MessageCall, createdAt: number): string {
  if (call.endedAt === null) return '📞 Arama başlattı.';
  if (call.participantIds.length <= 1) return '📞 Cevapsız arama.';
  return `📞 Arama başlattı · ${formatCallDuration(call.endedAt - createdAt)} sürdü.`;
}

/** Sabitlenmiş mesajlar listesindeki mesaj (GET /api/channels/:id/pins): ne zaman ve kimin sabitlediği */
export interface PinnedMessage extends Message {
  pinned: true;
  pinnedAt: number;
  /** Sabitleyen (hesabı silindiyse null) */
  pinnedBy: string | null;
}

/**
 * Kanal panelindeki "Medya" sekmesinin bir öğesi: kanalda (ya da konuşmada) paylaşılmış resim/video dosyası
 * ve ait olduğu mesaj (GET /api/channels/:id/media). Yeniden eskiye; aynı mesajın dosyaları sırasıyla.
 */
export interface ChannelMediaItem {
  messageId: string;
  authorId: string | null;
  createdAt: number;
  attachment: Attachment;
}

/**
 * Kanal panelindeki "Bağlantılar" sekmesinin bir öğesi: mesajdaki bir bağlantı (GET /api/channels/:id/links).
 * Başlık ve site adı mesajın bağlantı önizlemesinden gelir (önizleme yoksa null).
 */
export interface ChannelLinkItem {
  messageId: string;
  authorId: string | null;
  createdAt: number;
  url: string;
  title: string | null;
  siteName: string | null;
}

/** Kanal paneli listelerinin bir sayfası; nextCursor verilirse daha eskisi `before` ile istenir */
export interface ChannelPanelPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Bir kanalın sabitlenmiş mesajları değişti; son sabitlemenin zamanı (hiç kalmadıysa null) */
export interface ChannelPinsUpdate {
  channelId: string;
  lastPinAt: number | null;
}

/** Yanıtın üstünde gösterilen, yanıt verilen mesajın özeti */
export interface ReferencedMessage {
  id: string;
  /** Yazarın hesabı silindiyse null */
  authorId: string | null;
  /** Metnin ilk REPLY_EXCERPT_LENGTH karakteri */
  content: string;
  /** Dosya eki var mı (metni boş, yalnızca dosyalı mesajlarda "Ek" gösterilir) */
  hasAttachments: boolean;
}

/** Gateway'deki mesaj güncellemesi: tepkiler kişiye özel (`me`) olduğundan taşınmaz */
export type MessageUpdate = Omit<Message, 'reactions'>;

/**
 * Bir mesajda belirli bir emojiyle tepki verenlerin bir sayfası (GET /api/messages/:id/reactions/:emoji),
 * tepki verilme sırasına göre. `next` doluysa sonraki sayfa için `?after=<next>` ile istenir.
 */
export interface ReactionUsersPage {
  users: User[];
  next: string | null;
}

/** Bir kullanıcı bir mesaja tepki verdi ya da tepkisini geri aldı */
export interface ReactionEvent {
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
}

/** Kullanıcının bir kanaldaki okunma durumu (READ_STATE_UPDATE) */
export interface ReadStateUpdate {
  channelId: string;
  /** Okunan son mesajın kimliği */
  lastReadId: string;
  /** Okunmamış bahsetme sayısı (direkt mesajda okunmamış mesaj sayısı) */
  mentionCount: number;
}

export interface Invite {
  code: string;
  /** Katılınacak sunucu; null: yalnızca hesap açtıran davet (sunucuya katılmaz) */
  guildId: string | null;
  createdBy: string;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
}

/** Davet bağlantısının önizlemesi (giriş gerekmez): hangi sunucuya davet edildiği */
export interface InvitePreview {
  code: string;
  /** Yalnızca hesap daveti ise null */
  guild: { id: string; name: string; iconUrl: string | null } | null;
  memberCount: number;
  expiresAt: number | null;
}

/** Sunucu davet bağlantısı: https://<sunucu>/davet/<kod> (indirme sayfası kodu gösterir) */
export const INVITE_LINK_PATH = '/davet/';

/** Yapıştırılan davet bağlantısından ya da koddan davet kodu (geçersizse null) */
export function parseInviteCode(input: string): string | null {
  const text = input.trim();
  const fromLink = /\/davet\/([a-z0-9]+)/i.exec(text)?.[1];
  const code = (fromLink ?? text).toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

/** Uygulamayı açan davet bağlantısının şeması: diskort://davet/<kod> */
export const APP_LINK_SCHEME = 'diskort';

/**
 * Uygulamayı açan bağlantıdan davet kodu: diskort://davet/<kod> (masaüstü ve telefon). Telefonda yönlendirici
 * yalnızca yolu da verebilir ("/davet/<kod>"). Başka her şey (başka şema, başka yol, geçersiz kod) null.
 */
export function parseInviteDeepLink(url: string): string | null {
  const m = /^(?:diskort:\/{0,3}|\/)?davet\/([a-z0-9]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  return m?.[1] ? parseInviteCode(m[1]) : null;
}

// ---------- REST ----------

export interface RegisterRequest {
  /**
   * Hesap daveti: yeni hesap yalnızca bununla açılır. Sunucu davetiyle yeni hesap açılamaz; hesabı olan biri
   * kendi kullanıcı adı ve şifresiyle gönderirse giriş yapılır ve o sunucuya katılır.
   */
  inviteCode: string;
  username: string;
  password: string;
  displayName?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface PushTokenRequest {
  token: string;
  platform: 'android' | 'ios';
}

export interface DeleteAccountRequest {
  password: string;
}

export interface UpdateMeRequest {
  displayName?: string;
  /** Yeni istemciler göndermez (seçici kalktı); eski istemciler gönderir. Saklanır: temasız kullanıcının avatar rengi */
  avatarColor?: string;
  /** null: temayı kaldırır */
  profileTheme?: ProfileTheme | null;
  /**
   * Set efekti: setin kimliği (yerleşik ya da yayında olan bir paket); null: efekti kaldırır. Yanıtta
   * animatedEffect'te döner. Eski istemcilerin gönderdiği kaldırılmış efektler (snow, sparkles, petals)
   * sessizce yok sayılır.
   */
  profileEffect?: CosmeticSetId | null;
  /**
   * Hareketli dekorasyon (`anim:<set kimliği>`); null: kaldırır. Eski istemcilerin gönderdiği kaldırılmış
   * katalog kimlikleri sessizce yok sayılır.
   */
  avatarDecoration?: string | null;
  /** İsim plakası: setin kimliği (yerleşik ya da yayında olan bir paket); null: kaldırır */
  nameplate?: CosmeticSetId | null;
}

/** Profil kartının iki rengi ("#rrggbb"): üstte primary, altta accent */
export interface ProfileTheme {
  primary: string;
  accent: string;
}

// Hareketli kozmetik setleri: yerleşik setler, set kimliği ve sunucudan dağıtılan paketlerin sözleşmesi
// cosmetics.ts'te. Aşağıdakiler kullanıcının seçimlerini okuyan yardımcılar. "Yerleşik" olanlar (PROFILE_EFFECTS,
// NAMEPLATES, userProfileEffect, userNameplate, animatedDecorationSet) istemcinin kodla çizdiği altı sete
// daraltır; paketlerle birlikte tam liste client-core'daki paket deposundan okunur (selectableCosmeticSets).

/** Yerleşik setlerin profil efektleri (kimliği setin kimliği): istemcide kodla çizilir */
export const PROFILE_EFFECTS = COSMETIC_SETS;
export type ProfileEffect = CosmeticSet;
export const PROFILE_EFFECT_LABELS: Record<ProfileEffect, string> = COSMETIC_SET_LABELS;

/** Kullanıcının kartındaki efektin set kimliği (yerleşik ya da paket); yoksa ya da biçimi bozuksa null */
export const userEffectId = (user: Pick<User, 'animatedEffect'>): CosmeticSetId | null =>
  isCosmeticSetId(user.animatedEffect) ? user.animatedEffect : null;

/** Kullanıcının isim plakasının set kimliği (yerleşik ya da paket); yoksa ya da biçimi bozuksa null */
export const userNameplateId = (user: Pick<User, 'nameplate'>): CosmeticSetId | null =>
  isCosmeticSetId(user.nameplate) ? user.nameplate : null;

/** Kullanıcının kartındaki efekt YERLEŞİK setlerden biriyse o; değilse (paket, yok, tanınmıyor) null */
export const userProfileEffect = (user: Pick<User, 'animatedEffect'>): ProfileEffect | null =>
  isCosmeticSet(user.animatedEffect) ? user.animatedEffect : null;

/** Kullanıcının isim plakası YERLEŞİK setlerden biriyse o; değilse (paket, yok, tanınmıyor) null */
export const userNameplate = (user: Pick<User, 'nameplate'>): Nameplate | null =>
  isCosmeticSet(user.nameplate) ? user.nameplate : null;

/**
 * Hareketli avatar dekorasyonları: `anim:<set kimliği>`. 0.8.x istemciler bu kimliği eski kataloglarında
 * bulamaz ve dekorasyon çizmez (0.8.4 masaüstü hareketli olanı zaten çizer).
 */
export const ANIMATED_DECORATION_PREFIX = 'anim:';
export type AnimatedDecoration = `anim:${CosmeticSetId}`;
export const animatedDecoration = (set: CosmeticSetId): AnimatedDecoration => `anim:${set}`;
/** Yerleşik setlerin dekorasyonları */
export const ANIMATED_DECORATIONS: readonly AnimatedDecoration[] = COSMETIC_SETS.map(animatedDecoration);
/**
 * Hareketli dekorasyonun set kimliği (yerleşik ya da paket); kimlik hareketli dekorasyon değilse (eski
 * katalog kimliği, boş, biçimi bozuk) null
 */
export function animatedDecorationId(id: string | null | undefined): CosmeticSetId | null {
  if (!id || !id.startsWith(ANIMATED_DECORATION_PREFIX)) return null;
  const set = id.slice(ANIMATED_DECORATION_PREFIX.length);
  return isCosmeticSetId(set) ? set : null;
}
/** Hareketli dekorasyon YERLEŞİK setlerden birininse o set; değilse (paket, eski katalog kimliği, boş) null */
export function animatedDecorationSet(id: string | null | undefined): CosmeticSet | null {
  const set = animatedDecorationId(id);
  return isCosmeticSet(set) ? set : null;
}

/** Yerleşik setlerin isim plakaları (kimliği setin kimliği) */
export const NAMEPLATES = COSMETIC_SETS;
export type Nameplate = CosmeticSet;
export const NAMEPLATE_LABELS: Record<Nameplate, string> = COSMETIC_SET_LABELS;

/** "#rrggbb" */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Afiş boyutu (piksel, 17:6); istemciler kartın genişliğine göre sığdırır */
export const BANNER_WIDTH = 1020;
export const BANNER_HEIGHT = 360;

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  /** Bu cihazın bildirim jetonu (biliniyorsa): diğer jetonlar silinirken bu korunur */
  pushToken?: string;
}

/** Yöneticinin verdiği tek kullanımlık kodla şifre sıfırlama (giriş ekranı). */
export interface ResetPasswordRequest {
  username: string;
  code: string;
  newPassword: string;
}

export interface ResetCodeResponse {
  code: string;
  expiresAt: number;
}

export interface CreateRoleRequest {
  name: string;
  color?: string | null;
  hoist?: boolean;
  permissions?: number;
}

export interface UpdateRoleRequest {
  name?: string;
  color?: string | null;
  hoist?: boolean;
  permissions?: number;
}

/** @everyone hariç tüm roller, yukarıdan aşağı yeni sırasıyla */
export interface ReorderRolesRequest {
  roleIds: string[];
}

export interface CreateGuildRequest {
  name: string;
}

export interface UpdateGuildRequest {
  name?: string;
  /** Sahipliği devretmek (yalnızca sahip) */
  ownerId?: string;
}

export interface BanRequest {
  reason?: string;
}

export interface Ban {
  user: User;
  reason: string | null;
  bannedAt: number;
}

/** Sesli sohbette üyeyi yönetmek; channelId: başka kanala taşı, null: sesten çıkar */
export interface VoiceModerationRequest {
  mute?: boolean;
  deaf?: boolean;
  channelId?: string | null;
}

export interface CreateInviteRequest {
  maxUses?: number | null;
  expiresInHours?: number | null;
}

/** Davetle katılınan sunucu (POST /api/invites/:code/accept) */
export interface AcceptInviteResponse {
  guild: Guild;
  /** Zaten üyeydin */
  alreadyMember: boolean;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
}

export interface UpdateChannelRequest {
  name?: string;
  position?: number;
  /** Kanalın tüm rol izinleri (verilirse eskilerinin yerine geçer) */
  overwrites?: PermissionOverwrite[];
}

export interface CreateMessageRequest {
  /** Dosya eklendiyse boş olabilir */
  content: string;
  /** Önce POST /api/channels/:id/attachments ile yüklenen dosyalar */
  attachmentIds?: string[];
  /** Aynı kanaldaki bir mesaja yanıt (eski sunucular bu alanı yok sayar, mesaj normal gider) */
  replyToId?: string;
  /** Yanıtta asıl yazar bildirilsin mi (Discord'daki "@ AÇIK"); verilmezse evet */
  replyMention?: boolean;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface AckRequest {
  messageId: string;
}

/**
 * Direkt mesaj başlatmak. Tek kişi: bire bir konuşma (varsa var olanı döner, 200; yoksa oluşturulur,
 * 201). Birden çok kişi: yeni grup (en fazla DM_GROUP_MAX_PARTICIPANTS kişi, sen dahil).
 */
export interface CreateDmRequest {
  /** Diğer katılımcılar (sen hariç) */
  userIds: string[];
  /** Grubun adı (yalnızca grupta) */
  name?: string | null;
}

/** Grubun adını değiştirmek; null ya da boş: ad kaldırılır */
export interface UpdateDmRequest {
  name: string | null;
}

export interface VoiceJoinResponse {
  /** İstemcinin bağlanacağı LiveKit adresi (ws:// veya wss://) */
  url: string;
  token: string;
  roomName: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

// ---------- Gateway (WebSocket) ----------

export interface ReadyPayload {
  user: User;
  /** Kullanıcının üye olduğu sunucular, katılma sırasıyla (hiç yoksa boş) */
  guilds: GuildData[];
  /**
   * Kullanıcının görebildiği hesapların profilleri: ortak sunuculardaki (eski üyeler dahil), direkt mesaj
   * konuşmalarındaki kişiler ve arkadaşlar
   */
  users: User[];
  /** Yalnızca görülebilen ses kanallarındakiler */
  voiceStates: VoiceState[];
  /** Ortak sunucularda ve arkadaşlardan çevrimiçi olanlar (görünmez olanlar hariç) */
  online: string[];
  /**
   * `online` listesindekilerin durumu ve özel durumu (eski sunucularda gelmez: hepsi 'online' sayılır).
   * Kullanıcının kendisi de, çevrimiçi görünüyorsa, buradadır (otomatik "boşta" dahil).
   */
  presences?: Record<string, Presence>;
  /** Kullanıcının kendi durum ayarları (eski sunucularda gelmez) */
  status?: SelfStatus;
  /**
   * Ana sunucu (ilk kurulan): silinemez; ilk hesap ve yönetici davetiyle açılan hesaplar ona katılır. Hesap
   * yöneticiliği ona bağlı değildir (bkz. User.isAdmin). Kullanıcı üyesi olmasa da bildirilir.
   */
  primaryGuildId: string | null;
  /** Metin kanallarındaki en son mesaj kimliği (kanal → mesaj) */
  lastMessageIds: Record<string, string>;
  /** Bu kullanıcının kanal başına okuduğu son mesaj (kanal → mesaj) */
  readStates: Record<string, string>;
  /** Bu kullanıcının kanal başına okunmamış bahsetme sayısı */
  mentionCounts: Record<string, number>;
  /** Tek dosyanın en büyük boyutu (bayt); istemci yüklemeden önce denetler */
  attachmentMaxBytes: number;
  /** İsteğe bağlı özellikler (ör. GIF araması); eski sunucularda hiç gelmez */
  features?: ServerFeatures;
  /**
   * Kullanıcının listesinde açık direkt mesaj konuşmaları. Yalnızca IDENTIFY'da 'dm' özelliğini bildiren
   * istemcilere gelir; bunların okunmamış bilgisi (son mesaj, okunan son mesaj, okunmamış mesaj sayısı)
   * kanallarınkiyle birlikte lastMessageIds / readStates / mentionCounts içindedir. DM'de karşı tarafın
   * her mesajı bahsetme gibi sayılır.
   */
  dms?: DmChannel[];
  /**
   * Katıldığın konuşmalarda süren sesli aramalar (çalınıyor olabilirsin: ringing). Yalnızca 'dm' özelliğini
   * bildiren istemcilere; eski sunucularda hiç gelmez.
   */
  dmCalls?: DmCall[];
  /** Engellediğin kişiler (yalnızca senin listen; seni engelleyenler hiçbir yerde söylenmez). Eski sunucularda yok. */
  blockedUserIds?: string[];
  /** Arkadaşların ve bekleyen istekler (profilleriyle). Eski sunucularda yok. */
  friends?: FriendsList;
}

export type GatewayServerMessage =
  | { t: 'HELLO'; d: { heartbeatInterval: number } }
  | { t: 'READY'; d: ReadyPayload }
  | { t: 'HEARTBEAT_ACK' }
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceState }
  | { t: 'VOICE_STATE_DELETE'; d: { userId: string; channelId: string } }
  /** Profil değişti (ya da yeni tanınan biri) */
  | { t: 'USER_UPDATE'; d: User }
  | { t: 'USER_DELETE'; d: { id: string } }
  /**
   * Çevrimiçi durumu değişti. `online` eski istemciler içindir (boşta/rahatsız etmeyin = true, görünmez =
   * false); `status` ve `customStatus` eski sunucularda gelmez. Kullanıcının kendisine de gider.
   */
  | { t: 'PRESENCE_UPDATE'; d: { userId: string; online: boolean } & Partial<Presence> }
  /** Kendi durum ayarların değişti (başka cihazdan, süresi doldu ya da özel durum temizlendi) */
  | { t: 'USER_STATUS_UPDATE'; d: SelfStatus }
  | { t: 'CHANNEL_CREATE'; d: Channel }
  | { t: 'CHANNEL_UPDATE'; d: Channel }
  | { t: 'CHANNEL_DELETE'; d: { id: string; guildId?: string } }
  /** Bir sunucuya katıldın ya da sunucu kurdun */
  | { t: 'GUILD_CREATE'; d: GuildCreatePayload }
  | { t: 'GUILD_UPDATE'; d: Guild }
  /** Sunucu listenden çıktı: ayrıldın, atıldın, yasaklandın ya da sunucu silindi */
  | { t: 'GUILD_DELETE'; d: { id: string; reason?: string } }
  /** Sunucuya biri katıldı (ya da geri döndü) */
  | { t: 'GUILD_MEMBER_ADD'; d: { guildId: string; member: GuildMember; user: User } }
  /** Üyenin rolleri değişti */
  | { t: 'GUILD_MEMBER_UPDATE'; d: { guildId: string; member: GuildMember } }
  /** Üye sunucudan ayrıldı, atıldı ya da yasaklandı (eski üye olarak kalır) */
  | { t: 'GUILD_MEMBER_REMOVE'; d: { guildId: string; userId: string } }
  /** Sunucunun rollerinden biri eklendi, değişti, silindi ya da sıralama değişti: tüm liste */
  | { t: 'ROLES_UPDATE'; d: { guildId: string; roles: Role[] } }
  /**
   * Yetkili biri seni başka ses kanalına taşıdı: seste olan istemci o kanala geçer. (Kendi sunucumuzdaki
   * LiveKit katılımcı taşımayı desteklemiyor; bu olayı tanımayan eski istemci bir süre sonra sesten çıkarılır.)
   */
  | { t: 'VOICE_MOVE'; d: { channelId: string } }
  | { t: 'MESSAGE_CREATE'; d: Message }
  | { t: 'MESSAGE_UPDATE'; d: MessageUpdate }
  | { t: 'MESSAGE_DELETE'; d: { id: string; channelId: string } }
  /**
   * Kanalın sabitlenmiş mesajları değişti (sabitlendi, sabitleme kaldırıldı ya da sabitli mesaj silindi).
   * Mesajın kendisi ayrıca MESSAGE_UPDATE (pinned) / MESSAGE_DELETE ile gelir. Eski istemciler yok sayar.
   */
  | { t: 'CHANNEL_PINS_UPDATE'; d: ChannelPinsUpdate }
  | { t: 'MESSAGE_REACTION_ADD'; d: ReactionEvent }
  | { t: 'MESSAGE_REACTION_REMOVE'; d: ReactionEvent }
  | { t: 'TYPING_START'; d: { channelId: string; userId: string } }
  /**
   * Okunma durumu ilerledi (bu kullanıcı bir cihazda kanalı okudu ya da oraya yazdı): kullanıcının bütün
   * oturumlarına gider; okunmamış işaretleri ve bahsetme sayıları diğer cihazlarda da temizlenir.
   * `mentionCount` onaydan sonraki sayıdır (kanalın sonuna kadar okunduysa 0). Eski istemciler yok sayar.
   */
  | { t: 'READ_STATE_UPDATE'; d: ReadStateUpdate }
  /**
   * Direkt mesaj olayları (yalnızca 'dm' özelliğini bildiren istemcilere, yalnızca katılımcılara).
   * CREATE: konuşma listende göründü (yeni, yeniden açıldı ya da gruba eklendin; mesaj olaylarından önce
   * gelir). UPDATE: grup adı ya da katılımcılar değişti. DELETE: listenden kalktı (kapattın ya da ayrıldın).
   */
  | { t: 'DM_CHANNEL_CREATE'; d: DmChannel }
  | { t: 'DM_CHANNEL_UPDATE'; d: DmChannel }
  | { t: 'DM_CHANNEL_DELETE'; d: { id: string } }
  /**
   * Konuşmada sesli arama başladı ya da değişti (çalınanlar listesi). Yalnızca 'dm' özelliğini bildiren
   * istemcilere, konuşmanın katılımcılarına. Eski istemciler tanımadığı olayı yok sayar.
   */
  | { t: 'DM_CALL_UPDATE'; d: DmCall }
  /** Arama bitti (ses odası boşaldı) */
  | { t: 'DM_CALL_DELETE'; d: { channelId: string } }
  /** Engellediklerin değişti (yalnızca engelleyenin kendi oturumlarına): listenin tamamı */
  | { t: 'USER_BLOCKS_UPDATE'; d: { userIds: string[] } }
  /**
   * Arkadaşların ya da bekleyen isteklerin değişti (istek geldi/gitti, kabul edildi, reddedildi, geri
   * çekildi, arkadaşlıktan çıkıldı, engelleme): listenin tamamı, yalnızca o kullanıcının oturumlarına.
   * Eski istemciler tanımadığı olayı yok sayar.
   */
  | { t: 'FRIENDS_UPDATE'; d: FriendsList }
  | { t: 'INVALID_SESSION'; d: { reason: string } }
  /** İstemci sürümü eski: bağlantı kapatılır, güncellemeden yeniden bağlanılamaz */
  | { t: 'UPDATE_REQUIRED'; d: { version: string } }
  /** Yeni sürüm yayınlandı: istemci arka planda indirmeye başlar */
  | { t: 'UPDATE_AVAILABLE'; d: { version: string } }
  /** Yeni geri bildirim (yalnızca hesap yöneticilerine) */
  | { t: 'FEEDBACK_CREATE'; d: Feedback }
  /** Geri bildirimin durumu ya da notu değişti (hesap yöneticilerine ve gönderene) */
  | { t: 'FEEDBACK_UPDATE'; d: Feedback }
  | { t: 'FEEDBACK_DELETE'; d: { id: number } }
  /**
   * Sunucu, ses kanalındaki istemcilerden olay kaydını (son ~2 dakikanın saniyelik bağlantı ölçümleri) ister.
   * Yalnızca CLIENT_FEATURE_VOICE_TRACE bildiren oturumlara gider; eski istemciler tanımadığı olayı yok sayar.
   */
  | { t: 'VOICE_TRACE_REQUEST'; d: VoiceTraceRequest };

/** İstemci türü: sürüm kuralı her platform için ayrı uygulanır */
export type ClientPlatform = 'desktop' | 'android' | 'ios';

export interface IdentifyPayload {
  token: string;
  /** Uygulama sürümü (masaüstünde 0.1.3'ten itibaren gönderilir) */
  version?: string;
  /** Bildirilmezse masaüstü sayılır (0.1.4 öncesi masaüstü sürümleri göndermez) */
  platform?: ClientPlatform;
  /**
   * İstemcinin tanıdığı ek özellikler (bkz. CLIENT_FEATURE_*). Bildirilmeyen özelliğin verisi ve olayları
   * gönderilmez: ör. eski istemciler direkt mesajları tanımadığından onlara hiç DM gitmez.
   */
  features?: string[];
}

/** İstemci direkt mesajları tanıyor: READY'de `dms`, DM_CHANNEL_* ve DM mesaj olayları gelir */
export const CLIENT_FEATURE_DM = 'dm';
/**
 * İstemci boşta olduğunu bildirir (IDLE_SET). Bunu bildiren bir masaüstü oturumu etkinken (boşta değil)
 * telefonlara bildirim gönderilmez: kişi mesajı zaten masaüstünde canlı görüyor.
 */
export const CLIENT_FEATURE_PRESENCE = 'presence';
/**
 * İstemci sunucudan dağıtılan kozmetik paketlerini tanıyor: kullanıcıların set seçimlerinde (animatedEffect,
 * avatarDecoration, nameplate) yerleşik olmayan kimlikler de gelir ve istemci tanımadığı kimliği sorunsuz
 * yok sayar. Bildirmeyen istemciye (0.9.1 ve öncesi) bu alanlarda yalnızca yerleşik kimlikler gider, gerisi
 * null olur: o sürümlerin masaüstü istemcisi tanımadığı isim plakası kimliğinde çizim döngüsünü düşürür.
 * Gateway'de IDENTIFY'ın `features` listesinde, HTTP isteklerinde CLIENT_FEATURES_HEADER başlığında bildirilir.
 */
export const CLIENT_FEATURE_COSMETIC_PACKS = 'cosmetic_packs';
/** İstemcinin tanıdığı özelliklerin (CLIENT_FEATURE_*) virgülle ayrılmış listesini taşıyan HTTP başlığı */
export const CLIENT_FEATURES_HEADER = 'x-diskort-features';

export type GatewayClientMessage =
  | { t: 'IDENTIFY'; d: IdentifyPayload }
  | { t: 'HEARTBEAT' }
  | { t: 'VOICE_STATE_SET'; d: { selfMute: boolean; selfDeaf: boolean } }
  | { t: 'TYPING_START'; d: { channelId: string } }
  /** Bu oturum boşta mı (masaüstünde ~10 dk girdi yok ya da ekran kilitli; telefonda uygulama arka planda) */
  | { t: 'IDLE_SET'; d: { idle: boolean } }
  /**
   * İzlenen yayınların tam listesi (yayıncıların kimlikleri). Liste her değiştiğinde ve yeniden bağlanınca
   * (seste iken) gönderilir; eski sunucular tanımaz ve yok sayar.
   */
  | { t: 'STREAM_WATCH_SET'; d: { userIds: string[] } }
  /**
   * Bu oturumun etkinliklerinin tam listesi (açık oyunlar, en fazla ACTIVITY_MAX_COUNT); boş: hiçbiri.
   * Değişince ve yeniden bağlanınca gönderilir; eski sunucular tanımaz ve yok sayar.
   */
  | { t: 'ACTIVITY_SET'; d: { activities: ActivityReport[] } };

// ---------- Sabitler ----------

export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;
/** Gateway kapanış kodu: istemci güncellenmeden yeniden bağlanmamalı */
export const GATEWAY_CLOSE_UPDATE_REQUIRED = 4010;

export const USERNAME_PATTERN = /^[a-z0-9_.]{3,32}$/;
/** Bahsetme sözcükleri kullanıcı adı olamaz */
export const RESERVED_USERNAMES: readonly string[] = ['everyone', 'here'];
export const GUILD_NAME_MAX_LENGTH = 48;
/** Bir hesabın üye olabileceği en fazla sunucu */
export const MAX_GUILDS_PER_USER = 100;
/** Bir hesabın sahibi olabileceği en fazla sunucu */
export const MAX_OWNED_GUILDS = 10;
export const BAN_REASON_MAX_LENGTH = 200;
export const PASSWORD_MIN_LENGTH = 8;
export const DISPLAY_NAME_MAX_LENGTH = 32;
export const CHANNEL_NAME_MAX_LENGTH = 48;
/** Grup DM'indeki en fazla kişi (kuran dahil) */
export const DM_GROUP_MAX_PARTICIPANTS = 10;
export const DM_NAME_MAX_LENGTH = 48;
export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_PAGE_SIZE = 50;
/** Yanıt özetindeki (referencedMessage.content) en fazla karakter */
export const REPLY_EXCERPT_LENGTH = 200;
/** Bir mesajdaki en fazla farklı emoji tepkisi sayısı */
export const MESSAGE_MAX_REACTIONS = 20;
/** Bir kanalda (ya da direkt mesaj konuşmasında) en fazla sabitlenmiş mesaj sayısı */
export const MAX_PINS_PER_CHANNEL = 50;
/** Kanal panelinde "Medya" sekmesinin sayfa boyutu (dosya) ve en fazlası */
export const CHANNEL_MEDIA_PAGE_SIZE = 48;
export const CHANNEL_MEDIA_MAX_PAGE_SIZE = 100;
/** Kanal panelinde "Bağlantılar" sekmesinin sayfa boyutu (mesaj) ve en fazlası */
export const CHANNEL_LINKS_PAGE_SIZE = 30;
export const CHANNEL_LINKS_MAX_PAGE_SIZE = 100;
/** Kanal panelinde bir mesajdan en fazla bu kadar bağlantı listelenir */
export const CHANNEL_LINKS_PER_MESSAGE = 10;
/** Tepki verenler listesinin varsayılan ve en büyük sayfa boyutu */
export const REACTION_USERS_PAGE_SIZE = 50;
export const REACTION_USERS_MAX_PAGE_SIZE = 100;
/** Bir mesajdaki en fazla dosya sayısı */
export const MESSAGE_MAX_ATTACHMENTS = 10;
/** Sunucu ayarı yoksa tek dosyanın en büyük boyutu */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Mesajın içinde resim olarak gösterilen türler (sunucu bunları dosyanın içeriğinden belirler) */
export const INLINE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const isImageAttachment = (a: Pick<Attachment, 'contentType'>): boolean =>
  INLINE_IMAGE_TYPES.includes(a.contentType);
/**
 * Mesajın içinde oynatılan video türleri (sunucu bunları dosyanın içeriğinden belirler: MP4/QuickTime
 * "ftyp" kutusu, WebM EBML başlığı). Matroska (.mkv) indirilebilir dosya olarak kalır.
 */
export const INLINE_VIDEO_TYPES: readonly string[] = ['video/mp4', 'video/webm', 'video/quicktime'];

export const isVideoAttachment = (a: Pick<Attachment, 'contentType'>): boolean =>
  INLINE_VIDEO_TYPES.includes(a.contentType);
/** Yüklenen profil fotoğrafının en büyük boyutu (PNG, JPEG, WebP ya da GIF; sunucu küçültür) */
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
/** "Yazıyor…" göstergesinin geçerlilik süresi; istemci bu aralıkta en fazla bir kez bildirir */
export const TYPING_TIMEOUT_MS = 8000;

export const AVATAR_COLORS = [
  '#5865f2',
  '#3ba55c',
  '#faa61a',
  '#ed4245',
  '#eb459e',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
  '#747f8d',
] as const;

const VOICE_ROOM_PREFIX = 'ch_';

export function voiceRoomName(channelId: string): string {
  return VOICE_ROOM_PREFIX + channelId;
}

export function channelIdFromRoom(roomName: string): string | null {
  return roomName.startsWith(VOICE_ROOM_PREFIX) ? roomName.slice(VOICE_ROOM_PREFIX.length) : null;
}

/** Android bildirim kanalları (kimlikler kalıcıdır: telefon kanalı bu kimlikle oluşturur, sunucu bununla gönderir) */
export const PUSH_CHANNEL_MENTIONS = 'diskort-mentions';
export const PUSH_CHANNEL_DM = 'diskort-dm';
/**
 * Gelen arama ve cevapsız arama bildirimleri: yüksek öncelikli ayrı kanal (telefon uygulaması oluşturur;
 * oluşturmamış eski sürümde Android bildirimi varsayılan kanalda gösterir).
 */
export const PUSH_CHANNEL_CALL = 'diskort-call';

/**
 * Telefon bildiriminin verisi (`data`; iOS'ta ayrıca `body` altında): her türde `type` ve (test hariç)
 * `channelId` vardır; dokununca o kanal ya da konuşma açılır. 'call': biri seni arıyor; 'missed_call':
 * aynı aramanın cevapsız kaldığı (aynı etiketle öncekinin yerini alır). Aramalarda `messageId` arama kaydının
 * kimliğidir (konuşma okununca bildirim kalkar, bkz. pushTag).
 */
export type PushDataType = 'mention' | 'dm' | 'call' | 'missed_call' | 'test';

const PUSH_TAG_PREFIX = 'diskort:';

/**
 * Android bildiriminin etiketi (FCM `tag`): mesaja özgüdür, yani yeni mesaj öncekinin yerini almaz. Uygulama
 * kapalıyken bildirimi işletim sistemi gösterir ve verisi (channelId) uygulamaya okunamaz; okununca
 * kaldırılacak bildirimler bu etiketten bulunur (bkz. parsePushTag).
 */
export function pushTag(channelId: string, messageId: string): string {
  return `${PUSH_TAG_PREFIX}${channelId}:${messageId}`;
}

export function parsePushTag(tag: string): { channelId: string; messageId: string } | null {
  if (!tag.startsWith(PUSH_TAG_PREFIX)) return null;
  const rest = tag.slice(PUSH_TAG_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0 || at === rest.length - 1) return null;
  return { channelId: rest.slice(0, at), messageId: rest.slice(at + 1) };
}

// ---------- Yardımcılar ----------

/**
 * Metindeki @kullanıcıadı bahsetmeleri (küçük harfle, tekrarsız). E-posta gibi bir kelimenin
 * ortasındaki @ sayılmaz; sondaki noktalar ("@ali.") cümle noktalaması kabul edilir.
 */
export function extractMentions(content: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(/(?<![a-z0-9_.@])@([a-z0-9_.]*[a-z0-9_])/gi)) names.add(m[1]!.toLowerCase());
  return [...names];
}

/**
 * Mesajın yanıtların üstünde gösterilen özeti. Sunucu okurken, istemci de ekrandaki yanıtları asıl
 * mesajın güncellemesiyle tazelerken aynı kuralı kullanır.
 */
export function referenceOf(
  message: Pick<Message, 'id' | 'authorId' | 'content'> & { embeds?: readonly Embed[] | null },
  hasAttachments: boolean,
): ReferencedMessage {
  return {
    id: message.id,
    authorId: message.authorId,
    // GIF mesajının metni GIPHY bağlantısıdır; özette bağlantı yerine "GIF" yazar (eski istemcilerde de)
    content: isGifMessage(message) ? GIF_SNIPPET : [...message.content].slice(0, REPLY_EXCERPT_LENGTH).join(''),
    hasAttachments,
  };
}

/** Yanıt özetinde ve bildirimlerde GIF mesajının metni */
export const GIF_SNIPPET = 'GIF';

/** Sunucunun GIF gömdüğü mesaj (metni yalnızca bir GIPHY bağlantısıdır) */
export const isGifMessage = (message: { embeds?: readonly Embed[] | null }): boolean =>
  message.embeds?.some((e) => e.type === 'gif') ?? false;

/**
 * Kod blokları (```…```) ve satır içi kod (`…`): içlerindeki @everyone / @here bahsetme sayılmaz
 * (istemcilerdeki biçimlendirme de bunları kod olarak gösterir).
 */
const CODE_SPANS = /```(?:[a-z0-9+#.-]+\n)?\n?[\s\S]*?\n?```|`[^`\n]+`/gi;

const withoutCode = (content: string): string => content.replace(CODE_SPANS, ' ');

/** Metindeki bağlantılar (istemcilerin bağlantı olarak gösterdiği biçim; bkz. client-core markdown) */
const URL_IN_TEXT = /(<)?(https?:\/\/[^\s<>"]*[^\s<>".,:;'!?)\]])(>)?/gi;
const SPOILERS = /\|\|[\s\S]+?\|\|/g;
// Paket DOM/Node türleri olmadan derlenir; URL her ortamda (tarayıcı, Node, Hermes) vardır.
declare const URL: new (input: string) => { protocol: string; username: string; password: string; hostname: string; href: string };
/** Önizlenecek bağlantının en fazla uzunluğu */
export const EMBED_URL_MAX_LENGTH = 2048;

/**
 * Önizlenecek bağlantılar (en fazla MESSAGE_MAX_LINK_EMBEDS, tekrarsız, metindeki sırayla). Kod blokları,
 * satır içi kod ve ||sürpriz|| içindekiler ile <https://…> biçiminde yazılanlar (Discord'daki gibi
 * önizlemeyi kapatma) sayılmaz. Kullanıcı adı/şifre içeren ya da çok uzun adresler atlanır.
 */
export function extractEmbedUrls(content: string): string[] {
  return scanUrls(content, false, MESSAGE_MAX_LINK_EMBEDS);
}

/**
 * Mesajdaki bağlantılar (kanal panelinin "Bağlantılar" sekmesi için; en fazla `max`, tekrarsız, metindeki
 * sırayla). Önizlemedeki kurallarla aynı, ama <https://…> biçiminde yazılanlar da sayılır.
 */
export function extractMessageUrls(content: string, max = CHANNEL_LINKS_PER_MESSAGE): string[] {
  return scanUrls(content, true, max);
}

function scanUrls(content: string, withSuppressed: boolean, max: number): string[] {
  const text = withoutCode(content).replace(SPOILERS, ' ');
  const urls: string[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    if (m[1] && m[3] && !withSuppressed) continue;
    const raw = m[2]!;
    if (raw.length > EMBED_URL_MAX_LENGTH) continue;
    let url: InstanceType<typeof URL>;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) continue;
    const href = url.href;
    if (!urls.includes(href)) urls.push(href);
    if (urls.length >= max) break;
  }
  return urls;
}

/** Metinde kod dışında @everyone bahsetmesi var mı (yazarın yetkisi ayrıca denetlenir) */
export function mentionsEveryone(content: string): boolean {
  return /(?<![a-z0-9_.@])@everyone(?![a-z0-9_])/i.test(withoutCode(content));
}

/**
 * Metinde kod dışında @here bahsetmesi var mı. @here, @everyone ile aynı yetkiyi (MENTION_EVERYONE)
 * ister ama yalnızca o an çevrimiçi olanlara (gateway'e bağlı) bildirim gider.
 */
export function mentionsHere(content: string): boolean {
  return /(?<![a-z0-9_.@])@here(?![a-z0-9_])/i.test(withoutCode(content));
}

/** "1.2.3" biçimindeki sürümleri karşılaştırır (ön ek "v" ve "-beta" gibi ekler yok sayılır). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Uygulama içi "Yenilikler" sayfasındaki bir sürüm (GET /api/releases) */
export interface ReleaseNotes {
  version: string;
  publishedAt: string;
  /** Sürüm notları (Markdown: başlıklar, madde işaretleri, kalın yazı) */
  notes: string;
}
