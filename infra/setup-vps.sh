#!/usr/bin/env bash
# Ubuntu 22.04/24.04 VPS için tek seferlik hazırlık: Docker kurulumu, güvenlik duvarı, UDP tamponları,
# günlük yedek zamanlayıcısı ve rastgele anahtarlı .env.
# Kullanım: sudo bash infra/setup-vps.sh
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp            # HTTPS sertifikası (Let's Encrypt)
  ufw allow 443/tcp           # API + LiveKit sinyal (WSS)
  ufw allow 7881/tcp          # WebRTC TCP yedeği
  ufw allow 3478/udp          # TURN
  ufw allow 50000:60000/udp   # WebRTC medya (ses/görüntü)
  ufw --force enable
fi

# Yayın trafiği ani UDP patlamaları üretir; varsayılan 208 KB çekirdek tamponu paket düşürebilir.
# (LiveKit bir sonraki yeniden başlatılışında büyük tamponu kullanır.)
cat > /etc/sysctl.d/60-diskort-udp.conf <<'EOF'
net.core.rmem_max = 5000000
net.core.wmem_max = 5000000
EOF
sysctl --system >/dev/null

cd "$(dirname "$0")"

# API kapsayıcısı node (1000) olarak çalışır: gizli dosyaları okur, yedek listesini panelde gösterir. API_USER'sız
# eski .env'de kapsayıcı yetkisiz root'tur ve başkasının klasörüne giremez, sahiplik göçle değişir.
if [ ! -f .env ] || grep -q '^API_USER=' .env; then
  mkdir -p secrets /var/backups/diskort
  chown -R 1000:1000 secrets
  chown 1000:1000 /var/backups/diskort
  chmod 700 secrets /var/backups/diskort
else
  echo "UYARI: .env'de API_USER yok, API root'ta kalır. Göç: docs/sunucu-kurulumu.md, Root'suz çalıştırma"
fi

# Günlük veritabanı yedeği (her gece 04:00, /var/backups/diskort, 14 gün saklanır).
# Birim dosyaları /opt/diskort yolunu varsayar.
if [ "$(pwd)" = "/opt/diskort/infra" ]; then
  cp systemd/diskort-backup.service systemd/diskort-backup.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now diskort-backup.timer
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
  sed -i "s/^LIVEKIT_API_SECRET=.*/LIVEKIT_API_SECRET=$(openssl rand -hex 32)/" .env
  echo ".env oluşturuldu. DISKORT_DOMAIN, LIVEKIT_DOMAIN ve TURN_DOMAIN değerlerini düzenle, sonra:"
  echo "  docker compose up -d --build"
fi
