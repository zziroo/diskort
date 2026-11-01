# Diskort

Depo herkese açık: sır, sunucu adresi ve anahtar adı yazma. Tarihçe bu dosyaya değil vault'a gider.

- Durum ve kararlar: vault `10-Projects/diskort/_overview.md`. Kod haritası: `docs/kod-haritasi.md`; yapı değiştiren commit'te güncellenir.
- Doğrulama: `pnpm typecheck`, `pnpm test`.
- İstemci sürümünü yalnız Yusuf çıkarır. Yayınlanan sürüm zorunlu güncellemedir; sunucu önce deploy edilir. Akış: `docs/surumler-ve-guncellemeler.md`.
- Sunucu: kesinti yaratan iş bakım penceresinde, önce `livekit_participant_total` bakılır. API güncellemesi `docker compose up -d --no-deps --build api`; `--no-deps` olmadan LiveKit de yeniden başlayabilir. Üretimde `docker compose ... caddy` çalıştırılmaz.
- API root'suz çalışacak biçimde kurulu (`docs/sunucu-kurulumu.md`, Root'suz çalıştırma): yeni yazma yolları `/data` altında olmalı, kapsayıcı dosya sistemine yazma ekleme.
- `sharp` sürümü iki yerde sabittir: `apps/server/package.json` ve `apps/server/Dockerfile`.
- Masaüstü ve mobil `package.json` sürümleri aynı olmalı.
