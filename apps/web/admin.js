// Yönetim paneli (/admin): hesap yöneticilerine sunucunun genel durumu. Özet GET /api/admin/dashboard'dan sayfa
// görünürken 5 sn'de bir gelir; ağır/ayrıntılı veriler (ses geçmişi, bağlantı teşhisi, altyapı, API, güvenlik,
// sunucular, geri bildirimler) yalnızca ilgili sekme açıkken kendi uçlarından istenir (LOADERS).
// Giriş, uygulamanın kendi giriş ucuyla (POST /api/auth/login) yapılır; jeton sessionStorage'da ("Beni hatırla"
// seçilirse localStorage'da) durur.
// CSP gereği satır içi betik ve stil yok (öğe stilleri yalnızca CSSOM ile; resimler data: adresiyle). Tüm
// metinler textContent ile yazılır: istemci hata iletileri, geri bildirim metinleri gibi dışarıdan gelen
// metinler asla HTML olarak yorumlanmaz.

const REFRESH_MS = 5_000;
const TOKEN_KEY = 'diskort-admin-token';
const TAB_KEY = 'diskort-admin-tab';
const DIAG_KEY = 'diskort-admin-diag';
const USERS_SHOWN = 15;
const DAY_MS = 86_400_000;
/** Sunucunun gün dosyalarının saat dilimi (STATS_UTC_OFFSET_MIN varsayılanı: Türkiye) */
const SERVER_DAY_OFFSET_MIN = 180;

const $ = (id) => document.getElementById(id);

// ---------- Oturum ----------

function loadToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(value, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
  } catch {
    // Depolama kapalı (gizli sekme): jeton yalnızca bu sayfa açıkken bellekte kalır
  }
}

function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // yok say
  }
}

let token = loadToken();
let timer = null;
let inflight = false;
let lastData = null;
let failures = 0;

const TABS = ['genel', 'ses', 'teshis', 'ses-gecmisi', 'makine', 'api', 'istemciler', 'guvenlik', 'sunucular', 'geri-bildirim', 'iphone', 'hatalar'];
/** Eski bağlantılar (#sunucu, #hat-testleri) yeni sekmelere */
const TAB_ALIASES = { sunucu: 'makine', 'hat-testleri': 'teshis' };

/** "Bağlantı teşhisi" sekmesinin açılış görünümü: eski #hat-testleri bağlantısı testleri açar */
function initialDiagView() {
  if (decodeURIComponent(location.hash.slice(1)) === 'hat-testleri') return 'testler';
  try {
    const saved = localStorage.getItem(DIAG_KEY);
    if (['canli', 'olaylar', 'testler', 'ayrinti'].includes(saved)) return saved;
  } catch {
    // depolama kapalı
  }
  return 'canli';
}

function initialTab() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const fromHash = TAB_ALIASES[hash] ?? hash;
  if (TABS.includes(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (TABS.includes(saved)) return saved;
  } catch {
    // depolama kapalı
  }
  return 'genel';
}

/** Yeniden çizimde korunacak arayüz durumu */
const ui = {
  tab: initialTab(),
  allUsers: false,
  openErrors: new Set(),
  incidentDays: 7,
  historyDays: 7,
  fbStatus: 'yeni',
  fbType: '',
  allEvents: false,
  lineDays: 7,
  diagView: initialDiagView(),
  /** Dakikalık ağ geçmişinde seçili gün (null: bugün) */
  minuteDay: null,
  /** Makine yükü geçmişinin aralığı: '24h' ya da '7d' */
  machineRange: '24h',
};

const VIEWS = ['adm-login', 'adm-denied', 'adm-loading', 'adm-dashboard'];

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  $('adm-session').hidden = view !== 'adm-dashboard' && view !== 'adm-loading';
  if (view !== 'adm-dashboard') closeSheet();
  if (view === 'adm-login') setTimeout(() => $('adm-login-form').elements.username.focus(), 0);
}

function logout(message) {
  clearTimeout(timer);
  stopExtra();
  token = null;
  lastData = null;
  extra.data = {};
  clearToken();
  loginError(message ?? null);
  show('adm-login');
}

function loginError(message) {
  const el = $('adm-login-error');
  el.hidden = !message;
  el.textContent = message ?? '';
}

$('adm-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  if (!username || !password) return loginError('Kullanıcı adı ve şifre gerekli.');
  const submit = $('adm-login-submit');
  submit.disabled = true;
  loginError(null);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return loginError(body?.message ?? `Giriş başarısız (${res.status}).`);
    form.elements.password.value = '';
    // Yönetici olmayanın jetonu saklanmaz
    if (!body?.user?.isAdmin) return show('adm-denied');
    token = body.token;
    saveToken(token, form.elements.remember.checked);
    show('adm-loading');
    void refresh();
  } catch {
    loginError('Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.');
  } finally {
    submit.disabled = false;
  }
});

$('adm-logout').addEventListener('click', () => logout());
$('adm-denied-logout').addEventListener('click', () => logout());

// ---------- İstekler ----------

class AccessError extends Error {}

/** Yetki hatalarını oturum ekranına çevirir; diğer hatalar atılır */
function checkAccess(res) {
  if (res.status === 401) {
    logout('Oturumun sona erdi, tekrar giriş yap.');
    throw new AccessError('401');
  }
  if (res.status === 403) {
    clearToken();
    token = null;
    stopExtra();
    show('adm-denied');
    throw new AccessError('403');
  }
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  checkAccess(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiSend(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  checkAccess(res);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? `İstek başarısız (${res.status}).`);
  return data;
}

/** Yetkiyle korunan resmi data: adresine çevirir (CSP: img-src 'self' data:) */
async function imageDataUrl(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  checkAccess(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Yenileme (5 sn'lik özet) ----------

function schedule() {
  clearTimeout(timer);
  if (token && !document.hidden) timer = setTimeout(refresh, REFRESH_MS);
}

async function refresh() {
  if (inflight || !token) return;
  clearTimeout(timer);
  inflight = true;
  try {
    const res = await fetch(`/api/admin/dashboard?tz=${new Date().getTimezoneOffset()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    checkAccess(res);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const first = !lastData;
    lastData = await res.json();
    failures = 0;
    render(lastData);
    setLive('ok', `Canlı · ${clock(lastData.generatedAt, true)}`);
    show('adm-dashboard');
    if (first) {
      setTab(ui.tab, false);
      window.scrollTo(0, 0);
    }
  } catch (err) {
    if (err instanceof AccessError) return;
    failures++;
    setLive('bad', lastData ? `Bağlantı yok · son ${clock(lastData.generatedAt, true)}` : 'Bağlantı yok');
    if (!lastData) {
      $('adm-loading-text').textContent = 'Sunucuya ulaşılamadı; yeniden deneniyor…';
      show('adm-loading');
    }
  } finally {
    inflight = false;
    if (token) schedule();
  }
}

function setLive(state, text) {
  $('adm-live').dataset.state = state;
  $('adm-live-text').textContent = text;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    stopExtra();
    clearTimeout(sheet.timer);
    if (token) setLive('paused', 'Duraklatıldı');
  } else if (token) {
    void refresh();
    loadExtra(true);
    if (sheet.reload) sheet.reload();
  }
});

// ---------- Sekmeler ve sekmeye özel veriler ----------

/**
 * Sekmeye özel veriler: yalnızca sekme açıkken ve sayfa görünürken, kendi aralığıyla istenir. `render`
 * gelen veriyle sekmenin bölümlerini çizer.
 */
const LOADERS = {
  // Bağlantı teşhisi: görünüme göre farklı uç ve aralık (bkz. loadDiag)
  teshis: { load: () => loadDiag(), every: () => DIAG_EVERY[ui.diagView], render: (x) => renderDiag(x) },
  'ses-gecmisi': {
    url: () => `/api/admin/voice-history?days=${ui.historyDays}&tz=${new Date().getTimezoneOffset()}`,
    every: 60_000,
    render: (x) => draw('adm-history', () => voiceHistory(x)),
  },
  makine: {
    load: () => loadMachine(),
    every: 10_000,
    render: (x) => {
      draw('adm-machine-history', () => machineHistory(x.history));
      draw('adm-infra', () => infra(x.infra));
      draw('adm-usage', () => usage(x.infra));
    },
  },
  api: { url: () => '/api/admin/api-stats', every: 5_000, render: (x) => draw('adm-api', () => apiHealth(x)) },
  guvenlik: { url: () => '/api/admin/security', every: 30_000, render: (x) => draw('adm-security', () => security(x)) },
  sunucular: { url: () => '/api/admin/guilds', every: 60_000, render: (x) => draw('adm-guilds', () => guilds(x)) },
  'geri-bildirim': {
    url: () => `/api/feedback?${new URLSearchParams({ ...(ui.fbStatus ? { status: ui.fbStatus } : {}), ...(ui.fbType ? { type: ui.fbType } : {}) })}`,
    every: 60_000,
    render: (x) => draw('adm-feedback-list', () => feedbackList(x)),
  },
  iphone: { url: () => '/api/admin/ios-devices', every: 20_000, render: (x) => draw('adm-iphone', () => iosDevices(x)) },
  hatalar: { url: () => '/api/admin/api-stats', every: 15_000, render: (x) => draw('adm-logs', () => serverLogs(x)) },
};

const extra = { data: {}, timer: null, seq: 0 };

function stopExtra() {
  clearTimeout(extra.timer);
  extra.timer = null;
  extra.seq++;
}

/** Açık sekmenin verisini ister (force: hemen, yoksa zamanı gelmişse) */
async function loadExtra(force = false) {
  const tab = ui.tab;
  const loader = LOADERS[tab];
  clearTimeout(extra.timer);
  if (!loader || !token || document.hidden) return;
  const seq = ++extra.seq;
  const cached = extra.data[tab];
  // Aralık sekmenin o anki görünümüne göre değişebilir (bağlantı teşhisi)
  const every = typeof loader.every === 'function' ? loader.every() : loader.every;
  if (cached && !force && Date.now() - cached.at < every) {
    extra.timer = setTimeout(() => loadExtra(true), every - (Date.now() - cached.at));
    return;
  }
  if (!cached) placeholder(tab, 'Yükleniyor…');
  try {
    const data = loader.load ? await loader.load() : await apiGet(loader.url());
    if (seq !== extra.seq || ui.tab !== tab) return;
    extra.data[tab] = { at: Date.now(), value: data };
    loader.render(data);
  } catch (err) {
    if (err instanceof AccessError || seq !== extra.seq) return;
    if (!extra.data[tab]) placeholder(tab, `Veri alınamadı (${err.message}); yeniden denenecek.`);
  }
  if (seq === extra.seq && token) extra.timer = setTimeout(() => loadExtra(true), typeof loader.every === 'function' ? loader.every() : loader.every);
}

/** Sekme verisi gelene kadar bölümlerinde kısa bir not */
function placeholder(tab, text) {
  const target = {
    teshis: ['adm-diag'],
    'ses-gecmisi': ['adm-history'],
    makine: ['adm-machine-history', 'adm-infra', 'adm-usage'],
    api: ['adm-api'],
    guvenlik: ['adm-security'],
    sunucular: ['adm-guilds'],
    'geri-bildirim': ['adm-feedback-list'],
    iphone: ['adm-iphone'],
    hatalar: ['adm-logs'],
  }[tab];
  for (const id of target ?? []) $(id).replaceChildren(h('article', 'adm-card adm-wide adm-empty', text));
}

function setTab(tab, scroll = true) {
  if (!TABS.includes(tab)) tab = 'genel';
  ui.tab = tab;
  for (const btn of $('adm-tabs').querySelectorAll('[data-tab]')) {
    const active = btn.dataset.tab === tab;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  }
  for (const id of TABS) $(id).hidden = id !== tab;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // depolama kapalı
  }
  if (location.hash !== `#${tab}`) window.history.replaceState(null, '', `#${tab}`);
  if (tab === 'teshis') drawDiagNav();
  const cached = extra.data[tab];
  if (cached) LOADERS[tab]?.render(cached.value);
  stopExtra();
  void loadExtra(!cached);
  if (scroll && $('adm-tabs').getBoundingClientRect().top < 0) $('adm-tabs').scrollIntoView({ block: 'start' });
}

$('adm-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) setTab(btn.dataset.tab);
});
$('adm-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = TABS.indexOf(ui.tab);
  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  setTab(next);
  $('adm-tabs').querySelector(`[data-tab="${next}"]`)?.focus();
});
window.addEventListener('hashchange', () => {
  const hash = decodeURIComponent(location.hash.slice(1));
  const tab = TAB_ALIASES[hash] ?? hash;
  if (hash === 'hat-testleri') setDiagView('testler');
  if (TABS.includes(tab) && tab !== ui.tab) setTab(tab);
});

/** Bölümü çizer; bir bölümdeki hata diğerlerini bozmaz */
function draw(id, fn) {
  try {
    $(id).replaceChildren(...[fn()].flat(Infinity).filter(Boolean));
  } catch (err) {
    console.error(err);
    $(id).replaceChildren(h('article', 'adm-card adm-wide adm-empty', `Bu bölüm çizilemedi: ${err.message}`));
  }
}

// ---------- Biçimlendirme ----------

const nf = new Intl.NumberFormat('tr-TR');
const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });

const num = (n) => (n === null || n === undefined ? '—' : nf.format(n));
const dec = (n, digits = 1) =>
  n === null || n === undefined ? '—' : (digits === 2 ? nf2 : digits === 0 ? nf : nf1).format(n);

/** Bayt (ondalık birimler: kota ve sağlayıcı paketleri de öyle) */
function bytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? nf.format(v) : nf1.format(v)} ${units[i]}`;
}

/** Bit/sn */
function bits(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return `${nf1.format(v / 1e9)} Gb/sn`;
  if (v >= 1e6) return `${nf1.format(v / 1e6)} Mb/sn`;
  if (v >= 1e3) return `${nf.format(Math.round(v / 1e3))} kb/sn`;
  return `${nf.format(Math.round(v))} b/sn`;
}

/** Bayt/sn → bit/sn */
const rate = (bps) => (bps === null || bps === undefined ? '—' : bits(bps * 8));

const percent = (x) => (x === null || x === undefined ? '—' : `%${nf.format(Math.round(x * 100))}`);
/** Zaten yüzde olan değer (0–100) */
const pct = (x, digits = 1) => (x === null || x === undefined ? '—' : `%${(digits === 2 ? nf2 : nf1).format(x)}`);
const msText = (x) => (x === null || x === undefined ? '—' : `${nf.format(Math.round(x))} ms`);
const perSec = (x) => (x === null || x === undefined ? '—' : `${nf1.format(x)}/sn`);

function duration(sec) {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const hh = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d} g ${hh} sa`;
  if (hh > 0) return `${hh} sa ${m} dk`;
  if (m > 0) return `${m} dk`;
  return `${s} sn`;
}

/** Dakika → "3 sa 20 dk" */
const minutes = (min) =>
  min === null || min === undefined ? '—' : min <= 0 ? '0 dk' : min < 1 ? '<1 dk' : duration(min * 60);

function clock(ms, seconds = false) {
  return new Date(ms).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

const shortDate = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
const dateTime = (ms) =>
  new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

function ago(ms, now) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'şimdi';
  if (s < 3_600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} sa önce`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} gün önce`;
  return shortDate(ms);
}

/** Sunucunun gün dosyası anahtarı (YYYY-AA-GG) */
const serverDay = (ms) => new Date(ms + SERVER_DAY_OFFSET_MIN * 60_000).toISOString().slice(0, 10);

const PLATFORM = { desktop: 'Masaüstü', android: 'Android', ios: 'iOS' };
// deepfilter: 0.9.3 öncesi istemciler (DeepFilterNet 3 kaldırıldı)
const NOISE = { dpdfnet: 'DPDFNet', deepfilter: 'DeepFilterNet', standard: 'Standart', off: 'Kapalı' };
const SEVERITY = { ok: ['İyi', 'ok'], warn: ['İdare eder', 'warn'], poor: ['Kötü', 'bad'] };

function routeText(candidate, protocol) {
  if (!candidate) return '—';
  const type = candidate === 'relay' ? 'TURN' : candidate === 'host' ? 'Doğrudan' : candidate === 'srflx' || candidate === 'prflx' ? 'NAT' : candidate;
  return protocol ? `${type} · ${protocol.toUpperCase()}` : type;
}

// ---------- DOM yardımcıları ----------

/** Öğe oluşturur; çocuklar metin (textContent olarak), öğe, dizi ya da boş (atlanır) olabilir */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (typeof props === 'string') el.className = props;
  else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Kutu: başlık, büyük değer, alt satırlar ve isteğe bağlı grafik. `wide` her zaman tüm satırı kaplar.
 * Telefonda kutular tam genişliktir; yalnızca kısa sayı kutuları (`compact`) ikişer yan yana dizilir.
 */
function card({ label, value, unit, sub, wide, compact, tone, children, cls }) {
  return h(
    'article',
    `adm-card${wide ? ' adm-wide' : ''}${compact ? ' adm-compact' : ''}${tone ? ` adm-tone-${tone}` : ''}${cls ? ` ${cls}` : ''}`,
    h('div', 'adm-label', label),
    value !== undefined && h('div', 'adm-value', value, unit && h('span', 'adm-unit', unit)),
    sub && (Array.isArray(sub) ? sub : [sub]).filter(Boolean).map((line) => h('div', 'adm-sub', line)),
    children,
  );
}

/** Başlıklı geniş kutu (listeler) */
const panel = (label, ...children) => h('article', 'adm-card adm-wide', h('div', 'adm-label', label), children);

/** Doluluk çubuğu: renk durumu taşır (normal → uyarı → tehlike) */
function meter(fraction, label) {
  const f = Math.max(0, Math.min(1, fraction ?? 0));
  const bar = h('span');
  bar.style.width = `${(f * 100).toFixed(1)}%`;
  const state = f >= 0.95 ? 'danger' : f >= 0.8 ? 'warn' : 'ok';
  return h('div', { class: `adm-meter adm-meter-${state}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(f * 100) }, bar);
}

/**
 * Küçük çizgi grafik. points: [{ at, v }] (v null ise çizgide boşluk). Fareyle ya da dokunarak üzerine
 * gelinen ölçümün saati ve değeri gösterilir. `axis`: altta başlangıç ve bitiş saati. `marks`: vurgulanacak
 * zaman aralıkları ([{ from, to }], ör. kesinti saniyeleri): grafiğin arkasına dikey bant olarak çizilir.
 * `peak`: aynı anlara ait en yüksek değerler ([{ at, v }]): soluk kesikli çizgi, ipucunda "en çok".
 * `span`: [başlangıç, bitiş] zaman ekseni (verisi olmayan baş ve son da görünür); `ticks`: eksen yazıları.
 */
function sparkline(points, { max, format, color = 'brand', label, axis = false, seconds = true, marks = [], peak = null, span = null, ticks = null }) {
  const W = 300;
  const H = 60;
  const wrap = h('div', `adm-spark adm-c-${color}`);
  const valid = points.filter((p) => p.v !== null && p.v !== undefined);
  if (points.length < 2 || valid.length === 0) {
    append(wrap, [h('div', 'adm-spark-empty', points.length === 0 ? 'Veri yok' : 'Ölçülüyor…')]);
    return wrap;
  }
  const from = span ? span[0] : points[0].at;
  const to = span ? span[1] : points[points.length - 1].at;
  const peakValid = (peak ?? []).filter((p) => p.v !== null && p.v !== undefined);
  const peakAt = new Map(peakValid.map((p) => [p.at, p.v]));
  const top = Math.max(max ?? 0, ...valid.map((p) => p.v), ...peakValid.map((p) => p.v)) || 1;
  const x = (t) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (v) => H - 2 - (Math.min(v, top) / top) * (H - 6);
  // null değer çizgide boşluk bırakır
  const paths = (list) => {
    let line = '';
    let area = '';
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      const d = run.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
      line += run.length === 1 ? `${d}h0.5` : d;
      area += `${d}L${run[run.length - 1][0].toFixed(1)},${H}L${run[0][0].toFixed(1)},${H}Z`;
      run = [];
    };
    for (const p of list) {
      if (p.v === null || p.v === undefined) flush();
      else run.push([x(p.at), y(p.v)]);
    }
    flush();
    return { line, area };
  };
  const { line, area } = paths(points);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  for (const m of marks) {
    if (m.to < from || m.from > to) continue;
    const x0 = x(Math.max(from, m.from));
    chart.append(svg('rect', { x: x0.toFixed(1), y: 0, width: Math.max(1.5, x(Math.min(to, m.to)) - x0).toFixed(1), height: H, class: 'adm-spark-mark' }));
  }
  chart.append(svg('path', { d: area, class: 'adm-spark-area' }));
  if (peak) chart.append(svg('path', { d: paths(peak).line, class: 'adm-spark-peak', 'vector-effect': 'non-scaling-stroke' }));
  chart.append(svg('path', { d: line, class: 'adm-spark-line', 'vector-effect': 'non-scaling-stroke' }));
  const cursor = h('div', 'adm-spark-cursor');
  const dot = h('div', 'adm-spark-dot');
  const tip = h('div', 'adm-spark-tip');
  cursor.hidden = dot.hidden = tip.hidden = true;
  const move = (e) => {
    const rect = wrap.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left) / rect.width) * (to - from);
    let best = null;
    for (const p of valid) if (!best || Math.abs(p.at - t) < Math.abs(best.at - t)) best = p;
    if (!best) return;
    const left = (x(best.at) / W) * 100;
    cursor.style.left = dot.style.left = `${left}%`;
    dot.style.top = `${(y(best.v) / H) * 100}%`;
    const most = peakAt.get(best.at);
    tip.textContent = `${to - from > 86_400_000 ? dateTime(best.at) : clock(best.at, seconds)} · ${format(best.v)}${most !== undefined ? ` · en çok ${format(most)}` : ''}`;
    tip.style.left = `${left}%`;
    tip.dataset.side = left > 60 ? 'left' : 'right';
    cursor.hidden = dot.hidden = tip.hidden = false;
  };
  const leave = (e) => {
    // Dokunmatikte parmak kalkınca da "ayrıldı" gelir: değer bir sonraki yenilemeye kadar görünür kalsın
    if (e.pointerType === 'touch') return;
    cursor.hidden = dot.hidden = tip.hidden = true;
  };
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerdown', move);
  wrap.addEventListener('pointerleave', leave);
  append(wrap, [chart, cursor, dot, tip]);
  if (!axis) return wrap;
  return h('div', null, wrap, h('div', 'adm-axis', (ticks ?? [clock(from), clock(to)]).map((t) => h('span', null, t))));
}

const series = (list, key) => list.map((s) => ({ at: s.at, v: s[key] ?? null }));

/** Seçim düğmeleri (ör. 7 / 30 / 90 gün) */
function chips(options, current, onPick, label) {
  return h(
    'div',
    { class: 'adm-chips', role: 'group', 'aria-label': label },
    options.map(([value, text]) =>
      h('button', { type: 'button', class: 'adm-chip', 'aria-pressed': String(value === current), on: { click: () => onPick(value) } }, text),
    ),
  );
}

/** Anahtar-değer satırı */
const kv = (name, value, tone) => h('div', `adm-kv${tone ? ` adm-kv-${tone}` : ''}`, h('span', null, name), h('b', null, value));

function avatar(user, size = 32) {
  const el = h('span', 'adm-avatar');
  el.style.width = el.style.height = `${size}px`;
  if (user?.avatarUrl) {
    append(el, [h('img', { src: user.avatarUrl, alt: '', width: size, height: size, loading: 'lazy' })]);
  } else {
    el.style.background = user?.avatarColor ?? '#5865f2';
    el.textContent = (user?.displayName ?? '?').trim().charAt(0).toLocaleUpperCase('tr') || '?';
  }
  return el;
}

const badge = (text, tone) => h('span', `adm-badge${tone ? ` adm-badge-${tone}` : ''}`, text);
const userName = (u, fallback = 'Silinmiş kullanıcı') => u?.displayName ?? fallback;

/** Satır içi kişi: avatar + ad + @kullanıcı adı */
function person(u, size = 24) {
  return h('span', 'adm-person', avatar(u, size), h('span', null, userName(u)), u && h('span', 'adm-muted', ` @${u.username}`));
}

// ---------- 5 sn'lik özetten çizilen bölümler ----------

function render(d) {
  const now = d.generatedAt;
  draw('adm-overview', () => overview(d, now));
  draw('adm-voice', () => voice(d, now));
  draw('adm-quality', () => quality(d, now));
  draw('adm-system', () => system(d, now));
  draw('adm-clients', () => clients(d, now));
  draw('adm-errors', () => errors(d, now));
  draw('adm-feedback', () => feedbackSummary(d));
  const fb = $('adm-fb-count');
  fb.hidden = !(d.feedback.counts.yeni > 0);
  fb.textContent = num(d.feedback.counts.yeni);
  const errCount = d.errors.client.last24h + d.errors.server.last24h;
  $('adm-err-count').hidden = errCount === 0;
  $('adm-err-count').textContent = num(errCount);
  $('adm-foot').textContent =
    `Son güncelleme ${clock(now, true)} · özet 5 saniyede bir, açık sekmenin ayrıntıları kendi aralığıyla yenilenir. ` +
    `Kısa grafikler sunucu belleğinde tutulur (${dateTime(d.errors.since)} tarihinden beri); hata kayıtları yeniden başlatmada korunur (son 200, 14 gün).`;
}

function overview(d, now) {
  const o = d.overview;
  const m = o.messages;
  const trackedDays = (now - o.activitySince) / 86_400_000;
  const maxDay = Math.max(1, ...m.perDay.map((p) => p.count));
  const caption = h('div', 'adm-sub adm-bars-caption', `Son ${m.perDay.length} gün`);
  const bars = h(
    'div',
    { class: 'adm-bars', role: 'img', 'aria-label': `Son ${m.perDay.length} günün günlük mesaj sayıları` },
    m.perDay.map((p, i) => {
      const bar = h('span', {
        class: `adm-bar${p.count === 0 ? ' adm-bar-zero' : ''}${i === m.perDay.length - 1 ? ' adm-bar-today' : ''}`,
        title: `${shortDate(p.day)}: ${num(p.count)} mesaj`,
      });
      bar.style.height = `${Math.max(3, (p.count / maxDay) * 100)}%`;
      const label = `${i === m.perDay.length - 1 ? 'Bugün' : shortDate(p.day)}: ${num(p.count)} mesaj`;
      const showDay = () => (caption.textContent = label);
      bar.addEventListener('pointerenter', showDay);
      bar.addEventListener('pointerdown', showDay);
      bar.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch') caption.textContent = `Son ${m.perDay.length} gün`;
      });
      return bar;
    }),
  );
  const s = o.storage;
  const hl = d.health;
  return [
    card({
      label: 'Hesaplar',
      value: num(o.users),
      compact: true,
      sub: [
        `${num(o.admins)} yönetici · ${num(o.guilds)} sunucu`,
        `${num(o.channels.text + o.channels.voice)} kanal · ${num(o.channels.dm)} DM`,
      ],
    }),
    card({
      label: 'Şu an bağlı',
      value: num(o.online),
      unit: 'kişi',
      sub: `${num(o.sessions)} açık bağlantı`,
      children: sparkline(series(d.system.history, 'online'), {
        format: (v) => `${num(v)} kişi`,
        label: 'Bağlı kişi sayısı, son dakikalar',
        max: 1,
      }),
    }),
    card({
      label: 'Etkin hesaplar',
      value: num(o.active24h),
      unit: 'son 24 saat',
      compact: true,
      sub: [
        `Son 7 günde ${num(o.active7d)}`,
        // Bağlantı takibi yeni başladıysa öncesi yalnızca mesaj yazanlardan bilinir
        trackedDays < 7 && `Bağlantı takibi ${shortDate(o.activitySince)} tarihinden beri`,
      ],
    }),
    hl &&
      card({
        label: 'API (son 1 saat)',
        value: num(hl.requestsLastHour),
        unit: 'istek',
        compact: true,
        tone: hl.errors5xxLastHour > 0 ? 'bad' : hl.limitedLastHour > 0 ? 'warn' : undefined,
        sub: [`${num(hl.errors5xxLastHour)} sunucu hatası · ${num(hl.limitedLastHour)} sınır aşımı`, `${num(hl.openSockets)} açık WebSocket`],
      }),
    card({
      label: 'Depolama',
      value: bytes(s.database + s.attachments + (s.avatars ?? 0) + (s.feedback ?? 0) + (s.linkPreviews ?? 0)),
      children: h(
        'div',
        'adm-kvs',
        kv('Veritabanı', bytes(s.database)),
        kv(`Dosya ekleri (${num(s.attachmentCount)})`, bytes(s.attachments)),
        kv('Profil ve sunucu resimleri', bytes(s.avatars)),
        kv('Geri bildirim görüntüleri', bytes(s.feedback)),
        kv('Bağlantı önizlemeleri', bytes(s.linkPreviews)),
      ),
    }),
    card({
      label: 'Mesajlar',
      value: num(m.today),
      unit: 'bugün',
      wide: true,
      sub: `Son 24 saatte ${num(m.last24h)} · son 7 günde ${num(m.last7d)} · toplam ${num(m.total)}`,
      children: [bars, caption],
    }),
  ];
}

function trackText(t) {
  const codec = t.mimeType ? t.mimeType.split('/')[1] : '';
  if (t.kind === 'video') return `${t.width && t.height ? `${t.width}×${t.height} ` : ''}${codec}`.trim();
  return codec;
}

/** Kişinin ses kalitesi özeti (varsa) */
const qualityOf = (d, userId) => (d.voice.quality ?? []).find((q) => q.userId === userId) ?? null;

function voice(d, now) {
  const v = d.voice;
  const lk = v.livekit;
  const mismatch = lk.ok && lk.participants !== v.participants;
  const mx = v.metrics;
  const cards = [
    card({
      label: 'Seste',
      value: num(v.participants),
      unit: 'kişi',
      sub: `${num(v.channels.length)} kanalda`,
      children: sparkline(series(d.system.history, 'voice'), {
        format: (x) => `${num(x)} kişi`,
        label: 'Sesteki kişi sayısı, son dakikalar',
        max: 1,
      }),
    }),
    card({ label: 'Yayında', value: num(v.streams), unit: 'ekran paylaşımı', compact: true }),
    card({
      label: 'LiveKit',
      value: lk.ok ? 'Çalışıyor' : 'Ulaşılamıyor',
      compact: true,
      tone: lk.ok ? (mismatch ? 'warn' : 'ok') : 'bad',
      sub: lk.ok
        ? [
            `${num(lk.rooms)} oda · ${num(lk.participants)} kişi · ${num(lk.tracks)} iz`,
            `Yanıt ${num(lk.latencyMs ?? 0)} ms`,
            // Ses durumu LiveKit'le 30 sn'de bir eşitlenir
            mismatch && `Uygulamadaki ses listesiyle uyuşmuyor (${num(v.participants)} kişi)`,
          ]
        : lk.error,
    }),
    mx &&
      card({
        label: 'LiveKit trafiği',
        value: mx.ok && mx.latest ? rate((mx.latest.bytesIn ?? 0) + (mx.latest.bytesOut ?? 0)) : 'Ölçüm yok',
        compact: true,
        tone: mx.ok && (mx.latest?.lossInPct ?? 0) >= 3 ? 'warn' : undefined,
        sub:
          mx.ok && mx.latest
            ? [`↓ ${rate(mx.latest.bytesIn)} · ↑ ${rate(mx.latest.bytesOut)}`, `Kayıp ${pct(mx.latest.lossInPct, 2)} · RTT ${msText(mx.latest.rttMs)}`]
            : ['Metrikler kapalı (Bağlantı teşhisi > Ayrıntı)'],
      }),
  ];
  if (v.channels.length === 0) {
    cards.push(h('article', 'adm-card adm-wide adm-empty', 'Şu an seste kimse yok.'));
    return cards;
  }
  for (const c of v.channels) {
    cards.push(
      h(
        'article',
        'adm-card adm-wide',
        h(
          'div',
          'adm-channel-head',
          h('span', 'adm-channel-name', `🔊 ${c.name}`),
          c.guildName && h('span', 'adm-muted', c.guildName),
          h('span', 'adm-muted adm-push', `${num(c.participants.length)} kişi`),
          // Özel arama (DM): kimliksiz gösterilir, yönetici olay kaydı isteyemez
          !c.private && traceRequestButton(c.channelId),
        ),
        h(
          'ul',
          'adm-rows',
          c.participants.map((p) => {
            const name = p.user?.displayName ?? (c.private ? 'Gizli katılımcı' : 'Silinmiş kullanıcı');
            const screen = p.tracks?.find((t) => t.source === 'screen');
            const mic = p.tracks?.find((t) => t.source === 'microphone');
            const q = qualityOf(d, p.userId);
            return h(
              'li',
              { class: 'adm-row adm-clickable', tabindex: 0, role: 'button', on: rowOpen(() => openTelemetry(p.userId, p.user)) },
              avatar(p.user),
              h(
                'div',
                'adm-row-main',
                h('div', 'adm-row-title', name, p.user && h('span', 'adm-muted', ` @${p.user.username}`)),
                h(
                  'div',
                  'adm-badges',
                  q && badge(`${SEVERITY[q.severity][0]} · ${msText(q.rttAvg)}`, SEVERITY[q.severity][1]),
                  badge(`${duration((now - p.joinedAt) / 1000)} seste`),
                  p.platforms.map((pl) => badge(PLATFORM[pl] ?? pl)),
                  p.streaming &&
                    badge(
                      `Yayında${p.streamStartedAt ? ` · ${duration((now - p.streamStartedAt) / 1000)}` : ''}${screen ? ` · ${trackText(screen)}` : ''}`,
                      'live',
                    ),
                  p.selfMute && badge('Mikrofon kapalı', 'muted'),
                  p.selfDeaf && badge('Sağırlaştırılmış', 'muted'),
                  p.serverMute && badge('Sunucuda susturuldu', 'warn'),
                  p.serverDeaf && badge('Sunucuda sağırlaştırıldı', 'warn'),
                  mic && !p.selfMute && badge(`Mikrofon ${mic.muted ? 'sessiz' : 'açık'}${trackText(mic) ? ` · ${trackText(mic)}` : ''}`),
                  p.tracks && p.tracks.length === 0 && badge('LiveKit: iz yok', 'muted'),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
  return cards;
}

/** Tıklanabilir satır: fare ve klavye (Enter / boşluk) */
function rowOpen(fn) {
  return {
    click: fn,
    keydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  };
}

/** Ölçüm hücresi (ad + değer), kötü değer renklidir */
const metric = (name, value, tone) => h('div', `adm-metric${tone ? ` adm-metric-${tone}` : ''}`, h('span', null, name), h('b', null, value));
const toneOf = (v, warn, bad) => (v === null || v === undefined ? undefined : v >= bad ? 'bad' : v >= warn ? 'warn' : undefined);

function micText(mic) {
  if (!mic) return '—';
  let name = NOISE[mic.noise] ?? mic.noise;
  // Masaüstü: seçili model düştüyse gerçekte çalışan (ör. "DPDFNet → Standart")
  if (mic.fallback) name += ` → ${NOISE[mic.fallback.to] ?? mic.fallback.to}`;
  const load = mic.load !== null && mic.load !== undefined ? ` · %${nf.format(Math.round(mic.load * 100))} yük` : '';
  return `${mic.muted ? 'Kapalı · ' : ''}${name}${load}`;
}

/** Konuşma seviyesi (dBFS medyanı; kazanç öncesi → gönderilen) ve gerçekte çalışan otomatik kazanç */
function speechText(mic) {
  if (!mic) return null;
  const has = (v) => v !== null && v !== undefined;
  const pre = has(mic.speechRmsDb) ? dec(mic.speechRmsDb, 1) : null;
  const out = has(mic.speechRmsDbOut) ? dec(mic.speechRmsDbOut, 1) : null;
  const agc =
    mic.digitalAgc === true ? 'yazılımsal kazanç' : mic.effectiveAgc === true ? 'tarayıcı kazancı' : mic.effectiveAgc === false ? 'kazanç yok' : '';
  if (!pre && !out && !agc) return null;
  const level = pre && out && pre !== out ? `${pre} → ${out} dBFS` : pre || out ? `${out ?? pre} dBFS` : '';
  const p90 = has(mic.speechRmsDbOutP90) ? `p90 ${dec(mic.speechRmsDbOutP90, 1)}` : '';
  return [level, p90, agc].filter(Boolean).join(' · ');
}
/** Gönderilen konuşma seviyesi çok kısık ya da çok yüksekse uyarı */
const speechTone = (mic) => {
  const v = mic?.speechRmsDbOut ?? mic?.speechRmsDb;
  return v === null || v === undefined ? undefined : v < -35 || v > -10 ? 'warn' : undefined;
};

function screenText(s) {
  if (!s) return null;
  const size = s.width && s.height ? `${s.width}×${s.height}` : '';
  const encode = s.encodeMs !== null && s.encodeMs !== undefined ? `${dec(s.encodeMs)} ms/kare` : '';
  return [size, s.fps !== null ? `${dec(s.fps)} fps` : '', bits(s.bitrate), s.encoder ?? '', encode].filter(Boolean).join(' · ');
}

/** İzlenen yayın: kodek, çözücü (donanım/yazılım), çözünürlük, çözme süresi */
function watchText(w) {
  if (!w) return null;
  const kind = w.hardware === true ? 'Donanım' : w.hardware === false ? 'Yazılım' : 'Bilinmiyor';
  const codec = w.codec ? (w.codec.split('/')[1] ?? w.codec) : '';
  const size = w.width && w.height ? `${w.width}×${w.height}${w.fps !== null ? `@${dec(w.fps, 0)}` : ''}` : '';
  const decode = w.decodeMs !== null ? `${dec(w.decodeMs)} ms/kare${w.decodeMsMax !== null ? ` (en çok ${dec(w.decodeMsMax)})` : ''}` : '';
  const view = w.view ? (w.view.mode === 'fullscreen' ? 'tam ekran' : 'küçük') : '';
  return [codec, `${kind}${w.decoder ? ` (${w.decoder})` : ''}`, size, decode, bits(w.bitrate), w.framesDropped ? `${num(w.framesDropped)} atılan` : '', view]
    .filter(Boolean)
    .join(' · ');
}

/** Gelen sesler: kaç kişi, ses kaybı, gizleme olayı, titreşim (en çok), tampon, bit hızı */
function audioInText(a) {
  if (!a) return null;
  return [
    `${num(a.streams)} ses`,
    `kayıp ${pct(a.lossPct, 2)}`,
    a.concealEvents !== null ? `${num(a.concealEvents)} gizleme` : '',
    a.jitterMaxMs !== null ? `titreşim en çok ${msText(a.jitterMaxMs)}` : '',
    a.jitterBufferMs !== null ? `tampon ${msText(a.jitterBufferMs)}` : '',
    bits(a.bitrate),
  ]
    .filter(Boolean)
    .join(' · ');
}

const lagText = (l) => (l ? `en çok ${msText(l.maxMs)} · p95 ${msText(l.p95Ms)}${l.stalls ? ` · ${num(l.stalls)} takılma` : ''}` : null);

/** Sesi bozabilecek ayarlar: kapalı yankı/kazanç, ses algılama, gürültü, seviyeler */
function settingsText(s) {
  if (!s) return null;
  const onOff = (v) => (v === true ? 'açık' : v === false ? 'kapalı' : '?');
  const vad = s.voiceActivity === false ? 'kapalı' : s.vadAuto ? 'otomatik' : s.vadThresholdDb !== null && s.vadThresholdDb !== undefined ? `${s.vadThresholdDb} dB` : '?';
  return [
    `yankı ${onOff(s.echoCancellation)}`,
    `kazanç ${onOff(s.autoGainControl)}`,
    s.inputMode === 'ptt' ? 'bas-konuş' : `algılama ${vad}`,
    s.noiseMode ? `gürültü ${s.noiseMode}${s.noiseStrengthDb ? ` ${s.noiseStrengthDb} dB` : ''}` : '',
    s.speaker === true ? 'hoparlör' : s.speaker === false ? 'ahize' : '',
    s.userVolumesChanged ? `${num(s.userVolumesChanged)} kişi seviyesi değişik (en çok ${percent(s.userVolumeMax)})` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Yazılım çözücü yalnızca telefonda uyarı (ısınma ve pil); masaüstünde olağan */
const watchTone = (e) => (e.watch?.hardware === false && (e.platform === 'android' || e.platform === 'ios') ? 'warn' : undefined);

const LIMIT = { cpu: 'işlemci', bandwidth: 'bant genişliği', other: 'diğer' };

/** Kişi başına ölçüm hücreleri (canlı tablo ve ayrıntı sayfası) */
function metricsOf(q) {
  return h(
    'div',
    'adm-metrics',
    metric('Ping', q.rttMax !== null && q.rttMax !== q.rttAvg ? `${msText(q.rttAvg)} (en çok ${nf.format(q.rttMax)})` : msText(q.rttAvg), toneOf(q.rttAvg, 120, 250)),
    metric('Titreşim', msText(q.jitterIn), toneOf(q.jitterIn, 30, 60)),
    metric('Kayıp ↑ / ↓', `${pct(q.lossOut, 1)} / ${pct(q.lossIn, 1)}`, toneOf(Math.max(q.lossOut ?? 0, q.lossIn ?? 0), 3, 10)),
    metric('Ses kesilmesi', pct(q.concealed, 2), toneOf(q.concealed, 3, 8)),
    metric('Bit hızı ↑ / ↓', `${bits(q.bitrateOut)} / ${bits(q.bitrateIn)}`),
    metric('Bağlantı yolu', routeText(q.candidate, q.protocol), q.candidate === 'relay' ? 'warn' : undefined),
    metric('Mikrofon', micText(q.mic), toneOf(q.mic?.load, 0.6, 0.8)),
    speechText(q.mic) && metric('Konuşma seviyesi', speechText(q.mic), speechTone(q.mic)),
    q.screen && metric('Yayın', screenText(q.screen)),
    q.screen &&
      q.screen.limitation !== 'none' &&
      metric('Yayın kısıtı', `${LIMIT[q.screen.limitation] ?? q.screen.limitation} · ${percent(q.screen.limitedRatio)}`, toneOf(q.screen.limitedRatio, 0.3, 0.5)),
    q.watch && metric('İzlenen yayın', watchText(q.watch), watchTone(q)),
    q.audioIn && metric('Gelen sesler', audioInText(q.audioIn), toneOf(q.audioIn.lossPct, 3, 10)),
    q.jsLag && metric('Uygulama takılması', lagText(q.jsLag), toneOf(q.jsLag.maxMs, 250, 1000)),
    q.settings && metric('Ses ayarları', settingsText(q.settings)),
    q.reconnects > 0 && metric('Yeniden bağlanma', num(q.reconnects), 'bad'),
    metric('Cihaz', `${PLATFORM[q.platform] ?? q.platform} ${q.version}`),
  );
}

function quality(d, now) {
  const list = [...(d.voice.quality ?? [])];
  const users = new Map();
  for (const c of d.voice.channels) for (const p of c.participants) users.set(p.userId, p.user);
  for (const u of d.clients.users) if (!users.has(u.user.id)) users.set(u.user.id, u.user);
  const rank = { poor: 0, warn: 1, ok: 2 };
  list.sort((a, b) => rank[a.severity] - rank[b.severity] || (users.get(a.userId)?.displayName ?? '').localeCompare(users.get(b.userId)?.displayName ?? '', 'tr'));
  const counts = { ok: 0, warn: 0, poor: 0 };
  for (const q of list) counts[q.severity]++;
  if (list.length === 0) {
    return [
      h(
        'article',
        'adm-card adm-wide adm-empty',
        'Şu an ölçüm gönderen yok. İstemciler (0.7.0 ve sonrası) sesliyken 30 saniyede bir, bağlantı kötüleşince hemen kısa bir özet gönderir.',
      ),
    ];
  }
  const inVoice = new Set(d.voice.channels.flatMap((c) => c.participants.map((p) => p.userId)));
  return [
    h(
      'article',
      `adm-card adm-wide${counts.poor ? ' adm-tone-bad' : counts.warn ? ' adm-tone-warn' : ''}`,
      h('div', 'adm-label', 'Ölçüm gönderenler (son 90 sn)'),
      h(
        'div',
        'adm-stats',
        [
          ['ok', 'İyi'],
          ['warn', 'İdare eder'],
          ['poor', 'Kötü'],
        ].map(([key, label]) => h('div', `adm-stat adm-stat-${key}`, h('b', null, num(counts[key])), h('span', null, label))),
      ),
    ),
    panel(
      'Kişi başına son ölçüm',
      h(
        'ul',
        'adm-rows',
        list.map((q) => {
          const u = users.get(q.userId) ?? null;
          const [label, tone] = SEVERITY[q.severity];
          return h(
            'li',
            { class: 'adm-qrow adm-clickable', tabindex: 0, role: 'button', on: rowOpen(() => openTelemetry(q.userId, u)) },
            h(
              'div',
              'adm-qhead',
              avatar(u, 28),
              h('div', 'adm-row-title', userName(u), u && h('span', 'adm-muted', ` @${u.username}`), badge(label, tone), !inVoice.has(q.userId) && badge('seste değil', 'muted')),
              h('span', 'adm-muted adm-push adm-nowrap', ago(q.at, now)),
            ),
            q.causes.length > 0 && h('div', 'adm-sub', q.causes.join(' · ')),
            metricsOf(q),
          );
        }),
      ),
      h('div', 'adm-sub adm-note', 'Ayrıntı ve son bir saatin grafikleri için kişiye dokun.'),
    ),
  ];
}

function incidentRow(i, x, now) {
  const u = x.users[i.userId] ?? null;
  const channel = i.channelId ? x.channels[i.channelId]?.name : null;
  // Bağlantı yolu ayrı rozette gösterilir
  const [main, ...rest] = i.causes.filter((c) => !c.cause.startsWith('TURN aktarıcısı'));
  const w = i.worst;
  return h(
    'li',
    {
      class: 'adm-row adm-row-top adm-clickable',
      tabindex: 0,
      role: 'button',
      on: rowOpen(() => openTelemetry(i.userId, u, now - i.end > 3_600_000 ? serverDay(i.start) : null)),
    },
    avatar(u, 28),
    h(
      'div',
      'adm-row-main',
      h('div', 'adm-row-title', userName(u), i.open && badge('sürüyor', 'live')),
      h('div', 'adm-sub', `${dateTime(i.start)} – ${clock(i.end)} · ${duration((i.end - i.start) / 1000)}${channel ? ` · 🔊 ${channel}` : ''}`),
      h(
        'div',
        'adm-badges',
        main && badge(main.cause, 'warn'),
        rest.slice(0, 3).map((c) => badge(c.cause)),
        w.rttMs !== null && badge(`ping ${nf.format(w.rttMs)} ms`),
        w.lossOutPct ? badge(`kayıp ↑ ${pct(w.lossOutPct)}`) : null,
        w.lossInPct ? badge(`kayıp ↓ ${pct(w.lossInPct)}`) : null,
        w.concealedPct ? badge(`kesilme ${pct(w.concealedPct)}`) : null,
        badge(`${PLATFORM[i.platform] ?? i.platform} ${i.version}`, 'muted'),
        i.candidate && badge(routeText(i.candidate, i.protocol), i.candidate === 'relay' ? 'warn' : 'muted'),
      ),
    ),
  );
}

// ---------- Bağlantı teşhisi: canlı durum, olaylar, testler, ayrıntı ----------
// Tek sekme, dört görünüm. Veriler: /api/admin/net/* (saniyelik ağ kaydı, sondalar, kesintiler, dakikalık özet),
// /api/admin/telemetry/incidents (olaylar), /api/admin/line-tests (testler), /api/admin/infra (LiveKit ayrıntısı).

const DIAG_VIEWS = ['canli', 'olaylar', 'testler', 'ayrinti'];
const DIAG_LABEL = { canli: 'Canlı durum', olaylar: 'Olaylar', testler: 'Testler', ayrinti: 'Ayrıntı' };
/** Görünümün yenilenme aralığı (ms) */
const DIAG_EVERY = { canli: 2_000, olaylar: 30_000, testler: 10_000, ayrinti: 10_000 };
/** aday: yalnızca NIC sessizliği, dış sondalarla doğrulanmamış (tek başına kesinti sayılmaz) */
const OUTAGE_KIND = { tam: ['tam kesinti', 'bad'], sonda: ['yalnız sonda', 'warn'], aday: ['aday (yalnız NIC)', 'muted'] };
const confirmedOutages = (list) => (list ?? []).filter((o) => o.kind !== 'aday');
const LIVE_WINDOW_MS = 300_000;
/** Her yoklamada son bu kadar saniye yeniden istenir (sonda sonuçları ve kesinti işaretleri satıra sonradan işlenir) */
const LIVE_OVERLAP_MS = 15_000;

/** Canlı görünümün biriken verisi (yoklamalar arasında korunur) */
const live = { rows: [], lk: [] };

function setDiagView(view) {
  if (!DIAG_VIEWS.includes(view) || view === ui.diagView) return;
  ui.diagView = view;
  try {
    localStorage.setItem(DIAG_KEY, view);
  } catch {
    // depolama kapalı
  }
  delete extra.data.teshis;
  stopExtra();
  drawDiagNav();
  placeholder('teshis', 'Yükleniyor…');
  void loadExtra(true);
}

function drawDiagNav() {
  $('adm-diag-nav').replaceChildren(
    chips(
      DIAG_VIEWS.map((v) => [v, DIAG_LABEL[v]]),
      ui.diagView,
      setDiagView,
      'Bağlantı teşhisi görünümü',
    ),
  );
}

async function loadDiag() {
  const view = ui.diagView;
  if (view === 'canli') return { view, data: await loadLive() };
  if (view === 'olaylar') return { view, data: await apiGet(`/api/admin/telemetry/incidents?days=${ui.incidentDays}`) };
  if (view === 'testler') return { view, data: await apiGet(`/api/admin/line-tests?days=${ui.lineDays}`) };
  const [infraData, minutes] = await Promise.all([
    apiGet('/api/admin/infra'),
    apiGet(`/api/admin/net/minutes${ui.minuteDay ? `?day=${ui.minuteDay}` : ''}`),
  ]);
  return { view, data: { infra: infraData, minutes } };
}

function renderDiag(x) {
  drawDiagNav();
  // Görünüm değiştiyse eski verinin çizimi atlanır (yenisi yolda)
  if (x.view !== ui.diagView) return;
  const view = { canli: liveView, olaylar: eventsView, testler: lineTests, ayrinti: detailView }[x.view];
  draw('adm-diag', () => view(x.data));
}

const secs1 = (ms) => nf1.format(ms / 1000);
const dateTimeSec = (ms) =>
  new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mbpsText = (v) => (v === null || v === undefined ? '—' : `${nf1.format(v)} Mbps`);
const ppsText = (v) => (v === null || v === undefined ? '—' : `${nf.format(Math.round(v))} pk/sn`);
/** Dış hedeflerin (ağ geçidi hariç) bir saniyedeki sonda sonuçları */
const externalProbes = (r) =>
  Object.entries(r.p ?? {})
    .filter(([k]) => k !== 'ağ geçidi')
    .map(([, v]) => v);

/** Panoya kopyalama düğmesi */
function copyButton(text, label = 'Kopyala') {
  const btn = h('button', { type: 'button', class: 'adm-more' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      btn.textContent = 'Kopyalandı';
    } catch {
      btn.textContent = 'Kopyalanamadı (metni seçip kopyala)';
    }
    setTimeout(() => (btn.textContent = label), 2_000);
  });
  return btn;
}

/** Kesintilerden grafik işaretleri ({ from, to }) */
const outageMarks = (outages) => (outages ?? []).map((o) => ({ from: o.at, to: o.at + Math.max(o.durationMs, 1_000) }));

/** Başlıklı küçük grafik kutusu; veri yoksa null */
function chartBox(label, pts, format, opts = {}) {
  if (!pts.some((p) => p.v !== null && p.v !== undefined)) return null;
  const last = pts.findLast((p) => p.v !== null && p.v !== undefined)?.v;
  return h(
    'div',
    'adm-card adm-chart',
    h('div', 'adm-net-head', h('span', 'adm-muted', label), h('b', null, format(last))),
    sparkline(pts, { format, label, axis: true, ...opts }),
  );
}

/** Saniyelik sunucu satırlarının grafikleri (paket hızları ve kesinti işaretleriyle) */
function serverCharts(rows, marks) {
  const chart = (label, pick, format, opts = {}) =>
    chartBox(
      label,
      rows.map((r) => ({ at: r.t, v: pick(r) })),
      format,
      { marks, ...opts },
    );
  const probeLost = (r) => {
    const v = externalProbes(r);
    return v.length === 0 ? null : (v.filter((n) => n < 0).length / v.length) * 100;
  };
  const probeRtt = (r) => {
    const v = externalProbes(r).filter((n) => n >= 0);
    return v.length === 0 ? null : Math.max(...v);
  };
  return h(
    'div',
    'adm-chart-grid',
    chart('Sunucuya gelen paket (NIC)', (r) => r.rxp, ppsText, { color: 'ok' }),
    chart('Sunucudan giden paket (NIC)', (r) => r.txp, ppsText),
    chart('Sunucuya gelen (NIC)', (r) => r.rx, mbpsText, { color: 'ok' }),
    chart('Sunucudan giden (NIC)', (r) => r.tx, mbpsText),
    chart('Dış sonda kaybı (saniye başına)', probeLost, (v) => pct(v, 0), { max: 100, color: 'pink' }),
    chart('Dış sonda gecikmesi (en yüksek)', probeRtt, msText, { max: 100 }),
    chart('NIC düşen/hatalı paket', (r) => r.nd, (v) => `${num(v)} paket`, { max: 5, color: 'pink' }),
    chart('UDP tampon/giriş hatası', (r) => r.ue + r.ur + r.us, (v) => `${num(v)} paket`, { max: 5, color: 'pink' }),
    chart('LiveKit işlemcisi', (r) => r.lk, (v) => `%${dec(v * 100, 0)} çekirdek`, { max: 1, color: 'ok' }),
    chart('CPU baskısı (PSI)', (r) => r.psi, (v) => pct(v), { max: 10, color: 'pink' }),
    chart('Bağlantı izleme tablosu (conntrack)', (r) => (r.ct != null && r.ctm ? (r.ct / r.ctm) * 100 : null), (v) => pct(v), { max: 100 }),
    chart('Çekirdek ağ kuyruğu (düşen + time_squeeze)', (r) => (r.sd === null || r.sd === undefined ? null : r.sd + (r.sq ?? 0)), (v) => `${num(v)}`, { max: 5, color: 'pink' }),
  );
}

/** LiveKit ölçümleri (düğüm geneli hızlar) */
function lkCharts(lk, marks) {
  const chart = (label, pick, format, opts = {}) =>
    chartBox(
      label,
      lk.map((r) => ({ at: r.t, v: pick(r) })),
      format,
      { marks, ...opts },
    );
  return h(
    'div',
    'adm-chart-grid',
    chart('LiveKit: yeniden gönderme isteği (NACK)', (r) => r.nack, perSec, { max: 5 }),
    chart('LiveKit: anahtar kare isteği (PLI + FIR)', (r) => (r.pli === null && r.fir === null ? null : (r.pli ?? 0) + (r.fir ?? 0)), perSec, { max: 2, color: 'pink' }),
    chart('LiveKit: yayıncılardan gelen akışta kayıp', (r) => r.lin, (v) => pct(v, 2), { max: 2, color: 'pink' }),
    chart('LiveKit: izleyicilere giden akışta kayıp', (r) => r.lout, (v) => pct(v, 2), { max: 2, color: 'pink' }),
    chart('LiveKit: gelen paket', (r) => r.pin, perSec, { color: 'ok' }),
    chart('LiveKit: giden paket', (r) => r.pout, perSec),
  );
}

// ---------- Canlı durum ----------

async function loadLive() {
  const last = live.rows.at(-1)?.t;
  const d = await apiGet(`/api/admin/net/live?seconds=${LIVE_WINDOW_MS / 1000}${last ? `&since=${last - LIVE_OVERLAP_MS}` : ''}`);
  const cut = d.now - LIVE_WINDOW_MS;
  const merge = (old, add) => {
    const from = add.length > 0 ? add[0].t : Infinity;
    return [...old.filter((r) => r.t < from && r.t >= cut), ...add];
  };
  live.rows = merge(live.rows, d.rows);
  live.lk = merge(live.lk, d.livekit.history);
  return { ...d, rows: live.rows, lk: live.lk };
}

function outageRow(o, meta) {
  const [text, tone] = OUTAGE_KIND[o.kind] ?? [o.kind, 'muted'];
  const p = o.probe;
  const n = o.nic;
  return h(
    'li',
    'adm-row adm-row-top',
    h(
      'div',
      'adm-row-main',
      h('div', 'adm-row-title', dateTimeSec(o.at), ' ', badge(text, tone), ' ', badge(`${secs1(o.durationMs)} sn`, 'muted')),
      p && h('div', 'adm-sub', `Dış sondalar: ${num(p.lost)} sonda art arda yanıtsız (${p.targets.join(', ')})${p.udp && p.tcp ? ' · UDP ve TCP birlikte' : p.udp ? ' · yalnızca UDP' : ' · yalnızca TCP'}`),
      n &&
        h(
          'div',
          'adm-sub',
          `Sunucuya gelen paket: taban ${num(n.baseline)} → ${num(n.rxpMin)} pk/sn${n.txCollapsed ? ' · giden de durdu' : ''}${n.participants !== null && n.participants !== undefined ? ` · seste ${num(n.participants)} kişi` : ''}` +
            (p
              ? ''
              : n.probesLost > 0
                ? ` · aynı saniyelerde ${num(n.probesLost)} dış sonda yanıtsız${n.probeTargets?.length ? ` (${n.probeTargets.join(', ')})` : ''}${o.kind === 'aday' ? ': doğrulama için yetersiz (en az iki farklı hedef gerekir)' : ''}`
                : ' · dış sondalar yanıt aldı: doğrulanmadı (aday)'),
        ),
      h(
        'div',
        'adm-actions',
        h('button', { type: 'button', class: 'adm-more', on: { click: () => openOutage(o, meta) } }, 'Saniyeleri göster'),
        o.kind !== 'aday' && h('button', { type: 'button', class: 'adm-more', on: { click: () => openProviderReport([o], meta) } }, 'Sağlayıcı raporu'),
      ),
    ),
  );
}

function liveView(d) {
  const rows = d.rows;
  const last = rows.at(-1) ?? null;
  const stale = !last || d.now - last.t > 6_000;
  const sm = d.sampler;
  const meta = { serverIp: sm.serverIp, iface: sm.iface };
  // Grafiklerde yalnızca doğrulanmış kesintiler işaretlenir
  const marks = outageMarks(confirmedOutages(d.outages));
  if (d.open.probe) marks.push({ from: d.open.probe.at, to: d.now });
  const out = [];

  // --- Bölüm bölüm durum ---
  const targets = d.probes.targets.filter((t) => !t.disabled);
  const sent = targets.reduce((n, t) => n + t.sent, 0);
  const lost = targets.reduce((n, t) => n + t.lost, 0);
  const lossyTargets = targets.filter((t) => t.lost >= 2).length;
  const probeValue = d.open.probe ? 'Kesinti' : !d.probes.running ? 'Kapalı' : sent === 0 ? 'Ölçülüyor…' : lost === 0 ? 'Temiz' : `${pct((lost / sent) * 100)} kayıp`;
  const probeTone = d.open.probe || lossyTargets >= 2 ? 'bad' : !d.probes.running ? undefined : lost > 0 ? 'warn' : sent > 0 ? 'ok' : undefined;
  out.push(
    card({
      label: 'Dış sondalar (sunucu → internet)',
      value: probeValue,
      compact: true,
      tone: probeTone,
      sub: d.probes.running
        ? [
            d.open.probe && `${secs1(d.open.probe.durationMs)} sn'dir yanıt yok (${d.open.probe.targets.join(', ')})`,
            `Son 60 sn: ${num(sent)} sonda, ${num(lost)} yanıtsız`,
            targets.map((t) => `${t.label} ${t.lastRtt === null ? (t.lastAt ? '✕' : '—') : `${nf.format(Math.round(t.lastRtt))} ms`}`).join(' · '),
            d.probes.targets.some((t) => t.disabled) && `Yanıt vermediği için bırakılan: ${d.probes.targets.filter((t) => t.disabled).map((t) => t.label).join(', ')}`,
          ]
        : ['Sondalar çalışmıyor (geliştirme kipi, SYSTEM_STATS=0 ya da NET_PROBE_TARGETS=0).'],
    }),
  );
  if (!sm.readable.net) {
    out.push(card({ label: 'Sunucu ağı', value: 'Bilgi yok', compact: true, tone: 'warn', sub: 'Saniyelik ağ ölçümü yalnızca Linux sunucuda (/proc) çalışır.' }));
  } else {
    const lk = d.livekit;
    const l = lk.latest;
    const recent = rows.slice(-LIVE_WINDOW_MS / 1000);
    const sum = (pick) => recent.reduce((n, r) => n + (pick(r) ?? 0), 0);
    const drops = sum((r) => r.nd);
    const udpErr = sum((r) => r.ur + r.us);
    const softnet = sum((r) => r.sd);
    const psiMax = Math.max(0, ...recent.map((r) => r.psi ?? 0));
    const ctPct = last?.ct != null && last?.ctm ? (last.ct / last.ctm) * 100 : null;
    const keyframes = l ? (l.pli ?? 0) + (l.fir ?? 0) : 0;
    out.push(
      card({
        label: `Sunucuya gelen (${sm.iface ?? '—'})`,
        value: stale ? '—' : ppsText(last.rxp),
        compact: true,
        tone: d.open.nic ? (d.open.probe || d.open.nic.probesLost >= 2 ? 'bad' : 'warn') : stale ? 'warn' : undefined,
        sub: [
          d.open.nic ? `Sessizlik adayı: ${num(d.open.nic.seconds)} sn'dir ${num(d.open.nic.rxpMin)} pk/sn (olağanı ${num(d.open.nic.baseline)})` : stale ? 'Ölçüm gelmiyor' : `↓ ${mbpsText(last.rx)}`,
          `Seste ${num(d.voice.participants)} kişi · ${num(d.voice.streams)} yayın`,
        ],
      }),
      card({
        label: 'Ses sunucusu (LiveKit)',
        value: lk.ok && l ? percent(l.cpu) : 'Ölçüm yok',
        unit: lk.ok && l ? 'işlemci' : undefined,
        compact: true,
        tone: !lk.ok ? undefined : keyframes >= 2 || (l?.lin ?? 0) >= 3 ? 'warn' : undefined,
        sub: lk.ok && l ? [`NACK ${perSec(l.nack)} · anahtar kare isteği ${perSec(keyframes)}`, `Kayıp ↓ ${pct(l.lin, 2)} · ↑ ${pct(l.lout, 2)} · ${num(l.parts)} katılımcı`] : [lk.error ?? 'Metrikler kapalı'],
      }),
      card({
        label: 'Sunucudan giden',
        value: stale ? '—' : mbpsText(last.tx),
        compact: true,
        sub: [stale ? 'Ölçüm gelmiyor' : `↑ ${ppsText(last.txp)}`, `Son 5 dk en yüksek ${mbpsText(Math.max(0, ...recent.map((r) => r.tx ?? 0)))}`],
      }),
      card({
        label: 'Sunucu kaynağı',
        value: drops + udpErr + softnet === 0 && psiMax < 30 ? 'Temiz' : psiMax >= 30 ? `PSI ${pct(psiMax)}` : `${num(drops + udpErr + softnet)} düşen`,
        compact: true,
        tone: psiMax >= 50 || (ctPct ?? 0) >= 90 ? 'bad' : drops + udpErr + softnet > 0 || psiMax >= 30 ? 'warn' : 'ok',
        sub: [
          `Son 5 dk: NIC düşen ${num(drops)} · UDP tampon ${num(udpErr)} · çekirdek kuyruğu ${num(softnet)}`,
          `CPU baskısı en çok ${pct(psiMax)}${ctPct !== null ? ` · conntrack ${pct(ctPct)} (${num(last.ct)}/${num(last.ctm)})` : sm.readable.conntrack ? '' : ' · conntrack okunamıyor'}`,
        ],
      }),
    );
    // --- Son 5 dakika, saniye saniye ---
    const chart = (label, pick, format, opts = {}) =>
      chartBox(
        label,
        rows.map((r) => ({ at: r.t, v: pick(r) })),
        format,
        { marks, ...opts },
      );
    out.push(
      h(
        'article',
        'adm-card adm-wide',
        h('div', 'adm-label', 'Son 5 dakika, saniye saniye (kırmızı bantlar: kesinti saniyeleri)'),
        h(
          'div',
          'adm-chart-grid',
          chart('Gelen paket', (r) => r.rxp, ppsText, { color: 'ok' }),
          chart('Giden paket', (r) => r.txp, ppsText),
          chart('Gelen', (r) => r.rx, mbpsText, { color: 'ok' }),
          chart('Giden', (r) => r.tx, mbpsText),
          chart(
            'Dış sonda gecikmesi (en yüksek)',
            (r) => {
              const v = externalProbes(r).filter((n) => n >= 0);
              return v.length === 0 ? null : Math.max(...v);
            },
            msText,
            { max: 100 },
          ),
          chartBox(
            'LiveKit: NACK',
            d.lk.map((r) => ({ at: r.t, v: r.nack })),
            perSec,
            { max: 5, marks, color: 'pink' },
          ),
        ),
        h(
          'div',
          'adm-sub adm-note',
          `Ölçüm: ${sm.iface ?? '?'} · ağ geçidi ${sm.gateway ?? 'bilinmiyor'}${sm.serverIp ? ` · sunucu ${sm.serverIp}` : ''} · bellekte ${num(sm.ring)} sn · diske yazılan (anormal saniyelerin çevresi) ${num(sm.persistedRows)} satır.`,
        ),
      ),
    );
  }
  // --- Son kesintiler ---
  out.push(
    h(
      'article',
      `adm-card adm-wide${d.open.probe ? ' adm-tone-bad' : ''}`,
      h('div', 'adm-label', `Son kesintiler · son 24 saatte ${num(d.outageCounts.day)}, 7 günde ${num(d.outageCounts.week)}`),
      d.outages.length === 0
        ? h('div', 'adm-sub', 'Kayıtlı kesinti yok.')
        : h(
            'ul',
            'adm-rows',
            d.outages.map((o) => outageRow(o, meta)),
          ),
      h(
        'div',
        'adm-sub adm-note',
        'tam kesinti: sunucuya gelen paketler neredeyse sıfıra indi ve aynı saniyelerde dış sondalar da yanıtsız kaldı (sağlayıcı/hipervizör ağı). yalnız sonda: dış sondalar art arda yanıtsız ama sunucuya paket gelmeye devam etti. aday (yalnız NIC): gelen paketler neredeyse sıfıra indi ama sondalar yanıt aldı; tek başına kesinti sayılmaz (istemciler göndermeyi kesmiş olabilir).',
      ),
    ),
  );
  return out;
}

/** Bir kesintinin çevresindeki saniyeler (±30 sn) */
function openOutage(o, meta) {
  openSheet(`Kesinti · ${dateTimeSec(o.at)} · ${secs1(o.durationMs)} sn`);
  const seq = ++sheet.seq;
  void (async () => {
    try {
      const d = await apiGet(`/api/admin/net/seconds?from=${o.at - 30_000}&to=${o.at + o.durationMs + 30_000}`);
      if (seq !== sheet.seq) return;
      const marks = outageMarks(confirmedOutages(d.outages));
      const [text, tone] = OUTAGE_KIND[o.kind] ?? [o.kind, 'muted'];
      $('adm-sheet-body').replaceChildren(
        ...[
          h(
            'div',
            'adm-card',
            h('div', 'adm-row-title', badge(text, tone), ' ', `${dateTimeSec(o.at)} · ${secs1(o.durationMs)} sn`),
            o.kind !== 'aday' && h('button', { type: 'button', class: 'adm-more', on: { click: () => openProviderReport([o], meta) } }, 'Sağlayıcı raporu'),
          ),
          d.rows.length < 2
            ? h('div', 'adm-card adm-empty', 'Bu aralığın saniyelik kaydı yok (bellekten çıkmış ve diske yazılmamış).')
            : serverCharts(d.rows, marks),
          d.livekit.length >= 2 && lkCharts(d.livekit, marks),
        ].filter(Boolean),
      );
    } catch (err) {
      if (err instanceof AccessError || seq !== sheet.seq) return;
      $('adm-sheet-body').replaceChildren(h('div', 'adm-sub', `Veri alınamadı: ${err.message}`));
    }
  })();
}

// ---------- Sağlayıcı raporu ----------

const utcStamp = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
function localStampText(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, '0');
  const zone = `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${zone})`;
}

/** Barındırma sağlayıcısına gönderilecek düz metin (Türkçe ve İngilizce) */
function providerReportText(outages, facts) {
  const en1 = (ms) => (ms / 1000).toFixed(1);
  const ip = facts.serverIp ?? '<sunucu IP>';
  const tr = [];
  const en = [];
  // Rapor yalnızca verinin gösterdiğini söyler: her cümle ilgili kanıt varsa yazılır
  const anyNic = outages.some((o) => o.nic);
  tr.push(anyNic ? 'Konu: Sanal sunucuda kısa süreli ağ kesintileri (paketler misafir makinenin ağ arayüzüne ulaşmıyor)' : 'Konu: Sanal sunucudan dışarıya kısa süreli bağlantı kesintileri (giden sondalar yanıtsız kalıyor)', '');
  en.push(anyNic ? 'Subject: Short network blackouts on the virtual server (packets do not reach the guest NIC)' : 'Subject: Short outbound connectivity losses from the virtual server (outbound probes get no reply)', '');
  tr.push(`Sunucu IP: ${ip}${facts.iface ? ` (arayüz ${facts.iface})` : ''}`);
  en.push(`Server IP: ${facts.serverIp ?? '<server IP>'}${facts.iface ? ` (interface ${facts.iface})` : ''}`);
  tr.push('', 'Kesintiler:');
  en.push('', 'Outages:');
  for (const o of outages) {
    tr.push(`- ${utcStamp(o.at)} / yerel ${localStampText(o.at)}: ${secs1(o.durationMs)} sn`);
    en.push(`- ${utcStamp(o.at)} / local ${localStampText(o.at)}: ${en1(o.durationMs)} s`);
    if (o.nic) {
      tr.push(`    Misafir NIC'e gelen paket hızı ${num(o.nic.baseline)} → ${num(o.nic.rxpMin)} paket/sn'ye düştü (sunucuya neredeyse hiç paket ulaşmadı).`);
      en.push(`    Inbound packet rate on the guest NIC dropped from ${o.nic.baseline} to ${o.nic.rxpMin} packets/s (almost no packets reached the guest).`);
    }
    if (!o.probe && o.nic && o.nic.probesLost > 0) {
      tr.push(`    Aynı saniyelerde sunucudan dışarıya giden ${num(o.nic.probesLost)} sonda (DNS/TCP) yanıtsız kaldı.`);
      en.push(`    In the same seconds ${o.nic.probesLost} outbound probes (DNS/TCP) from the server got no reply.`);
    }
    if (!o.nic) {
      tr.push('    Bu sürede sunucuya paket gelmeye devam etti (NIC sessizliği saptanmadı): gözlenen, giden sondaların yanıtsız kalmasıdır.');
      en.push('    Packets kept arriving at the guest during this interval (no NIC silence detected): what was observed is unanswered outbound probes.');
    }
    if (o.probe) {
      const kinds = o.probe.udp && o.probe.tcp ? ['UDP (DNS) ve TCP (443)', 'UDP (DNS) and TCP (443)'] : o.probe.udp ? ['UDP (DNS)', 'UDP (DNS)'] : ['TCP (443)', 'TCP (443)'];
      tr.push(`    Aynı anda sunucudan dışarıya giden ${kinds[0]} sondaları yanıtsız kaldı: ${o.probe.targets.join(', ')} (${num(o.probe.lost)} sonda art arda).`);
      en.push(`    At the same time outbound ${kinds[1]} probes from the server got no reply: ${o.probe.targets.join(', ')} (${o.probe.lost} consecutive probes).`);
    }
  }
  tr.push('', 'Misafir işletim sistemindeki sayaçlar (kesinti çevresinde):');
  en.push('', 'Guest OS counters (around the outage):');
  if (facts.nicDrops !== null) {
    const clean = facts.nicDrops + facts.udpErrors === 0;
    // "Paketler makineye hiç gelmedi" yalnızca NIC sessizliği gözlendiyse ve misafirde düşen paket yoksa söylenebilir
    tr.push(`- NIC düşen/hatalı paket: ${num(facts.nicDrops)}; UDP tampon hatası: ${num(facts.udpErrors)}${clean ? (anyNic ? ' → paketler makineye hiç gelmedi; kayıp misafirin dışında.' : ' → misafir işletim sisteminde paket düşmedi.') : ''}`);
    en.push(`- NIC dropped/errored packets: ${facts.nicDrops}; UDP buffer errors: ${facts.udpErrors}${clean ? (anyNic ? ' → the packets never arrived at the guest; the loss is upstream of the VM.' : ' → no packets were dropped inside the guest OS.') : ''}`);
  } else {
    tr.push('- Saniyelik sayaç kaydı bu aralık için elde yok.');
    en.push('- Per-second counters are not available for this interval.');
  }
  if (facts.psiMax !== null) {
    // "Yük altında değildi" yalnızca baskı gerçekten düşükse yazılır
    const calm = facts.psiMax < 10;
    tr.push(`- CPU baskısı (PSI) en çok %${nf1.format(facts.psiMax)}${calm ? ': sunucu yük altında değildi.' : '.'}`);
    en.push(`- CPU pressure (PSI) peaked at ${facts.psiMax.toFixed(1)}%${calm ? ': the server was not overloaded.' : '.'}`);
  }
  if (facts.burst) {
    const b = facts.burst;
    const when = b.secBeforeLoss === null ? 'Kesinti sırasında ' : b.secBeforeLoss === 0 ? 'Kesintinin hemen öncesinde ' : `Kesintiden ${num(b.secBeforeLoss)} sn önce `;
    tr.push(`- ${when}giden trafik ${mbpsText(b.txMbps)}${b.txPps != null ? ` / ${num(b.txPps)} paket/sn` : ''} düzeyine sıçradı (olağanı ${mbpsText(b.baseTxMbps)}).`);
    en.push(`- ${b.secBeforeLoss === null ? 'Around' : b.secBeforeLoss === 0 ? 'Immediately before' : `${b.secBeforeLoss} s before`} the outage egress traffic spiked to ${b.txMbps} Mbps${b.txPps != null ? ` / ${b.txPps} packets/s` : ''} (baseline ${b.baseTxMbps} Mbps).`);
  }
  tr.push(
    '',
    `İstek: Bu zaman aralıklarında hipervizör, sanal anahtar ve ağ koruma (DDoS süzgeci / hız sınırlayıcı) kayıtlarını inceler misiniz?${facts.burst ? ' Ani trafik artışında devreye giren bir hız sınırı (policer) var mı?' : ''}`,
  );
  en.push(
    '',
    `Request: Could you check the hypervisor, virtual switch and network protection (DDoS filter / rate limiter) logs for these intervals?${facts.burst ? ' Is there a policer that triggers on traffic bursts?' : ''}`,
  );
  return { tr: tr.join('\n'), en: en.join('\n') };
}

/** Kesinti(ler) için sağlayıcıya gönderilecek metin; sayaçlar kesinti çevresindeki saniyelerden okunur */
function openProviderReport(outages, meta) {
  openSheet('Sağlayıcı raporu');
  const seq = ++sheet.seq;
  void (async () => {
    const facts = { serverIp: meta.serverIp ?? null, iface: meta.iface ?? null, nicDrops: null, udpErrors: null, psiMax: null, burst: meta.burst ?? null };
    try {
      let rows = meta.rows ?? null;
      if (!rows) {
        const from = Math.min(...outages.map((o) => o.at)) - 5_000;
        const to = Math.min(from + 14 * 60_000, Math.max(...outages.map((o) => o.at + o.durationMs)) + 5_000);
        rows = (await apiGet(`/api/admin/net/seconds?from=${from}&to=${to}`)).rows;
      }
      if (rows.length > 0) {
        facts.nicDrops = rows.reduce((n, r) => n + r.nd, 0);
        facts.udpErrors = rows.reduce((n, r) => n + r.ur + r.us, 0);
        const psi = rows.map((r) => r.psi).filter((v) => v !== null && v !== undefined);
        facts.psiMax = psi.length > 0 ? Math.max(...psi) : null;
      }
    } catch (err) {
      if (err instanceof AccessError) return;
      // Sayaçlar alınamadıysa rapor onlarsız yazılır
    }
    if (seq !== sheet.seq) return;
    const text = providerReportText(outages, facts);
    $('adm-sheet-body').replaceChildren(
      h('div', 'adm-sub', 'Barındırma sağlayıcısına destek talebi olarak gönderilebilecek özet. Metni göndermeden önce gözden geçir.'),
      h('div', 'adm-card', h('div', 'adm-label', 'Türkçe'), h('pre', 'adm-pre', text.tr), copyButton(text.tr)),
      h('div', 'adm-card', h('div', 'adm-label', 'English'), h('pre', 'adm-pre', text.en), copyButton(text.en)),
    );
  })();
}

// ---------- Olaylar: yayın donmaları + kalite sorunları tek zaman çizelgesinde ----------

const CONFIDENCE_TONE = { yüksek: 'ok', orta: 'warn', düşük: 'muted' };
/** Olay hangi bölümü gösteriyor: rozet tonu */
const SEGMENT_TONE = { saglayici: 'bad', saglayici_gelen: 'bad', saglayici_giden: 'bad', sunucu: 'bad', sfu: 'bad', yol: 'warn', yayinci: 'warn', kullanici: 'warn', belirsiz: 'muted' };
/** Eski kayıtlarda özet cümlesi yok */
const freezeSummary = (f) => f.summary ?? `Olası neden: ${f.label}`;
/** Kalite kaydı bu olayın kanalında ve penceresinde mi (±30 sn) */
const incidentInFreeze = (i, f) => i.channelId === f.channelId && i.start <= f.end + 30_000 && i.end >= f.start - 30_000;

function freezeRow(f, x, linked) {
  const channel = x.channels[f.channelId]?.name;
  const names = f.users.map((u) => userName(x.users[u.userId], 'Kullanıcı'));
  const outs = f.server?.outages ?? [];
  const tests = (x.lineTests ?? []).filter((t) => t.freezeIds.includes(f.id));
  return h(
    'li',
    { class: 'adm-row adm-row-top adm-clickable', tabindex: 0, role: 'button', on: rowOpen(() => openFreeze(f, x)) },
    h(
      'div',
      'adm-row-main',
      h('div', 'adm-row-title', freezeSummary(f)),
      h('div', 'adm-sub', `${dateTime(f.start)} – ${clock(f.end)} · ${duration((f.end - f.start) / 1000)}${channel ? ` · 🔊 ${channel}` : ''} · ${num(f.affected)}/${num(f.users.length)} kullanıcı etkilendi: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}`),
      f.evidence[0] && h('div', 'adm-sub', f.evidence[0]),
      h(
        'div',
        'adm-badges',
        badge(f.label, SEGMENT_TONE[f.segment] ?? 'warn'),
        badge(`güven: ${f.confidence}`, CONFIDENCE_TONE[f.confidence] ?? 'muted'),
        outs.map((o) => badge(`${(OUTAGE_KIND[o.kind] ?? [o.kind])[0]} ${secs1(o.durationMs)} sn`, (OUTAGE_KIND[o.kind] ?? [])[1] ?? 'muted')),
        f.freezes > 0 && badge(`${num(f.freezes)} donma · ${dec(f.freezeSec)} sn`),
        f.probe === 'kayıp' && outs.length === 0 && badge('dış sondalarda kayıp', 'warn'),
        f.probe === 'temiz' && badge('dış sondalar temiz', 'muted'),
        f.factors.some((t) => t.startsWith('patlama_sonrasi')) && badge('patlama sonrası', 'warn'),
        (f.missing?.length ?? 0) > 0 && badge(`${num(f.missing.length)} eksik kanıt`, 'muted'),
        f.traces ? badge(`olay kaydı: ${num(f.traces.users.length)}/${num(f.users.length)} kullanıcı`, 'ok') : f.traces === null && badge('olay kaydı yok', 'muted'),
        linked.length > 0 && badge(`${num(linked.length)} kişisel kalite kaydı`, 'muted'),
        tests.length > 0 && badge(`${num(tests.length)} hat testi çakışıyor`, 'muted'),
      ),
    ),
  );
}

function eventsView(x) {
  const now = x.now;
  const st = x.storage;
  const s = x.netSampler;
  const freezeList = x.freezes ?? [];
  const pick = (days) => {
    ui.incidentDays = days;
    delete extra.data.teshis;
    void loadExtra(true);
  };
  // Tek zaman çizelgesi: yayın donması olayları + onlara bağlanamayan (tek kullanıcılık) kalite kayıtları
  const linkedOf = new Map(freezeList.map((f) => [f.id, x.incidents.filter((i) => incidentInFreeze(i, f))]));
  const linkedIds = new Set([...linkedOf.values()].flat().map((i) => i.id));
  const single = x.incidents.filter((i) => !linkedIds.has(i.id));
  const items = [...freezeList.map((f) => ({ end: f.end, freeze: f })), ...single.map((i) => ({ end: i.end, incident: i }))].sort((a, b) => b.end - a.end);
  const shown = ui.allEvents ? items : items.slice(0, 60);
  const counts = new Map();
  for (const f of freezeList) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  const reads = s ? [s.readable.net && 'ağ', s.readable.snmp && 'UDP', s.readable.softnet && 'softnet', s.readable.psi && 'CPU baskısı', s.readable.conntrack && 'conntrack'].filter(Boolean) : [];
  return [
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Olaylar: birden çok kullanıcıyı etkileyen donma/kayıp olayları (arızalı bölüm ve kanıtla) ve tek kullanıcılık kalite sorunları'),
      chips(
        [
          [1, 'Son 24 saat'],
          [7, '7 gün'],
          [30, '30 gün'],
        ],
        ui.incidentDays,
        pick,
        'Dönem',
      ),
      freezeList.length > 0 &&
        h(
          'div',
          'adm-badges',
          [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => badge(`${label}: ${num(n)}`, 'muted')),
          single.length > 0 && badge(`tek kullanıcı kalite sorunu: ${num(single.length)}`, 'muted'),
        ),
      items.length === 0
        ? h('div', 'adm-sub', 'Bu dönemde olay yok.')
        : h(
            'ul',
            'adm-rows',
            shown.map((it) => (it.freeze ? freezeRow(it.freeze, x, linkedOf.get(it.freeze.id) ?? []) : incidentRow(it.incident, x, now))),
          ),
      items.length > shown.length &&
        h(
          'button',
          {
            type: 'button',
            class: 'adm-more',
            on: {
              click: () => {
                ui.allEvents = true;
                renderDiag({ view: 'olaylar', data: x });
              },
            },
          },
          `Tümünü göster (${num(items.length)})`,
        ),
      h(
        'div',
        'adm-sub adm-note',
        `İstemci özetleri ${num(st.retentionDays)} gün saklanır (${num(st.files)} gün dosyası, ${bytes(st.bytes)}); son 24 saatte ${num(st.reports24h)} özet${st.dropped ? ` · boyut sınırı yüzünden yazılmayan ${num(st.dropped)}` : ''}. ` +
          (s && reads.length > 0
            ? `Sunucu saniyelik ölçüm: ${s.iface ?? '?'} · okunan: ${reads.join(', ')}.`
            : 'Sunucu saniyelik ağ ölçümü çalışmıyor (yalnızca Linux sunucuda /proc okunur).'),
      ),
    ),
  ];
}

function openFreeze(f, x) {
  openSheet(`${f.label} · ${dateTime(f.start)}`);
  const seq = ++sheet.seq;
  void (async () => {
    try {
      // Olayın sunucu kanıtı ve aynı saniyelerin istemci olay kayıtları (kayıtlar alınamazsa ayrıntı onlarsız çizilir)
      const [d, tw] = await Promise.all([
        apiGet(`/api/admin/telemetry/freezes/${encodeURIComponent(f.id)}`),
        apiGet(`/api/admin/voice/traces/window?${new URLSearchParams({ from: String(f.start - 30_000), to: String(f.end + 10_000), channelId: f.channelId, limit: '60' })}`).catch((err) => {
          if (err instanceof AccessError) throw err;
          return null;
        }),
      ]);
      d.traces = tw;
      if (seq !== sheet.seq) return;
      $('adm-sheet-body').replaceChildren(...freezeDetail(d, x).flat(Infinity).filter(Boolean));
    } catch (err) {
      if (err instanceof AccessError || seq !== sheet.seq) return;
      $('adm-sheet-body').replaceChildren(h('div', 'adm-sub', `Veri alınamadı: ${err.message}`));
    }
  })();
}

/** Kullanıcı başına zaman şeridi: özet pencereleri (kayba göre renkli) ve kesinti bantları */
function userLanes(f, x) {
  const users = f.users.filter((u) => (u.w?.length ?? 0) > 0);
  if (users.length === 0) return null;
  const from = f.start;
  const span = Math.max(1_000, f.end - f.start);
  const W = 1000;
  const H = 16;
  const px = (t) => (Math.max(0, Math.min(span, t - from)) / span) * W;
  const outs = f.server?.outages ?? [];
  const lanes = users.map((u) => {
    const name = userName(x.users[u.userId], 'Kullanıcı');
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${name}: olay süresince özet pencereleri` });
    for (const r of u.w) {
      const a = r.a - Math.max(1, r.s) * 1000;
      if (r.a <= from || a >= f.end) continue;
      const worst = Math.max(r.o ?? 0, r.i ?? 0);
      const rect = svg('rect', {
        x: px(a) + 1,
        width: Math.max(3, px(r.a) - px(a) - 2),
        y: 1,
        height: H - 2,
        rx: 2,
        class: worst >= 10 || r.f >= 2 ? 'adm-bar-bad' : worst >= 3 || r.f > 0 ? 'adm-bar-warn' : 'adm-bar-ok',
      });
      const tip = svg('title', {});
      tip.textContent = `${clock(a, true)} – ${clock(r.a, true)} · kayıp ↑ ${pct(r.o)} ↓ ${pct(r.i)}${r.f ? ` · ${num(r.f)} donma` : ''}${r.r !== null ? ` · ping ${msText(r.r)}` : ''}`;
      rect.append(tip);
      chart.append(rect);
    }
    for (const o of outs) {
      chart.append(svg('rect', { x: px(o.at), width: Math.max(4, px(o.at + o.durationMs) - px(o.at)), y: 0, height: H, class: 'adm-lane-mark' }));
    }
    return h('div', 'adm-lane', h('span', 'adm-lane-name', name, ' ', h('span', 'adm-muted', u.role)), h('div', 'adm-lane-bar', chart));
  });
  return panel(
    'Kullanıcı şeritleri: her kutu bir istemci özeti penceresi (yeşil temiz, sarı kayıp ≥ %3 ya da donma, kırmızı kayıp ≥ %10); dikey kırmızı bant kesinti',
    lanes,
    h('div', 'adm-axis', h('span', null, clock(f.start, true)), h('span', null, clock(f.end, true))),
  );
}

// ---------- İstemci olay kayıtları (saniyelik bağlantı ölçümleri) ----------

/** Ses kanalındaki bütün istemcilerden olay kaydı ister (son ~2 dakikanın saniyelik ölçümleri) */
/** Son isteğin sonucu (kanal → metin ve geçerlilik süresi): sekme 5 sn'de bir yeniden çizilse de görünür kalsın */
const traceRequests = new Map();

function traceRequestButton(channelId) {
  const label = 'Sesteki herkesten kayıt iste';
  const state = traceRequests.get(channelId);
  const busy = state && state.until > Date.now();
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'adm-more adm-trace-request',
      disabled: busy,
      title: 'Kanaldaki istemciler son ~2 dakikanın saniyelik bağlantı ölçümlerini gönderir (Bağlantı teşhisi > Olaylar ayrıntısında görünür)',
    },
    busy ? state.text : label,
  );
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    let text;
    try {
      const r = await apiSend('POST', '/api/admin/voice/traces/request', { channelId, reason: 'yönetici isteği' });
      text = r.sessions > 0 ? `${num(r.sessions)} istemciden istendi (~20 sn içinde gelir)` : 'Kayıt gönderebilen istemci yok (eski sürüm)';
    } catch (err) {
      if (err instanceof AccessError) return;
      // Hata: düğme yeniden denenebilsin diye hemen açılır; ileti kısa süre görünür
      btn.textContent = err.message;
      btn.disabled = false;
      setTimeout(() => (btn.textContent = label), 6_000);
      return;
    }
    traceRequests.set(channelId, { text, until: Date.now() + 10_000 });
    btn.textContent = text;
    // Sekme yeniden çizilmese de düğme süre dolunca açılır
    setTimeout(() => {
      btn.textContent = label;
      btn.disabled = false;
    }, 10_000);
  });
  return btn;
}

const isVideoKind = (k) => k === 'scr' || k === 'v';
/** Giden akışlarda karşı tarafın bildirdiği kayıp (%): son alıcı raporu, yoksa kayıp / gönderilen */
function upLossPct(s, video) {
  const list = s.up.filter((u) => isVideoKind(u.k) === video);
  if (list.length === 0) return null;
  const fl = list.map((u) => u.fl).filter((v) => v !== null && v !== undefined);
  if (fl.length > 0) return Math.max(...fl);
  const sent = list.reduce((n, u) => n + u.ps, 0);
  return sent > 0 ? (list.reduce((n, u) => n + (u.pl ?? 0), 0) / sent) * 100 : null;
}
const inLossPct = (pr, pl) => (pr + pl > 0 ? (pl / (pr + pl)) * 100 : null);

/**
 * Kullanıcı başına saniye saniye şeritler (sunucu saatine hizalı; sunucu grafikleriyle aynı zaman ekseni). Her
 * hücre bir ölçümdür: renk yoğunluğu değerin büyüklüğü, üzerine gelince saati ve değeri. Dikey kırmızı bant kesinti.
 */
function traceLanes(tw, f, x, marks) {
  const from = f.start - 30_000;
  const to = f.end + 10_000;
  const span = Math.max(1_000, to - from);
  const W = 1000;
  const H = 10;
  const px = (t) => (Math.max(0, Math.min(span, t - from)) / span) * W;
  const byUser = new Map();
  for (const t of tw.traces) {
    const u = byUser.get(t.userId) ?? { samples: [], marks: [], meta: t };
    u.samples.push(...t.samples);
    u.marks.push(...t.marks);
    byUser.set(t.userId, u);
  }
  const strip = (label, samples, value, { max, cls = 'bad', fmt }) => {
    const vals = samples.map((s) => ({ s, v: value(s) })).filter((p) => p.v !== null && p.v !== undefined && Number.isFinite(p.v));
    if (!vals.some((p) => p.v > 0)) return null;
    const peak = Math.max(...vals.map((p) => p.v));
    const top = max ?? peak;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label}: en çok ${fmt(peak)}` });
    for (const m of marks) chart.append(svg('rect', { x: px(m.from), width: Math.max(3, px(m.to) - px(m.from)), y: 0, height: H, class: 'adm-lane-mark' }));
    for (const { s, v } of vals) {
      const a = px(s.ts - s.dt);
      const rect = svg('rect', { x: a.toFixed(1), width: Math.max(2, px(s.ts) - a).toFixed(1), y: 0, height: H, class: `adm-heat-${cls}`, opacity: (v <= 0 ? 0.07 : Math.min(1, 0.2 + (0.8 * v) / Math.max(top, 1e-9))).toFixed(2) });
      const tip = svg('title', {});
      tip.textContent = `${clock(s.ts, true)} · ${fmt(v)}`;
      rect.append(tip);
      chart.append(rect);
    }
    return h('div', 'adm-lane adm-lane-thin', h('span', 'adm-lane-name adm-muted', label), h('div', 'adm-lane-bar', chart), h('span', 'adm-lane-val', fmt(peak)));
  };
  const pctFmt = (v) => pct(v);
  const blocks = [...byUser.entries()].map(([userId, u]) => {
    const s = u.samples.sort((a, b) => a.ts - b.ts);
    const user = x.users[userId] ?? tw.users?.[userId] ?? null;
    const role = f.users.find((fu) => fu.userId === userId)?.role;
    const video = (pick) => (smp) => {
      const v = smp.up.filter((up) => isVideoKind(up.k));
      return v.length === 0 ? null : pick(v, smp);
    };
    const rows = [
      strip('Giden kayıp · ses', s, (smp) => upLossPct(smp, false), { max: 20, fmt: pctFmt }),
      strip('Giden kayıp · görüntü', s, (smp) => upLossPct(smp, true), { max: 20, fmt: pctFmt }),
      strip('STUN yanıtsız', s, (smp) => smp.x?.su ?? null, { max: 3_000, fmt: msText }),
      strip('RTT', s, (smp) => smp.x?.rtt ?? null, { max: 300, cls: 'brand', fmt: msText }),
      strip('Yükleme tahmini (BWE)', s, (smp) => smp.x?.ao ?? null, { cls: 'ok', fmt: bits }),
      strip(
        'Yayın bit hızı',
        s,
        video((v, smp) => (smp.dt > 0 ? (v.reduce((n, up) => n + up.bs, 0) * 8) / (smp.dt / 1000) : null)),
        { cls: 'brand', fmt: bits },
      ),
      strip(
        'Yayın hedef bit hızı',
        s,
        video((v) => {
          const tb = v.map((up) => up.tb).filter((n) => n !== null && n !== undefined);
          return tb.length > 0 ? tb.reduce((a, b) => a + b, 0) : null;
        }),
        { cls: 'brand', fmt: bits },
      ),
      strip(
        'Anahtar / dev kare',
        s,
        video((v) => v.reduce((n, up) => n + (up.kf ?? 0) + (up.hf ?? 0), 0)),
        { max: 2, cls: 'warn', fmt: (v) => `${num(v)} kare` },
      ),
      strip(
        'Alınan PLI / NACK',
        s,
        video((v) => v.reduce((n, up) => n + (up.pli ?? 0) + (up.fir ?? 0) + (up.nk ?? 0), 0)),
        { max: 20, cls: 'warn', fmt: (v) => `${num(v)}` },
      ),
      strip('Gelen kayıp · ses', s, (smp) => (smp.da ? inLossPct(smp.da.pr, smp.da.pl) : null), { max: 20, fmt: pctFmt }),
      strip(
        'Gelen kayıp · görüntü',
        s,
        (smp) => (smp.dv?.length ? inLossPct(smp.dv.reduce((n, v) => n + v.pr, 0), smp.dv.reduce((n, v) => n + (v.pl ?? 0), 0)) : null),
        { max: 20, fmt: pctFmt },
      ),
      strip('Donma', s, (smp) => (smp.dv?.length ? smp.dv.reduce((n, v) => n + (v.fzd ?? 0) + (v.fz ? 1 : 0), 0) : null), { max: 1_000, fmt: msText }),
      strip('JS gecikmesi', s, (smp) => smp.lag ?? null, { max: 500, cls: 'warn', fmt: msText }),
    ].filter(Boolean);
    const inRange = u.marks.filter((m) => m.ts >= from && m.ts <= to).sort((a, b) => a.ts - b.ts);
    return h(
      'div',
      'adm-trace-user',
      h('div', 'adm-row-title', userName(user, 'Kullanıcı'), role && [' ', badge(role, role === 'yayıncı' ? 'live' : 'muted')], ' ', h('span', 'adm-muted', `${PLATFORM[u.meta.platform] ?? u.meta.platform} ${u.meta.version} · ${num(s.length)} ölçüm`)),
      rows.length > 0 ? rows : h('div', 'adm-sub', 'Bu aralıkta kayda değer bir değer yok (kayıp, donma, gecikme sıfır).'),
      inRange.length > 0 && h('div', 'adm-sub', `İşaretler: ${inRange.slice(0, 12).map((m) => `${clock(m.ts, true)} ${m.l}`).join(' · ')}${inRange.length > 12 ? ' …' : ''}`),
    );
  });
  const missing = f.users.filter((fu) => !byUser.has(fu.userId)).map((fu) => userName(x.users[fu.userId], 'Kullanıcı'));
  return panel(
    'İstemci olay kayıtları: kullanıcı başına saniye saniye (sunucu saatine hizalı; renk yoğunluğu değerin büyüklüğü, sağda en yüksek değer)',
    blocks,
    h('div', 'adm-axis', h('span', null, clock(from, true)), h('span', null, clock(to, true))),
    h(
      'div',
      'adm-sub adm-note',
      `${num(tw.traces.length)} kayıt, ${num(byUser.size)} kullanıcı.${missing.length > 0 ? ` Kaydı olmayanlar (eski istemci ya da kayıt ulaşmadı): ${missing.join(', ')}.` : ''}` +
        `${tw.truncated ? ' Kayıtların bir kısmı gösterilmedi (sınır).' : ''} Saatler istemcinin ölçtüğü saat farkıyla sunucu saatine çevrilir (±1 sn).`,
    ),
  );
}

function freezeDetail(d, x) {
  const f = d.event;
  const rows = d.rows;
  const lk = d.lk ?? [];
  const outs = f.server?.outages ?? [];
  const marks = outageMarks(confirmedOutages(outs));
  const linked = x.incidents.filter((i) => incidentInFreeze(i, f));
  const tests = (x.lineTests ?? []).filter((t) => t.freezeIds.includes(f.id));
  const meta = { serverIp: d.serverIp ?? null, iface: x.netSampler?.iface ?? null, burst: f.server?.burst ?? null, rows: rows.length > 0 ? rows : null };
  const out = [];
  out.push(
    h(
      'div',
      `adm-card adm-tone-${SEGMENT_TONE[f.segment] === 'bad' ? 'bad' : 'warn'}`,
      h('div', 'adm-row-title', freezeSummary(f)),
      h('div', 'adm-badges', badge(f.label, SEGMENT_TONE[f.segment] ?? 'warn'), badge(`güven: ${f.confidence}`, CONFIDENCE_TONE[f.confidence] ?? 'muted')),
      h('div', 'adm-label', 'Kanıt'),
      f.evidence.map((t) => h('div', 'adm-sub', `• ${t}`)),
      f.factors.length > 0 && [h('div', 'adm-label', 'Diğer etkenler'), f.factors.map((t) => h('div', 'adm-sub', `• ${t}`))],
      (f.missing?.length ?? 0) > 0 && [h('div', 'adm-label', 'Eksik kanıt (doğrulanamayanlar)'), f.missing.map((t) => h('div', 'adm-sub', `• ${t}`))],
      confirmedOutages(outs).length > 0 &&
        h('button', { type: 'button', class: 'adm-more', on: { click: () => openProviderReport(confirmedOutages(outs), meta) } }, 'Sağlayıcı raporu'),
    ),
  );
  if (outs.length > 0) {
    out.push(
      panel(
        'Olay penceresindeki kesintiler',
        h(
          'ul',
          'adm-rows',
          outs.map((o) => outageRow(o, meta)),
        ),
      ),
    );
  }
  out.push(userLanes(f, x));
  if (d.traces && d.traces.traces.length > 0) out.push(traceLanes(d.traces, f, x, marks));
  else out.push(h('div', 'adm-sub', d.traces ? 'Bu olayın saniyelerine ait istemci olay kaydı yok (eski istemciler kayıt göndermez).' : 'İstemci olay kayıtları alınamadı.'));
  const userRows = f.users.map((u) => {
    const s = u.screen;
    return h(
      'li',
      'adm-row',
      h(
        'div',
        'adm-row-main',
        h('div', 'adm-row-title', userName(x.users[u.userId], 'Kullanıcı'), ' ', badge(u.role, u.role === 'yayıncı' ? 'live' : 'muted')),
        h(
          'div',
          'adm-badges',
          u.lossOut != null && badge(`kayıp ↑ ${pct(u.lossOut)}`, u.lossOut >= 3 ? 'warn' : 'muted'),
          u.lossIn != null && badge(`kayıp ↓ ${pct(u.lossIn)}`, u.lossIn >= 3 ? 'warn' : 'muted'),
          u.rttAvg != null && badge(`ping ${msText(u.rttAvg)}`, 'muted'),
          u.freezes > 0 && badge(`${num(u.freezes)} donma · ${dec(u.freezeSec)} sn`, 'warn'),
          s && badge(`${dec(s.fpsMin)}–${dec(s.fpsMax)} fps`, s.fpsMin != null && s.fpsMin < 24 ? 'warn' : 'muted'),
          s?.bitrate && badge(bits(s.bitrate), 'muted'),
          s?.encoder && badge(`${s.encoder}${s.hardware ? ' (donanım)' : ''}`, 'muted'),
          s && s.limitation !== 'none' && badge(`kısıtlama: ${s.limitation}`, 'warn'),
          u.watchFpsMin != null && badge(`izleme ${dec(u.watchFpsMin)} fps`, 'muted'),
          u.route && badge(u.route.replace('·', ' · '), 'muted'),
          badge(`${PLATFORM[u.platform] ?? u.platform}`, 'muted'),
        ),
      ),
    );
  });
  out.push(panel('Kullanıcılar (istemci özetleri, olay süresince en kötü değerler)', h('ul', 'adm-rows', userRows)));
  if (rows.length < 2) {
    out.push(h('div', 'adm-card adm-empty', 'Bu olay için sunucu saniyelik kaydı yok (sunucu ölçümü kapalıydı ya da yeni başlamıştı).'));
  } else {
    const sv = f.server;
    out.push(
      h(
        'div',
        'adm-sub',
        `Olay penceresi ${clock(f.start, true)} – ${clock(f.end, true)}; grafikler 30 sn öncesinden başlar, kırmızı bantlar kesinti saniyeleridir. İstemci özetleri 10–30 sn'lik pencerelerdir: hizalama saniyeye değil pencereyedir.` +
          (sv?.rxPpsMin != null ? ` Gelen paket ${num(sv.rxPpsMin)}–${num(sv.rxPpsMax)}/sn${sv.rxDip ? `, en derin çöküş ${clock(sv.rxDip.at, true)} anında olağanın ${pct(sv.rxDip.pct)}'i` : ''}.` : ''),
      ),
      serverCharts(rows, marks),
    );
  }
  if (lk.length >= 2) {
    out.push(
      h('div', 'adm-sub', 'LiveKit ölçümleri (düğüm geneli; LiveKit katılımcı başına ölçüm vermez). Olay açıkken 2 saniyede bir, öncesinde 10 saniyede bir.'),
      lkCharts(lk, marks),
    );
  } else if (f.livekit === undefined || f.livekit === null) {
    out.push(h('div', 'adm-sub', 'Bu olay için LiveKit ölçümü kaydedilmedi.'));
  }
  if (tests.length > 0) {
    out.push(
      panel(
        'Bu olayla çakışan hat testleri (±60 sn); ayrıntısı Testler görünümünde',
        h(
          'ul',
          'adm-rows',
          tests.map((t) =>
            h(
              'li',
              'adm-row adm-row-top',
              h(
                'div',
                'adm-row-main',
                h('div', 'adm-row-title', (t.who.userId ? x.users[t.who.userId]?.displayName : null) ?? t.who.name, ' ', h('span', 'adm-muted', `${clock(t.at, true)} – ${clock(t.end, true)}`)),
                t.findings.map((fd) => h('div', 'adm-sub', `${FINDING_WORD[fd.tone] ?? ''}: ${fd.text}`)),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (linked.length > 0) {
    out.push(
      panel(
        'Bu olaya bağlı kişisel kalite kayıtları (kişiye dokun: bağlantı kalitesi ayrıntısı)',
        h(
          'ul',
          'adm-rows',
          linked.map((i) => incidentRow(i, x, x.now)),
        ),
      ),
    );
  }
  return out;
}

// ---------- Ayrıntı: LiveKit ölçümleri ve dakikalık ağ geçmişi ----------

function minuteHistory(m) {
  const rows = m.rows;
  const pickDay = (day) => {
    ui.minuteDay = day === m.days[0] ? null : day;
    delete extra.data.teshis;
    void loadExtra(true);
  };
  const dayChips =
    m.days.length > 1 &&
    chips(
      m.days.slice(0, 14).map((day) => [day, day.slice(5).split('-').reverse().join('.')]),
      m.day,
      pickDay,
      'Gün',
    );
  if (rows.length < 2) {
    return h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', `Dakikalık ağ geçmişi · ${m.day}`),
      dayChips,
      h('div', 'adm-sub', 'Bu gün için dakikalık özet yok (ölçüm yeni başladı ya da yalnızca Linux sunucuda çalışır). Özetler 14 gün saklanır.'),
    );
  }
  const chart = (label, pick, format, opts = {}) =>
    chartBox(
      label,
      rows.map((r) => ({ at: r.at, v: pick(r) })),
      format,
      { seconds: false, ...opts },
    );
  const probeLoss = (r) => {
    const v = Object.entries(r.p ?? {}).filter(([k]) => k !== 'ağ geçidi');
    const sent = v.reduce((n, [, x]) => n + x[0], 0);
    return sent === 0 ? null : (v.reduce((n, [, x]) => n + x[1], 0) / sent) * 100;
  };
  const total = (pick) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);
  return h(
    'article',
    'adm-card adm-wide',
    h('div', 'adm-label', `Dakikalık ağ geçmişi · ${m.day} (sunucu saat dilimi) · ${num(rows.length)} dakika`),
    dayChips,
    h(
      'div',
      'adm-badges',
      badge(`kesinti işaretli ${num(total((r) => r.o))} sn`, total((r) => r.o) > 0 ? 'warn' : 'muted'),
      badge(`NIC düşen ${num(total((r) => r.nd))}`, total((r) => r.nd) > 0 ? 'warn' : 'muted'),
      badge(`UDP tampon hatası ${num(total((r) => r.ur + r.us))}`, total((r) => r.ur + r.us) > 0 ? 'warn' : 'muted'),
      badge(`dinleyensiz porta gelen ${num(total((r) => r.un))}`, 'muted'),
    ),
    h(
      'div',
      'adm-chart-grid',
      chart('Gelen (dakikanın en yükseği)', (r) => r.rx?.[1] ?? null, mbpsText, { color: 'ok' }),
      chart('Giden (dakikanın en yükseği)', (r) => r.tx?.[1] ?? null, mbpsText),
      chart('Gelen paket (dakikanın en düşüğü)', (r) => r.rxp?.[0] ?? null, ppsText, { color: 'ok' }),
      chart('Gelen paket (ortalama)', (r) => r.rxp?.[1] ?? null, ppsText, { color: 'ok' }),
      chart('Kesinti işaretli saniye', (r) => r.o, (v) => `${num(v)} sn`, { max: 5, color: 'pink' }),
      chart('Dış sonda kaybı', probeLoss, (v) => pct(v), { max: 5, color: 'pink' }),
      chart('NIC düşen/hatalı paket', (r) => r.nd, (v) => `${num(v)} paket`, { max: 5, color: 'pink' }),
      chart('UDP tampon/giriş hatası', (r) => r.ue + r.ur + r.us, (v) => `${num(v)} paket`, { max: 5, color: 'pink' }),
      chart('CPU baskısı (en yüksek)', (r) => r.psi, (v) => pct(v), { max: 10, color: 'pink' }),
      chart('Bağlantı izleme tablosu (conntrack)', (r) => (r.ct != null && r.ctm ? (r.ct / r.ctm) * 100 : null), (v) => pct(v), { max: 100 }),
      chart('Sesteki kişi (en çok)', (r) => r.vp, (v) => `${num(v)} kişi`, { max: 1 }),
      chart('LiveKit işlemcisi (en yüksek)', (r) => r.lk, (v) => `%${dec(v * 100, 0)} çekirdek`, { max: 1, color: 'ok' }),
    ),
    h('div', 'adm-sub adm-note', 'Dakikalık özetler tek ağ örnekleyicisinden (saniyelik kayıt) türetilir ve 14 gün saklanır (telemetry/netmin-*.jsonl).'),
  );
}

function detailView(x) {
  return [minuteHistory(x.minutes), h('h3', 'adm-subhead adm-wide', 'Ses sunucusu (LiveKit)'), livekit(x.infra)];
}

// ---------- Testler: hat testleri (LiveKit'ten bağımsız UDP/TCP ölçümü; bkz. tools/udp-probe) ----------

const LINE_PROFILE = { ramp: 'Hız basamakları', pps: 'Küçük paket (pps)', steady: 'Yayın benzeri', quick: 'Kısa test', burst: 'Patlama' };
const LINE_MODE = { up: 'yukarı', down: 'aşağı', both: 'iki yön' };
const LINE_TONE = { bad: 'bad', warn: 'warn', ok: 'ok', info: 'muted' };
/** Komutlarda gösterilen sunucu adresi: panelin açıldığı köken */
const LINE_SERVER = location.origin;
/** Aşamanın sunucu tarafında görülen (dış sondalarla doğrulanmış) kesintileri */
const runOutages = (r) => (r.outages ?? []).filter((o) => o.kind !== 'aday');

/** Aşamanın bir yönündeki toplam kayıp yüzdesi (ölçülmediyse null) */
function dirLoss(run, dir) {
  const stats = run.stats?.[dir];
  if (!stats) return null;
  const planned = stats.reduce((n, s) => n + s.planned, 0);
  const lost = stats.reduce((n, s) => n + s.lost, 0);
  return planned > 0 ? (lost / planned) * 100 : null;
}

/** Saniye saniye kayıp çubukları: yükseklik kayıp %, renk eşiğe göre; ayrım çizgileri adım başlangıçları */
function lossBars(seconds, steps, label) {
  const n = seconds.length;
  const W = n * 8;
  const H = 44;
  const lossOf = (s) => (s.planned > 0 ? (Math.max(0, s.planned - s.recv) / s.planned) * 100 : 0);
  const top = Math.max(10, ...seconds.map(lossOf));
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  for (const st of steps) {
    if (st.startSec > 0) chart.append(svg('line', { x1: st.startSec * 8, x2: st.startSec * 8, y1: 0, y2: H, class: 'adm-bars-sep' }));
  }
  seconds.forEach((s, i) => {
    const loss = lossOf(s);
    const step = steps.find((st) => i >= st.startSec && i < st.startSec + st.secs);
    const height = Math.max(loss > 0 ? 2 : 0.5, (loss / top) * H);
    const bar = svg('rect', {
      x: i * 8 + 1,
      width: 6,
      y: H - height,
      height,
      class: loss >= 2 ? 'adm-bar-bad' : loss >= 1 ? 'adm-bar-warn' : 'adm-bar-ok',
    });
    const tip = svg('title', {});
    tip.textContent = `${step?.label ?? ''} · ${i + 1}. sn · kayıp %${nf1.format(loss)} (${num(s.recv)}/${num(s.planned)})`;
    bar.append(tip);
    chart.append(bar);
  });
  return h('div', 'adm-lossbars', chart, h('div', 'adm-axis', h('span', null, `0 – ${n} sn`), h('span', null, `tepe %${nf1.format(top)}`)));
}

function lineBadges(s) {
  const out = [];
  const lossy = s.findings.filter((f) => f.tone === 'bad' || f.tone === 'warn');
  for (const f of (lossy.length > 0 ? lossy : s.findings).slice(0, 3)) {
    out.push(badge(f.text.length > 70 ? `${f.text.slice(0, 68)}…` : f.text, LINE_TONE[f.tone]));
  }
  return out;
}

function lineWho(s, x) {
  const u = s.who.userId ? x.users[s.who.userId] : null;
  return u?.displayName ?? s.who.name;
}

function lineRow(s, x) {
  const overall = (dir) => {
    const v = s.runs.map((r) => dirLoss(r, dir)).filter((n) => n !== null);
    return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
  };
  const up = overall('up');
  const down = overall('down');
  return h(
    'li',
    { class: 'adm-row adm-row-top adm-clickable', tabindex: 0, role: 'button', on: rowOpen(() => openLine(s, x)) },
    h(
      'div',
      'adm-row-main',
      h('div', 'adm-row-title', lineWho(s, x), ' ', badge(s.streaming ? 'yayın açıkken' : 'boşta', s.streaming ? 'live' : 'muted')),
      h('div', 'adm-sub', `${dateTime(s.at)} · ${duration((s.end - s.at) / 1000)} · ${s.runs.length} aşama${s.ip ? ` · ${s.ip}` : ''}`),
      h(
        'div',
        'adm-badges',
        up !== null && badge(`kayıp ↑ ${pct(up)}`, up >= 2 ? 'bad' : up >= 1 ? 'warn' : 'muted'),
        down !== null && badge(`kayıp ↓ ${pct(down)}`, down >= 2 ? 'bad' : down >= 1 ? 'warn' : 'muted'),
        s.runs.some((r) => runOutages(r).length > 0) && badge('test sırasında sunucu kesinti gördü', 'bad'),
        s.freezeIds.length > 0 && badge('donma olayıyla çakışıyor', 'warn'),
        lineBadges(s),
      ),
    ),
  );
}

function lineGroup(g, x) {
  const byId = new Map(x.suites.map((s) => [s.id, s]));
  const members = g.suiteIds.map((id) => byId.get(id)).filter(Boolean);
  const cols = members.map((s) => {
    const upRun = s.runs.find((r) => r.transport === 'udp' && r.up && r.profile !== 'pps' && r.profile !== 'steady') ?? s.runs.find((r) => r.transport === 'udp' && r.up);
    const downRun = s.runs.find((r) => r.transport === 'udp' && r.down && r.profile !== 'pps' && r.profile !== 'steady') ?? s.runs.find((r) => r.transport === 'udp' && r.down);
    const bad = s.findings.find((f) => f.tone === 'bad') ?? s.findings.find((f) => f.tone === 'warn') ?? s.findings[0];
    return h(
      'div',
      'adm-line-col',
      h('div', 'adm-row-title', lineWho(s, x)),
      h('div', 'adm-sub', `${clock(s.at, true)}${s.streaming ? ' · yayın açıkken' : ''}`),
      bad && badge(bad.text.length > 60 ? `${bad.text.slice(0, 58)}…` : bad.text, LINE_TONE[bad.tone]),
      upRun && h('div', 'adm-sub', `↑ ${LINE_PROFILE[upRun.profile]} · kayıp ${pct(dirLoss(upRun, 'up'))}`),
      upRun && lossBars(upRun.up, upRun.steps, `${lineWho(s, x)} yukarı yön kaybı`),
      downRun && h('div', 'adm-sub', `↓ ${LINE_PROFILE[downRun.profile]} · kayıp ${pct(dirLoss(downRun, 'down'))}`),
      downRun && lossBars(downRun.down, downRun.steps, `${lineWho(s, x)} aşağı yön kaybı`),
    );
  });
  return h(
    'article',
    'adm-card adm-wide',
    h('div', 'adm-label', `Ortak test · ${dateTime(g.at)} · ${num(g.total)} kişi`),
    h('div', 'adm-sub', g.text),
    h('div', 'adm-line-cols', cols),
  );
}

async function newLineCode(msg, btn, admin = false) {
  btn.disabled = true;
  msg.textContent = '';
  try {
    await apiSend('POST', '/api/admin/line-test/codes', { label: admin ? 'yönetici' : '', hours: 12, maxUses: admin ? 20 : 40, admin });
    delete extra.data.teshis;
    await loadExtra(true);
  } catch (err) {
    if (err instanceof AccessError) return;
    msg.textContent = `Kod üretilemedi: ${err.message}`;
    btn.disabled = false;
  }
}

const lineCommand = (code, extraArgs = '') => `node probe.mjs --server ${LINE_SERVER} --kod ${code} --ad ADIN${extraArgs}`;

/** Kopyalanabilir komut satırı */
const commandLine = (text) => h('div', 'adm-command', h('code', 'adm-pre adm-pre-inline', text), copyButton(text));

function lineTests(x) {
  const msg = h('div', 'adm-sub');
  const btn = h('button', { type: 'button', class: 'adm-more', on: { click: () => void newLineCode(msg, btn) } }, 'Test kodu üret (12 saat)');
  const adminBtn = h('button', { type: 'button', class: 'adm-more', on: { click: () => void newLineCode(msg, adminBtn, true) } }, 'Yönetici kodu üret (patlama testi)');
  const out = [
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Hat testi: istemci ↔ sunucu UDP yolunu sese girmeden ölçer (yukarı/aşağı kayıp, hız eşiği, paket/sn, TCP karşılaştırması, patlama)'),
      x.enabled
        ? h(
            'div',
            'adm-badges',
            badge(`UDP port ${x.port}`, 'ok'),
            badge(`şu an ${num(x.active)} test · ${dec(x.reservedMbps)} Mbps ayrılmış (sınır ${num(x.maxMbps)}, yönetici ${num(x.adminMaxMbps ?? x.maxMbps)} Mbps)`, 'muted'),
            badge(x.streamLive ? 'şu an canlı yayın var' : 'canlı yayın yok', x.streamLive ? 'live' : 'muted'),
          )
        : h('div', 'adm-sub', 'Hat testi kapalı: UDP portu açılamadı ya da LINE_TEST_PORT=off.'),
      x.enabled &&
        x.stats &&
        h('div', 'adm-sub', `Paketler: ${num(x.stats.rx)} alınan · ${num(x.stats.tx)} giden · ${num(x.stats.dropped)} atılan · ${num(x.stats.rateLimited)} sınırlanan · ${num(x.stats.sendErrors)} gönderim hatası`),
      h('div', 'adm-actions', btn, adminBtn),
      msg,
      x.codes.length > 0 &&
        h(
          'ul',
          'adm-rows',
          x.codes.map((c) =>
            h(
              'li',
              'adm-row',
              h(
                'div',
                'adm-row-main',
                h(
                  'div',
                  'adm-row-title',
                  c.code,
                  ' ',
                  c.admin && badge('yönetici kodu', 'warn'),
                  ' ',
                  badge(`${num(c.uses)}/${num(c.maxUses)} kullanım`, 'muted'),
                  ' ',
                  badge(`${clock(c.expiresAt)} saatine kadar`, 'muted'),
                ),
                commandLine(lineCommand(c.code)),
                c.admin && commandLine(lineCommand(c.code, ' --patlama')),
              ),
            ),
          ),
        ),
    ),
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Nasıl çalıştırılır (herhangi bir bilgisayardan, sese girmeden)'),
      h('div', 'adm-sub', '1. Yukarıdan bir test kodu üret ve kişiye ver (12 saat geçerli). Patlama testi için yönetici kodu gerekir.'),
      h('div', 'adm-sub', '2. Windows: tools/udp-probe/hat-testi.cmd dosyasına çift tıklanır, kod ve ad yazılır (probe.mjs yoksa GitHub\'dan indirip SHA-256 ile doğrular; Node yoksa Diskort uygulamasının Node\'unu kullanır). Bu dosya her zaman asıl sunucuyu ölçer.'),
      commandLine('hat-testi.cmd'),
      commandLine('hat-testi.cmd --patlama'),
      h('div', 'adm-sub', '3. Node kurulu her sistemde (probe.mjs ile aynı klasörde):'),
      commandLine(lineCommand('KOD')),
      commandLine(lineCommand('KOD', ' --hizli')),
      commandLine(lineCommand('YONETICI_KODU', ' --patlama')),
      h(
        'div',
        'adm-sub adm-note',
        'Tam test ~2,5 dk, kısa test ~12 sn, patlama testi ~45 sn sürer. Patlama testi yayındaki sahne değişimini taklit eder (taban 3 Mbps, 2 sn\'lik patlamalar: aşağı 10-20-30-40, yukarı 6-10-12 Mbps) ve sunucunun o sırada kendi ağında kesinti görüp görmediğini sonuca ekler; canlı yayın varken --zorla eklenmedikçe başlamaz. Birkaç kişi aynı anda başlasın diye: --at SS:DD:SN. Hesabı olanlar uygulamada Ayarlar > Ses ve Görüntü > Hat testi düğmesiyle yalnızca kısa testi çalıştırabilir.',
      ),
    ),
    chips(
      [
        [1, 'Son 24 saat'],
        [7, '7 gün'],
        [30, '30 gün'],
      ],
      ui.lineDays,
      (days) => {
        ui.lineDays = days;
        delete extra.data.teshis;
        void loadExtra(true);
      },
      'Dönem',
    ),
  ];
  for (const g of x.groups.slice(0, 8)) out.push(lineGroup(g, x));
  out.push(
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Testler: kim, ne zaman, yayın açıkken mi boşta mı, otomatik yorum'),
      x.suites.length === 0
        ? h('div', 'adm-sub', 'Bu dönemde hat testi yok.')
        : h(
            'ul',
            'adm-rows',
            x.suites.map((s) => lineRow(s, x)),
          ),
    ),
  );
  return out;
}

function lineRun(r) {
  const label = `${LINE_PROFILE[r.profile] ?? r.profile} · ${LINE_MODE[r.mode] ?? r.mode}${r.transport === 'tcp' ? ' · TCP' : ''}`;
  const out = [h('div', 'adm-label', label)];
  if (r.unreachable) out.push(h('div', 'adm-sub', 'UDP el sıkışması tamamlanamadı: sunucuya hiç ulaşılamadı.'));
  if (r.partial) out.push(h('div', 'adm-sub', 'İstemci raporu gelmedi; yalnızca sunucunun ölçtüğü yukarı yön var.'));
  for (const [dir, text, secs] of [
    ['up', '↑ yukarı (istemci → sunucu, sunucu ölçtü)', r.up],
    ['down', '↓ aşağı (sunucu → istemci, istemci ölçtü)', r.down],
  ]) {
    if (!secs) continue;
    const stats = r.stats?.[dir] ?? [];
    out.push(
      h('div', 'adm-sub', `${text}: toplam kayıp ${pct(dirLoss(r, dir))}`),
      lossBars(secs, r.steps, `${label} ${text}`),
      h(
        'ul',
        'adm-rows',
        stats.map((st) =>
          h(
            'li',
            'adm-row',
            h(
              'div',
              'adm-row-main',
              h(
                'div',
                'adm-badges',
                badge(st.label, 'muted'),
                badge(`kayıp ${pct(st.lossPct)}`, st.lossPct >= 2 ? 'bad' : st.lossPct >= 1 ? 'warn' : 'ok'),
                st.reordPct > 0 && badge(`sırasız ${pct(st.reordPct)}`, 'muted'),
                badge(`sapma ${dec(st.jitMs)} ms`, 'muted'),
                badge(`${num(st.recv)}/${num(st.planned)} paket`, 'muted'),
              ),
            ),
          ),
        ),
      ),
    );
  }
  for (const [text, secs] of [
    ['TCP ↑', r.tcpUp],
    ['TCP ↓', r.tcpDown],
  ]) {
    if (!secs) continue;
    const got = secs.reduce((n, s) => n + Math.min(s.bytes, s.target), 0);
    const target = secs.reduce((n, s) => n + s.target, 0);
    out.push(h('div', 'adm-sub', `${text}: hedefin %${target ? nf1.format((got / target) * 100) : '—'}'ine ulaştı (${bytes(got)} / ${bytes(target)})`));
  }
  if (r.serverTxMbps != null) out.push(h('div', 'adm-sub', `Sunucu NIC giden: ${dec(r.serverTxMbps)} Mbps (başlangıçta).`));
  // Sunucu tarafı ilişkilendirme: test sürerken dış sondalar / NIC sessizliği kesinti gördü mü
  for (const o of runOutages(r)) {
    const where = o.burst ? `"${o.burst}" adımı${o.afterBurstSec ? `ndan ${nf1.format(o.afterBurstSec)} sn sonra` : ' sırasında'}` : o.sec < 0 ? `test başlamadan ${nf1.format(-o.sec)} sn önce başlayan` : `testin ${nf1.format(o.sec)}. saniyesinde${o.step ? ` (${o.step})` : ''}`;
    out.push(h('div', 'adm-row-title', badge('sunucu kesinti gördü', 'bad'), ' ', `${where}: ${(OUTAGE_KIND[o.kind] ?? [o.kind])[0]}, ${secs1(o.durationMs)} sn`));
  }
  if (r.profile === 'burst' && runOutages(r).length === 0) out.push(h('div', 'adm-sub', 'Sunucu tarafı: test sürerken ve hemen sonrasında kesinti görülmedi (dış sondalar ve NIC temiz).'));
  if (r.loopLag && r.loopLag.maxMs >= 20) {
    out.push(h('div', 'adm-sub', `Sunucu olay döngüsü gecikmesi en çok ${nf1.format(r.loopLag.maxMs)} ms (${num(r.loopLag.stalls)} takılma): ölçüm sunucu yükünden etkilenmiş olabilir.`));
  }
  return h('div', `adm-card${runOutages(r).length > 0 ? ' adm-tone-bad' : ''}`, out);
}

const FINDING_WORD = { bad: 'sorun', warn: 'dikkat', ok: 'temiz', info: 'bilgi' };

function openLine(s, x) {
  openSheet(`${lineWho(s, x)} · ${dateTime(s.at)}`);
  const channels = [...new Set(s.runs.flatMap((r) => r.streaming.channels))].map((id) => x.channels[id]).filter(Boolean);
  const body = [
    h(
      'div',
      'adm-card',
      h('div', 'adm-label', 'Otomatik yorum'),
      s.findings.map((f) => [h('div', 'adm-row-title', badge(FINDING_WORD[f.tone], LINE_TONE[f.tone]), ' ', f.text), f.evidence && h('div', 'adm-sub', f.evidence)]),
      h('div', 'adm-sub', s.streaming ? `Test sırasında canlı yayın vardı${channels.length ? ` (${channels.join(', ')})` : ''}.` : 'Test sırasında canlı yayın yoktu (boşta ölçüm).'),
      s.freezeIds.length > 0 &&
        h('div', 'adm-sub', `Çakışan yayın donması olayı: ${s.freezeIds.map((id) => x.freezes.find((f) => f.id === id)?.label ?? id).join(', ')} (Olaylar görünümünde).`),
    ),
    s.runs.map((r) => lineRun(r)),
  ];
  const c = s.runs.find((r) => r.client)?.client;
  if (c) {
    body.push(
      h(
        'div',
        'adm-card',
        h('div', 'adm-label', 'İstemci'),
        h('div', 'adm-sub', [c.os, c.arch, c.node && `node ${c.node}`, c.app && `uygulama ${c.app}`, c.localIp && `yerel IP: ${c.localIp}`, c.rttMs != null && `HTTPS gecikme ${dec(c.rttMs, 0)} ms`].filter(Boolean).join(' · ')),
        c.note && h('div', 'adm-sub', c.note),
        c.tracert && h('pre', 'adm-pre', c.tracert),
      ),
    );
  }
  $('adm-sheet-body').replaceChildren(...body.flat(Infinity).filter(Boolean));
}

function system(d, now) {
  const s = d.system;
  const p = s.process;
  const hist = s.history;
  // Son ölçüm hesaplanamadıysa (ör. sunucu yeni başladı) geçmişteki en son değer
  const latest = (value, key) => value ?? hist.findLast((x) => x[key] !== null && x[key] !== undefined)?.[key] ?? null;
  const processCard = card({
    label: 'Çalışma süresi',
    value: duration(s.hostUptimeSec ?? p.uptimeSec),
    unit: s.hostUptimeSec !== null ? 'makine' : 'API',
    compact: true,
    sub: [`API ${duration(p.uptimeSec)} · ${bytes(p.rss)} bellek`, `Node ${p.node}`],
  });
  if (!s.available) {
    return [
      card({
        label: 'Makine',
        value: 'Bilgi yok',
        tone: 'warn',
        sub: 'Makine bilgileri yalnızca Linux sunucuda (/proc) okunabilir.',
      }),
      processCard,
    ];
  }
  const mem = s.memory;
  const disk = s.disk;
  const cards = [
    card({
      label: 'İşlemci',
      value: percent(latest(s.cpu?.usage, 'cpu')),
      sub: s.cpu?.load
        ? `Yük ${s.cpu.load.map((l) => nf2.format(l)).join(' · ')} (${num(s.cpu.cores)} çekirdek)`
        : `${num(s.cpu?.cores ?? 0)} çekirdek`,
      children: sparkline(series(hist, 'cpu'), { max: 1, format: percent, label: 'İşlemci kullanımı, son dakikalar' }),
    }),
  ];
  if (mem) {
    const used = mem.total - mem.available;
    cards.push(
      card({
        label: 'Bellek',
        value: bytes(used),
        unit: `/ ${bytes(mem.total)}`,
        sub: `${bytes(mem.available)} kullanılabilir`,
        children: [
          meter(used / mem.total, 'Bellek doluluğu'),
          sparkline(series(hist, 'memUsed'), { max: mem.total, format: bytes, label: 'Kullanılan bellek, son dakikalar', color: 'ok' }),
        ],
      }),
    );
  }
  if (disk) {
    cards.push(
      card({
        label: 'Disk (veri)',
        compact: true,
        value: bytes(disk.used),
        unit: `/ ${bytes(disk.total)}`,
        sub: `${bytes(disk.free)} boş`,
        children: meter(disk.used / Math.max(1, disk.used + disk.free), 'Disk doluluğu'),
      }),
    );
  }
  const t = s.traffic;
  if (t) {
    // Sağlayıcının kotası yalnızca giden trafiği sayar: ölçer, renk ve ay sonu tahmini gidene göre
    const out = t.tx;
    const start = new Date(now);
    const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const monthEnd = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    const elapsed = now - t.since;
    // Ay sonu tahmini: bu ayki ortalama hızla (en az bir günlük veri varsa)
    const projected = elapsed > 86_400_000 ? (out / elapsed) * (monthEnd - t.since) : null;
    cards.push(
      card({
        label: `Bu ayın giden trafiği (${t.month})`,
        value: bytes(out),
        unit: `/ ${bytes(t.quota)}`,
        tone: out / t.quota >= 0.95 ? 'bad' : out / t.quota >= 0.8 ? 'warn' : undefined,
        children: [
          meter(out / t.quota, 'Aylık giden trafik kotası'),
          [
            'Kota yalnızca gideni sayar.',
            `Gelen ${bytes(t.rx)} · giden ${bytes(t.tx)} · toplam ${bytes(t.rx + t.tx)}`,
            projected !== null && `Bu hızla ay sonunda ~${bytes(projected)} giden (kotaya göre %${num(Math.round((projected / t.quota) * 100))})`,
            t.since > monthStart + 60_000 && `Sayım ${dateTime(t.since)} tarihinden beri (öncesi bilinmiyor).`,
            t.history.length > 0 &&
              `Önceki aylar (giden): ${t.history
                .slice(-3)
                .reverse()
                .map((m) => `${m.month} ${bytes(m.tx)}`)
                .join(' · ')}`,
          ]
            .filter(Boolean)
            .map((line) => h('div', 'adm-sub', line)),
        ],
      }),
    );
  }
  cards.push(processCard);
  return cards;
}

// ---------- Makine yükü geçmişi (24 saat / 7 gün) ----------

/** Uzun geçmiş dakikada bir (ya da aralık değişince) istenir; alınamazsa kapsayıcılar yine çizilir */
const longHistory = { data: null, at: 0, failed: false };
const LONG_HISTORY_EVERY = 60_000;

async function loadMachine() {
  const range = ui.machineRange;
  const stale = !longHistory.data || longHistory.data.range !== range || Date.now() - longHistory.at >= LONG_HISTORY_EVERY;
  const [infraData, hist] = await Promise.all([
    apiGet('/api/admin/infra'),
    stale
      ? apiGet(`/api/admin/system-history?range=${range}`).catch((err) => {
          if (err instanceof AccessError) throw err;
          return null;
        })
      : null,
  ]);
  if (stale) longHistory.failed = !hist;
  if (hist && hist.range === ui.machineRange) {
    longHistory.data = hist;
    longHistory.at = Date.now();
  }
  return { infra: infraData, history: longHistory.data };
}

/** Kovalardan grafik noktaları: sunucunun kapalı olduğu (kovası olmayan) aralıkta boşluk */
function bucketSeries(buckets, stepMs, key) {
  const out = [];
  let prev = null;
  for (const b of buckets) {
    if (prev !== null && b.at - prev > stepMs * 1.5) out.push({ at: prev + stepMs, v: null });
    out.push({ at: b.at, v: b[key] ?? null });
    prev = b.at;
  }
  return out;
}

function machineHistory(x) {
  const range = ui.machineRange;
  const pick = (value) => {
    if (value === ui.machineRange) return;
    ui.machineRange = value;
    draw('adm-machine-history', () => machineHistory(longHistory.data));
    void loadExtra(true);
  };
  const head = [
    h('div', 'adm-label', 'Makine yükü geçmişi'),
    chips(
      [
        ['24h', '24 saat'],
        ['7d', '7 gün'],
      ],
      range,
      pick,
      'Geçmiş aralığı',
    ),
  ];
  if (!x || x.range !== range) {
    return h('article', 'adm-card adm-wide', head, h('div', 'adm-sub', longHistory.failed ? 'Geçmiş alınamadı; yeniden denenecek.' : 'Yükleniyor…'));
  }
  const span = [x.from, x.to];
  const week = range === '7d';
  // Eksen: 5 eşit aralık (24 saatte saat, 7 günde gün)
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const at = x.from + ((x.to - x.from) * i) / 4;
    return week ? shortDate(at) : clock(at);
  });
  const stat = (key, format) => {
    const avgs = x.buckets.map((b) => b[key]).filter((v) => v !== null && v !== undefined);
    const tops = x.buckets.map((b) => b[`${key}Max`]).filter((v) => v !== null && v !== undefined);
    if (avgs.length === 0) return null;
    return `ort. ${format(avgs.reduce((a, b) => a + b, 0) / avgs.length)}${tops.length ? ` · en çok ${format(Math.max(...tops))}` : ''}`;
  };
  const box = (label, key, format, opts = {}) => {
    const pts = bucketSeries(x.buckets, x.stepMs, key);
    if (!pts.some((p) => p.v !== null)) {
      return h('div', 'adm-card adm-chart', h('div', 'adm-net-head', h('span', 'adm-muted', label)), h('div', 'adm-sub', 'Bu aralıkta ölçüm yok.'));
    }
    return h(
      'div',
      'adm-card adm-chart adm-hist',
      h('div', 'adm-net-head', h('span', 'adm-muted', label), h('b', null, stat(key, format))),
      sparkline(pts, { format, label, axis: true, seconds: false, span, ticks, peak: bucketSeries(x.buckets, x.stepMs, `${key}Max`), ...opts }),
    );
  };
  const hasNet = x.buckets.some((b) => b.rx !== null || b.tx !== null);
  const first = x.buckets[0]?.at;
  return h(
    'article',
    'adm-card adm-wide',
    head,
    h(
      'div',
      'adm-chart-grid',
      box('İşlemci', 'cpu', percent, { max: 1 }),
      box(`Bellek${x.memTotal ? ` (toplam ${bytes(x.memTotal)})` : ''}`, 'mem', bytes, { max: x.memTotal ?? undefined, color: 'ok' }),
      hasNet && box('Ağ gelen (NIC)', 'rx', mbpsText, { color: 'ok' }),
      hasNet && box('Ağ giden (NIC)', 'tx', mbpsText),
    ),
    h(
      'div',
      'adm-sub',
      `${week ? '30' : '5'} dakikalık ortalama (düz çizgi) ve en yüksek (kesikli). Boşluklar sunucunun kapalı olduğu aralıklardır.` +
        (first !== undefined && first > x.from + x.stepMs ? ` Kayıt ${dateTime(first)} tarihinden beri.` : ''),
    ),
  );
}

function clients(d, now) {
  const c = d.clients;
  const cards = [
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Açık bağlantılar (platforma göre)'),
      h(
        'div',
        'adm-stats',
        ['desktop', 'android', 'ios'].map((p) =>
          h(
            'div',
            'adm-stat',
            h('b', null, num(c.platforms[p])),
            h('span', null, PLATFORM[p]),
            h('span', null, c.latest[p] ? `son sürüm ${c.latest[p]}` : 'son sürüm bilinmiyor'),
          ),
        ),
      ),
    ),
  ];
  cards.push(
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Bağlı sürümler'),
      c.versions.length === 0
        ? h('div', 'adm-sub', 'Şu an bağlı istemci yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            c.versions.map((v) =>
              h(
                'li',
                'adm-row',
                h('span', 'adm-row-title', `${PLATFORM[v.platform]} ${v.version ?? '(sürüm bildirmiyor)'}`),
                h('span', 'adm-muted adm-push', `${num(v.sessions)} bağlantı`),
                v.current === true
                  ? badge('güncel', 'ok')
                  : v.current === false
                    ? badge(`eski · son ${c.latest[v.platform]}`, 'warn')
                    : null,
              ),
            ),
          ),
    ),
  );
  const shown = ui.allUsers ? c.users : c.users.slice(0, USERS_SHOWN);
  const more =
    c.users.length > USERS_SHOWN &&
    h(
      'button',
      {
        type: 'button',
        class: 'adm-more',
        on: {
          click: () => {
            ui.allUsers = !ui.allUsers;
            if (lastData) render(lastData);
          },
        },
      },
      ui.allUsers ? 'Daha az göster' : `Tümünü göster (${num(c.users.length)})`,
    );
  cards.push(
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Hesaplar ve son görülme'),
      h(
        'ul',
        'adm-rows',
        shown.map((u) => {
          const devices = u.devices.map((x) => `${PLATFORM[x.platform]} ${x.version ?? ''}${x.idle ? ' (boşta)' : ''}`.trim());
          const last = u.lastPlatform ? `${PLATFORM[u.lastPlatform]} ${u.lastVersion ?? ''}`.trim() : null;
          return h(
            'li',
            'adm-row',
            h('span', { class: `adm-status${u.online ? ' adm-status-on' : ''}`, title: u.online ? 'Bağlı' : 'Bağlı değil' }),
            avatar(u.user, 28),
            h(
              'div',
              'adm-row-main',
              h('div', 'adm-row-title', u.user.displayName, h('span', 'adm-muted', ` @${u.user.username}`), u.user.isAdmin && badge('yönetici')),
              h('div', 'adm-sub', u.online ? devices.join(' · ') : last ? `Son: ${last}` : 'Bu takip başladığından beri bağlanmadı'),
            ),
            h('span', 'adm-muted adm-push adm-nowrap', u.online ? 'bağlı' : ago(u.lastSeen, now)),
          );
        }),
      ),
      more,
    ),
  );
  return cards;
}

function countText(c) {
  return `${num(c.last24h)}${c.capped ? '+' : ''}`;
}

function details(key, summary, body) {
  const el = h('details', 'adm-details', h('summary', null, summary), h('pre', null, body));
  if (ui.openErrors.has(key)) el.open = true;
  el.addEventListener('toggle', () => (el.open ? ui.openErrors.add(key) : ui.openErrors.delete(key)));
  return el;
}

function errors(d, now) {
  const e = d.errors;
  const cards = [
    card({
      label: 'İstemci hataları',
      value: countText(e.client),
      unit: 'son 24 saat',
      compact: true,
      tone: e.client.last24h > 0 ? 'warn' : undefined,
      sub: `Toplam ${num(e.client.total)}`,
    }),
    card({
      label: 'Sunucu hataları',
      value: countText(e.server),
      unit: 'son 24 saat',
      compact: true,
      tone: e.server.last24h > 0 ? 'bad' : undefined,
      sub: `Toplam ${num(e.server.total)} (5xx yanıt)`,
    }),
  ];
  cards.push(
    panel(
      'Son istemci hataları',
      e.client.recent.length === 0
        ? h('div', 'adm-sub', 'Hata yok.')
        : h(
            'ul',
            'adm-rows',
            e.client.recent.map((x) =>
              h(
                'li',
                'adm-row adm-row-top',
                h(
                  'div',
                  'adm-row-main',
                  h(
                    'div',
                    'adm-badges',
                    badge(ago(x.at, now)),
                    badge(`${PLATFORM[x.platform] ?? x.platform} ${x.version}`),
                    badge(x.where),
                    badge(x.user ? `@${x.user}` : 'oturumsuz', 'muted'),
                  ),
                  h('div', 'adm-error-msg', x.message),
                  x.stack && details(`c${x.at}${x.message}`, 'Yığın izi', x.stack),
                ),
              ),
            ),
          ),
    ),
  );
  cards.push(
    panel(
      'Son sunucu hataları (5xx)',
      e.server.recent.length === 0
        ? h('div', 'adm-sub', 'Hata yok.')
        : h(
            'ul',
            'adm-rows',
            e.server.recent.map((x) =>
              h(
                'li',
                'adm-row adm-row-top',
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-badges', badge(ago(x.at, now)), badge(String(x.status), 'warn'), badge(`${x.method} ${x.route}`)),
                  x.message && h('div', 'adm-error-msg', x.message),
                ),
              ),
            ),
          ),
    ),
  );
  return cards;
}

/** Sunucu günlüğündeki hata ve ölümcül kayıtlar (Hatalar sekmesi; /api/admin/api-stats) */
function serverLogs(a) {
  const now = a.now;
  const logs = a.logs;
  return [
    panel(
      `Hata ve ölümcül kayıtlar (toplam ${num(logs.total)}, ${dateTime(a.since)} tarihinden beri)`,
      logs.recent.length === 0
        ? h('div', 'adm-sub', 'Kayıt yok.')
        : h(
            'ul',
            'adm-rows',
            logs.recent.map((x) =>
              h(
                'li',
                'adm-row adm-row-top',
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-badges', badge(ago(x.at, now)), badge(x.level >= 60 ? 'ölümcül' : 'hata', x.level >= 60 ? 'live' : 'warn')),
                  h('div', 'adm-error-msg', x.msg || '(ileti yok)'),
                  x.err && h('div', 'adm-sub', x.err),
                  x.stack && details(`l${x.at}${x.msg}`, 'Yığın izi', x.stack),
                ),
              ),
            ),
          ),
    ),
  ];
}

// ---------- Ses kalitesi ayrıntısı (kişi başına) ----------

const sheet = { timer: null, reload: null, seq: 0 };

function openSheet(title, onClose) {
  $('adm-sheet-title').textContent = title;
  $('adm-sheet-body').replaceChildren(h('div', 'adm-sub', 'Yükleniyor…'));
  $('adm-sheet').hidden = false;
  document.body.classList.add('adm-sheet-open');
  sheet.onClose = onClose ?? null;
  $('adm-sheet-close').focus();
}

function closeSheet() {
  clearTimeout(sheet.timer);
  sheet.seq++;
  sheet.reload = null;
  if ($('adm-sheet').hidden) return;
  $('adm-sheet').hidden = true;
  document.body.classList.remove('adm-sheet-open');
  sheet.onClose?.();
  sheet.onClose = null;
}

$('adm-sheet-close').addEventListener('click', closeSheet);
$('adm-sheet').addEventListener('click', (e) => {
  if (e.target === $('adm-sheet')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('adm-sheet').hidden) closeSheet();
});

/** Kişinin son bir saati (date: null) ya da geçmiş bir günü */
function openTelemetry(userId, user, date = null) {
  openSheet(`${userName(user, 'Kullanıcı')} · bağlantı kalitesi`);
  const state = { date };
  const seq = ++sheet.seq;
  const load = async () => {
    clearTimeout(sheet.timer);
    if (seq !== sheet.seq) return;
    try {
      const params = new URLSearchParams({ user: userId, ...(state.date ? { date: state.date } : { minutes: '60' }) });
      const x = await apiGet(`/api/admin/telemetry?${params}`);
      if (seq !== sheet.seq) return;
      $('adm-sheet-title').textContent = `${userName(x.user, 'Kullanıcı')} · bağlantı kalitesi`;
      const scroll = $('adm-sheet-body').scrollTop;
      $('adm-sheet-body').replaceChildren(...telemetryDetail(x, state, load));
      $('adm-sheet-body').scrollTop = scroll;
    } catch (err) {
      if (err instanceof AccessError || seq !== sheet.seq) return;
      $('adm-sheet-body').replaceChildren(h('div', 'adm-sub', `Veri alınamadı: ${err.message}`));
    }
    // Canlı görünüm 15 sn'de bir yenilenir
    if (!state.date && seq === sheet.seq && !document.hidden) sheet.timer = setTimeout(load, 15_000);
  };
  sheet.reload = load;
  void load();
}

function telemetryDetail(x, state, reload) {
  const entries = x.entries;
  const now = x.now;
  const pickDay = (day) => {
    state.date = day;
    $('adm-sheet-body').replaceChildren(h('div', 'adm-sub', 'Yükleniyor…'));
    void reload();
  };
  const today = serverDay(now);
  const dayOptions = [[null, 'Son 1 saat'], ...x.days.slice(0, 14).map((d) => [d, d === today ? 'Bugün (tümü)' : d.slice(5).split('-').reverse().join('.')])];
  const out = [chips(dayOptions, state.date, pickDay, 'Dönem')];
  if (entries.length === 0) {
    out.push(h('div', 'adm-card adm-empty', state.date ? 'Bu gün için ölçüm yok.' : 'Son bir saatte ölçüm yok (kişi seste değil ya da eski sürüm kullanıyor).'));
  } else {
    const poor = entries.filter((e) => e.severity === 'poor').length;
    const warn = entries.filter((e) => e.severity === 'warn').length;
    const last = entries.at(-1);
    out.push(
      h(
        'div',
        'adm-sub',
        `${num(entries.length)} özet · ${num(poor)} kötü · ${num(warn)} idare eder${x.truncated ? ' · (ilk 3000 kayıt)' : ''}` +
          ` · son: ${dateTime(last.at)} · ${PLATFORM[last.platform] ?? last.platform} ${last.version}`,
      ),
    );
    // Zaman çizelgesi: her özet bir dilim (yeşil iyi, sarı idare eder, kırmızı kötü); boşluklar ölçüm yok
    const from = entries[0].at - entries[0].windowSec * 1000;
    const span = Math.max(1, last.at - from);
    const strip = h('div', { class: 'adm-timeline', role: 'img', 'aria-label': 'Bağlantı kalitesi zaman çizelgesi' });
    for (const e of entries) {
      const seg = h('span', { class: `adm-tl adm-tl-${e.severity}`, title: `${clock(e.at, true)} · ${SEVERITY[e.severity][0]}${e.causes.length ? ` · ${e.causes[0]}` : ''}` });
      const start = Math.max(from, e.at - e.windowSec * 1000);
      seg.style.left = `${(((start - from) / span) * 100).toFixed(2)}%`;
      seg.style.width = `${Math.max(0.4, ((e.at - start) / span) * 100).toFixed(2)}%`;
      strip.append(seg);
    }
    out.push(
      h(
        'div',
        'adm-card',
        h('div', 'adm-label', 'Kalite zaman çizelgesi'),
        strip,
        h('div', 'adm-axis', h('span', null, span > DAY_MS ? dateTime(from) : clock(from)), h('span', null, clock(last.at))),
      ),
    );
    out.push(h('div', 'adm-card', h('div', 'adm-label', `Son özet (${clock(last.at, true)})`), last.causes.length > 0 && h('div', 'adm-sub', last.causes.join(' · ')), metricsOf(last)));
    const chart = (label, key, format, opts = {}) => {
      const pts = entries.map((e) => ({ at: e.at, v: typeof key === 'function' ? key(e) : e[key] }));
      if (!pts.some((p) => p.v !== null && p.v !== undefined)) return null;
      const lastV = pts.findLast((p) => p.v !== null && p.v !== undefined)?.v;
      return h(
        'div',
        'adm-card adm-chart',
        h('div', 'adm-net-head', h('span', 'adm-muted', label), h('b', null, format(lastV))),
        sparkline(pts, { format, label, axis: true, ...opts }),
      );
    };
    out.push(
      h(
        'div',
        'adm-chart-grid',
        chart('Ping (ortalama)', 'rttAvg', msText, { max: 100 }),
        chart('Ping (en yüksek)', 'rttMax', msText, { max: 100, color: 'pink' }),
        chart('Titreşim (gelen)', 'jitterIn', msText, { max: 20, color: 'ok' }),
        chart('Paket kaybı ↑ (giden)', 'lossOut', (v) => pct(v, 2), { max: 5, color: 'pink' }),
        chart('Paket kaybı ↓ (gelen)', 'lossIn', (v) => pct(v, 2), { max: 5, color: 'pink' }),
        chart('Ses kesilmesi (gelen)', 'concealed', (v) => pct(v, 2), { max: 5, color: 'pink' }),
        chart('Gelen ses kaybı', (e) => e.audioIn?.lossPct ?? null, (v) => pct(v, 2), { max: 5, color: 'pink' }),
        chart('Gelen ses gizleme olayı', (e) => e.audioIn?.concealEvents ?? null, num, { max: 10, color: 'pink' }),
        chart('Uygulama takılması (en yüksek)', (e) => e.jsLag?.maxMs ?? null, msText, { max: 200, color: 'pink' }),
        chart('Bit hızı ↑', 'bitrateOut', bits),
        chart('Bit hızı ↓', 'bitrateIn', bits, { color: 'ok' }),
        chart('Gürültü engelleyici yükü', (e) => e.mic?.load ?? null, percent, { max: 1 }),
        chart('Yayın kare hızı', (e) => e.screen?.fps ?? null, (v) => `${dec(v)} fps`, { max: 30, color: 'ok' }),
        chart('Yayın bit hızı', (e) => e.screen?.bitrate ?? null, bits, { color: 'pink' }),
        chart('İzlenen yayın: çözme süresi', (e) => e.watch?.decodeMs ?? null, (v) => `${dec(v)} ms/kare`, { max: 10, color: 'pink' }),
        chart('İzlenen yayın: kare hızı', (e) => e.watch?.fps ?? null, (v) => `${dec(v)} fps`, { max: 30, color: 'ok' }),
        chart('Gürültü engelleyici kare süresi', (e) => e.mic?.avgFrameMs ?? null, (v) => `${dec(v, 2)} ms`, { max: 5 }),
        chart('Kullanılabilir yükleme hızı', 'availableOut', bits, { color: 'ok' }),
      ),
    );
    const shown = [...entries].reverse().slice(0, 60);
    out.push(
      panel(
        'Özetler (en yeniler önce)',
        h(
          'ul',
          'adm-rows',
          shown.map((e) =>
            h(
              'li',
              'adm-row adm-row-top',
              h(
                'div',
                'adm-row-main',
                h(
                  'div',
                  'adm-badges',
                  badge(clock(e.at, true)),
                  badge(SEVERITY[e.severity][0], SEVERITY[e.severity][1]),
                  badge(`ping ${msText(e.rttAvg)}`),
                  badge(`kayıp ${pct(e.lossOut, 1)} / ${pct(e.lossIn, 1)}`),
                  e.concealed ? badge(`kesilme ${pct(e.concealed)}`) : null,
                  e.screen && badge(`yayın ${screenText(e.screen)}`, 'live'),
                  e.watch && badge(`izliyor ${watchText(e.watch)}`, watchTone(e)),
                  (e.jsLag?.maxMs ?? 0) >= 250 ? badge(`takılma ${msText(e.jsLag.maxMs)}`, e.jsLag.maxMs >= 1000 ? 'bad' : 'warn') : null,
                  e.channelId && x.channels[e.channelId] && badge(`🔊 ${x.channels[e.channelId].name}`, 'muted'),
                ),
                e.causes.length > 0 && h('div', 'adm-sub', e.causes.join(' · ')),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (x.incidents.length > 0) {
    out.push(
      panel(
        'Son 14 günün kalite sorunları',
        h(
          'ul',
          'adm-rows',
          x.incidents.slice(0, 20).map((i) =>
            h(
              'li',
              'adm-row adm-row-top',
              h(
                'div',
                'adm-row-main',
                h('div', 'adm-row-title', `${dateTime(i.start)} · ${duration((i.end - i.start) / 1000)}`, i.open && badge('sürüyor', 'live')),
                h('div', 'adm-sub', i.causes.map((c) => c.cause).join(' · ')),
              ),
              x.days.includes(serverDay(i.start)) &&
                h('button', { type: 'button', class: 'adm-more', on: { click: () => pickDay(serverDay(i.start)) } }, 'O günü aç'),
            ),
          ),
        ),
      ),
    );
  }
  return out;
}

// ---------- Ses geçmişi ----------

function voiceHistory(x) {
  const pick = (days) => {
    ui.historyDays = days;
    delete extra.data['ses-gecmisi'];
    void loadExtra(true);
  };
  const t = x.totals;
  const channelName = (id) => x.channelNames[id]?.name ?? 'Silinmiş kanal';
  const maxDay = Math.max(1, ...x.perDay.map((d) => d.voiceMin));
  const caption = h('div', 'adm-sub adm-bars-caption', `Son ${x.days} gün · günlük ses dakikası`);
  const bars = h(
    'div',
    { class: 'adm-bars', role: 'img', 'aria-label': 'Günlük ses süreleri' },
    x.perDay.map((d, i) => {
      const bar = h('span', { class: `adm-bar${d.voiceMin === 0 ? ' adm-bar-zero' : ''}${i === x.perDay.length - 1 ? ' adm-bar-today' : ''}` });
      bar.style.height = `${Math.max(3, (d.voiceMin / maxDay) * 100)}%`;
      const label = `${i === x.perDay.length - 1 ? 'Bugün' : shortDate(d.day)}: ${minutes(d.voiceMin)} ses, ${minutes(d.streamMin)} yayın · ${num(d.users)} kişi · aynı anda en çok ${num(d.peak)}`;
      const showDay = () => (caption.textContent = label);
      bar.addEventListener('pointerenter', showDay);
      bar.addEventListener('pointerdown', showDay);
      return bar;
    }),
  );
  // Isı haritası: haftanın günleri × saatler
  const peak = Math.max(1, ...x.heatmap.flat());
  const heat = h(
    'div',
    { class: 'adm-heat', role: 'img', 'aria-label': 'Haftanın günlerine ve saatlere göre ses süresi' },
    h('span', 'adm-heat-corner'),
    Array.from({ length: 24 }, (_, hr) => h('span', 'adm-heat-hour', hr % 6 === 0 ? String(hr).padStart(2, '0') : '')),
    x.heatmap.map((row, day) => [
      h('span', 'adm-heat-day', WEEKDAYS[day]),
      row.map((v, hr) => {
        const cell = h('span', { class: 'adm-heat-cell', title: `${WEEKDAYS[day]} ${String(hr).padStart(2, '0')}:00 · ${minutes(v)}` });
        if (v > 0) cell.style.background = `rgba(88, 101, 242, ${(0.15 + 0.85 * (v / peak)).toFixed(2)})`;
        return cell;
      }),
    ]),
  );
  const maxUser = Math.max(1, ...x.userStats.map((u) => u.voiceMin));
  return [
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Dönem'),
      chips(
        [
          [1, 'Bugün'],
          [7, '7 gün'],
          [30, '30 gün'],
          [90, '90 gün'],
        ],
        ui.historyDays,
        pick,
        'Dönem',
      ),
      x.trackingSince
        ? h('div', 'adm-sub', `Kayıt ${dateTime(x.trackingSince)} tarihinden beri tutuluyor.`)
        : h('div', 'adm-sub', 'Henüz ses kaydı yok (kayıt bu sürümle başladı).'),
    ),
    card({ label: 'Toplam ses', value: minutes(t.voiceMin), compact: true, sub: `${num(t.sessions)} oturum · ${num(t.users)} kişi` }),
    card({ label: 'Toplam yayın', value: minutes(t.streamMin), compact: true, sub: `${num(t.streams)} yayın · ${num(t.streamers)} kişi` }),
    card({ label: 'Günlük ses', wide: true, children: [bars, caption] }),
    card({ label: 'En yoğun saatler (sizin saat diliminizle)', wide: true, children: heat }),
    panel(
      'Kim ne kadar seste / yayında',
      x.userStats.length === 0
        ? h('div', 'adm-sub', 'Bu dönemde kayıt yok.')
        : h(
            'ul',
            'adm-rows',
            x.userStats.slice(0, 50).map((u) => {
              const bar = h('span');
              bar.style.width = `${((u.voiceMin / maxUser) * 100).toFixed(1)}%`;
              return h(
                'li',
                'adm-row',
                avatar(x.users[u.userId], 28),
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-row-title', userName(x.users[u.userId]), u.online && badge('seste', 'live')),
                  h('div', 'adm-hbar', bar),
                  h('div', 'adm-sub', [`${minutes(u.voiceMin)} ses`, u.streamMin > 0 && `${minutes(u.streamMin)} yayın`, `${num(u.sessions)} oturum`].filter(Boolean).join(' · ')),
                ),
                h('span', 'adm-muted adm-nowrap', ago(u.lastAt, x.to)),
              );
            }),
          ),
    ),
    panel(
      'En çok kullanılan kanallar',
      x.channels.length === 0
        ? h('div', 'adm-sub', 'Kayıt yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            x.channels.map((c) =>
              h(
                'li',
                'adm-row',
                h('span', 'adm-row-title', `🔊 ${channelName(c.channelId)}`),
                c.guildId && x.guildNames[c.guildId] && h('span', 'adm-muted', x.guildNames[c.guildId]),
                h('span', 'adm-muted adm-push', `${minutes(c.voiceMin)} · ${num(c.users)} kişi · ${num(c.sessions)} oturum`),
              ),
            ),
          ),
    ),
    panel(
      'Son oturumlar',
      x.recent.length === 0
        ? h('div', 'adm-sub', 'Kayıt yok.')
        : h(
            'ul',
            'adm-rows',
            x.recent.map((r) =>
              h(
                'li',
                'adm-row',
                avatar(x.users[r.userId], 24),
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-row-title', userName(x.users[r.userId]), badge(r.kind === 'stream' ? 'yayın' : 'ses', r.kind === 'stream' ? 'live' : undefined), r.open && badge('sürüyor', 'ok')),
                  h('div', 'adm-sub', `🔊 ${channelName(r.channelId)} · ${dateTime(r.start)} · ${duration((r.end - r.start) / 1000)}`),
                ),
              ),
            ),
          ),
    ),
  ];
}

// ---------- Makine sekmesi: kapsayıcılar, LiveKit, kullanım sayaçları ----------

const CONTAINER = { api: 'API', livekit: 'LiveKit', caddy: 'Caddy (HTTPS, TURN/TLS)' };

function infra(x) {
  const now = x.now;
  const cards = [];
  cards.push(
    panel(
      'Kapsayıcılar (işlemci: tek çekirdek oranı)',
      h(
        'ul',
        'adm-rows',
        x.containers.map((c) =>
          h(
            'li',
            'adm-row adm-row-top',
            h(
              'div',
              'adm-row-main',
              h('div', 'adm-row-title', CONTAINER[c.name] ?? c.name, !c.ok && badge('ölçülemiyor', 'muted')),
              c.ok
                ? h('div', 'adm-sub', `İşlemci ${percent(c.cpu)} · bellek ${bytes(c.memory)}${c.memoryLimit ? ` / ${bytes(c.memoryLimit)}` : ''} · kaynak: ${c.source}`)
                : h('div', 'adm-sub', c.error ?? '—'),
              c.ok &&
                sparkline(
                  x.history.map((s) => ({ at: s.at, v: s[c.name] })),
                  { max: 0.5, format: percent, label: `${c.name} işlemci kullanımı`, color: c.name === 'livekit' ? 'pink' : c.name === 'caddy' ? 'ok' : 'brand' },
                ),
            ),
          ),
        ),
      ),
    ),
  );
  const net = x.network;
  if (net) {
    if (!net.ok || net.history.length === 0) {
      cards.push(
        card({
          label: 'Makine ağı',
          value: net.ok ? 'Ölçülüyor…' : 'Bilgi yok',
          compact: true,
          tone: net.ok ? undefined : 'warn',
          sub: net.ok ? 'İlk ölçüm birkaç saniye içinde.' : net.error,
        }),
      );
    } else {
      const nh = net.history;
      const last = nh[nh.length - 1];
      const top = Math.max(1, ...nh.flatMap((p) => [p.rxMbps ?? 0, p.txMbps ?? 0]));
      const half = (arrow, name, key, color) =>
        h(
          'div',
          'adm-net',
          h('div', 'adm-net-head', h('span', 'adm-muted', name), h('b', null, `${arrow} ${mbpsText(last[key])}`)),
          sparkline(series(nh, key), { max: top, format: mbpsText, label: `${name} trafik (makine), son 30 dakika`, color }),
        );
      const peak = (key) => Math.max(0, ...nh.map((p) => p[key] ?? 0));
      cards.push(
        card({
          label: `Makine ağı (${net.iface}, son 30 dk)`,
          sub: [
            `En yüksek: ↓ ${mbpsText(peak('rxMbps'))} · ↑ ${mbpsText(peak('txMbps'))} · paket ↓ ${ppsText(last.rxPps)} · ↑ ${ppsText(last.txPps)}`,
            'Saniyelik görünüm, düşen paketler, UDP hataları ve kesintiler: Bağlantı teşhisi sekmesi.',
          ],
          children: [half('↓', 'Gelen', 'rxMbps', 'brand'), half('↑', 'Giden', 'txMbps', 'pink')],
        }),
      );
    }
  }
  const cd = x.caddy;
  cards.push(
    card({
      label: 'Yedek bağlantı (TURN/TLS, 443)',
      value: cd.ok ? num(cd.turnActive ?? 0) : '—',
      unit: cd.ok ? 'açık' : undefined,
      compact: true,
      sub: cd.ok
        ? [`${dec(cd.turnPerMin ?? 0)} yeni/dk · toplam ${num(cd.turnTotal)}`, ...cd.upstreams.map((u) => `${u.upstream}: ${u.healthy ? 'sağlıklı' : 'SAĞLIKSIZ'}`)]
        : cd.error,
      tone: cd.ok && cd.upstreams.some((u) => !u.healthy) ? 'bad' : undefined,
    }),
  );
  const b = x.backups;
  if (b) {
    const age = b.latest ? now - b.latest.at : null;
    cards.push(
      card({
        label: 'Veritabanı yedeği',
        value: b.latest ? ago(b.latest.at, now) : b.configured ? 'Yedek yok' : 'Bilinmiyor',
        compact: true,
        tone: !b.configured ? undefined : age === null || age > 26 * 3_600_000 ? 'bad' : 'ok',
        sub: b.configured
          ? [
              b.latest && `${dateTime(b.latest.at)} · ${bytes(b.latest.size)}`,
              `${num(b.count)} yedek · toplam ${bytes(b.totalBytes)}`,
              b.attachmentsAt && `Ek/avatar anlık görüntüsü ${ago(Math.max(b.attachmentsAt, b.avatarsAt ?? 0), now)}`,
              b.error,
            ]
          : [b.error ?? 'Yedek klasörü bağlı değil'],
      }),
    );
  }
  if (x.tls.length > 0) {
    cards.push(
      panel(
        'TLS sertifikaları',
        h(
          'ul',
          'adm-rows adm-rows-compact',
          x.tls.map((t) =>
            h(
              'li',
              'adm-row',
              h('span', 'adm-row-title', t.domain),
              h('span', 'adm-muted', t.ok ? `${t.issuer ?? ''} · ${shortDate(t.validTo)} tarihine kadar` : t.error),
              h(
                'span',
                'adm-push',
                t.ok ? badge(`${num(t.daysLeft)} gün`, t.daysLeft < 7 ? 'live' : t.daysLeft < 14 ? 'warn' : 'ok') : badge('denetlenemedi', 'warn'),
                t.ok && !t.authorized && badge('doğrulanmadı', 'warn'),
              ),
            ),
          ),
        ),
        h('div', 'adm-sub adm-note', `Son denetim ${ago(x.tls[0].checkedAt, now)} (6 saatte bir). Caddy sertifikaları süresi dolmadan kendisi yeniler.`),
      ),
    );
  }
  return cards;
}

function livekit(x) {
  const m = x.livekit;
  if (!m.configured || !m.ok) {
    return [
      h(
        'article',
        'adm-card adm-wide adm-tone-warn',
        h('div', 'adm-label', 'LiveKit ölçümleri'),
        h('div', 'adm-value adm-value-sm', 'Metrikler kapalı'),
        h('div', 'adm-sub', m.error ?? ''),
        h(
          'div',
          'adm-sub adm-note',
          'Açmak için infra/livekit.yaml içinde ',
          h('b', null, 'prometheus: port: 6789'),
          ' olmalı ve LiveKit yeniden başlatılmalı (görüşmeler birkaç saniye kopar). Port güvenlik duvarıyla dışarıya kapalıdır; API yalnızca 127.0.0.1\'den okur.',
        ),
      ),
    ];
  }
  const hist = m.history;
  const l = m.latest;
  const top = Math.max(1, ...hist.flatMap((s) => [s.bytesIn ?? 0, s.bytesOut ?? 0]));
  const pair = (arrow, name, key, value, color, fmt, max) =>
    h('div', 'adm-net', h('div', 'adm-net-head', h('span', 'adm-muted', name), h('b', null, `${arrow} ${fmt(value)}`)), sparkline(series(hist, key), { max, format: fmt, label: name, color }));
  const tracks = (o) => Object.entries(o ?? {}).map(([k, n]) => `${k === 'audio' ? 'ses' : k === 'video' ? 'görüntü' : k} ${num(n)}`).join(' · ') || '0';
  return [
    card({
      label: 'Medya trafiği',
      children: [pair('↓', 'Gelen (yayıncılardan)', 'bytesIn', l.bytesIn, 'brand', rate, top), pair('↑', 'Giden (izleyicilere)', 'bytesOut', l.bytesOut, 'pink', rate, top)],
    }),
    card({
      label: 'Paketler',
      children: [
        pair('↓', 'Gelen', 'packetsIn', l.packetsIn, 'brand', perSec),
        pair('↑', 'Giden', 'packetsOut', l.packetsOut, 'pink', perSec),
      ],
    }),
    card({
      label: 'Paket kaybı',
      value: pct(l.lossInPct, 2),
      unit: 'gelen',
      tone: (l.lossInPct ?? 0) >= 5 ? 'bad' : (l.lossInPct ?? 0) >= 2 ? 'warn' : undefined,
      sub: `Giden ${pct(l.lossOutPct, 2)} · ${perSec(l.lossIn)} kayıp paket`,
      children: sparkline(series(hist, 'lossInPct'), { max: 2, format: (v) => pct(v, 2), label: 'Gelen paket kaybı', color: 'pink' }),
    }),
    card({
      label: 'Yeniden gönderme / anahtar kare',
      value: perSec(l.nack),
      unit: 'NACK',
      sub: `PLI ${perSec(l.pli)} · FIR ${perSec(l.fir)}`,
      children: sparkline(series(hist, 'nack'), { max: 5, format: perSec, label: 'NACK/sn' }),
    }),
    card({
      label: 'Gecikme ve titreşim (sunucudan)',
      value: msText(l.rttMs),
      unit: 'RTT',
      sub: `Titreşim ${msText(l.jitterMs)}`,
      children: sparkline(series(hist, 'rttMs'), { max: 50, format: msText, label: 'RTT', color: 'ok' }),
    }),
    card({
      label: 'Odalar',
      value: num(l.rooms),
      unit: 'oda',
      compact: true,
      sub: [`${num(l.participants)} katılımcı`, `Yayınlanan: ${tracks(l.tracksPublished)}`, `Abone: ${tracks(l.tracksSubscribed)}`, l.joinsPerMin !== null && `${dec(l.joinsPerMin)} katılım/dk`],
    }),
    card({
      label: 'LiveKit süreci',
      value: percent(l.cpu),
      unit: 'işlemci',
      compact: true,
      sub: [`${bytes(l.rss)} bellek`, l.goroutines !== null && `${num(l.goroutines)} goroutine`],
    }),
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-label', 'Tüm LiveKit ölçümleri (ham toplamlar)'),
      details('lk-raw', `${num(m.raw.length)} ölçüm`, m.raw.map((r) => `${r.name} ${r.value}`).join('\n')),
      h('div', 'adm-sub', `Son ölçüm ${clock(m.lastOkAt, true)} · 10 saniyede bir`),
    ),
  ];
}

function usage(x) {
  const p = x.push;
  const sum = (o, prefix) => Object.entries(o).filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
  const pushLine = (label, key) =>
    h(
      'div',
      'adm-kv',
      h('span', null, label),
      h('b', null, `${num(sum(p.counts.day, key))} / ${num(sum(p.counts.week, key))} / ${num(sum(p.counts.month, key))}`),
    );
  const tokens = Object.fromEntries(p.tokens.map((t) => [t.platform, t]));
  const d = x.downloads.counts;
  const u = x.updates;
  const dl = (name) => `${num(d.day[name] ?? 0)} / ${num(d.week[name] ?? 0)} / ${num(d.month[name] ?? 0)}`;
  const three = (o, key) => `${num(o.day[key] ?? 0)} / ${num(o.week[key] ?? 0)} / ${num(o.month[key] ?? 0)}`;
  const platforms = [...new Set([...Object.keys(d.month)].filter((k) => k !== 'page'))].sort();
  return [
    card({
      label: 'Telefon bildirimleri',
      value: p.enabled ? num(sum(p.counts.day, 'android.sent') + sum(p.counts.day, 'ios.sent')) : 'Kapalı',
      unit: p.enabled ? 'bugün gönderildi' : undefined,
      tone: p.enabled && sum(p.counts.day, 'android.failed') + sum(p.counts.day, 'ios.failed') > 0 ? 'warn' : undefined,
      children: [
        h(
          'div',
          'adm-kvs',
          h('div', 'adm-sub', 'Bugün / 7 gün / 30 gün'),
          pushLine('Android gönderildi', 'android.sent'),
          pushLine('Android başarısız', 'android.failed'),
          pushLine('Android geçersiz jeton', 'android.unregistered'),
          pushLine('iOS gönderildi', 'ios.sent'),
          pushLine('iOS başarısız', 'ios.failed'),
          kv('Kayıtlı cihaz', `Android ${num(tokens.android?.n ?? 0)} · iOS ${num(tokens.ios?.n ?? 0)}`),
        ),
        sparkline(
          p.daily.sent.map((s) => ({ at: Date.parse(`${s.day}T12:00:00Z`), v: s.count })),
          { max: 1, format: (v) => `${num(v)} bildirim`, label: 'Günlük bildirim, son 14 gün' },
        ),
      ],
    }),
    card({
      label: 'İndirme sayfası ve indirmeler',
      value: num(d.day.page ?? 0),
      unit: 'ziyaret bugün',
      children: h(
        'div',
        'adm-kvs',
        h('div', 'adm-sub', 'Bugün / 7 gün / 30 gün'),
        kv('Sayfa ziyareti', dl('page')),
        platforms.length === 0 ? h('div', 'adm-sub', 'Henüz indirme yok.') : platforms.map((pl) => kv(pl, dl(pl))),
      ),
    }),
    card({
      label: 'Güncellemeler',
      value: num(u.desktop.day.check ?? 0),
      unit: 'masaüstü denetimi bugün',
      children: h(
        'div',
        'adm-kvs',
        h('div', 'adm-sub', 'Bugün / 7 gün / 30 gün'),
        kv('Masaüstü denetimi', three(u.desktop, 'check')),
        kv('Masaüstü kurulum indirmesi', three(u.desktop, 'download')),
        kv('Android OTA denetimi', three(u.ota, 'android.check')),
        kv('Android OTA güncellemesi', three(u.ota, 'android.served')),
        kv('iOS OTA denetimi', three(u.ota, 'ios.check')),
        kv('Sürüm sorgusu (tümü)', `${num(sum(u.version.day, ''))} / ${num(sum(u.version.week, ''))} / ${num(sum(u.version.month, ''))}`),
      ),
    }),
    h('p', 'adm-sub adm-wide', `Sayaçlar ${dateTime(x.countersSince)} tarihinden beri (günler Türkiye saatine göre).`),
  ];
}

// ---------- API sağlığı ----------

function apiHealth(a) {
  const now = a.now;
  const lh = a.lastHour;
  const g = a.gateway;
  const gh = a.gatewayHistory;
  const lastG = gh.at(-1) ?? {};
  const closes = Object.entries(g.closes)
    .sort((x, y) => y[1] - x[1])
    .map(([code, n]) => `${code}: ${num(n)}`)
    .join(' · ');
  return [
    card({
      label: 'İstekler (dakikada)',
      value: num(a.perMinute.at(-1)?.total ?? 0),
      unit: 'bu dakika',
      sub: `Son 1 saatte ${num(lh.total)} · başlangıçtan beri ${num(a.totals.requests)}`,
      children: sparkline(
        a.perMinute.map((m) => ({ at: m.minute, v: m.total })),
        { max: 10, format: (v) => `${num(v)} istek/dk`, label: 'Dakikadaki istekler, son saat', seconds: false },
      ),
    }),
    card({
      label: 'Durum kodları (son 1 saat)',
      value: num(lh.s5),
      unit: '5xx',
      tone: lh.s5 > 0 ? 'bad' : lh.limited > 0 ? 'warn' : undefined,
      children: [
        h('div', 'adm-kvs', kv('2xx', num(lh.s2)), kv('3xx', num(lh.s3)), kv('4xx', num(lh.s4)), kv('429 (sınır aşımı)', num(lh.limited), lh.limited ? 'warn' : undefined), kv('5xx', num(lh.s5), lh.s5 ? 'bad' : undefined)),
        sparkline(
          a.perMinute.map((m) => ({ at: m.minute, v: m.s4 + m.s5 })),
          { max: 1, format: (v) => `${num(v)} hata/dk`, label: '4xx ve 5xx, son saat', color: 'pink', seconds: false },
        ),
      ],
    }),
    card({
      label: 'Olay döngüsü gecikmesi',
      value: a.eventLoop ? `${dec(a.eventLoop.p99)} ms` : '—',
      unit: 'p99',
      compact: true,
      tone: a.eventLoop && a.eventLoop.p99 > 100 ? 'warn' : undefined,
      sub: a.eventLoop ? `p50 ${dec(a.eventLoop.p50)} ms · en çok ${dec(a.eventLoop.max)} ms (son 5 sn)` : 'Düzenli ölçüm kapalı',
    }),
    card({
      label: 'Gateway (WebSocket)',
      value: num(g.openSockets),
      unit: 'açık',
      sub: [
        `${num(g.sessions)} oturum · ${num(g.connections)} bağlantı · ${num(g.reconnects)} yeniden bağlanma`,
        `${num(g.authFailures)} geçersiz oturum · ${num(g.updateRequired)} güncelleme zorunlu`,
        closes && `Kapanış kodları: ${closes}`,
      ],
      children: [
        h(
          'div',
          'adm-net',
          h('div', 'adm-net-head', h('span', 'adm-muted', 'Giden mesaj'), h('b', null, `${perSec(lastG.outPerSec)} · ${rate(lastG.bytesOutPerSec)}`)),
          sparkline(series(gh, 'outPerSec'), { max: 1, format: perSec, label: 'Giden gateway mesajları' }),
        ),
        h(
          'div',
          'adm-net',
          h('div', 'adm-net-head', h('span', 'adm-muted', 'Gelen mesaj'), h('b', null, perSec(lastG.inPerSec))),
          sparkline(series(gh, 'inPerSec'), { max: 1, format: perSec, label: 'Gelen gateway mesajları', color: 'pink' }),
        ),
      ],
    }),
    panel(
      'Yol gruplarına göre gecikme (son 15 dk)',
      a.groups.length === 0
        ? h('div', 'adm-sub', 'İstek yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            a.groups.map((x) =>
              h(
                'li',
                'adm-row',
                h('span', 'adm-row-title adm-mono', x.group),
                h('span', 'adm-muted adm-push', `${num(x.count)} istek · p50 ${dec(x.p50)} ms · p95 ${dec(x.p95)} ms`),
              ),
            ),
          ),
    ),
    panel(
      'En sık istenen yollar (son 15 dk)',
      a.routes.length === 0
        ? h('div', 'adm-sub', 'İstek yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            a.routes.map((x) =>
              h(
                'li',
                'adm-row',
                h('span', 'adm-row-title adm-mono', x.route),
                h('span', 'adm-muted adm-push', `${num(x.count)} · p50 ${dec(x.p50)} · p95 ${dec(x.p95)} · en çok ${dec(x.max)} ms`),
              ),
            ),
          ),
    ),
    panel(
      `Sınır aşımları (429; toplam ${num(a.rateLimited.total)})`,
      a.rateLimited.recent.length === 0
        ? h('div', 'adm-sub', 'Yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            a.rateLimited.recent.slice(0, 30).map((x) =>
              h(
                'li',
                'adm-row',
                badge(ago(x.at, now)),
                h('span', 'adm-row-title adm-mono', `${x.method} ${x.route}`),
                h('span', 'adm-muted adm-push', `${x.ip}${x.user ? ` · @${x.user}` : ''}`),
              ),
            ),
          ),
    ),
    h('p', 'adm-sub adm-wide', `Sayımlar ${dateTime(a.since)} tarihinden beri (sunucu belleğinde). Sunucu günlüğündeki hatalar Hatalar sekmesinde.`),
  ];
}

// ---------- Güvenlik ----------

const AUTH_KIND = {
  login: ['Giriş', 'ok'],
  login_failed: ['Başarısız', 'warn'],
  register: ['Kayıt', undefined],
  join: ['Davetle katıldı', undefined],
  reset: ['Şifre sıfırlandı', 'warn'],
  password: ['Şifre değişti', undefined],
  rate_limited: ['Sınır aşımı', 'live'],
};

function security(x) {
  const now = x.now;
  const c = x.counts;
  const events = ui.allEvents ? x.events : x.events.slice(0, 25);
  const guild = (id) => (id ? (x.guildNames[id] ?? 'Silinmiş sunucu') : 'Hesap daveti');
  return [
    card({ label: 'Girişler', value: num(c.login24h), unit: 'son 24 saat', compact: true, sub: `Son 7 günde ${num(c.login7d)}` }),
    card({
      label: 'Başarısız girişler',
      value: num(c.failed24h),
      unit: 'son 24 saat',
      compact: true,
      tone: c.failed24h >= 10 ? 'bad' : c.failed24h > 0 ? 'warn' : undefined,
      sub: [`Son 7 günde ${num(c.failed7d)}`, `${num(c.limited24h)} sınır aşımı (24 sa)`],
    }),
    card({
      label: 'Oturumlar',
      value: num(x.sessions.gatewaySessions),
      unit: 'bağlı cihaz',
      sub: [
        `${num(x.sessions.onlineUsers)} kişi çevrimiçi`,
        `${num(x.sessions.pushDevices)} bildirim kayıtlı cihaz (${num(x.sessions.pushUsers)} kişi)`,
        `${num(x.sessions.gatewayAuthFailures)} geçersiz oturumla bağlanma`,
        `Jetonlar ${num(x.sessions.tokenTtlDays)} gün geçerli; sunucu jeton listesi tutmaz`,
      ],
    }),
    x.failuresByIp.length > 0 &&
      panel(
        'Başarısız girişler: adrese göre (son 24 saat)',
        h(
          'ul',
          'adm-rows adm-rows-compact',
          x.failuresByIp.map((f) =>
            h(
              'li',
              'adm-row',
              h('span', 'adm-row-title adm-mono', f.ip),
              h('span', 'adm-muted', f.usernames.length ? f.usernames.map((n) => `@${n}`).join(', ') : 'bilinmeyen hesaplar'),
              h('span', 'adm-push', badge(`${num(f.count)} deneme`, f.count >= 10 ? 'live' : 'warn'), ' ', badge(ago(f.last, now), 'muted')),
            ),
          ),
        ),
      ),
    panel(
      'Son giriş olayları (30 gün saklanır)',
      x.events.length === 0
        ? h('div', 'adm-sub', 'Kayıt yok.')
        : h(
            'ul',
            'adm-rows',
            events.map((e) => {
              const u = e.userId ? x.users[e.userId] : null;
              const [label, tone] = AUTH_KIND[e.kind] ?? [e.kind];
              return h(
                'li',
                'adm-row adm-row-top',
                h(
                  'div',
                  'adm-row-main',
                  h(
                    'div',
                    'adm-badges',
                    badge(label, tone),
                    badge(dateTime(e.at), 'muted'),
                    e.username ? badge(`@${e.username}`) : badge('bilinmeyen hesap', 'muted'),
                    badge(e.client),
                    badge(e.ip, 'muted'),
                  ),
                  (e.detail || u) && h('div', 'adm-sub', [u && userName(u), e.detail].filter(Boolean).join(' · ')),
                ),
              );
            }),
          ),
      x.events.length > 25 &&
        h(
          'button',
          {
            type: 'button',
            class: 'adm-more',
            on: {
              click: () => {
                ui.allEvents = !ui.allEvents;
                draw('adm-security', () => security(x));
              },
            },
          },
          ui.allEvents ? 'Daha az göster' : `Tümünü göster (${num(x.events.length)})`,
        ),
    ),
    panel(
      'Davet kullanımları (kim kimi davet etti)',
      x.inviteUses.length === 0
        ? h('div', 'adm-sub', 'Kayıt yok (bu sürümden sonraki kullanımlar görünür).')
        : h(
            'ul',
            'adm-rows',
            x.inviteUses.map((u) =>
              h(
                'li',
                'adm-row',
                avatar(x.users[u.userId], 24),
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-row-title', userName(x.users[u.userId]), badge(u.kind === 'register' ? 'yeni hesap' : 'sunucuya katıldı')),
                  h('div', 'adm-sub', `${guild(u.guildId)} · davet eden: ${u.inviterId ? userName(x.users[u.inviterId]) : 'başlangıç daveti'} · ${u.code} · ${dateTime(u.at)}`),
                ),
              ),
            ),
          ),
    ),
    panel(
      'Davetler',
      x.invites.length === 0
        ? h('div', 'adm-sub', 'Davet yok.')
        : h(
            'ul',
            'adm-rows adm-rows-compact',
            x.invites.map((i) =>
              h(
                'li',
                'adm-row',
                h('span', 'adm-row-title adm-mono', i.code),
                h('span', 'adm-muted', `${guild(i.guildId)} · ${i.createdBy ? userName(x.users[i.createdBy]) : 'sistem'} · ${shortDate(i.createdAt)}`),
                h(
                  'span',
                  'adm-push',
                  badge(`${num(i.uses)}${i.maxUses ? ` / ${num(i.maxUses)}` : ''} kullanım`),
                  ' ',
                  i.grantsAdmin && badge('yönetici', 'warn'),
                  i.active ? badge(i.expiresAt ? `${shortDate(i.expiresAt)} tarihine kadar` : 'süresiz', 'ok') : badge('bitti', 'muted'),
                ),
              ),
            ),
          ),
    ),
    panel(
      'Son açılan hesaplar ve yöneticiler',
      h(
        'ul',
        'adm-rows adm-rows-compact',
        x.recentAccounts.map((a) =>
          h('li', 'adm-row', person(x.users[a.userId]), x.admins.includes(a.userId) && badge('yönetici', 'warn'), h('span', 'adm-muted adm-push', dateTime(a.createdAt))),
        ),
      ),
      h('div', 'adm-sub', `Hesap yöneticileri: ${x.admins.map((id) => userName(x.users[id])).join(', ') || '—'}`),
    ),
  ];
}

// ---------- Sunucular ----------

function guilds(x) {
  const out = x.guilds.map((g) =>
    h(
      'article',
      'adm-card adm-wide',
      h('div', 'adm-channel-head', h('span', 'adm-channel-name', g.name), h('span', 'adm-muted', `sahibi ${userName(x.users[g.ownerId], '—')}`), h('span', 'adm-muted adm-push', `kuruldu ${shortDate(g.createdAt)}`)),
      h(
        'div',
        'adm-metrics',
        metric('Üyeler', `${num(g.members)}${g.formerMembers ? ` (+${num(g.formerMembers)} eski)` : ''}`),
        metric('Yasaklı', num(g.banned)),
        metric('Kanallar', `${num(g.channels.text)} metin · ${num(g.channels.voice)} ses`),
        metric('Mesajlar', `${num(g.messages.total)} (7 gün: ${num(g.messages.last7d)})`),
        metric('Son mesaj', g.messages.lastAt ? ago(g.messages.lastAt, x.generatedAt) : '—'),
        metric('Dosya ekleri', `${num(g.attachments.count)} · ${bytes(g.attachments.bytes)}`),
        metric('Ses (7 gün)', minutes(g.voice7d.voiceMin)),
        metric('Yayın (7 gün)', minutes(g.voice7d.streamMin)),
        metric('Etkin davet', num(g.invites)),
      ),
      g.topPosters.length > 0 &&
        h(
          'div',
          'adm-sub',
          'En çok yazanlar (7 gün): ',
          g.topPosters.map((p, i) => `${i ? ', ' : ''}${userName(x.users[p.userId])} ${num(p.count)}`).join(''),
        ),
    ),
  );
  out.push(
    card({
      label: 'Direkt mesajlar',
      value: num(x.dms.conversations),
      unit: 'konuşma',
      compact: true,
      sub: [`${num(x.dms.messages)} mesaj (7 gün: ${num(x.dms.last7d)})`, `${num(x.dms.attachments.count)} ek · ${bytes(x.dms.attachments.bytes)}`],
    }),
  );
  return out;
}

// ---------- Geri bildirim ----------

const FEEDBACK = [
  ['yeni', 'Yeni'],
  ['incelendi', 'İncelendi'],
  ['planlandi', 'Planlandı'],
  ['tamamlandi', 'Tamamlandı'],
  ['reddedildi', 'Reddedildi'],
];
const FEEDBACK_LABEL = Object.fromEntries(FEEDBACK);
const FEEDBACK_TYPES = [
  ['', 'Tüm türler'],
  ['hata', 'Hata'],
  ['oneri', 'Öneri'],
  ['diger', 'Diğer'],
];
const FEEDBACK_TYPE_LABEL = { hata: 'Hata', oneri: 'Öneri', diger: 'Diğer' };
const STATUS_TONE = { yeni: 'live', incelendi: 'warn', planlandi: undefined, tamamlandi: 'ok', reddedildi: 'muted' };

function feedbackSummary(d) {
  const f = d.feedback;
  const pick = (status) => {
    ui.fbStatus = ui.fbStatus === status ? '' : status;
    delete extra.data['geri-bildirim'];
    draw('adm-feedback', () => feedbackSummary(d));
    void loadExtra(true);
  };
  return [
    h(
      'article',
      `adm-card adm-wide${f.counts.yeni > 0 ? ' adm-tone-accent' : ''}`,
      h('div', 'adm-label', `Durumlara göre (toplam ${num(f.total)}) · süzmek için dokun`),
      h(
        'div',
        'adm-stats',
        FEEDBACK.map(([key, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: `adm-stat adm-stat-btn${key === 'yeni' && f.counts[key] > 0 ? ' adm-stat-new' : ''}`,
              'aria-pressed': String(ui.fbStatus === key),
              on: { click: () => pick(key) },
            },
            h('b', null, num(f.counts[key] ?? 0)),
            h('span', null, label),
          ),
        ),
      ),
      chips(
        FEEDBACK_TYPES,
        ui.fbType,
        (type) => {
          ui.fbType = type;
          delete extra.data['geri-bildirim'];
          draw('adm-feedback', () => feedbackSummary(d));
          void loadExtra(true);
        },
        'Tür',
      ),
    ),
  ];
}

/** Hesap bilgisi (panelin kişi listesinden) */
function knownUser(id) {
  return lastData?.clients.users.find((u) => u.user.id === id)?.user ?? null;
}

function feedbackList(list) {
  const now = Date.now();
  const title = `${ui.fbStatus ? FEEDBACK_LABEL[ui.fbStatus] : 'Tüm durumlar'}${ui.fbType ? ` · ${FEEDBACK_TYPE_LABEL[ui.fbType]}` : ''} (${num(list.length)})`;
  return [
    panel(
      title,
      list.length === 0
        ? h('div', 'adm-sub', 'Bu süzgeçte geri bildirim yok.')
        : h(
            'ul',
            'adm-rows',
            list.map((f) => {
              const u = f.userId ? knownUser(f.userId) : null;
              return h(
                'li',
                { class: 'adm-row adm-row-top adm-clickable', tabindex: 0, role: 'button', on: rowOpen(() => openFeedback(f)) },
                avatar(u, 28),
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-row-title', `#${f.id} `, f.title || f.body.split('\n')[0].slice(0, 120)),
                  h(
                    'div',
                    'adm-badges',
                    badge(FEEDBACK_TYPE_LABEL[f.type] ?? f.type, f.type === 'hata' ? 'warn' : undefined),
                    badge(FEEDBACK_LABEL[f.status] ?? f.status, STATUS_TONE[f.status]),
                    badge(u ? `@${u.username}` : f.userId ? 'hesap' : 'silinmiş hesap', 'muted'),
                    badge(ago(f.createdAt, now), 'muted'),
                    f.screenshots.length > 0 && badge(`${num(f.screenshots.length)} görüntü`),
                    f.adminNote && badge('not var'),
                  ),
                ),
              );
            }),
          ),
    ),
  ];
}

const CONTEXT_LABELS = {
  platform: 'Platform',
  appVersion: 'Uygulama sürümü',
  nativeVersion: 'Yüklü APK sürümü',
  os: 'İşletim sistemi',
  osVersion: 'Sistem sürümü',
  device: 'Cihaz',
  screen: 'Ekran',
  window: 'Pencere',
  view: 'Açık görünüm',
  inVoice: 'Seste',
};

function openFeedback(f) {
  const u = f.userId ? knownUser(f.userId) : null;
  openSheet(`Geri bildirim #${f.id}`);
  const body = [];
  body.push(
    h(
      'div',
      'adm-badges',
      badge(FEEDBACK_TYPE_LABEL[f.type] ?? f.type, f.type === 'hata' ? 'warn' : undefined),
      badge(FEEDBACK_LABEL[f.status] ?? f.status, STATUS_TONE[f.status]),
      badge(dateTime(f.createdAt), 'muted'),
      f.updatedAt !== f.createdAt && badge(`güncellendi ${dateTime(f.updatedAt)}`, 'muted'),
    ),
  );
  body.push(h('div', 'adm-fb-author', u ? person(u, 28) : h('span', 'adm-muted', f.userId ? 'Hesap' : 'Silinmiş hesap')));
  if (f.title) body.push(h('h3', 'adm-fb-title', f.title));
  // Kullanıcı metni: yalnızca metin olarak (satır sonları korunur)
  body.push(h('div', 'adm-fb-body', f.body));
  if (f.screenshots.length > 0) {
    const shots = h('div', 'adm-shots');
    for (const s of f.screenshots) {
      const holder = h('a', { class: 'adm-shot', href: '#', 'aria-label': `Ekran görüntüsü ${s.width}×${s.height}` }, h('span', 'adm-sub', 'Yükleniyor…'));
      shots.append(holder);
      imageDataUrl(s.url)
        .then((src) => {
          const img = h('img', { src, alt: `Ekran görüntüsü ${s.width}×${s.height}`, loading: 'lazy' });
          holder.replaceChildren(img);
          holder.addEventListener('click', (e) => {
            e.preventDefault();
            holder.classList.toggle('adm-shot-big');
          });
        })
        .catch((err) => {
          if (!(err instanceof AccessError)) holder.replaceChildren(h('span', 'adm-sub', 'Görüntü alınamadı'));
        });
    }
    body.push(h('div', 'adm-label', 'Ekran görüntüleri (büyütmek için dokun)'), shots);
  }
  const ctx = f.context;
  if (ctx) {
    const rows = Object.entries(CONTEXT_LABELS)
      .filter(([k]) => ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '')
      .map(([k, label]) => kv(label, k === 'inVoice' ? (ctx[k] ? 'evet' : 'hayır') : k === 'platform' ? (PLATFORM[ctx[k]] ?? String(ctx[k])) : String(ctx[k])));
    body.push(h('div', 'adm-label', 'Teknik bilgiler'), h('div', 'adm-kvs', rows));
    if (Array.isArray(ctx.recentErrors) && ctx.recentErrors.length > 0) {
      body.push(details(`fb${f.id}`, `Son uygulama hataları (${num(ctx.recentErrors.length)})`, ctx.recentErrors.join('\n')));
    }
  } else {
    body.push(h('div', 'adm-sub', 'Gönderen teknik bilgileri eklemedi.'));
  }
  // Durum ve yönetici notu (gönderen de görür)
  const status = h(
    'select',
    { class: 'adm-input', 'aria-label': 'Durum' },
    FEEDBACK.map(([value, label]) => {
      const opt = h('option', { value }, label);
      if (value === f.status) opt.selected = true;
      return opt;
    }),
  );
  const note = h('textarea', { class: 'adm-input', rows: 4, maxlength: 2000, 'aria-label': 'Yönetici notu', placeholder: 'Gönderenin de göreceği not (isteğe bağlı)' });
  note.value = f.adminNote ?? '';
  const message = h('p', 'adm-sub', '');
  const save = h('button', { type: 'button', class: 'btn btn-primary adm-save' }, 'Kaydet');
  save.addEventListener('click', async () => {
    save.disabled = true;
    message.textContent = 'Kaydediliyor…';
    try {
      const updated = await apiSend('PATCH', `/api/feedback/${f.id}`, { status: status.value, adminNote: note.value.trim() || null });
      Object.assign(f, updated);
      message.textContent = `Kaydedildi (${clock(Date.now(), true)}).`;
      delete extra.data['geri-bildirim'];
      if (ui.tab === 'geri-bildirim') void loadExtra(true);
      void refresh();
    } catch (err) {
      if (!(err instanceof AccessError)) message.textContent = `Kaydedilemedi: ${err.message}`;
    } finally {
      save.disabled = false;
    }
  });
  body.push(
    h(
      'div',
      'adm-card adm-fb-edit',
      h('label', 'adm-field', h('span', null, 'Durum'), status),
      h('label', 'adm-field', h('span', null, 'Yönetici notu'), note),
      h('div', 'adm-fb-actions', save, message),
    ),
  );
  $('adm-sheet-body').replaceChildren(...body);
}

// ---------- iPhone cihazları (Ad Hoc onayı) ----------

const IOS_STATUS = {
  bekliyor: ['Bekliyor', 'live'],
  onaylandi: ['Onaylandı', 'warn'],
  eklendi: ['Eklendi', 'ok'],
  reddedildi: ['Reddedildi', 'muted'],
};
const CI_STATUS = {
  queued: ['Sırada', 'warn'],
  requested: ['Sırada', 'warn'],
  waiting: ['Bekliyor', 'warn'],
  pending: ['Sırada', 'warn'],
  in_progress: ['Derleniyor', 'warn'],
  bulunamadi: ["GitHub'da bulunamadı", 'bad'],
  hata: ['Başlatılamadı', 'bad'],
};
const CI_CONCLUSION = { success: ['Başarılı', 'ok'], failure: ['Başarısız', 'bad'], cancelled: ['İptal edildi', 'muted'], timed_out: ['Zaman aşımı', 'bad'] };

/** Durumu değiştirip listeyi yeniden ister */
async function setIosStatus(udid, status, button) {
  button.disabled = true;
  try {
    await apiSend('PATCH', `/api/admin/ios-devices/${encodeURIComponent(udid)}`, { status });
    delete extra.data.iphone;
    if (ui.tab === 'iphone') void loadExtra(true);
  } catch (err) {
    if (!(err instanceof AccessError)) {
      button.disabled = false;
      window.alert(`Kaydedilemedi: ${err.message}`);
    }
  }
}

function iosDevices(x) {
  const now = x.generatedAt;
  const waiting = x.devices.filter((d) => d.status === 'bekliyor').length;
  const count = $('adm-ios-count');
  count.hidden = waiting === 0;
  count.textContent = num(waiting);
  const out = [];

  // Otomatik derleme durumu
  const auto = x.automation;
  const ci = x.ci;
  const running = ci && !['completed', 'bulunamadi', 'hata'].includes(ci.status);
  // Sürmekte olan derlemeye girmemiş onaylı cihazlar
  const waitingBuild = x.devices.filter((d) => d.status === 'onaylandi' && !(running && ci.udids.includes(d.udid))).length;
  if (auto.enabled) {
    const message = h('p', 'adm-sub', '');
    const now_ = h('button', { type: 'button', class: 'adm-more' }, 'Hemen derle');
    now_.addEventListener('click', async () => {
      now_.disabled = true;
      message.textContent = 'Başlatılıyor…';
      try {
        await apiSend('POST', '/api/admin/ios-devices/dispatch', {});
        message.textContent = 'Derleme başlatıldı.';
        delete extra.data.iphone;
        void loadExtra(true);
      } catch (err) {
        if (!(err instanceof AccessError)) message.textContent = err.message;
        now_.disabled = false;
      }
    });
    out.push(
      card({
        label: 'Otomatik derleme',
        value: 'Açık',
        wide: true,
        tone: 'ok',
        sub: [
          auto.pendingDispatchAt
            ? `Onaylar toplanıyor; derleme ${clock(Date.parse(auto.pendingDispatchAt), true)} civarı başlayacak.`
            : waitingBuild > 0
              ? `${num(waitingBuild)} onaylı cihaz derleme bekliyor.`
              : running
                ? 'Derleme sürüyor; bitince cihazlar "Eklendi" olur (yaklaşık 30-40 dk).'
                : 'Onaylanan cihazlar birkaç dakika içinde tek derlemede Apple\'a eklenir ve IPA yenilenir.',
        ],
        children: waitingBuild > 0 ? h('div', 'adm-fb-actions', now_, message) : null,
      }),
    );
  } else {
    const manual = x.manualCommand;
    out.push(
      h(
        'article',
        `adm-card adm-wide ${auto.keyMissing ? 'adm-tone-bad' : 'adm-tone-accent'}`,
        h('div', 'adm-label', auto.keyMissing ? 'Otomatik derleme durdu: IOS_DEVICES_KEY yok' : 'Otomatik derleme kapalı'),
        h(
          'div',
          'adm-sub',
          auto.keyMissing
            ? 'Sunucuda GitHub belirteci var ama cihaz listesini şifreleyecek anahtar (IOS_DEVICES_KEY) yok. Depo herkese açık olduğundan UDID\'ler açık gönderilmez; anahtarı .env\'e ekle (bkz. docs/ios.md). O zamana kadar elle:'
            : 'Sunucuda GITHUB_DISPATCH_TOKEN yok (bkz. docs/ios.md). Onayladığın cihazlar için şu komutu çalıştır; derleme bitince cihazları "Eklendi" olarak işaretle.',
        ),
        manual
          ? [
              h('pre', 'adm-mono adm-pre', manual.command),
              !manual.encrypted &&
                h(
                  'div',
                  'adm-sub',
                  "Cihaz listesi şifrelenemediği için komut cihazsız: önce cihazları Apple Developer'da (Devices) elle ekle; derleme Apple'daki tüm açık cihazlarla profili yeniler.",
                ),
            ]
          : h('div', 'adm-sub', 'Şu an onaylı cihaz yok.'),
      ),
    );
  }

  if (ci) {
    const [label, tone] = ci.status === 'completed' ? (CI_CONCLUSION[ci.conclusion] ?? [ci.conclusion ?? 'Bitti', 'muted']) : (CI_STATUS[ci.status] ?? [ci.status, 'warn']);
    out.push(
      h(
        'article',
        'adm-card adm-wide',
        h('div', 'adm-label', 'Son derleme'),
        h(
          'div',
          'adm-badges',
          badge(label, tone),
          badge(`${num(ci.udids.length)} cihaz`, 'muted'),
          badge(`başladı ${ago(Date.parse(ci.dispatchedAt), now)}`, 'muted'),
          ci.checkedAt && badge(`denetlendi ${clock(Date.parse(ci.checkedAt), true)}`, 'muted'),
        ),
        ci.url && h('div', 'adm-sub', h('a', { href: ci.url, target: '_blank', rel: 'noopener noreferrer' }, "GitHub'da aç")),
        ci.error && h('div', 'adm-sub', ci.error),
      ),
    );
  }

  const action = (udid, status, text) => {
    const btn = h('button', { type: 'button', class: 'adm-more' }, text);
    btn.addEventListener('click', () => setIosStatus(udid, status, btn));
    return btn;
  };
  const ACTIONS = {
    bekliyor: (d) => [action(d.udid, 'onaylandi', 'Onayla'), action(d.udid, 'reddedildi', 'Reddet')],
    onaylandi: (d) => [action(d.udid, 'bekliyor', 'Geri al'), !auto.enabled && action(d.udid, 'eklendi', 'Eklendi say')],
    eklendi: (d) => [action(d.udid, 'bekliyor', 'Bekliyor yap')],
    reddedildi: (d) => [action(d.udid, 'onaylandi', 'Onayla')],
  };

  out.push(
    panel(
      `Kayıtlı cihazlar (${num(x.devices.length)}) · /udid sayfasından`,
      x.devices.length === 0
        ? h('div', 'adm-sub', 'Henüz kayıt yok. Arkadaşların iPhone\'da Safari ile /udid sayfasını açıp profili yükleyince burada görünür.')
        : h(
            'ul',
            'adm-rows',
            x.devices.map((d) => {
              const [label, tone] = IOS_STATUS[d.status] ?? [d.status, 'muted'];
              return h(
                'li',
                'adm-row adm-row-top adm-ios-row',
                h(
                  'div',
                  'adm-row-main',
                  h('div', 'adm-row-title', d.name || d.deviceName || 'Adsız'),
                  h(
                    'div',
                    'adm-badges',
                    badge(label, tone),
                    d.name && d.deviceName && badge(d.deviceName, 'muted'),
                    d.product && badge(d.product, 'muted'),
                    d.version && badge(`iOS ${d.version}`, 'muted'),
                    badge(`kayıt ${dateTime(Date.parse(d.at))}`, 'muted'),
                    d.statusAt && badge(`${label.toLowerCase()} ${ago(Date.parse(d.statusAt), now)}`, 'muted'),
                  ),
                  h('div', 'adm-sub adm-mono', d.udid),
                ),
                h('div', 'adm-ios-actions', ACTIONS[d.status]?.(d)),
              );
            }),
          ),
    ),
  );
  return out;
}

// ---------- Başlangıç ----------

if (token) {
  show('adm-loading');
  void refresh();
} else {
  show('adm-login');
}
