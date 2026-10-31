#!/usr/bin/env bash
# Dosya eklerinin (mesajlardaki resim/dosyalar), profil fotoğraflarının, geri bildirim ekran görüntülerinin,
# giriş seslerinin ve ses paneli seslerinin günlük anlık kopyası: BACKUP_DIR/attachments, BACKUP_DIR/avatars,
# BACKUP_DIR/feedback, BACKUP_DIR/intro-sounds ve BACKUP_DIR/sounds.
# Bu dosyalar hiç değişmez (adları rastgele kimlik ya da içerik özeti), bu yüzden kopya "sabit bağlantı" (hard link) ile alınır:
# diskte ek yer kaplamaz. Mesaj silinip dosya uygulamadan kalkınca kopyadaki bağlantı tek başına kalır
# ve KEEP_DAYS gün sonra silinir; yanlışlıkla silinenler bu süre içinde geri getirilebilir.
# Bilgisayardaki yedek (scripts/pull-db-backups.sh ve .ps1) bu beş klasörü de aynalar.
# Günlük olarak systemd zamanlayıcısı çalıştırır (infra/systemd/diskort-backup.service).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/diskort}"
KEEP_DAYS="${KEEP_DAYS:-30}"
cd "$(dirname "$0")"

# api kapsayıcısındaki /data'nın sunucudaki yeri (Docker birimi)
container="$(docker compose ps -q api)"
data="$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
# Klasör → dosya adı kalıbı: ekler rastgele kimlikle, profil fotoğrafları içerik özetiyle adlandırılır.
# Yarım yüklemeler (.part, .tmp) alınmaz.
backup_dir() {
  local src="$1" dst="$2" pattern="$3" added=0 removed count size
  mkdir -p "$dst"
  chmod 700 "$dst"
  if [ -d "$src" ]; then
    while IFS= read -r -d '' file; do
      name="$(basename "$file")"
      if [ ! -e "${dst}/${name}" ]; then
        ln "$file" "${dst}/${name}"
        added=$((added + 1))
      fi
    done < <(find "$src" -maxdepth 1 -type f -regextype posix-egrep -regex ".*/${pattern}" -print0)
  fi
  # Uygulamadan silinmiş (bağlantı sayısı 1'e düşmüş) ve KEEP_DAYS günü geçmiş kopyalar. Bağlantı sayısı
  # değişince dosyanın ctime'ı güncellenir; yani süre silinme anından itibaren sayılır.
  removed="$(find "$dst" -maxdepth 1 -type f -links 1 -ctime "+${KEEP_DAYS}" -print -delete | wc -l)"
  count="$(find "$dst" -maxdepth 1 -type f | wc -l)"
  size="$(du -sh "$dst" | cut -f1)"
  echo "$(basename "$dst"): ${count} dosya (${size}), yeni ${added}, süresi dolup silinen ${removed}"
}

chmod 700 "$BACKUP_DIR"
backup_dir "${data}/attachments" "${BACKUP_DIR}/attachments" '[0-9a-f]{32}'
backup_dir "${data}/avatars" "${BACKUP_DIR}/avatars" '[0-9a-f]{32}\.webp'
backup_dir "${data}/feedback" "${BACKUP_DIR}/feedback" '[0-9a-f]{32}\.webp'
backup_dir "${data}/intro-sounds" "${BACKUP_DIR}/intro-sounds" '[0-9a-f]{32}\.mp3'
backup_dir "${data}/sounds" "${BACKUP_DIR}/sounds" '[0-9a-f]{32}\.mp3'
