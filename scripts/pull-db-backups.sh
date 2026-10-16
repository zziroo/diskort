#!/usr/bin/env bash
# Sunucudaki Diskort yedeklerini bu bilgisayara indirir (Mac karşılığı; Windows'ta scripts/pull-db-backups.ps1):
# en son veritabanı yedeği (60 gün tutulur), dosya eklerinin, profil fotoğraflarının ve geri bildirim ekran
# görüntülerinin aynası. Böylece sunucu tamamen kaybolsa bile bir kopya burada kalır. Aynı sunucudaki Tussle'ın
# gece yedeğini de indirir (~/Yedekler/Tussle, 14 gün: Tussle gizlilik sayfası yedekleri en çok 14 gün tutar).
# launchd her gün 12:00'de çalıştırır (net.ziroo.diskort-yedek). Elle: bash scripts/pull-db-backups.sh
#
# Sunucuya ~/.ssh/config'teki `vps` alias'ıyla bağlanır (anahtar, kullanıcı, zaman aşımı orada).
set -euo pipefail

SERVER="${DISKORT_BACKUP_SERVER:-vps}"
DEST="${DISKORT_BACKUP_DEST:-$HOME/Yedekler/Diskort}"
KEEP_DAYS="${DISKORT_BACKUP_KEEP_DAYS:-60}"
TUSSLE_DEST="${TUSSLE_BACKUP_DEST:-$HOME/Yedekler/Tussle}"
TUSSLE_KEEP_DAYS=14   # Tussle gizlilik sayfasındaki söz; artırma
REMOTE_ROOT=/var/backups/diskort
SSH=(ssh -o BatchMode=yes "$SERVER")
SCP=(scp -q -o BatchMode=yes)

mkdir -p "$DEST"
LOG="$DEST/yedek-gunlugu.txt"
now() { date '+%Y-%m-%d %H:%M'; }
fail() { echo "$(now) HATA   $*" >>"$LOG"; echo "HATA: $*" >&2; exit 1; }
trap 'fail "satır $LINENO: $BASH_COMMAND"' ERR

remote() { "${SSH[@]}" "$1"; }

# Sunucudaki bir klasörü buraya aynalar: yalnız eksik dosyalar iner (tar paketiyle, 400'erli);
# sunucuda silinenler buradan da silinir. Sunucu hiç dosya bildirmezse hiçbir şey silinmez.
mirror() {
  local remote_dir="$1" local_dir="$2" pattern="$3" label="$4"
  mkdir -p "$local_dir"
  local listing
  listing="$(remote "if test -d $remote_dir; then ls -1 $remote_dir; fi" | grep -E "$pattern" || true)"
  local -a remote_files=() missing=()
  [ -n "$listing" ] && while IFS= read -r f; do remote_files+=("$f"); done <<<"$listing"
  local f
  for f in "${remote_files[@]}"; do
    [ -e "$local_dir/$f" ] || missing+=("$f")
  done
  local tmp_tar="${TMPDIR:-/tmp}/diskort-yedek-$$.tar"
  local i batch remote_tar="/tmp/diskort-yedek-$$.tar"
  for ((i = 0; i < ${#missing[@]}; i += 400)); do
    batch="${missing[*]:i:400}"
    remote "cd $remote_dir && tar -cf $remote_tar $batch" >/dev/null
    "${SCP[@]}" "$SERVER:$remote_tar" "$tmp_tar" || { remote "rm -f $remote_tar" >/dev/null || true; fail "$label indirilemedi"; }
    remote "rm -f $remote_tar" >/dev/null || true
    tar -xf "$tmp_tar" -C "$local_dir"
    rm -f "$tmp_tar"
  done
  local removed=0
  if [ "${#remote_files[@]}" -gt 0 ]; then
    for f in "$local_dir"/*; do
      [ -f "$f" ] || continue
      local name; name="$(basename "$f")"
      echo "$name" | grep -qE "$pattern" || continue
      if ! printf '%s\n' "${remote_files[@]}" | grep -qxF "$name"; then
        rm -f "$f"; removed=$((removed + 1))
      fi
    done
  fi
  echo "$label: ${#remote_files[@]} dosya, yeni ${#missing[@]}, silinen $removed"
}

# Sunucudaki latest.db.gz'nin hedefini (adı tarih taşır) yoksa indirir, gzip'ini doğrular; "<ad> <durum>" yazar.
pull_latest() {
  local remote_root="$1" dest="$2" name target
  mkdir -p "$dest"
  name="$(remote "readlink $remote_root/latest.db.gz")"
  [ -n "$name" ] || fail "$remote_root/latest.db.gz bulunamadı"
  target="$dest/$name"
  if [ -e "$target" ]; then
    echo "$name zaten vardı"
  else
    "${SCP[@]}" "$SERVER:$remote_root/$name" "$target.part"
    gzip -t "$target.part" || { rm -f "$target.part"; fail "$name bozuk indi"; }
    mv "$target.part" "$target"
    echo "$name indirildi ($(( $(stat -f %z "$target") / 1024 )) KB)"
  fi
}

# 1) En son veritabanı yedeği
db="$(pull_latest "$REMOTE_ROOT" "$DEST")"
find "$DEST" -maxdepth 1 -name 'diskort-*.db.gz' -mtime +"$KEEP_DAYS" -delete

# 2) Ekler, profil fotoğrafları, geri bildirim görüntüleri (sunucudaki günlük kopyanın aynası)
a="$(mirror "$REMOTE_ROOT/attachments" "$DEST/ekler" '^[0-9a-f]{32}$' 'ekler')"
b="$(mirror "$REMOTE_ROOT/avatars" "$DEST/profil-fotograflari" '^[0-9a-f]{32}\.webp$' 'profil fotoğrafları')"
c="$(mirror "$REMOTE_ROOT/feedback" "$DEST/geri-bildirim" '^[0-9a-f]{32}\.webp$' 'geri bildirim görüntüleri')"

# 3) Tussle veritabanı yedeği. Dosyanın zamanı indiği an (sunucuda alınıştan ~8 saat sonra), bu yüzden
# indirilişinden 13 gün sonra silinir; böylece hiçbir kopya alınışından 14 gün sonra burada durmaz.
t="$(pull_latest /var/backups/tussle "$TUSSLE_DEST")"
find "$TUSSLE_DEST" -maxdepth 1 -name 'tussle-*.db.gz' -mmin +"$(((TUSSLE_KEEP_DAYS - 1) * 1440))" -delete

echo "$(now) TAMAM  $db; $a; $b; $c; tussle $t" >>"$LOG"
echo "TAMAM: $db; $a; $b; $c; tussle $t"
