# Diskort API sunucusu. Derleme bağlamı depo köküdür:
#   docker build -f apps/server/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY patches patches
RUN pnpm install --frozen-lockfile --filter "@diskort/server..."
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @diskort/server build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=127.0.0.1 \
    PORT=3000
# Kişisel giriş sesleri için ses dönüştürme (ffmpeg): yüklenen ses kırpılır, ses yüksekliği eşitlenir ve
# MP3'e çevrilir (bkz. src/introSounds.ts). Debian paketi; yalnızca çalışma aşamasında gerekir.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# Paket tek dosyadır; yalnızca yerel (native) modüller ayrıca kurulur: şifreleme (argon2) ve profil
# fotoğrafları için resim işleme (sharp; libvips dahil hazır derlenmiş linux-x64/arm64 glibc paketiyle
# gelir, derleme gerekmez). Sürümler apps/server/package.json ve pnpm-lock.yaml ile aynı olmalı.
RUN npm install --no-save --no-package-lock @node-rs/argon2@2.2.1 sharp@0.35.4 && npm cache clean --force
# dist: sunucu (index.js), geri bildirim aracı (feedback-cli.js), hesap yöneticisi aracı (admin-cli.js) ve
# kozmetik paketi aracı (cosmetics-cli.js; ortak parçalar chunk-*.js)
COPY --from=build /repo/apps/server/dist ./dist
VOLUME /data
CMD ["node", "--enable-source-maps", "dist/index.js"]
