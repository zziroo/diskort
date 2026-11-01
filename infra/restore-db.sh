#!/usr/bin/env bash
# Bir yedeği geri yükler. Mevcut veritabanı önce güvenlik kopyası olarak saklanır.
# Kullanım: bash infra/restore-db.sh /var/backups/diskort/diskort-2026-09-27_0400.db.gz
set -euo pipefail

backup="${1:?Kullanım: restore-db.sh <yedek.db.gz | yedek.db>}"
[ -f "$backup" ] || { echo "Dosya bulunamadı: $backup" >&2; exit 1; }
cd "$(dirname "$0")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [[ "$backup" == *.gz ]]; then gunzip -c "$backup" > "$work/restore.db"; else cp "$backup" "$work/restore.db"; fi

safety="/var/backups/diskort/pre-restore-$(date +%F_%H%M%S).db"
mkdir -p /var/backups/diskort

echo "API durduruluyor..."
docker compose stop api >/dev/null

# Durdurulmuş konteynerin veri klasörüyle çalışmak için geçici yardımcı konteyner
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -a -q api)")"
docker run --rm -v "${volume}:/data" -v "$work:/restore" node:24-slim sh -c "
  set -e
  if [ -f /data/diskort.db ]; then cp /data/diskort.db /restore/current.db; fi
  rm -f /data/diskort.db /data/diskort.db-wal /data/diskort.db-shm
  cp /restore/restore.db /data/diskort.db
  chown --reference=/data /data/diskort.db
"
[ -f "$work/current.db" ] && cp "$work/current.db" "$safety" && chmod 600 "$safety" && echo "Önceki veritabanı saklandı: $safety"

echo "API başlatılıyor..."
docker compose start api >/dev/null
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then echo "Geri yükleme tamamlandı."; exit 0; fi
  sleep 1
done
echo "API sağlık kontrolünden geçmedi! Loglar: docker compose logs api" >&2
exit 1
