<div align="center">

# Diskort

**Arkadaş grupları için kendi sunucunda çalışan ses, ekran paylaşımı ve sohbet uygulaması.**

Discord kalitesinde ses ve yayın · 10–20 kişilik kapalı topluluklar için · Reklamsız, izlemesiz, verin sende

[![Son sürüm](https://img.shields.io/github/v/release/zziroo/diskort?label=s%C3%BCr%C3%BCm)](https://github.com/zziroo/diskort/releases/latest)
[![Lisans: MIT](https://img.shields.io/badge/lisans-MIT-blue)](LICENSE)
![Platformlar](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android%20%7C%20iOS-555)

**[⬇️ İndir](https://diskort.ziroo.net)** · [Özellikler](#özellikler) · [Nasıl çalışır?](#nasıl-çalışır) · [Geliştirme](#geliştirme) · [Kendi sunucunu kur](docs/sunucu-kurulumu.md)

</div>

---

## Diskort nedir?

Diskort, küçük bir arkadaş grubunun sesli sohbet etmesi, oyun oynarken ekran paylaşması ve yazışması için
yapılmış bir uygulamadır. Discord'a benzer, ama:

- **Kendi sunucunda çalışır.** Mesajlar, dosyalar ve hesaplar senin makinende durur.
- **Kapalıdır.** Yeni hesap yalnızca davetle açılır; dışarıdan kimse kayıt olamaz.
- **Küçük gruplar için ayarlanmıştır.** Ses kalitesi, gecikme ve yayın görüntüsü 10–20 kişilik bir grup için
  en iyi hâle getirilmiştir.

> Diskort'u kullanmak için bir hesap davetine ihtiyacın var. Davetin varsa
> **[diskort.ziroo.net](https://diskort.ziroo.net)** adresinden uygulamayı indirip "Davet koduyla kaydol" de.

## Özellikler

### 🎙️ Ses

- Net ses: Opus 64 kbps (32–128 ayarlanabilir), paket kaybına dayanıklı (DTX + RED)
- **Yapay zekâ gürültü engelleme** (DPDFNet, cihazın kendisinde çalışır), yankı engelleme, otomatik kazanç
- Ses aktivitesi (otomatik ya da elle eşik) veya **bas-konuş** (global kısayol, fare yan tuşları)
- Kişi başı ses seviyesi (%0–200), yerel susturma, konuşan göstergesi, ping göstergesi
- Zayıf ağlarda yedek bağlantı: yalnızca 443 portuna izin veren ağlarda (okul, yurt, iş yeri) bile çalışır

### 🖥️ Ekran paylaşımı

- Pencere ya da ekran seçici; **720p60 / 1080p30 / 1080p60**
- Windows'ta yayına **sistem sesi** (sohbet sesleri otomatik hariç tutulur, yankı olmaz)
- **"Yayını İzle":** görüntü yalnızca izlemek isteyene gönderilir; tam ekran ve ayrı yayın sesi ayarı
- Kanala girmeden kimin hangi kanalda olduğu ve kimin yayında olduğu görünür

### 💬 Sohbet

- Metin kanalları: kalıcı geçmiş, düzenleme, silme, yanıtlar, sabitlenmiş mesajlar
- Biçimlendirme (**kalın**, *italik*, `kod`, alıntı, `||sürpriz||`), bağlantı önizlemeleri, GIF araması
- Emoji tepkileri, dosya ve resim paylaşımı (sürükle-bırak, yapıştır), mesaj içinde oynayan videolar
- **@bahsetmeler**, okunmamış rozetleri, mesaj arama (`from:`, `in:`, `has:`, tarih)
- **Direkt mesajlar:** bire bir ve 10 kişiye kadar grup; sunucu yöneticileri bile okuyamaz

### 👥 Topluluk

- Birden çok sunucu: herkes kendi sunucusunu kurabilir, davetle başkalarınınkine katılabilir
- **Roller ve yetkiler** (Discord gibi): renkli roller, özel kanallar, sustur, taşı, at, yasakla
- Profil fotoğrafı, afiş, profil teması ve hareketli profil süsleri
- Durum (çevrimiçi, boşta, rahatsız etmeyin, görünmez) ve oynanan oyunu gösterme (Windows)
- Uygulama içi **geri bildirim** (ekran görüntüsüyle hata/öneri gönderme)

## Platformlar

| | Windows | Linux | macOS | Android |
|---|:---:|:---:|:---:|:---:|
| Ses, sohbet, direkt mesajlar | ✅ | ✅ | ✅ | ✅ |
| Roller, yönetim, sunucu ayarları | ✅ | ✅ | ✅ | ✅ |
| Ekran paylaşımı | ✅ | ✅ | ✅ | ✅ tüm ekran (720p) |
| Yayına sistem sesi | ✅ | ❌ | ❌ | — |
| Bas-konuş / global kısayollar | ✅ | ✅ X11 · ⚠️ Wayland | ✅ | — |
| Oynanan oyunu algılama | ✅ | ❌ | ❌ | ❌ |
| Otomatik güncelleme | ✅ | ✅ | ❌ (indirme sayfasından) | ✅ |
| Paket | Kurulum (x64) | AppImage, .deb | .dmg (Apple Silicon, Intel) | APK (Android 8+) |

**iOS:** App Store'da değildir; kayıtlı iPhone'lara Ad Hoc imzayla kurulur ([ayrıntılar](docs/ios.md)).

> **İlk kurulumda uyarı:** Uygulama henüz kod imzalı değildir. Windows'ta SmartScreen uyarısı çıkarsa
> "Ek bilgi → Yine de çalıştır", macOS'ta ilk açılışta "Yine de Aç" de. Bu yalnızca ilk kurulumda olur
> ([kod imzalama durumu](docs/kod-imzalama.md)).

## Nasıl çalışır?

```
                       ┌───────────────────────── Sunucu (VPS) ─────────────────────────┐
 Masaüstü / Telefon    │                                                                │
 ──── HTTPS / WSS ────►│  Caddy :443 ──► API (Fastify + SQLite)  ◄── webhook ──┐        │
      (mesajlar,       │     │            hesaplar, mesajlar, yetkiler,        │        │
       hesaplar)       │     │            gateway (canlı olaylar)              │        │
                       │     └─► TURN/TLS (zor ağlar için) ─┐                   │        │
 ──── WebRTC / UDP ───►│                                    ▼                   │        │
      (ses, yayın)     │                         LiveKit SFU (ses + görüntü) ───┘        │
                       └────────────────────────────────────────────────────────────────┘
```

- **API** hesapları, sunucuları, mesajları ve yetkileri yönetir. Uygulamalar ona HTTPS ile istek atar ve bir
  WebSocket bağlantısıyla (gateway) canlı olayları alır: yeni mesaj, kim seste, kim yazıyor gibi.
- **LiveKit** ses ve görüntüyü taşıyan medya sunucusudur (SFU). Herkes sesini bir kez sunucuya gönderir, sunucu
  onu diğerlerine dağıtır. API, kanalda kimin olduğunu LiveKit'in bildirimlerinden öğrenir.
- **Caddy** HTTPS sertifikalarını otomatik alır ve 443 portunu API, indirme sayfası ve TURN/TLS arasında paylaştırır.
- **Yetki denetimi** sunucudadır; uygulamalar yalnızca yapılamayacak düğmeleri gizler.

### Kullanılan teknolojiler

| Katman | Teknoloji |
|---|---|
| Masaüstü | Electron, React, TypeScript, Vite, Tailwind |
| Mobil | React Native (Expo), Kotlin yerel modüller |
| Sunucu | Node.js, Fastify, SQLite, WebSocket |
| Ses ve görüntü | LiveKit (WebRTC SFU), Opus, H.264 / VP9 / AV1 |
| Gürültü engelleme | DPDFNet (ONNX Runtime; masaüstünde web, Android'de yerel) |
| Altyapı | Docker Compose, Caddy, GitHub Actions |

### Proje yapısı

```
diskort/
├── apps/
│   ├── desktop/        Electron uygulaması (main, preload, renderer)
│   ├── mobile/         Android / iOS uygulaması (Expo + React Native)
│   ├── server/         API, gateway, LiveKit entegrasyonu, güncelleme yönlendirmeleri
│   └── web/            İndirme sayfası, yönetim paneli (/admin), iPhone kaydı (/udid)
├── packages/
│   ├── shared/         Sunucu ve istemcilerin ortak tipleri ve yetki hesabı
│   └── client-core/    Masaüstü ve mobilin ortak mantığı (API, gateway, depolar)
├── infra/              Docker Compose, LiveKit ve Caddy ayarları, yedek betikleri
├── scripts/            Geliştirme ve sürüm betikleri
├── tools/              LiveKit (yerel), UDP hat testi
└── docs/               Ayrıntılı belgeler
```

Yeni özellikler önce `packages/client-core`'a yazılır; masaüstü ve mobil arayüzler ikisi de oradan kullanır.
Platforma özgü işler (bildirim, ses, depolama) `configureClient()` ile verilir.

## Geliştirme

### Gereksinimler

- **Node.js 22.12+** (CI ve sunucu imajı Node 24 kullanır)
- **pnpm** — `npm i -g pnpm`
- **LiveKit sunucusu** — [sürümler](https://github.com/livekit/livekit/releases) sayfasından işletim sistemine
  uygun dosyayı indir; Windows'ta `windows_amd64` zip'ini `tools/livekit/` altına aç (`livekit-server.exe`)

### Çalıştırma

```bash
pnpm install
```

Üç ayrı terminalde:

```bash
pnpm dev:livekit
```

```bash
pnpm dev:server
```

```bash
pnpm dev:desktop
```

İlk açılışta API konsolu **ilk yönetici davet kodunu** yazar. Uygulamada "Davet koduyla kaydol" ile bu kodu kullan;
ilk hesap yönetici olur. Diğer hesaplar için: Kullanıcı Ayarları → Yönetim → Hesaplar ve davetler.

İpuçları:

- Geliştirme sürümü ayrı bir profil (`%APPDATA%\Diskort-dev`) kullanır, kurulu uygulamaya karışmaz.
- Aynı bilgisayarda ikinci bir istemci açmak için: `pnpm dev:desktop2`
- `DISKORT_FAKE_MEDIA=1` sahte mikrofon/kamera kullanır (`DISKORT_FAKE_AUDIO_FILE=<wav>` ile bir ses dosyası çalar);
  `DISKORT_DEBUG_PORT=9222` otomatik test için Chrome DevTools Protokolü'nü açar. İkisi de paketlenmiş sürümde kapalıdır.

### Test ve tip kontrolü

GitHub Actions her push'ta ikisini de çalıştırır.

```bash
pnpm test
```

```bash
pnpm typecheck
```

### Kodda nereye bakmalı?

| Konu | Yer |
|---|---|
| Ses motoru (bağlanma, yayın, yeniden bağlanma) | [`apps/desktop/src/renderer/src/features/voice/voiceClient.ts`](apps/desktop/src/renderer/src/features/voice/voiceClient.ts) |
| Mikrofon zinciri ve gürültü engelleme | `apps/desktop/src/renderer/src/features/voice/` (`micProcessor.ts`, `denoise/`, `dpdfnet/`) |
| Ses durumu (kim hangi kanalda) | [`apps/server/src/voiceState.ts`](apps/server/src/voiceState.ts), [`routes/voice.ts`](apps/server/src/routes/voice.ts) |
| Gateway (canlı olaylar) | [`apps/server/src/gateway.ts`](apps/server/src/gateway.ts) |
| Yetki hesabı | [`packages/shared/src/permissions.ts`](packages/shared/src/permissions.ts) |
| Android yerel modülleri | `apps/mobile/modules/` (ön plan ses servisi, gürültü filtresi, çökme raporları) |

> `apps/mobile/android/` klasörü `expo prebuild` ile üretilir; elle düzenlenmez. Ayarlar `app.config.ts` ve
> eklentilerdedir.

## Belgeler

| Belge | İçerik |
|---|---|
| [Sunucu kurulumu](docs/sunucu-kurulumu.md) | VPS kurulumu, portlar, ayarlar, güncelleme, bakım ve yedekleme |
| [Sürümler ve güncellemeler](docs/surumler-ve-guncellemeler.md) | Otomatik güncelleme, Android OTA, yeni sürüm yayınlama |
| [Roller ve yetkiler](docs/roller-ve-yetkiler.md) | Yetki modeli, kanal izinleri, atma/yasaklama, hesap yöneticileri |
| [Direkt mesajlar](docs/direkt-mesajlar.md) | DM gizliliği ve veri modeli |
| [Yönetim](docs/yonetim.md) | Yönetim paneli, komut satırı araçları, sunucuda tutulan kayıtlar |
| [Geri bildirim](docs/geri-bildirim.md) | Geri bildirim akışı ve komut satırından yönetim |
| [Kozmetik paketleri](docs/kozmetik-paketleri.md) | Hareketli profil süslerinin hazırlanması ve yayınlanması |
| [iOS](docs/ios.md) | iPhone kurulumu, cihaz kaydı, imzalama |
| [Kod imzalama](docs/kod-imzalama.md) | Windows ve macOS kod imzalama durumu |
| [UDP hat testi](tools/udp-probe/README.md) | Sunucu ile kullanıcı arasındaki hattı ölçme |

## Gizlilik

- Mesajlar, dosyalar ve hesaplar yalnızca senin sunucunda tutulur; üçüncü taraf analiz ya da reklam yoktur.
- Yüklenen resimlerdeki konum (GPS) ve diğer üst veriler sunucuda silinir.
- Direkt mesajları yalnızca konuşmadakiler okuyabilir; sunucu sahipleri ve yöneticiler göremez.
- Bağlantı kalitesi ölçümleri IP adresi içermez ve 14 gün sonra silinir.

## Yol haritası

- [ ] Kod imzalama (Windows: SignPath Foundation, macOS: Apple Developer ID)
- [ ] Direkt mesajlarda sesli ve görüntülü arama
- [ ] Kamera
- [ ] Linux ve macOS'ta yayına sistem sesi
- [ ] Sunucuya özel emojiler

## Lisans

[MIT](LICENSE)
