# Ses paneli (soundboard) ve yayın satırı: tasarım sözleşmesi

_2026-10-31. Özellik belgesi: adlar, uç noktalar ve sınırlar burada. Uygulamada netleşen ayrıntılar en altta._

## Ürün kararları (Yusuf, 2026-10-31)

- **Ses kanalı üye satırı (masaüstü):** yayın küçük resmi satırdan kalkar, yalnız hover kartında (`StreamPreviewCard`) görünür. "YAYINDA" hapı kalır, sağa yaslı; yanında susturma/sağır simgeleri. Oyun ikonu yuvası yayında olmayanlarda aynen kalır. Önizleme resmi artık yalnız kart açıkken indirilir.
- **Giriş sesi:** kişisel yükleme olarak kalır. Seçici Profil'den **Ses ve Görüntü → Ses Paneli** alt başlığına taşınır (iki platform). "Bildirimler ve Sesler"deki "Giriş sesleri" kaydırıcısı kalkar; yerine Ses Paneli altında tek **"Ses paneli ses seviyesi"** (giriş sesleri + ses paneli sesleri, 0 = kapalı).
- **Ses paneli:** sesler **sunucuya** bağlı. Yükleme/düzenleme/silme yalnız yeni **"Ses Panelini Yönet"** yetkisiyle (varsayılan: Sunucuyu Yönet yetkisi olan roller + sahip; @everyone'a verilmez). Çalma: ses kanalında Konuş yetkisi olan ve sunucuca susturulmamış/sağırlaştırılmamış herkes. Panelde kullanıcının üyesi olduğu **bütün sunucuların** sesleri, bulunduğu sunucu üstte.
- **Sınırlar:** sunucu başına **64** ses, ses en çok **5 sn** (giriş sesiyle aynı işleme hattı), girdi 8 MB, ad 1–32 karakter, isteğe bağlı tek emoji.
- **Mobil:** çalma + yükleme (belge seçici, kesit seçici yok: ilk 5 sn).
- **Alt panel (masaüstü):** 5'li düğme sırası 4'e iner: Kamera (devre dışı, "Yakında"), Ekran paylaş, **Ses paneli**, Yayın Ayarları. "Sahne" düğmesi kalkar (ses kanalına tıklamak zaten sahneyi açıyor). Ses seviyesi gizli sağ tık yerine panelin içinde görünür kaydırıcı olarak durur; sağ tık da aynı paneli açar.
- **Çalma beklemesi:** kişi çaldığı ses bitene dek yeni ses çalamaz (en az 2 sn); farklı kişilerin sesleri üst üste biner. Bağlantı kartında "oynatılıyor" satırı yok, çalan kişi avatar halkasından anlaşılır.
- DM aramalarında ses paneli yok. Sürüm: 0.13.0 (Yusuf "sürüm çıkar" deyince).

## Shared (`packages/shared`)

`permissions.ts`:
- `MANAGE_SOUNDBOARD: 1 << 21`, `ALL_PERMISSIONS = (1 << 22) - 1`. Sunucu düzeyinde yetki; `VOICE_CHANNEL_PERMISSIONS`'a ve `DEFAULT_EVERYONE_PERMISSIONS`'a **eklenmez**, `DM_PERMISSIONS`'a eklenmez.
- `permissionInfo.ts` (client-core): "Genel" grubuna `info('MANAGE_SOUNDBOARD', 'Ses Panelini Yönet', 'Sunucunun ses paneline ses yükleyebilir, sesleri yeniden adlandırabilir ve silebilir.')`, MANAGE_GUILD'in hemen altına.

`index.ts`:
```ts
export const SOUNDBOARD_MAX_SOUNDS = 64;          // sunucu başına
export const SOUNDBOARD_NAME_MAX = 32;            // ad 1..32 (trim sonrası)
export const SOUNDBOARD_SOUND_MAX_SECONDS = INTRO_SOUND_MAX_SECONDS; // 5
export const SOUNDBOARD_SOUND_MAX_BYTES = INTRO_SOUND_MAX_BYTES;     // 8 MB girdi
export const SOUNDBOARD_MIN_GAP_MS = 2000;                           // aynı kişinin iki çalması arası en az
export const soundboardCooldownMs = (durationMs: number): number => Math.max(durationMs, SOUNDBOARD_MIN_GAP_MS);

export interface GuildSound {
  id: string;
  guildId: string;
  name: string;
  /** Tek bir emoji (unicode) ya da null */
  emoji: string | null;
  /** Sunucu köküne göre adres: /api/sounds/<guildId>/<özet>.mp3 (kimliksiz, immutable) */
  url: string;
  uploaderId: string | null;
  createdAt: number;
  durationMs: number;
}
```
- `GuildData`'ya `sounds: GuildSound[]` eklenir (READY ve GUILD_CREATE içinde gelir; eski sunucu göndermezse istemci `[]` sayar).
- Sunucu→istemci olaylar (`GatewayServerMessage`): `GUILD_SOUND_CREATE { sound }`, `GUILD_SOUND_UPDATE { sound }`, `GUILD_SOUND_DELETE { guildId, soundId }` (sunucu üyelerine `sendToGuild`); `SOUNDBOARD_PLAY { channelId, guildId, userId, sound: GuildSound }` (yalnız o ses kanalındaki üyelere, gönderen dahil; `sound` tam nesne ki başka sunucunun sesi de çalınabilsin). Eski istemciler bilinmeyen olayı yok sayar; bayrak gerekmez.

## Sunucu (`apps/server`)

- **Şema 29** (`db.ts` MIGRATIONS[28], `migration.test.ts` sabiti 29):
  ```sql
  CREATE TABLE guild_sounds (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL, emoji TEXT, hash TEXT NOT NULL, size INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);
  CREATE INDEX guild_sounds_guild ON guild_sounds(guild_id);
  UPDATE roles SET permissions = permissions | (1<<21) WHERE permissions & MANAGE_GUILD  -- göç 18 deseni
  ```
- **Depolama:** `<DATA_DIR>/sounds/<özet>.mp3`, özet = `sha256('sound:' + guildId + '\0' + çıktı)` ilk 32 hex. İşleme `introSounds.ts`'teki ffmpeg hattı (ortak `ffmpegTranscode`/`readLimited`/`parseRange` paylaşılsın; `parseRange` tek kopyaya insin). Yeni servis `apps/server/src/soundboard.ts` `SoundboardService` (`upload`, `rename`, `remove`, `removeDeleted(hashes)`, `sweep`, `serial` kuyruğu; ffmpeg giriş sesiyle aynı kuyruğu paylaşabilir). Sweep `app.ts` sweep döngüsüne eklenir; `deleteGuild` dönüşüne `sounds: string[]` (özetler) eklenir ve rota diski temizler. `infra/backup-attachments.sh` ve `docs/sunucu-kurulumu.md` `sounds/` ve `intro-sounds/` dizinlerini sayar. Disk: yüklemede `MIN_FREE_BYTES` kontrolü (attachments deseni).
- **REST** (`apps/server/src/routes/soundboard.ts`):
  - `GET /api/guilds/:guildId/sounds` (üye) → `{ sounds: GuildSound[] }` (ada göre sıralı).
  - `POST /api/guilds/:guildId/sounds?name=&emoji=&start=&duration=` ham ses gövdesi (`MANAGE_SOUNDBOARD`) → `201 { sound }`; hatalar: `400 invalid_name|invalid_emoji|invalid_start|invalid_duration|unsupported|empty`, `409 sound_limit` (64), `413 too_large`, `429 rate_limited` (kullanıcı başına 10 / 10 dk, yükleme+silme ortak), `503 unavailable` (ffmpeg yok), `507 no_space`. Yayın `GUILD_SOUND_CREATE`.
  - `PATCH /api/guilds/:guildId/sounds/:soundId` JSON `{ name?, emoji? }` (`MANAGE_SOUNDBOARD`) → `{ sound }`, yayın `GUILD_SOUND_UPDATE`.
  - `DELETE /api/guilds/:guildId/sounds/:soundId` (`MANAGE_SOUNDBOARD` **ya da** hesap yöneticisi `isAdmin`) → 204, yayın `GUILD_SOUND_DELETE`.
  - `GET /api/sounds/:guildId/:file` kimliksiz; `file = <özet>.mp3` ve özet o sunucunun bir sesine ait olmalı, yoksa 404. Başlıklar giriş sesi ucuyla aynı (`private, max-age=31536000, immutable`, ETag, Range 206/416, nosniff, CSP sandbox).
  - `POST /api/voice/soundboard/play` JSON `{ guildId, soundId }` → 204. Kontroller sırasıyla: kullanıcı seste mi (`voice.get(userId)`, yoksa `409 not_in_voice`); bulunduğu kanal bir sunucu ses kanalı mı (DM ise `400 not_guild_voice`); o kanalda `SPEAK` var mı ve sunucuca susturulmuş/sağırlaştırılmış ya da kendini sağırlaştırmış değil mi (`403 muted`); ses var mı ve kullanıcı sesin sunucusuna üye mi (`404 unknown_sound`); kullanıcının önceki sesi bitti mi (`429 rate_limited`; başarılı çalma beklemeyi `soundboardCooldownMs(durationMs)` kadar başlatır, reddedilen istek uzatmaz, kanal değiştirmek sıfırlamaz). Sonra `gateway.sendToUsers(voice.membersOf(channelId), { t: 'SOUNDBOARD_PLAY', ... })`. `VoiceStateStore.membersOf(channelId): string[]` eklenir (dmCalls.ts'teki filter de ona geçer).
- **admin-cli:** `sound-remove <guildId> <soundId>` (DB + dosya, gateway yok), `SOUNDBOARD_SCHEMA = 29`.
- **Yönetim paneli:** `GuildStat.sounds { count, bytes }` + `admin.js`'de "Sesler" metriği.
- **Testler:** `apps/server/test/soundboard.test.ts` (sahte dönüştürücüyle: yükleme/liste/yeniden adlandırma/silme, yetki 403, 64 sınırı 409, hız sınırı, kimliksiz sunum + ETag/Range, eski özet 404, çalma olayı yalnız kanaldakilere (üç istemci: çalan, aynı kanalda, kanalı görüp seste olmayan), seste değilken 409, susturulmuşken 403, başka sunucunun sesi üyeyse çalınır, sunucu silinince dosya silinir, sweep), göç 29 testi, roles/permissions testlerinin sabitleri.

## client-core

- `api.ts`/`uploads.ts`: `fetchGuildSounds(guildId)`, `uploadGuildSound(file, { guildId, name, emoji, start?, duration? })`, `updateGuildSound(guildId, soundId, { name?, emoji? })`, `removeGuildSound(guildId, soundId)`, `playGuildSound(sound)`, `useSoundboardCooling()`; `guildSoundUrl` yardımcıları gerekiyorsa.
- `guild.ts` deposu: sunucu başına `sounds` (READY/GUILD_CREATE'ten; üç olayla güncellenir); seçici `soundsOf(guildId)`; tüm sunucular için `allSounds()` (sunucu kimliğine göre gruplu).
- `sfx.ts` (ortak): `ChannelSoundGate` ses paneli için **kullanılmaz**.
- `settingsSections.ts`: `voice` anahtar kelimelerine "giriş sesi", "ses paneli", "soundboard"; `notifications`'tan giriş sesi çıkar.

## Ayar anahtarı

`introSoundVolume` → **`soundboardVolume`** (0..1, varsayılan 1) iki platformda da; persist göçünde eski değer taşınır. Giriş sesleri ve ses paneli sesleri aynı kazançla (`× 0.5`) bu değeri kullanır. Masaüstü alt paneldeki aç/kapa düğmesi kalkar; `introVolumeBeforeOff` mantığı panel içindeki kaydırıcının hoparlör düğmesine geçer (tıkla: 0 ↔ önceki).

## Masaüstü (`apps/desktop`)

- **`VoiceMemberRow`:** `TrailingSlot` yayındayken `null` (oyun ikonu yalnız yayında değilken); `StreamThumb` ve `useLivePreviewImage` satırdan kalkar (kartta `usePreviewImage(open)` kalır). Sıra: avatar, ad (`flex-1 truncate`), `WatchLiveBadge`, `VoiceStateIcons`, oyun ikonu. Hover kartı değişmez.
- **`VoiceConnectionPanel`:** 4 sütun ızgara. "Sahne" düğmesi kaldırılır. "Giriş sesleri" düğmesi yerine "Ses paneli" (lucide `Music2`/`AudioLines`; `data-tooltip="Ses paneli"`): sol ve sağ tık `SoundboardPopover`'ı açar. Sağ tık menüsündeki `IntroVolumeControls` kaldırılır (kaydırıcı panelin içinde).
- **`SoundboardPopover`** (`components/sidebar/SoundboardPopover.tsx`, `PanelMenu` deseni, genişlik 340, panelin üstüne): başlık "Ses Paneli" + sağda hoparlör düğmesi ve `Slider` (soundboardVolume; 0 iken düğme üstü çizili). Gövde: sunucuya göre gruplar (bulunulan sunucu önce, sonra ad sırası; grup başlığı sunucu adı), 4 sütun kutucuk: emoji (yoksa `Music2`) + ad (truncate, tooltip tam ad). Tık = herkese çal (`playGuildSound`); kutucuğun sağ üstünde hover'da küçük kulaklık düğmesi = yalnız kendine dinle. 12'den çok ses varsa üstte arama kutusu. Grup başlığında, kullanıcının o sunucuda `MANAGE_SOUNDBOARD`'ı varsa "Ses ekle" (→ `openSoundUpload(guildId)`) ve 64 sınırında devre dışı. Boş: "Henüz ses yok." Seste değilken çalma düğmeleri devre dışı, tooltip "Önce bir ses kanalına katıl"; çalınan ses bitene dek soluk, tooltip "Sesin bitince yeniden çalabilirsin" (kendine dinleme çalışır). Esc/dışarı tık kapatır.
- **Çalma** (`lib/sfx.ts`): `playSoundboardSound(url, { own })` giriş sesinden ayrı düğümler, üst üste çalmaya izin, 5,5 sn tavan, kazanç `soundboardVolume × 0.5`, sağırken (kendi dahil) çalmaz, `soundboardVolume === 0` ise çalmaz; `previewSound(url)` ayarlardan bağımsız. `voiceClient.ts`: `gateway.on` ile `SOUNDBOARD_PLAY` → `useVoice.channelId === d.channelId && connected` ise çal, `setVoice({ introPlayingUserId: d.userId })` halkası 3 sn (giriş sesindeki halka yeniden kullanılır).
- **Yükleme modalı** (`components/sounds/SoundUploadModal.tsx` + `stores/ui.ts`'de `soundUpload: { guildId } | null`, `openSoundUpload(guildId)`): dosya seç → `IntroSoundPicker.tsx`'teki dalga formlu kesici `components/sounds/SoundClipEditor.tsx` olarak dışa alınır ve iki yerde kullanılır → ad (zorunlu, 32) + emoji (isteğe bağlı; mevcut `openEmojiPicker` ile seçilir, tek emoji) → yükle. Hata metinleri Türkçe (`sound_limit` → "Sunucuda en çok 64 ses olabilir.").
- **Sunucu Ayarları → "Sesler"** (`components/serverSettings/SoundsSection.tsx`; `ServerSettingsModal` SECTIONS, `stores/ui.ts` `ServerSettingsSection`, client-core `GUILD_SETTINGS_SECTIONS` id `sounds`, `any: [MANAGE_SOUNDBOARD]`): "12/64" sayacı, "Ses ekle", liste satırı: emoji, ad (tıkla: satır içi yeniden adlandır), yükleyen, süre, dinle düğmesi, sil (ConfirmDialog).
- **Ayarlar → Ses ve Görüntü:** en alta `SectionTitle "Ses Paneli"`: "Ses paneli ses seviyesi" kaydırıcı (açıklama: "Giriş sesleri ve ses paneli sesleri. 0 = kapalı."), altında `IntroSoundPicker` ("Giriş sesi" başlığı). `ProfileLookSettings`'ten ve `SoundSettings`'ten ilgili parçalar kaldırılır.

## Mobil (`apps/mobile`)

- **Ayarlar:** `ProfileSettings`'teki "Giriş Sesi" kartı ve `SoundSettings`'teki "Giriş sesleri" kaydırıcısı → `VoiceSettings`'e yeni "Ses Paneli" kartı: kaydırıcı (soundboardVolume) + giriş sesi (yükle/dinle/kaldır). `soundsAvailable()` false ise kart yerine mevcut not.
- **Ses ekranı (`app/voice.tsx`):** kontrol sırasına "Ses paneli" düğmesi (Ionicons `musical-notes`), `VoiceBar`'a eklenmez. `components/SoundboardSheet.tsx` (`BottomSheet`): başlık + kaydırıcı; sunucuya göre gruplar (bulunulan sunucu önce); 4 sütun kutucuk (emoji/ad); dokun = herkese çal (çalınan ses bitene dek kapalı), uzun bas = kendine dinle; grup başlığında yetki varsa "Ses ekle" → `pickGuildSound` (DocumentPicker audio/*, 8 MB) → ad/emoji için küçük form (sayfa içinde) → `uploadGuildSound` (start 0, duration 5).
- **Çalma (`sounds.ts`):** `playSoundboardSound(url)` giriş sesinden ayrı; her çalma için `createAudioPlayer` (iOS `keepAudioSessionActive: true`), bitince `remove`, en çok 4 eşzamanlı (fazlası en eskisini keser), 6 sn ömür; `attachments.ts downloadToCache` deseniyle önbellek (`FileSystem.cacheDirectory/sounds/<özet>.mp3`); sağırken ve `soundboardVolume === 0` iken çalmaz. `setAudioModeAsync` **çağrılmaz**. `voice.ts`: `gateway.on` `SOUNDBOARD_PLAY` → bağlı ve aynı kanaldaysa çal + `introPlayingUserId` halkası 3 sn.
- **Sunucu ayarları → Sesler** (`components/serverSettings/Sounds.tsx`, `common.tsx SECTION_INFO`, `sunucu-ayarlari/[bolum].tsx`): liste, yeniden adlandır, sil, ses ekle.
- Ayar deposu persist sürümü +1, `introSoundVolume → soundboardVolume` göçü.

## Belgeler ve harita

`docs/roller-ve-yetkiler.md` tablosuna yeni yetki; `docs/kod-haritasi.md`'ye yeni dosyalar ve "ses paneli" akışı; `docs/sunucu-kurulumu.md` yedek dizinleri. Vault: karar notu (sunucu sesleri, yetki, sınırlar), 2026-10-22 yuva kararı ve 2026-10-15 giriş sesi kararı güncellemesi, "sol alt panel" kuralına istisna.

## Uygulamada netleşenler

- **Dar ses satırı:** satır içeriği 170 px altındaysa (kenar çubuğu yaklaşık 226 px altı) YAYINDA hapı kırmızı noktaya iner; tıklama ve erişilebilir ad aynen kalır. Sahne, PiP ve yayın kartındaki rozet değişmez.
- **Halka:** ses paneli sesi giriş sesi halkasını (`introPlayingUserId`) paylaşır. Aynı anda ikisi çalarsa son gelen görünür; bilinçli sadelik.
- **"Sesli sohbet sesleri" anahtarı** giriş seslerini kapatır, ses paneli seslerini kapatmaz. Ses paneli yalnız seviye 0 ve sağırlıkla susar (Discord'daki gibi).
- **Sağırlaşınca** çalan sesler hemen söner (dinleme hariç). Kaydırıcı çalan seslere de anında uygulanır.
- **Çalma beklemesi:** `SOUNDBOARD_MIN_GAP_MS` (2 sn) taban dakikada en çok 30 çalma demek, ayrı dakikalık sınır yok. Kaynak sunucudur; istemci beklemesi (`useSoundboardCooling`) yalnız görünüm içindir, yanıttan sonra başlar ve sunucununkinden biraz geç biter. Kod `rate_limited` kaldı: 0.13.0 istemcileri onu sessiz geçer.
- **Süre:** `durationMs` çıktı boyutundan tahmin edilir (96 kbps), 100 ms'ye yuvarlanır.
- **Ad:** kontrol ve görünmez biçim karakterleri silinir; emoji birleştiricisi ve bayrak etiketleri kalır.
- **Yetki:** göç 29 biti @everyone'a vermez. Hesap yöneticisi sesi üye olmasa da REST ile silebilir.
- **Yükleme ilerlemesi** yüzde göstermez (dosya en çok 8 MB); "Yükleniyor…" yazar.
- **Masaüstünde** dosya seçimi modalın ilk adımıdır; tarayıcının çözemediği dosya kesitsiz yüklenir (ilk 5 sn).
