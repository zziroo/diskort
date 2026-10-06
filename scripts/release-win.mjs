// Windows kurulum dosyasını derler ve GitHub'daki taslak (draft) sürüme yükler.
// electron-builder, sürüm henüz yokken dosyaları paralel yüklerken çift taslak açabildiği için
// taslak önceden oluşturulur. Kullanım: pnpm release:win   (gh CLI ile giriş yapılmış olmalı)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'zziroo/diskort';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop');
const { version } = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const tag = `v${version}`;

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const token = process.env.GH_TOKEN ?? gh('auth', 'token');

let exists = true;
try {
  gh('release', 'view', tag, '-R', REPO, '--json', 'tagName');
} catch {
  exists = false;
}
if (!exists) {
  gh('release', 'create', tag, '-R', REPO, '--draft', '--title', version, '--notes', `Diskort ${version}`);
  console.log(`Taslak sürüm oluşturuldu: ${tag}`);
}

const run = (cmd) => execFileSync(cmd, { cwd: desktopDir, stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token } });
run('pnpm exec electron-vite build');
run('pnpm exec electron-builder --win --publish always');
console.log(`\nYüklendi. Yayınlamak için GitHub'da taslağı aç: https://github.com/${REPO}/releases`);
