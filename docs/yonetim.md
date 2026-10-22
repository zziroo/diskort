# Yönetim

Hesap yöneticilerinin araçları: uygulama içi yönetim, komut satırı ve web yönetim paneli.
Hesap yöneticisinin ne olduğu için bkz. [Roller ve yetkiler → Hesap yöneticileri](roller-ve-yetkiler.md#hesap-yöneticileri).

## Uygulamada

**Kullanıcı Ayarları → Yönetim** (yalnızca hesap yöneticilerine; masaüstünde ve telefonda aynı):

- **Geri bildirimler** — bkz. [Geri bildirim](geri-bildirim.md)
- **Hesaplar ve davetler** — hesap yöneticisi ekle/çıkar, hesap davetleri, şifre sıfırlama kodu, hesap silme
- **Web yönetim paneli** bağlantısı

## Komut satırı

API imajındaki `dist/admin-cli.js` veritabanını doğrudan açar; değişiklik hemen geçerli olur.

```bash
cd /opt/diskort/infra
docker compose exec api node dist/admin-cli.js list              # hesap yöneticileri (--json)
docker compose exec api node dist/admin-cli.js grant <kullanıcı>
docker compose exec api node dist/admin-cli.js revoke <kullanıcı>   # son yönetici alınamaz
```

İlgili API uçları: `GET /api/users`, `GET /api/admins`, `PUT /api/admins/:id`, `DELETE /api/admins/:id`
(son yönetici: `400 last_admin`). Hepsi hesap yöneticisi ister.

## Web yönetim paneli (`/admin`)

Telefona uygun, sekmeli bir sayfa ([`apps/web/admin.html`](../apps/web/admin.html); ana sayfadan bağlantı yok,
arama motorlarına kapalı). Diskort hesabıyla giriş yapılır; yönetici olmayanlar içeri giremez. Özet 5 saniyede bir
yenilenir, ağır veriler yalnızca ilgili sekme açıkken yüklenir.

| Sekme | Ne gösterir |
|---|---|
| **Genel** | Hesaplar, bağlı kişiler, son 24 saat / 7 günde etkin hesaplar, günlük mesaj sayıları, depolama |
| **Ses** | Sesteki kişiler, kanal, süre, yayınlar, LiveKit izleri ve kişi başı bağlantı kalitesi grafikleri |
| **Bağlantı teşhisi** | "Donma/kesilme nerede?" sorusunun tek yeri: canlı durum, kesintiler, olaylar, hat testleri, LiveKit ölçümleri |
| **Ses geçmişi** | Kim ne kadar seste/yayında, yoğun saatler ısı haritası, en çok kullanılan kanallar |
| **Makine** | CPU, bellek, disk, ağ, aylık trafik, kapsayıcılar, TURN/TLS, son yedek, TLS sertifikalarının bitişi |
| **API** | İstek hızı, durum kodları, uç başına gecikme (p50/p95), gateway bağlantıları, 429'lar |
| **İstemciler** | Platform ve sürüme göre bağlantılar, hesapların son görülme anı |
| **Güvenlik** | Girişler, başarısız denemeler, sınır aşımları, oturumlar, davet kullanımları |
| **Sunucular** | Sunucu başına üye, kanal, mesaj ve ses istatistikleri (yalnızca sayılar) |
| **Geri bildirim** | Süzme, ayrıntı, durum ve not |
| **iPhone cihazları** | `/udid` sayfasından kaydolan cihazların onayı (bkz. [ios.md](ios.md)) |
| **Hatalar** | Son istemci hataları, 5xx ile biten istekler, sunucu günlüğündeki hatalar |

### DM aramalarının gizliliği

Direkt mesaj aramaları panelde **"Özel arama"** olarak görünür: konuşmanın kimliği, adı ve katılımcıların adı ya da
kimliği hiçbir sekmede, dışa aktarımda ya da kalıcı kayıtta yoktur. Kalite ölçümleri, olay kayıtları ve donma
teşhisi tutulur ama kişi ve konuşma, alınırken süreç başına rastgele anahtarla üretilen takma kimliklere
(`ozel-…`; kişininki konuşma başına ayrı) çevrilir (sunucu yeniden başlayınca değişir, gerçek kimliğe geri
bağlanamaz). Sınır: platform/sürüm ve zamanlama tanılama için kalır; çok küçük bir sunucuda yönetici bunlardan
tahmin yürütebilir. DM aramaları ses
geçmişine yazılmaz; yönetici özel aramadan elle olay kaydı isteyemez (donma olayında otomatik istek sürer).
Ayrıntı: [Direkt mesajlar → Aramalar](direkt-mesajlar.md#aramalar).

### Bağlantı teşhisi

Dört görünümü vardır:

- **Canlı durum:** bölüm bölüm durum (dış sondalar, sunucuya gelen trafik, ses sunucusu, giden trafik, sunucu
  kaynakları), son 5 dakikanın saniyelik grafikleri ve son kesintiler. Bir kesintiden Türkçe + İngilizce,
  kopyalanabilir **sağlayıcı raporu** üretilebilir.
- **Olaylar:** yayın donmaları ve kullanıcı bazlı kalite sorunları tek zaman çizelgesinde. Her olayda arızalı bölümü
  söyleyen bir özet, güven düzeyi, kanıtlar ve eksik kanıtlar listesi bulunur.
- **Testler:** hat testi kodları ve sonuçları. Testi çalıştırmak için: [tools/udp-probe](../tools/udp-probe/README.md).
- **Ayrıntı:** dakikalık ağ geçmişi (14 gün) ve LiveKit ölçümleri (bit hızı, kayıp, NACK/PLI, RTT, titreşim).

### Ses kalitesi ölçümleri

Seste olan istemciler (0.7.0+) 30 saniyelik bağlantı özetleri gönderir (`POST /api/telemetry/voice`): ping,
titreşim, kayıp, bit hızları, bağlantı yolu (doğrudan / NAT / TURN; IP adresi yok), yeniden bağlanmalar,
gürültü engelleyici yükü ve yayın bilgileri. Kalite kötüleşince hemen gönderilir. Sunucu son bir saati bellekte,
14 günü diskte tutar.

## Sunucuda tutulan kayıtlar

Hepsi `<DATA_DIR>` (kapsayıcıda `/data`) altındadır ve süresi dolunca kendiliğinden silinir.

| Dosya | İçerik | Süre |
|---|---|---|
| `traffic.json` | Aylık trafik sayacı | sürekli |
| `activity.json` | Hesapların son görülme anı | sürekli |
| `counters.json` | Günlük sayaçlar | 30 gün |
| `auth-log.jsonl` | Giriş kayıtları (şifre yazılmaz) | 30 gün |
| `client-errors.jsonl`, `server-errors.jsonl` | Son hatalar | 14 gün |
| `udids.jsonl`, `udid-status.json` | iPhone cihaz kayıtları | sürekli |
| `telemetry/YYYY-AA-GG.jsonl` | Ses kalitesi özetleri | 14 gün |
| `telemetry/netmin-*.jsonl` | Makine ağının dakikalık özetleri | 14 gün |
| `telemetry/netsec-*.jsonl` | Anormal saniyelerin çevresi | 7 gün |
| `telemetry/outages.jsonl` | Kesinti kaydı (`probe.proto`: `both` tüm yol, `udp`/`tcp` yalnız o protokol, sağlayıcı kesintisi sayılmaz; boş odadaki adaylar yazılmaz) | 14 gün |
| `telemetry/freeze-*.jsonl` | Yayın donması olayları ve kanıtları | — |
| `telemetry/line-tests.jsonl`, `line-codes.json` | Hat testi sonuçları ve kodları | — |

Bu ölçümlerle ilgili ortam değişkenleri: [Sunucu kurulumu → Ayarlar](sunucu-kurulumu.md#ayarlar).
