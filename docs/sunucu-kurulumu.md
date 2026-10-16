# Sunucu kurulumu

Diskort'u kendi sunucunda çalıştırmak için gerekenler: kurulum, güncelleme, ayarlar, bakım ve yedekleme.

## Gereksinimler

- **VPS:** 2 vCPU / 4 GB RAM yeterli. Türkiye'deki kullanıcılar için İstanbul lokasyonu en düşük gecikmeyi verir.
- **Bant genişliği:** 20 kişilik ses ≈ 1–2 Mbps; 1080p60 yayını izleyen her kişi ≈ 7 Mbps.
- **Alan adları:** üç alt alan adı, ör. `diskort.ornek.com` (API ve indirme sayfası), `lk.ornek.com` (LiveKit),
  `turn.ornek.com` (TURN/TLS).
- **Açık portlar:**

  | Port | Ne için |
  |---|---|
  | `80/tcp`, `443/tcp` | HTTPS, gateway, TURN/TLS (443'ü HTTPS ile paylaşır) |
  | `7881/tcp` | WebRTC TCP yedeği |
  | `3478/udp` | TURN/UDP |
  | `50000–60000/udp` | Ses ve görüntü (WebRTC) |

> **UDP önemli:** Bazı sağlayıcılar yoğun UDP trafiğini sessizce düşürür. Kurmadan önce sağlayıcının yüksek
> paket hızına izin verdiğinden emin ol; [tools/udp-probe](../tools/udp-probe/README.md) ile test edebilirsin.

## Kurulum

1. Üç alan adının DNS A kaydını VPS'in IP adresine yönlendir. Cloudflare kullanıyorsan kayıtlar
   **DNS only (gri bulut)** olmalı; proxy WebRTC ve TURN'ü bozar.
2. Depoyu `/opt/diskort`'a kopyala ve hazırlık betiğini çalıştır. Betik Docker'ı, güvenlik duvarını, günlük
   yedek zamanlayıcısını ve rastgele anahtarları kurar:

   ```bash
   sudo bash infra/setup-vps.sh
   ```

3. `infra/.env` içinde `DISKORT_DOMAIN`, `LIVEKIT_DOMAIN` ve `TURN_DOMAIN` değerlerini düzenle, sonra başlat:

   ```bash
   cd infra && docker compose up -d --build
   ```

4. İlk yönetici davet kodunu günlükte bul ve uygulamada **"Davet koduyla kaydol"** ile kullan:

   ```bash
   docker compose logs api | grep -i davet
   ```

Sunucuda üç kapsayıcı çalışır: **api** (Fastify + SQLite), **livekit** (SFU) ve **caddy** (HTTPS, TURN/TLS
yönlendirmesi). Hepsi host ağını kullanır.

> **443'ü başka projelerle paylaşıyorsan:** `caddy` servisi yalnızca `.env`'deki `COMPOSE_PROFILES=caddy` ile
> başlar. Sunucuda 443'ü başka bir Caddy tutuyorsa bu satırı sil, o Caddy'nin global ayarlarına
> `infra/Caddyfile`'daki TURN/TLS (katman-4) bloğunu ekle ve `infra/caddy/` klasörünü bağlayıp
> `diskort.caddy`'yi içe aktar. Diskort'un üretim sunucusu böyle çalışır (ayrı `ziroo-edge` projesi); orada
> `docker compose ... caddy` komutları çalıştırılmaz, Diskort site değişikliği `git pull` +
> `bash /opt/ziroo-edge/reload.sh` ile yayına girer.

## Güncelleme

```bash
cd /opt/diskort && git pull && cd infra && docker compose up -d --build
```

- Yalnızca API'yi güncellemek için `docker compose up -d --no-deps --build api` yeterlidir; süren görüşmeler kopmaz.
- `infra/caddy/diskort.caddy` değiştiyse `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`
  yeterlidir (kesinti yok). `infra/Caddyfile` değiştiyse Caddy'yi yeniden başlat (`docker compose restart caddy`);
  dosya tek başına bağlandığı için `git pull` sonrası eski hâlini görmeye devam eder.
- LiveKit ya da Caddy yeniden başlatılınca süren görüşmeler birkaç saniye kopar; kimse seste değilken yap.
- Şema değiştiren güncellemelerden önce `bash infra/backup-db.sh` ile yedek al.

## Ayarlar

Tümü `infra/.env` içinde. Kurulumun çalışması için yalnızca alan adları gerekir; diğerleri isteğe bağlıdır.

| Değişken | Ne yapar |
|---|---|
| `DISKORT_DOMAIN`, `LIVEKIT_DOMAIN`, `TURN_DOMAIN` | Alan adları (zorunlu) |
| `ATTACHMENT_MAX_MB` | Dosya başına yükleme sınırı (varsayılan 25) |
| `CLIENT_UPDATE_ENFORCE=0` | Zorunlu güncellemeyi acil durumda kapatır |
| `MIN_ANDROID_VERSION` | Android için alt sürüm sınırı (normalde boş) |
| `GIPHY_API_KEY`, `GIPHY_RATING`, `GIPHY_LANG` | GIF araması (bkz. aşağıda) |
| `FCM_SERVICE_ACCOUNT_FILE` | Telefon bildirimleri (bkz. aşağıda) |
| `TRAFFIC_QUOTA_GB` | Aylık trafik kotası (GB), panelde gösterilir; yalnızca giden trafik sayılır (varsayılan 1000) |
| `SYSTEM_STATS=0` | Makine ölçümlerini kapatır |
| `NET_PROBE_TARGETS` | Dış sonda hedefleri, ör. `udp:1.1.1.1:53,tcp:8.8.8.8:443` (`0` kapatır) |
| `LINE_TEST_MAX_MBPS`, `LINE_TEST_ADMIN_MAX_MBPS` | Hat testi bant sınırları (24 / 48) |
| `LIVEKIT_METRICS_URL`, `CADDY_METRICS_URL` | Ölçüm adresleri (`0` kapatır) |
| `BACKUP_DIR`, `TLS_CHECK_DOMAINS`, `STATS_UTC_OFFSET_MIN` | Panel için yedek klasörü, sertifika kontrolü, saat dilimi |

### GIF araması (GIPHY)

`GIPHY_API_KEY` tanımlıysa mesaj kutusunda GIF düğmesi çıkar (anahtar: developers.giphy.com → Create an App → API).
İstemciler GIPHY'ye değil sunucuya sorar; anahtar sunucuda kalır, sonuçlar 5 dakika önbelleğe alınır. İçerik sınırı
`GIPHY_RATING` (varsayılan `pg-13`), arama dili `GIPHY_LANG` (varsayılan `tr`).

### Telefon bildirimleri (FCM)

Sunucu, Google'ın FCM HTTP v1 arayüzüne doğrudan gönderir. Firebase → Proje ayarları → Service accounts →
"Generate new private key" ile alınan dosyayı `infra/secrets/fcm.json` olarak koy (`chmod 600`) ve `.env`'e
`FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json` ekle.

## Bakım ve güvenlik

- **Güvenlik güncellemeleri** her gün otomatik kurulur (`unattended-upgrades`); gerekirse sunucu gece 05:00'te
  kendini yeniden başlatır.
- **SSH** yalnızca anahtarla açılır. Anahtar kaybolursa sağlayıcı panelindeki konsoldan girip
  `/etc/ssh/sshd_config.d/00-diskort-hardening.conf` dosyasını silmek şifre girişini geri açar.
- Gizli değerler `infra/.env` (izinler 600) ve `infra/secrets/` altındadır; depoya girmez.

## Yedekleme

| Ne | Nasıl | Nerede | Süre |
|---|---|---|---|
| Veritabanı | `diskort-backup.timer`, her gece 04:00 → `infra/backup-db.sh` (tutarlı kopya + bütünlük kontrolü) | `/var/backups/diskort/` (`latest.db.gz` en yenisi) | 14 gün |
| Dosya ekleri, profil fotoğrafları, geri bildirim görüntüleri | Aynı zamanlayıcı → `infra/backup-attachments.sh` (sabit bağlantıyla, ek yer kaplamaz) | `/var/backups/diskort/` | silinen dosya 30 gün daha |
| Sunucu dışı kopya | Windows Görev Zamanlayıcı → [`scripts/pull-db-backups.ps1`](../scripts/pull-db-backups.ps1), her gün 12:00 | `OneDrive\Yedekler\Diskort` | 60 gün |
| Sunucu dışı kopya (Mac) | launchd `net.ziroo.diskort-yedek` → [`scripts/pull-db-backups.sh`](../scripts/pull-db-backups.sh), her gün 12:00; aynı sunucudaki Tussle'ın gece yedeğini de çeker | `~/Yedekler/Diskort`, Tussle `~/Yedekler/Tussle` | 60 gün; Tussle 14 gün (gizlilik sayfası) |

Notlar:

- Veritabanı yedeği yalnızca dosyaların kayıtlarını kapsar; dosyaların kendisi `/data/attachments/` ve
  `/data/avatars/` altındadır ve ayrı yedeklenir.
- Eski bir veritabanı yedeği geri yüklenirse, yedekte karşılığı olmayan dosyalar bir saat içinde kendiliğinden silinir.
- Diskte 1 GB'tan az yer kalınca yeni yüklemeler reddedilir.

### Geri yükleme

Betik önce mevcut veritabanının bir güvenlik kopyasını alır:

```bash
bash /opt/diskort/infra/restore-db.sh /var/backups/diskort/diskort-2026-09-27_0400.db.gz
```

Bilgisayardaki bir yedeği geri yüklemek için önce sunucuya kopyala:
`scp <dosya>.db.gz root@<sunucu>:/root/`
