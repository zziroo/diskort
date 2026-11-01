// iPhone kayıt sayfası (/udid). Sayfadaki içerik betiği CSP yüzünden ayrı dosyada (script-src 'self').
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const udid = params.get('udid');

  if (udid && /^[0-9A-Fa-f-]{25,40}$/.test(udid)) {
    $('udid-start').hidden = true;
    $('udid-done').hidden = false;
    $('udid-code').textContent = udid;
    const model = params.get('model');
    if (model) {
      $('udid-model').hidden = false;
      $('udid-model').textContent = `Model: ${model}`;
    }
    $('udid-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(udid);
        $('udid-copy').textContent = 'Kopyalandı';
      } catch {
        // Pano izni yoksa metni seçili bırak, elle kopyalansın
        const range = document.createRange();
        range.selectNodeContents($('udid-code'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    return;
  }
  // Liste doluyken adımları yinelemek işe yaramaz
  if (params.get('hata') === 'dolu') {
    $('udid-start').hidden = true;
    $('udid-full').hidden = false;
    return;
  }
  if (params.has('hata')) $('udid-error').hidden = false;

  // iPadOS kendini Mac olarak tanıtır; dokunmatik Mac yok
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  // Instagram/Facebook kendi tarayıcılarını kimliklerinde belli eder; WhatsApp/Telegram'ınki (SFSafariViewController)
  // Safari'den ayırt edilemez, onun için sayfada her zaman görünen not var
  const inApp = /Instagram|FBAN|FBAV|FB_IAB/.test(ua);
  if (inApp) $('udid-in-app').hidden = false;
  else if (!ios || otherBrowser) $('udid-not-ios').hidden = false;

  const name = $('udid-name');
  const link = $('udid-download');
  const update = () => {
    const v = name.value.trim();
    link.href = v ? `/api/udid/profile?ad=${encodeURIComponent(v)}` : '/api/udid/profile';
  };
  name.addEventListener('input', update);
  update();
})();
