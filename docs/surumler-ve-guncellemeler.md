# Sürümler ve güncellemeler

Diskort'ta **herkes her zaman en son sürümü kullanır** (Discord'daki gibi). Bu sayfa güncellemelerin nasıl
çalıştığını ve yeni sürümün nasıl yayınlandığını anlatır.

## Masaüstü güncellemeleri

1. **Açılışta:** küçük bir açılış penceresi güncellemeyi denetler. Yeni sürüm varsa yalnızca değişen blokları
   indirir (genelde birkaç MB), kurar ve yeni sürümle yeniden açılır. İnternet yoksa uygulama yine açılır.
2. **Sunucu tarafında:** gateway, en son yayınlanan sürümden eski istemcileri kabul etmez (`UPDATE_REQUIRED`);
   uygulama "Güncelleme gerekli" ekranını gösterip güncellemeyi kendisi kurar.
3. **Çalışırken:** yeni sürüm yayınlanınca güncelleme arka planda iner ve üstte "Şimdi yeniden başlat" şeridi
   çıkar. Kullanıcı seste değilken uygulama 5 dakikadır simge durumundaysa güncelleme sessizce kurulur.

Uygulamalar güncellemeyi `https://diskort.ziroo.net/updates/` adresinden ister; sunucu
([`routes/updates.ts`](../apps/server/src/routes/updates.ts)) dosyaları GitHub Releases'e yönlendirir. Dağıtım
yeri değişirse yalnızca sunucu değişir.

> **macOS:** Apple imzası olmadan kendi kendine güncelleme mümkün olmadığından açılış penceresi indirme sayfasına
> yönlendirir.

### Windows kurulum konumları

Kurulum yönetici izni istemez ([`build/installer.nsh`](../apps/desktop/build/installer.nsh)).

| | Konum |
|---|---|
| Uygulama | `%LOCALAPPDATA%\Programs\diskort` |
| Ayarlar ve oturum (kaldırınca silinmez) | `%APPDATA%\Diskort` |
| Güncelleme günlüğü | `%APPDATA%\Diskort\logs\updater.log` |
| İndirilen güncellemeler | `%LOCALAPPDATA%\diskort-updater` |

> ⚠️ `appId`, paket adı (`diskort`), `productName` ve `nsis.guid`
> ([`electron-builder.yml`](../apps/desktop/electron-builder.yml)) kurulu uygulamaların birbirini tanıması için
> **değiştirilmemelidir**.

## Android güncellemeleri

Güncellemeler iki katmanlıdır ve masaüstündeki gibi zorunludur:

| Katman | Ne zaman | Nasıl |
|---|---|---|
| **Kablosuz (OTA)** | Yalnızca arayüz (JavaScript) değiştiyse | Uygulama açılırken birkaç MB'lık paketi indirir ve kendini yeniden başlatır; kullanıcı bir şey yapmaz. |
| **APK** | Yerel kısım değiştiyse (Android kodu, kütüphaneler, izinler, Expo/React Native sürümü) | Telefona uygun APK iner (~50–60 MB) ve Android'in kurulum ekranı açılır; son onay kullanıcıdadır. |

Hangisinin gerektiğine **yerel kısmın parmak izi** karar verir
([`runtime-version.mjs`](../apps/mobile/scripts/runtime-version.mjs), `@expo/fingerprint`). OTA paketi yalnızca
aynı parmak izli APK'lara gider. Parmak izi değişmemişse sürümde APK yeniden derlenmez, öncekiler taşınır; böylece
yalnızca arayüz değişen bir sürüm birkaç dakikada çıkar.

### İmzalar

- **APK** depoda olmayan kalıcı bir anahtarla imzalanır (GitHub gizli değişkenleri `ANDROID_KEYSTORE_*`). Anahtar
  kaybolursa kurulu uygulamalar güncellenemez; herkes kaldırıp yeniden kurmak zorunda kalır.
- **OTA paketi** ayrı bir anahtarla imzalanır (`OTA_SIGNING_KEY`). Telefon imzayı uygulamanın içindeki sertifikayla
  ([`certs/certificate.pem`](../apps/mobile/certs/certificate.pem)) doğrular; sunucu ele geçirilse bile telefonlara
  kod gönderilemez.
- **Masaüstü** için bu güvence yok. macOS'ta Squirrel Developer ID imzasını denetler, ama Windows ve Linux paketleri
  imzasızdır ve güncelleyici yalnızca `latest.yml`'deki sha512'ye bakar. `latest.yml`'ye giden yönlendirmeyi sunucu
  verdiği için sunucu ele geçirilirse kurulu Windows ve Linux uygulamalarına kod gönderilebilir.
- `google-services.json`, derleme sırasında `GOOGLE_SERVICES_JSON` gizli değişkeninden yazılır.

### Test APK'sı

GitHub → Actions → **Android APK** → *Run workflow*. Varsayılan olarak yalnızca arm64 derlenir; *Tüm işlemciler*
seçilirse armv7 ve evrensel APK da üretilir. Yerel derlemeler (`expo run:android`) OTA almaz.

## iOS

iPhone uygulaması App Store'suz, Ad Hoc imzayla kendi sitemizden kurulur (yalnızca kayıtlı cihazlara). Yeni bir
iPhone `/udid` sayfasından kaydolur; yönetim panelinde onaylanınca IPA o cihazı da içerecek şekilde kendiliğinden
yeniden derlenir. Arayüz güncellemeleri Android'deki gibi OTA ile gelir. Ayrıntılar: [ios.md](ios.md).

## Yeni sürüm yayınlama

1. Sunucu değişikliği varsa **önce sunucuyu** güncelle; yeni istemci eski sunucuyla çalışmayabilir.
2. `apps/desktop/package.json` ve `apps/mobile/package.json` içindeki `version`'ı artır (ikisi aynı olmalı) ve
   commit'le.
3. Sürüm etiketini gönder:

   ```bash
   git tag v0.9.5 && git push origin v0.9.5
   ```

4. GitHub Actions ([`release.yml`](../.github/workflows/release.yml)) Windows, Linux, macOS, Android (ve imza
   ayarlıysa iOS) paketlerini derleyip **taslak** sürüme yükler. Linux paketi sanal ekranda açılış testinden geçer.
5. Taslağı yayınla:

   ```bash
   gh release edit v0.9.5 --draft=false --latest
   ```

> ⚠️ **Yayınladığın anda sürüm zorunlu olur:** açılan her uygulama güncellenir, sunucu birkaç dakika içinde eski
> sürümleri reddeder. Hatalı bir sürüm geri alınamaz; düzeltmeyi daha yüksek bir sürüm numarasıyla yayınla.
> Acil durumda sunucuda `CLIENT_UPDATE_ENFORCE=0` ile zorunluluğu geçici olarak kapatabilirsin.

Paketlenmiş uygulamanın varsayılan sunucusu `apps/desktop/.env.production` içindeki `VITE_DEFAULT_SERVER`
değeridir. Giriş ekranında sunucu adresi gizlidir; test için logoya art arda 5 kez tıklayınca değiştirilebilir.

Kod imzalama durumu: [kod-imzalama.md](kod-imzalama.md).
