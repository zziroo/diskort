import { defineConfig } from 'tsup';

export default defineConfig({
  // Diğer girişler: sunucuda geri bildirimleri okuma (dist/feedback-cli.js) ve hesap yöneticilerini
  // yönetme (dist/admin-cli.js) araçları (docker compose exec api node dist/...)
  entry: ['src/index.ts', 'src/feedback-cli.ts', 'src/admin-cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // node:sqlite yalnızca "node:" önekiyle yüklenebilir.
  removeNodeProtocol: false,
  // Tüm bağımlılıklar tek dosyaya gömülür; yalnızca yerel (native) modüller (argon2 ve resim işleme için
  // sharp) dışarıda kalır. Docker imajında bunlar ayrıca `npm i` ile kurulur (bkz. Dockerfile).
  noExternal: [/^(?!@node-rs\/argon2|sharp|@img\/|bufferutil|utf-8-validate)/],
  external: ['@node-rs/argon2', 'sharp', /^@img\//, 'bufferutil', 'utf-8-validate'],
  // Gömülen CommonJS paketlerinin require() çağrıları için
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
