# Windows kod imzalama (SignPath Foundation)

> macOS imzası (Apple Developer ID + notarizasyon) için bkz. [7. bölüm](#7-macos-developer-id-ve-notarizasyon).

Amaç: Windows'ta kurulum dosyası açılınca çıkan **“Windows kişisel bilgisayarınızı korudu” (SmartScreen)**
uyarısını ve “Bilinmeyen yayıncı” yazısını kaldırmak. Açık kaynak projelere ücretsiz sertifika veren
**SignPath Foundation** kullanılır; imzalama GitHub Actions'taki sürüm derlemesine bağlıdır.

Durum (30 Eylül 2026): CI tarafı hazır ama **etkin değil** ve SignPath Foundation'a **başvurulmadı** (şimdilik
başvurmama kararı: her sürümde iki elle onay gerektiriyor). Aşağıdaki gizli değerler/değişkenler eklenene kadar
Windows paketi eskisi gibi imzasız yayınlanır; hiçbir şey bozulmaz. Politika sayfası
(`apps/web/code-signing.html`) da sürümlerin şu an imzasız olduğunu söyler; imzalama açılınca o not kaldırılmalı.

---

## 1. Seçenekler (kısa karşılaştırma)

| Seçenek | Maliyet | Kimlik doğrulama | Anahtar | Diskort için |
|---|---|---|---|---|
| **SignPath Foundation** | Ücretsiz (OSS) | Yok; projenin açık kaynaktan derlendiği doğrulanır | SignPath'in HSM'inde, CI'dan imzalanır | **Seçilen.** Yayıncı adı “SignPath Foundation” olur |
| Certum Open Source Code Signing | ~50 USD/yıl (+ KDV) | Kişisel kimlik doğrulaması (pasaport/kimlik, video/noter) | Bulutta (SimplySign) — imzalamak için telefon uygulamasıyla oturum/OTP gerekir | CI'dan otomatik imzalamak zahmetli (SimplySign Desktop sanal kart); yayıncı adı “Open Source Developer, <Ad Soyad>” |
| Azure Artifact Signing (eski adıyla Trusted Signing) | ~10 USD/ay | Kurumsal ya da bireysel kimlik doğrulaması | Azure'da | **Türkiye'den kullanılamıyor:** bireysel geliştiriciler yalnızca ABD/Kanada; kuruluşlar ABD, Kanada, AB, İngiltere ve birkaç ülke |
| Ticari OV/EV sertifika | 200–500+ USD/yıl | Şirket/kişi doğrulaması | Donanım anahtarı (USB) ya da bulut HSM | Pahalı; 2024'ten beri EV bile anında SmartScreen itibarı vermiyor |

Önemli: Microsoft **Mart 2024'ten beri EV sertifikalara da anında SmartScreen itibarı vermiyor**; itibar
sertifika ve dosya bazında indirildikçe birikiyor. Yeni, kendi adına alınmış bir OV sertifika (Certum dahil) ilk
haftalarda yine uyarı gösterebilir. SignPath Foundation sertifikası çok sayıda açık kaynak projeyi imzaladığı için
itibar toplamış bir sertifikadır; bu yüzden uyarının hızlı kalkması beklenir (garanti değil: SmartScreen ayrıca
dosyanın kendisinin yeni olup olmadığına da bakar, ilk günlerde az sayıda kullanıcı yine uyarı görebilir).

## 2. SignPath Foundation koşulları ve Diskort'un durumu

| Koşul | Durum |
|---|---|
| OSI onaylı lisans, ticari çift lisans yok | MIT ✔ |
| Herkese açık depo, kaynak kodun tamamı açık, kapalı kaynak bileşen yok | ✔ (gürültü engelleme modelleri Apache-2.0/MIT) |
| Kötü amaçlı yazılım / istenmeyen yazılım yok, “hacking” aracı değil | ✔ |
| Proje yayınlanmış ve bakımı sürüyor | ✔ (GitHub Releases, düzenli sürümler) |
| İndirme sayfasında ne yaptığı anlatılıyor | ✔ diskort.ziroo.net |
| Yalnızca kendi kaynak kodundan derlenen dosyalar imzalanır | ✔ yalnızca `Diskort.exe` ve kurulum dosyası; Electron DLL'leri, `elevate.exe`, yerel modüller imzalanmaz |
| İmzalanan dosyalarda ürün adı/sürüm kısıtı | ✔ `.signpath/artifact-configurations/*.xml` (`product-name`, `product-version`) |
| Web sitesinde “code signing policy” bölümü (SignPath atfı, roller, gizlilik) | ✔ `apps/web/code-signing.html` → https://diskort.ziroo.net/code-signing (sunucuya dağıtılınca) |
| Roller: yazar, gözden geçiren, onaylayıcı | Hepsi depo sahibi (@zziroo) |
| Tüm ekip üyelerinde GitHub ve SignPath için MFA | **Senin yapman gerek** (aşağıda) |
| Her sürüm elle onaylanır | ✔ iş akışı SignPath onayını bekler |
| Kaldırma talimatı, gizlilik politikası | ✔ politika sayfasında + /privacy |

## 3. Nasıl çalışıyor (`.github/workflows/release.yml`, `windows` işi)

`v*` etiketi gönderilince, SignPath ayarlıysa:

1. `electron-builder --win --publish never` → uygulama klasörü (`win-unpacked`) oluşur (bu aşamanın imzasız
   kurulum dosyası atılır; tam derleme yapılır çünkü güncelleyici ayarı `app-update.yml` yalnızca nsis hedefiyle yazılır).
2. `Diskort.exe` GitHub artifact olarak yüklenir ve SignPath'e gönderilir (**1. onay**). İmzalı exe yerine konur,
   imzası PowerShell ile doğrulanır.
3. `electron-builder --win --prepackaged …` kurulum dosyasını imzalı uygulama klasöründen derler.
4. Kurulum dosyası SignPath'e gönderilir (**2. onay**), imzalı olan yerine konur ve doğrulanır.
5. `scripts/win-update-info.mjs`, imzalı dosyadan `.blockmap`'i (electron-builder'ın kendi koduyla) ve
   `latest.yml`'deki `sha512`/`size` değerlerini yeniden üretir.
6. Kurulum dosyası, `.blockmap` ve `latest.yml` `gh release upload` ile taslak sürüme yüklenir.

Neden bu sıra: electron-builder `latest.yml`'e dosyanın sha512 özetini yazar. Dosya sonradan imzalanırsa baytları
değişir ve kurulu uygulamalar güncellemeyi “sha512 checksum mismatch” diyerek reddeder. 5. adım bunu düzeltir.

SignPath ayarlı değilse: eski tek adım (`electron-builder --win --publish always`), imzasız.

İş akışı her istek için SignPath onayını **en fazla 1 saat** bekler; süre dolarsa iş başarısız olur, “Re-run
failed jobs” ile tekrarlanır (yeni istek oluşur).

## 4. Otomatik güncelleme: riskler ve seçilen ayar

electron-updater, `app-update.yml` içinde `publisherName` varsa indirilen kurulum dosyasının imzasını PowerShell
ile denetler ve yayıncı adı uymazsa güncellemeyi **reddeder**. `publisherName` yoksa bu denetim atlanır.

- Bugüne kadarki tüm sürümler imzasız derlendi, `publisherName` yok → **imzalı ilk sürümü sorunsuz alırlar.**
- `apps/desktop/electron-builder.yml`'e `win.verifyUpdateCodeSignature: false` eklendi: imzalı sürümlerde de
  `publisherName` yazılmaz. Sebep:
  - İş akışında imzasız yedek yol var (SignPath kapalı/erişilemez olursa). Yayıncı adı sabitlenmiş kurulumlar
    imzasız bir sürümü asla kuramaz ve **kalıcı olarak güncellemesiz kalır** (elle yeniden kurmak gerekir).
  - Sertifika değişirse (ör. ileride Certum'a geçiş ya da SignPath sertifikasının adının yenilemede değişmesi) aynı durum.
  - SignPath Foundation sertifikası birçok projede ortak; “SignPath Foundation” adını sabitlemek sadece Diskort'un
    dosyalarını değil, Foundation'ın imzaladığı her dosyayı kabul eder — kazanç sınırlı.
  - PowerShell tabanlı denetim bazı makinelerde (kısıtlı dil modu, antivirüs) hata verip güncellemeyi durdurabiliyor.
- Güncellemenin bütünlüğü yine korunuyor: `latest.yml`'deki sha512 (HTTPS üzerinden) indirilen dosyayla eşleşmeli.
- İleride sertleştirme (isteğe bağlı): birkaç imzalı sürüm sorunsuz çıktıktan ve imzasız yedek yol kaldırıldıktan
  sonra `win.publisherName: ["SignPath Foundation"]` eklenebilir. Bu geri alınamaz bir adımdır; o sürümden sonra
  her Windows sürümü mutlaka aynı adla imzalı olmalıdır.
- Fark (differential) güncelleme: blockmap imzalı dosyadan üretildiği için çalışır. İmzasız → imzalı geçişte
  eski ve yeni dosya daha çok blokta farklı olacağından ilk güncelleme biraz daha büyük inebilir.
- `scripts/release-win.mjs` (yerelden yayın) imzasız paket üretir; imzalama açıldıktan sonra kullanma.

## 5. Yapman gerekenler (adım adım)

### 5.1 Hazırlık

1. **GitHub'da MFA:** GitHub → Settings → Password and authentication → Two-factor authentication açık olmalı.
2. İş akışı ve politika sayfası `main`'de ve sayfa yayında (https://diskort.ziroo.net/code-signing; ana sayfanın
   altında “Kod imzalama” bağlantısı). Başvurmadan önce sayfadaki “şu an imzasız / başvurulmadı” notunu başvuruya
   uygun hâle getir.
4. (Önerilir) README'nin başına kısa İngilizce bir açıklama ve indirme bağlantısı eklemek başvuruyu hızlandırır;
   inceleyenler Türkçe bilmeyebilir.

### 5.2 Başvuru

https://signpath.org/apply adresindeki formu doldur. Taslak yanıtlar (İngilizce):

> **Project name:** Diskort
>
> **Repository:** https://github.com/zziroo/diskort
>
> **License:** MIT (OSI approved, no dual licensing)
>
> **Homepage / download page:** https://diskort.ziroo.net (releases: https://github.com/zziroo/diskort/releases)
>
> **Code signing policy:** https://diskort.ziroo.net/code-signing
>
> **Description:** Diskort is an open-source, self-hosted voice chat, screen sharing and text chat application
> (similar to Discord) for small invite-only communities. The desktop client is built with Electron and React;
> the server (Fastify + SQLite, LiveKit for media) is in the same repository. First released in September 2026;
> new versions are published frequently via GitHub Releases and delivered by the built-in auto-updater.
>
> **What should be signed:** The Windows application executable (`Diskort.exe`) and the NSIS installer
> (`Diskort-Setup-<version>.exe`) produced by electron-builder. Both are built by GitHub Actions on GitHub-hosted
> runners (`.github/workflows/release.yml`) from tagged commits; the workflow already contains the
> `signpath/github-action-submit-signing-request` integration and artifact configurations
> (`.signpath/artifact-configurations/`). Third-party binaries (Electron/Chromium DLLs, native modules) will not be signed.
>
> **Team:** Single maintainer: @zziroo (author, reviewer and approver). MFA is enabled on GitHub and will be
> enabled on SignPath.
>
> **Contact:** diskort@ziroo.net

Beklenen süre: SignPath Foundation incelemeyi elle yapıyor; kesin süre yayımlanmıyor — genelde birkaç gün ile
birkaç hafta arası. Ek soru gelirse e-postayla yanıtlanır.

Dikkat: proje çok yeni (ilk sürüm Eylül 2026) ve kullanıcı kitlesi küçük, davetli bir topluluk. Foundation
“yayınlanmış ve bakımı süren” proje istiyor; yeni projelerde bir süre sürüm geçmişi birikmesini isteyebilir ya da
başvuruyu erteleyebilir. Reddedilirse bölüm 1'deki Certum seçeneği yedek plandır (o durumda iş akışının imza
adımları Certum/SimplySign'a göre değiştirilmelidir).

### 5.3 Onaydan sonra SignPath'te

1. Gelen davetle SignPath hesabını aç, **MFA'yı aç** (zorunlu).
2. Organizasyon kimliğini (Organization ID) not et (Settings / URL'de görünür).
3. **Trusted build system:** GitHub.com bağlayıcısının projeye bağlı olduğundan emin ol (Foundation genelde
   hazırlar). Depo herkese açık olduğu için ayrıca GitHub App gerekmez.
4. **Proje:** slug'ı not et (ör. `diskort`); depo adresi `https://github.com/zziroo/diskort`.
5. **Artifact configurations:** iki yapılandırma oluştur ve içeriklerini depodan yapıştır:
   - slug `app` ← `.signpath/artifact-configurations/app.xml`
   - slug `installer` ← `.signpath/artifact-configurations/installer.xml`
6. **Signing policy:** Foundation sertifikalı politika (genelde `release-signing`). Onaylayıcı (approver) olarak
   kendini ekle. İstersen politikada yalnızca `v*` etiketlerinden/`main`'den gelen derlemelere izin ver.
7. **CI kullanıcısı ve API belirteci:** Users → yeni CI kullanıcısı (ör. `github-actions`), projede
   **Submitter** rolü ver, API token oluştur. Belirteç yalnızca bir kez gösterilir.

### 5.4 GitHub ayarları

Depo → Settings → Secrets and variables → Actions:

| Tür | Ad | Değer |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | CI kullanıcısının API belirteci |
| Secret | `SIGNPATH_ORGANIZATION_ID` | Organizasyon kimliği |
| Variable | `SIGNPATH_PROJECT_SLUG` | ör. `diskort` |
| Variable (isteğe bağlı) | `SIGNPATH_SIGNING_POLICY_SLUG` | varsayılan `release-signing` |
| Variable (isteğe bağlı) | `SIGNPATH_APP_CONFIGURATION_SLUG` | varsayılan `app` |
| Variable (isteğe bağlı) | `SIGNPATH_INSTALLER_CONFIGURATION_SLUG` | varsayılan `installer` |

Üç zorunlu değerin üçü de varsa imzalı yol çalışır; biri eksikse imzasız yol.

### 5.5 İlk imzalı sürüm

1. Her zamanki gibi sürüm numarasını artır, etiketle, gönder.
2. Actions'ta Windows işi “Diskort.exe'yi imzala” adımında bekler. SignPath'te (e-posta bildirimi ya da iş
   günlüğündeki bağlantı) isteği **onayla**. Birkaç dakika sonra “Kurulum dosyasını imzala” için **ikinci onayı** ver.
3. Taslakta `Diskort-Setup-<v>.exe`, `.blockmap` ve `latest.yml` olmalı. Kurulum dosyasını indirip sağ tık →
   Özellikler → Dijital İmzalar'da “SignPath Foundation” gör.
4. Taslağı yayınla. Kurulu bir eski sürümün güncellemeyi indirip kurduğunu bir makinede doğrula.

Sorun olursa geri dönüş: `SIGNPATH_PROJECT_SLUG` değişkenini sil → sonraki sürüm yine imzasız çıkar
(güncellemeler çalışmaya devam eder, bkz. bölüm 4).

## 6. Kullanıcılar için ne değişir

- İndirilen kurulum dosyasında yayıncı “Bilinmeyen yayıncı” yerine **SignPath Foundation** görünür; SmartScreen
  uyarısı büyük olasılıkla hiç çıkmaz ya da kısa sürede kaybolur. Antivirüs yanlış alarmları azalır.
- Kurulu uygulamalar yeni sürümü her zamanki gibi kendiliğinden alır; kullanıcının bir şey yapmasına gerek yok.
- Uygulama adı, kurulum klasörü, ayarlar, oturum değişmez.
- macOS, Linux ve Android bu değişiklikten etkilenmez.

---

## 7. macOS: Developer ID ve notarizasyon

`.github/workflows/release.yml` → `macos` işi. Uygulama **Developer ID Application** sertifikasıyla, sertleştirilmiş
çalışma ortamı (hardened runtime) ve `apps/desktop/build/entitlements.mac.plist` izinleriyle imzalanır, App Store
Connect API anahtarıyla Apple'a notarize ettirilir. Hedefler: `.dmg` (indirme sayfası) ve `.zip` (otomatik
güncelleme; Squirrel.Mac zip'i kurar, `latest-mac.yml` iki mimarinin zip'ini listeler).

| GitHub gizli değeri | İçerik |
|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application sertifikası + özel anahtarı (`.p12`), base64 (macOS'ta: `base64 -i DeveloperID.p12`) |
| `MAC_CERT_PASSWORD` | `.p12` dışa aktarılırken verilen parola |
| `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | iOS ile ortak App Store Connect API anahtarı (docs/ios.md); notarizasyon için |
| `APPLE_TEAM_ID` | (isteğe bağlı) imzanın doğru takımdan olduğunu denetlemek için |

- `MAC_CERT_P12_BASE64` yoksa iş eskisi gibi **ad-hoc** imzayla, notarizasyonsuz yayınlar (sürüm bozulmaz). ASC
  anahtarı eksikse imzalı ama notarizasyonsuz yayınlar (uyarı yazar).
- Uygulama otomatik güncellemeyi ancak kendisi Developer ID ile imzalıysa açar (`apps/desktop/src/main/updater.ts`,
  çalışma anında `codesign` ile bakılır); ad-hoc imzalı kurulumlarda eskisi gibi “yeni sürüm var, indir” uyarısı çıkar.
- **Geçiş:** ad-hoc imzalı sürümleri (ilk imzalı sürümden öncekiler) kullananlar imzalı sürüme otomatik geçemez
  (Squirrel.Mac yeni imzayı eski sürümün imza gereksinimine göre reddeder); bir kez indirme sayfasından kurarlar.
  Sonraki sürümler kendiliğinden gelir.
- İmzalı sürümler çıkmaya başladıktan sonra sertifikayı **kaldırma**: ad-hoc yedek yolla çıkan bir sürüm imzalı
  kurulumlara otomatik kurulamaz. Sertifika yenilenirse aynı takımdan (Team ID) olmalı.
- Sertifikanın süresi dolsa da daha önce imzalanıp notarize edilmiş sürümler açılmaya devam eder; yenisi yalnızca yeni
  sürümleri imzalamak için gerekir.
