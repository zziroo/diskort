// Uygulamanın resmi dağıtım adresi: indirme sayfası (/download).
// Sohbet sunucusu adresinden bağımsızdır (kullanıcı giriş ekranında başka sunucu seçse bile aynıdır).
export const DISTRIBUTION_URL = 'https://diskort.ziroo.net';
/**
 * Güncellemeler doğrudan GitHub Releases'ten gelir: masaüstü paketleri imzasız olduğundan sunucu zincirde kalsaydı,
 * sunucuyu ele geçiren otomatik güncellemeyle kurulu uygulamalara kod gönderebilirdi. 0.14.0 ve öncesi hâlâ sunucunun
 * /updates yönlendirmesini kullanır (apps/server/src/routes/updates.ts). Depo herkese açık kalmalı, adı değişmemeli.
 */
export const UPDATE_REPO = { owner: 'zziroo', repo: 'diskort' };
export const UPDATE_FEED_URL = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest/download`;
export const DOWNLOAD_PAGE_URL = `${DISTRIBUTION_URL}/download`;
