# iOS sürümü

Diskort'un iPhone uygulaması App Store ya da TestFlight olmadan, **Ad Hoc** imzayla kendi sitemizden
(`https://diskort.ziroo.net`) kurulur. Mac gerekmez: derleme GitHub'ın macOS makinelerinde yapılır.

Ad Hoc'un sınırı: uygulama yalnızca **UDID'si önceden kaydedilmiş cihazlara** kurulur (yılda en fazla
100 iPhone). Yeni bir cihaz eklendiğinde dağıtım profili yenilenir ve uygulama yeniden derlenir.

## Şu an durum

| Parça | Durum |
| --- | --- |
| iOS projesi (`expo prebuild`) ve derleme | Hazır. Actions → **iOS** → Run workflow, iOS Simülatörü için imzasız derler. |
| İmzalı IPA | Yayında: Apple hesabı ve GitHub gizli değişkenleri tanımlı, sürümlerde Ad Hoc IPA bulunur. (Gizli değişkenler yokken iş atlanır.) |
| Sesli sohbet arka planda | `audio` arka plan kipi + LiveKit'in yönettiği ses oturumu (AVAudioSession). Ön plan servisi ve bildirim düğmeleri yok (Android'e özgü). |
| Kablosuz (OTA) güncelleme | Hazır: `/updates/expo/ios`. Sürüm iş akışı IPA ile birlikte iOS paketini de yükler. |
| Uygulama güncellemesi (yeni IPA) | Uygulama, sunucu yeni IPA bildirince "Yükle" penceresini açar (`itms-services`). |
| Bildirimler | Sunucu doğrudan Apple'a (APNs) gönderir; Firebase gerekmez. APNs anahtarı sunucuya konunca çalışır. |
| İndirme sayfası | Sürümde IPA varsa iPhone kartı kendiliğinden görünür. |

## Kullanıcının yapması gerekenler

### 1. Apple Developer hesabı

1. <https://developer.apple.com/programs/enroll/> adresinden **Apple Developer Program**'a katıl (yıllık 99 $).
   Bireysel hesap yeterli. Onay birkaç saat ile iki gün sürebilir.
2. Onaylanınca <https://developer.apple.com/account> → **Membership details** sayfasındaki **Team ID**'yi
   (10 karakter, ör. `AB12CD34EF`) bir kenara yaz.

### 2. App ID (paket kimliği)

1. **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **App IDs** → **App**.
2. Description: `Diskort`, Bundle ID: **Explicit** → `com.diskort.app` (Android paket adıyla aynı).
3. **Capabilities** listesinde **Push Notifications**'ı işaretle. Başka bir şey gerekmez.
4. Continue → Register.

### 3. APNs anahtarı (bildirimler için)

1. **Keys** → **+** → ad: `Diskort APNs`, **Apple Push Notifications service (APNs)** işaretli → Continue → Register.
2. `AuthKey_XXXXXXXXXX.p8` dosyasını indir (**yalnızca bir kez indirilebilir**, sakla). Dosya adındaki
   10 karakter **Key ID**'dir.
3. Sunucuda:
   ```sh
   scp AuthKey_XXXXXXXXXX.p8 diskort-vps:/opt/diskort/infra/secrets/apns.p8
   ssh diskort-vps 'chmod 600 /opt/diskort/infra/secrets/apns.p8'
   ```
   `/opt/diskort/infra/.env` dosyasına ekle:
   ```
   APNS_KEY_FILE=/run/secrets/apns.p8
   APNS_KEY_ID=XXXXXXXXXX
   APNS_TEAM_ID=AB12CD34EF
   ```
   sonra `docker compose up -d api`. Sunucu günlüğünde `iOS bildirimleri açık (APNs)` görünmeli.

Not: Firebase'in iOS tarafı (GoogleService-Info.plist) **kullanılmıyor**. iPhone'un cihaz jetonu
doğrudan APNs jetonudur; sunucu Android'e FCM, iPhone'a APNs ile gönderir.

### 4. Dağıtım sertifikası (Apple Distribution)

Mac olmadan, OpenSSL ile (Windows'ta Git Bash içinde çalışır):

```sh
openssl genrsa -out diskort-ios.key 2048
openssl req -new -key diskort-ios.key -out diskort-ios.csr -subj "/emailAddress=SENIN@EPOSTAN/CN=Diskort/C=TR"
```

1. **Certificates** → **+** → **Apple Distribution** → Continue → `diskort-ios.csr`'ı yükle → indir
   (`distribution.cer`).
2. `.p12`'ye çevir (parolayı bir kenara yaz, `IOS_CERT_PASSWORD` olacak):
   ```sh
   openssl x509 -inform DER -in distribution.cer -out distribution.pem
   openssl pkcs12 -export -legacy -inkey diskort-ios.key -in distribution.pem -out diskort-ios.p12
   ```
   (`-legacy`: macOS'un anahtar zinciri yeni OpenSSL 3 şifrelemesini okuyamıyor. OpenSSL 1.x'te bu
   seçenek yoksa kaldır.)
3. `diskort-ios.key` ve `.p12` gizlidir; depoya koyma, güvenli bir yerde sakla. Sertifika 1 yıl geçerli.

### 5. Cihazları kaydet (UDID)

Her iPhone'un UDID'si gerekir. En kolay yol: iPhone'da Safari ile <https://diskort.ziroo.net/udid> →
profili yükle; cihaz yönetim panelinin **iPhone cihazları** sekmesinde görünür. (Alternatif: Windows'ta
**Apple Devices** uygulaması → cihaz → seri numarasına tıklayınca UDID görünür.)

Otomatik cihaz ekleme kuruluysa (aşağıda) panelde **Onayla** demek yeter. Değilse elle: **Devices** → **+** →
Platform iOS, ad (ör. `Yusuf iPhone`), UDID → Register.

### 6. Ad Hoc dağıtım profili

Otomatik cihaz ekleme kuruluysa bu adım gerekmez (profili iş akışı kendisi hazırlar). Elle:

1. **Profiles** → **+** → **Distribution** altında **Ad Hoc** → App ID: `com.diskort.app` →
   sertifika: 4. adımdaki → cihazlar: hepsini seç → ad: `Diskort Ad Hoc` → Generate → indir
   (`Diskort_Ad_Hoc.mobileprovision`).
2. Yeni cihaz eklendiğinde: profili **Edit** ile açıp cihazı işaretle, yeniden indir, 7. adımdaki
   `IOS_PROVISIONING_PROFILE_BASE64`'ü güncelle ve IPA'yı yeniden derlet (aşağıdaki `attach-latest`
   komutu ya da yeni sürüm). Profil 1 yıl geçerli.

### 7. GitHub gizli değişkenleri

Depo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Ad | Değer |
| --- | --- |
| `APPLE_TEAM_ID` | Team ID (1. adım) |
| `IOS_CERT_P12_BASE64` | `base64 -w0 diskort-ios.p12` çıktısı |
| `IOS_CERT_PASSWORD` | `.p12` parolası |
| `IOS_PROVISIONING_PROFILE_BASE64` | `base64 -w0 Diskort_Ad_Hoc.mobileprovision` çıktısı (ASC anahtarı varsa gerekmez) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | İsteğe bağlı: otomatik cihaz ekleme (aşağıda) |
| `IOS_DEVICES_KEY` | İsteğe bağlı: şifreli cihaz listesinin anahtarı (aşağıda; sunucuda da aynısı) |

`OTA_SIGNING_KEY` zaten var (Android ile aynı anahtar, iOS OTA paketini de imzalar).

### 8. İlk IPA

- Deneme: Actions → **iOS** → Run workflow (**İmzalı Ad Hoc IPA** işaretli). Bitince IPA ve
  `manifest.plist` "artifact" olarak iner. Bunu kurmak için yayınlanmış sürüm gerekir (aşağıda) ya da
  IPA'yı iPhone'a Apple Devices uygulamasıyla sürükle-bırak yapabilirsin.
- Yayın: her zamanki gibi `vX.Y.Z` etiketi gönder. Sürüm iş akışı artık iOS'u da derler, taslağa
  `Diskort-X.Y.Z-ios.ipa` ve `Diskort-X.Y.Z-ota-ios.json` (+ paket dosyaları) yükler. Taslak
  yayınlanınca indirme sayfasında iPhone kartı çıkar.

### 9. iPhone'a kurulum

iPhone'da **Safari** ile `https://diskort.ziroo.net` → **Yükle** (ya da doğrudan
`https://diskort.ziroo.net/download/ios`). iOS "Diskort yüklensin mi?" diye sorar. Uygulama ana ekrana iner.

- iOS 16+ ilk açılışta **Geliştirici Modu** isteyebilir: Ayarlar → Gizlilik ve Güvenlik → Geliştirici Modu
  → aç, telefon yeniden başlar. (Ad Hoc uygulamalarda genellikle gerekmez; istenirse böyle açılır.)
- "Bu uygulama yüklenemedi": cihazın UDID'si profilde yok ya da profil/sertifika süresi dolmuş.

## Otomatik cihaz ekleme

Amaç: yeni bir arkadaşın iPhone'u için tek iş yönetim panelinde **Onayla**'ya basmak.

### Akış

1. Arkadaş iPhone'da Safari ile `https://diskort.ziroo.net/udid?ad=Adı` → profili yükler. Sunucu cihazı
   `/data/udids.jsonl`'e yazar; panelde **iPhone cihazları** sekmesinde **Bekliyor** olarak görünür
   (sekmedeki kırmızı sayı bekleyenler).
2. Sen **Onayla** dersin (ya da **Reddet**). Durumlar `/data/udid-status.json`'da tutulur; `udids.jsonl`
   değişmez, eski kayıtlar "Bekliyor" sayılır.
3. Sunucu onayları 3 dakika toplar (`IOS_DISPATCH_DELAY_SEC`; aynı anda birkaç onay tek derleme olur), sonra
   GitHub'da **iOS** iş akışını başlatır: `signed=true`, `attach-latest=true`, `devices=<onaylı cihazlar, şifreli>`.
   Panelde **Hemen derle** beklemeyi atlar. Depo herkese açık olduğundan `devices` girdisi **AES-256-GCM ile
   şifrelidir** (`v1.<iv>.<veri>`, anahtar `IOS_DEVICES_KEY`); UDID ve adlar GitHub'da görünmez.
4. İş akışı (`.github/workflows/ios.yml`):
   - en son **yayınlanmış** sürümün etiketini alır ve o kodu derler (yeni sürüm gerekmez);
   - cihaz listesini `scripts/ios-devices-crypto.mjs` ile çözer: her UDID ve ad önce `::add-mask::` ile
     günlükte gizlenir, açık metin hiçbir yere yazılmaz (betik UDID'nin en çok son 4 karakterini yazar).
     Anahtar yoksa ya da çözme başarısızsa derleme hemen durur;
   - `scripts/ios-provisioning.mjs sync` ile App Store Connect API üzerinden cihazları Apple'a kaydeder,
     p12'deki sertifikayı Apple'daki kaydıyla eşler ve **tüm açık iOS cihazlarını** içeren yeni bir Ad Hoc
     profili oluşturur (`Diskort Ad Hoc otomatik <tarih>`; eski otomatik profiller silinir, elle
     oluşturduğun `Diskort Ad Hoc`'a dokunulmaz; cihaz listesi değişmediyse ve profil 30 günden uzun
     geçerliyse mevcut profil yeniden kullanılır);
   - profili denetler (App ID, `aps-environment`, **istenen her UDID profilde mi**) ve imzalı IPA'yı derler;
   - IPA'yı o sürümdeki `Diskort-<sürüm>-ios.ipa`'nın yerine yükler (`--clobber`). Sürümde iOS OTA paketi
     yoksa onu da üretip yükler; varsa dokunmaz.
5. Sunucu çalıştırmayı adındaki kimlikten bulur (`run-name: iOS · cihaz ekleme <kimlik>`), dakikada bir
   GitHub API'sinden durumuna bakar. Başarıyla biterse o derlemedeki cihazlar **Eklendi** olur. Panel son
   derlemenin durumunu ve GitHub bağlantısını gösterir. Başarısız olursa cihazlar **Onaylandı** kalır;
   **Hemen derle** ile yeniden denenir.
6. Arkadaş iPhone'da `https://diskort.ziroo.net` → **Yükle**. Daha önce kurmuş olanlar etkilenmez (eski
   IPA'ları kendi profilleriyle çalışmaya devam eder); JavaScript güncellemeleri yine OTA ile gelir.

Neden geri bildirim ucu yok: sunucu, başlattığı derlemeyi aynı GitHub belirteciyle zaten izleyebiliyor;
ikinci bir gizli anahtar (iş akışı → sunucu) gerekmiyor. İş akışı ancak istenen cihazların hepsi profildeyse
başarılı biter, yani "Eklendi" gerçekten kurulabilir demektir.

**Parçalardan biri yoksa:**

| Eksik | Ne olur |
| --- | --- |
| `GITHUB_DISPATCH_TOKEN` (sunucu) | Onay yalnızca durumu değiştirir; panel çalıştırılacak `gh workflow run …` komutunu gösterir. Derleme bitince cihazları panelde **Eklendi say** ile işaretle. |
| `IOS_DEVICES_KEY` (sunucu) | Belirteç olsa bile derleme **başlatılmaz** (UDID'ler asla açık gönderilmez); panel kırmızı uyarı ve elle komut gösterir. |
| `IOS_DEVICES_KEY` (GitHub) | Şifreli cihaz listesiyle başlatılan derleme hemen hata verir. |
| `ASC_*` gizli değişkenleri (GitHub) | İş akışı eskisi gibi `IOS_PROVISIONING_PROFILE_BASE64`'ü kullanır. Cihazı Apple'da elle ekleyip profili güncellemediysen derleme "Cihaz profilde yok" diye durur (boşuna IPA yüklenmez). |

Elle çalıştırma: UDID'leri **açık yazma** (herkese açık depoda görünür). Yollar:

- Panelin gösterdiği komut: sunucuda `IOS_DEVICES_KEY` varsa cihaz listesi komutta şifreli hazırdır.
- Cihazsız: `gh workflow run ios.yml --repo zziroo/diskort -f simulator=false -f signed=true -f attach-latest=true`.
  ASC yalnızca verilen cihazları kaydeder; cihaz verilmezse profil Apple'da zaten kayıtlı ve açık olan tüm
  cihazlarla yenilenir. Yani önce cihazı Apple Developer → Devices'ta elle ekle.
- Şifreli değeri kendin üretmek (anahtar dosyası bilgisayardaysa):
  `node scripts/ios-devices-crypto.mjs encrypt --key-file ios-devices.key UDID1,UDID2`

### Bir kerelik kurulum

**1. App Store Connect API anahtarı** (cihaz kaydı ve profil oluşturma için)

1. <https://appstoreconnect.apple.com/access/integrations/api> → **Users and Access** → **Integrations** →
   **App Store Connect API** → **Team Keys** sekmesi (ilk kez açılıyorsa "Request Access" onayı gerekir).
2. **Generate API Key** (ya da **+**) → ad: `Diskort CI` → **Access: Admin**. Apple'ın sertifika/profil
   (Provisioning) uçları yalnızca **Admin** rolündeki **takım** anahtarlarına açık; "Individual Key" ya da
   App Manager/Developer rolü işe yaramaz.
3. **Download** → `AuthKey_XXXXXXXXXX.p8` (**yalnızca bir kez indirilebilir**; güvenli bir yerde sakla, depoya
   koyma). Sayfada **Key ID** (10 karakter) ve üstte **Issuer ID** (UUID) görünür.

**2. GitHub gizli değişkenleri** — `.p8` dosyasının bulunduğu klasörde. Windows PowerShell 5.1 `<`
yönlendirmesini desteklemez ve Türkçe karakterleri bozabilir; bu yüzden `cmd /c` ile:

```powershell
cmd /c 'gh secret set ASC_KEY_P8 --repo zziroo/diskort < AuthKey_XXXXXXXXXX.p8'
gh secret set ASC_KEY_ID --repo zziroo/diskort --body XXXXXXXXXX
gh secret set ASC_ISSUER_ID --repo zziroo/diskort --body 00000000-0000-0000-0000-000000000000
```

(Git Bash'te ilk satır doğrudan `gh secret set ASC_KEY_P8 --repo zziroo/diskort < AuthKey_XXXXXXXXXX.p8`.)
Diğer gizli değişkenler (`IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`, `APPLE_TEAM_ID`) aynen kalır;
`IOS_PROVISIONING_PROFILE_BASE64` artık kullanılmaz ama silmek gerekmez (ASC anahtarı kaldırılırsa yedek).

İsteğe bağlı deneme (hiçbir şey değiştirmez; bilgisayarda, Git Bash):

```sh
export ASC_KEY_ID=XXXXXXXXXX ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000 ASC_KEY_FILE=AuthKey_XXXXXXXXXX.p8
node scripts/ios-provisioning.mjs list
node scripts/ios-provisioning.mjs sync --cert distribution.pem --dry-run
```

`distribution.pem` 4. adımda `distribution.cer`'den üretilen dosya. `--dry-run` yalnızca okur ve ne yapacağını
yazar (kayıt, profil oluşturma, silme yok).

**3. GitHub belirteci (sunucunun iş akışını başlatması için)**

1. <https://github.com/settings/personal-access-tokens/new> → **Fine-grained token** → ad: `diskort-ios-dispatch`,
   süre: 1 yıl, **Repository access: Only select repositories → zziroo/diskort**.
2. **Permissions → Repository permissions → Actions: Read and write** (Metadata: Read kendiliğinden gelir).
   Başka izin verme.
3. **Generate token** → değeri bilgisayarda bir dosyaya kaydet (ör. `gh-dispatch-token.txt`), sonra Git Bash'te:

```sh
scp gh-dispatch-token.txt diskort-vps:/tmp/gh-dispatch-token
ssh diskort-vps 'printf "\nGITHUB_DISPATCH_TOKEN=%s\n" "$(tr -d "\r\n" < /tmp/gh-dispatch-token)" >> /opt/diskort/infra/.env && rm /tmp/gh-dispatch-token && chmod 600 /opt/diskort/infra/.env && cd /opt/diskort/infra && docker compose up -d api'
rm gh-dispatch-token.txt
```

(PowerShell 5.1 iç içe tırnakları bozduğu için ikinci satırı Git Bash'te çalıştır.) `docker-compose.yml` bu
değişkeni api kapsayıcısına geçirir; sunucu bu sürümle güncellenmiş olmalı. Belirteç süresi dolunca
yenisini aynı şekilde yaz (önce `.env`'deki eski satırı sil).

**4. Cihaz listesi şifre anahtarı (`IOS_DEVICES_KEY`)** — aynı anahtar hem GitHub'a hem sunucuya.
PowerShell'de:

```powershell
cd C:\Users\yusuf\diskort-ios
node -e "require('fs').writeFileSync('ios-devices.key', require('crypto').randomBytes(32).toString('base64'))"
cmd /c 'gh secret set IOS_DEVICES_KEY --repo zziroo/diskort < "C:\Users\yusuf\diskort-ios\ios-devices.key"'
```

Sonra sunucuya, Git Bash'te (`/c/Users/yusuf/diskort-ios` klasöründe):

```sh
scp ios-devices.key diskort-vps:/tmp/ios-devices-key
ssh diskort-vps 'printf "\nIOS_DEVICES_KEY=%s\n" "$(tr -d "\r\n" < /tmp/ios-devices-key)" >> /opt/diskort/infra/.env && rm /tmp/ios-devices-key && chmod 600 /opt/diskort/infra/.env && cd /opt/diskort/infra && docker compose up -d api'
```

`ios-devices.key` dosyasını sakla (elle şifreli komut üretmek için gerekir); depoya koyma. Anahtar kaybolursa
yenisini üretip iki yere de yeniden yaz (önce `.env`'deki eski satırı sil).

Kontrol: panel → **iPhone cihazları** → "Otomatik derleme: Açık" görünmeli (anahtar eksikse kırmızı uyarı çıkar).

### Bilinen: IPA'daki cihaz listesi

Yayınlanan IPA herkese açık GitHub sürümündedir ve içine gömülü dağıtım profili **kayıtlı tüm cihazların
UDID'lerini** içerir (Ad Hoc'un doğası; IPA'yı indiren biri profili açıp okuyabilir). Adlar profilde yok.
Risk düşük (UDID tek başına cihaza erişim sağlamaz). İleride IPA yalnızca kendi sunucumuzdan, kurulum
bağlantısıyla sunulursa bu da kapanır.

## Nasıl çalışıyor (teknik)

- **Yapılandırma**: `apps/mobile/app.config.ts` → `ios` bölümü (paket kimliği, Türkçe izin metinleri,
  `UIBackgroundModes: audio, voip`, `ITSAppUsesNonExemptEncryption: false`). `plugins/withIos.js`
  iOS'un OTA adresini (`/updates/expo/ios`) ve arka plan kiplerini yazar; CI
  (`scripts/check-ios-project.sh`) prebuild sonrası bunları denetler.
- **Android'e özgü yerel modüller** iOS'ta yok sayılır: sesli sohbet ön plan servisi
  (`modules/voice-service`, iOS'ta boş işlevler), yerel çökme bildirici (`modules/crash-reporter`, iOS'ta
  yalnızca JavaScript hataları bildirilir), APK güncelleyici (iOS'ta `itms-services` bağlantısı),
  `expo-intent-launcher` (iOS'ta dosyalar paylaşım sayfasıyla, videolar Safari'de açılır), titreşim
  (iOS'ta kapalı, bkz. eksikler).
- **Ses**: `registerGlobals()` iOS ses oturumunu LiveKit'e bıraktırır (`setupIOSAudioManagement`).
  Arayüz sesleri (expo-audio) iOS'ta ses kipini değiştirmez ve oturumu kapatmaz; yoksa görüşme kesilirdi.
  Hoparlör düğmesi iOS'ta "hoparlöre zorla / varsayılan yol" arasında geçer.
- **OTA**: iOS'un parmak izi ayrıdır (`node scripts/runtime-version.mjs --platform ios`). IPA ile OTA
  paketi aynı macOS işinde üretilir; parmak izi değişmediyse IPA yeniden derlenmez, önceki sürümünki taşınır.
- **Sürüm kuralı**: `MIN_IOS_VERSION` ve en son sürümün iOS'a ulaşabilen hali (IPA ya da iOS OTA)
  Android'deki gibi uygulanır. Sürümde IPA yoksa iOS için kural yoktur.
- **Kurulum bildirimi**: sunucu `/download/ios/manifest.plist`'i en son sürümdeki IPA'dan üretir
  (IPA adresi GitHub'daki dosya). `IOS_BUNDLE_ID` ayarı varsayılan `com.diskort.app`.

## Bilinen eksikler

- **Ekran paylaşımı (iPhone'dan)**: iOS'ta sistem geneli ekran yayını bir **Broadcast Upload Extension**
  (ayrı hedef, App Group, ayrı profil) gerektirir; eklenmedi. Başkalarının yayınını izlemek çalışır.
  Paylaşım düğmesine basılırsa hata mesajı çıkar.
- **Kilit ekranı / Dinamik Ada kontrolleri, CallKit**: yok. Görüşme arka planda sürer ama kilit ekranında
  "sustur / ayrıl" düğmesi yoktur (Android'deki bildirim düğmelerinin karşılığı). CallKit ile gelen arama
  ekranı veya Now Playing kartı ileride eklenebilir.
- **VoIP push (PushKit)** yok: `voip` arka plan kipi yalnızca işaret; uygulama tamamen kapalıyken sesli
  kanala çağrı bildirimi gelmez (normal bildirimler gelir).
- **Titreşim**: React Native'in `Vibration`'ı iOS'ta kısa desen desteklemediği için düğme titreşimleri iOS'ta
  kapalı. `expo-haptics` eklenirse açılabilir (yeni yerel bağımlılık, yeni IPA).
- **Cihazda sistemli olarak doğrulanmadı**: IPA kayıtlı iPhone'lar için yayınlanıyor; mikrofon, arka plan sesi,
  Bluetooth ve bildirimlerin gerçek cihazdaki davranışı ayrıca tek tek denenmeli.
- `itms-services` bildirimindeki IPA adresi GitHub'a gider ve oradan yönlendirilir; iOS bunu izler. Sorun
  çıkarsa sunucu IPA'yı kendisi sunacak şekilde değiştirilebilir.
