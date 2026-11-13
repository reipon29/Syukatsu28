'use strict';

const APP_VERSION = '2.3.1';
const STORAGE_KEY = 'syukatsu.v1';

const STATUSES = [
  { id: 'interest',  label: '興味あり',     cls: 'g-pre' },
  { id: 'entry',     label: 'エントリー済', cls: '' },
  { id: 'es',        label: 'ES・書類選考', cls: '' },
  { id: 'test',      label: 'Webテスト',    cls: '' },
  { id: 'gd',        label: 'GD',           cls: '' },
  { id: 'int1',      label: '一次面接',     cls: '' },
  { id: 'int2',      label: '二次面接',     cls: '' },
  { id: 'intf',      label: '最終面接',     cls: '' },
  { id: 'offer',     label: '内定',         cls: 'g-offer' },
  { id: 'declined',  label: '辞退',         cls: 'g-end' },
  { id: 'rejected',  label: 'お見送り',     cls: 'g-end' },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.id, s]));
const IN_PROCESS = new Set(['entry', 'es', 'test', 'gd', 'int1', 'int2', 'intf']);
const ACTIVE_STATUSES = new Set(STATUSES.filter(s => !['declined', 'rejected'].includes(s.id)).map(s => s.id));

const TOKYO = {
  only:   { badge: '東京◎', cls: 'tk-only',   label: '東京勤務が確実' },
  likely: { badge: '東京△', cls: 'tk-likely', label: '東京の可能性あり' },
  no:     { badge: '東京×', cls: 'tk-no',     label: '東京勤務なし' },
};

// 学歴（初任給の自動選択に使う）
const DEGREES = {
  master: { label: '大学院（修士）', re: /大学院|院了|院卒|修士|博士前期|博士課程前期|Master/i },
  doctor: { label: '大学院（博士）', re: /博士(?!前期)|博士後期|ドクター|Ph\.?D/i },
  bachelor: { label: '大学（学部）', re: /大学卒|大卒|学部卒|学士|4年制大学/ },
  junior: { label: '短大・専門・高専', re: /短大|短期大学|専門|高専/ },
};

// 比較できる数値項目（better: 大きいほど良い=high / 小さいほど良い=low）
const METRICS = [
  { key: 'salary',   label: '初任給（月給）',  unit: '円',   better: 'high', fmt: v => v.toLocaleString('ja-JP') + '円' },
  { key: 'housing',  label: '住宅補助（月額）', unit: '円', better: 'high', fmt: v => v.toLocaleString('ja-JP') + '円' },
  { key: 'annual',   label: '想定年収',        unit: '万円', better: 'high', fmt: v => v.toLocaleString('ja-JP') + '万円' },
  { key: 'bonus',    label: '賞与',            unit: 'ヶ月', better: 'high', fmt: v => v + 'ヶ月' },
  { key: 'holidays', label: '年間休日',        unit: '日',   better: 'high', fmt: v => v + '日' },
  { key: 'overtime', label: '月平均残業',      unit: '時間', better: 'low',  fmt: v => v + '時間' },
  { key: 'hiring',   label: '採用予定人数',    unit: '人',   better: 'high', fmt: v => v.toLocaleString('ja-JP') + '人' },
];
const roundFor = (m, v) => (['bonus', 'overtime'].includes(m.key) ? Math.round(v * 10) / 10 : Math.round(v));
const POSTING_TEXT = ['title', 'location', 'job', 'recruiter', 'eligibility', 'startDate', 'contract', 'probation', 'hours', 'holidaysNote',
  'salaryNote', 'bonusNote', 'raise', 'benefits', 'allowances', 'commute', 'note', 'raw'];
const POSTING_FLAGS = [
  { key: 'flex', label: 'フレックス' },
  { key: 'discretionary', label: '裁量労働' },
  { key: 'remote', label: 'リモート可' },
];
const POSTING_NUM = METRICS.map(m => m.key);

/* ---------- storage ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const str = v => (v == null ? '' : String(v));
const numOrNull = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const isCipher = v => v && typeof v === 'object' && typeof v.iv === 'string' && typeof v.ct === 'string';

function normalizePwd(v) {
  if (typeof v === 'string') return v;
  if (isCipher(v)) return { iv: v.iv, ct: v.ct }; // v1.1〜1.2 で暗号化されたもの（引き継ぎ待ち）
  return '';
}
function normalizeEvent(ev) {
  return { id: str(ev.id) || uid(), title: str(ev.title), date: ev.date, time: str(ev.time), place: str(ev.place), done: Boolean(ev.done) };
}
function normalizePosting(p = {}) {
  const out = { id: str(p.id) || uid(), tokyo: TOKYO[p.tokyo] ? p.tokyo : '', applied: Boolean(p.applied), prevYear: Boolean(p.prevYear) };
  POSTING_TEXT.forEach(k => { out[k] = str(p[k]); });
  POSTING_NUM.forEach(k => { out[k] = numOrNull(p[k]); });
  POSTING_FLAGS.forEach(f => { out[f.key] = Boolean(p[f.key]); });
  return out;
}
function postingHasData(p) {
  return POSTING_NUM.some(k => p[k] != null) || POSTING_TEXT.some(k => p[k]) ||
    POSTING_FLAGS.some(f => p[f.key]) || Boolean(p.tokyo) || p.applied;
}
const postingTitle = (p, i) => p.title || `職種${i + 1}`;
function normalizeCompany(c) {
  let postings = Array.isArray(c.postings) ? c.postings.filter(x => x && typeof x === 'object').map(normalizePosting) : [];
  if (!Array.isArray(c.postings) && c.posting && typeof c.posting === 'object') {
    // v1.4 以前（募集要項が1つだけ）からの移行
    const one = normalizePosting(c.posting);
    if (postingHasData(one)) postings = [one];
  }
  return {
    id: str(c.id) || uid(),
    name: str(c.name),
    industry: str(c.industry),
    status: STATUS_MAP[c.status] ? c.status : 'interest',
    priority: [1, 2, 3].includes(Number(c.priority)) ? Number(c.priority) : 2,
    hq: str(c.hq),
    locations: str(c.locations),
    tokyo: TOKYO[c.tokyo] ? c.tokyo : '',
    route: str(c.route),
    url: str(c.url),
    loginId: str(c.loginId),
    pwd: normalizePwd(c.pwd),
    postings,
    memo: str(c.memo),
    history: (Array.isArray(c.history) ? c.history : [])
      .filter(h => h && STATUS_MAP[h.status]).map(h => ({ status: h.status, at: Number(h.at) || Date.now() })),
    notes: (Array.isArray(c.notes) ? c.notes : []).filter(n => n && (n.q || n.a)).map(normalizeNote),
    events: (Array.isArray(c.events) ? c.events : [])
      .filter(ev => ev && ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date))
      .map(normalizeEvent),
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Date.now(),
  };
}
function normalizeNote(n) {
  return { id: str(n.id) || uid(), kind: ['es', 'interview', 'other'].includes(n.kind) ? n.kind : 'es', q: str(n.q), a: str(n.a), memo: str(n.memo), at: Number(n.at) || Date.now() };
}
function normalizeStock(x) {
  return { id: str(x.id) || uid(), title: str(x.title), text: str(x.text), updatedAt: Number(x.updatedAt) || Date.now() };
}
function normalizeAccount(a) {
  return {
    id: str(a.id) || uid(),
    name: str(a.name),
    url: str(a.url),
    loginId: str(a.loginId),
    pwd: normalizePwd(a.pwd),
    memo: str(a.memo),
  };
}
function normalizeState(d) {
  const accounts = (Array.isArray(d.accounts) ? d.accounts : []).filter(a => a && a.name).map(normalizeAccount);
  const ids = new Set(accounts.map(a => a.id));
  const companies = (Array.isArray(d.companies) ? d.companies : []).filter(c => c && typeof c.name === 'string').map(normalizeCompany);
  companies.forEach(c => { if (c.route && c.route !== 'own' && !ids.has(c.route)) c.route = ''; });
  const stock = (Array.isArray(d.stock) ? d.stock : []).filter(x => x && (x.title || x.text)).map(normalizeStock);
  const profile = normalizeProfile(d.profile);
  const v = d.vault;
  const hasCipher = [...companies, ...accounts].some(x => isCipher(x.pwd));
  if (hasCipher && v && typeof v.salt === 'string' && isCipher(v.check)) {
    return { companies, accounts, stock, profile, vault: { salt: v.salt, check: v.check } };
  }
  // 鍵情報がない暗号データは復元できないので破棄
  [...companies, ...accounts].forEach(x => { if (isCipher(x.pwd)) x.pwd = ''; });
  return { companies, accounts, stock, profile };
}
function normalizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const y = Number(p.gradYear);
  return {
    gradYear: y >= 2020 && y <= 2040 ? y : 2028,
    degree: ['master', 'doctor', 'bachelor', 'junior'].includes(p.degree) ? p.degree : 'master',
  };
}

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return { companies: [], accounts: [], stock: [], profile: normalizeProfile() };
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert('保存に失敗しました: ' + e.message);
  }
}

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysFromToday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(dateStr, withYear = false) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${withYear ? y + '/' : ''}${m}/${d}(${wd})`;
}
function relLabel(dateStr) {
  const n = daysFromToday(dateStr);
  if (n === 0) return '今日';
  if (n === 1) return '明日';
  if (n > 1) return `${n}日後`;
  return `${-n}日前`;
}
const evKey = e => e.date + (e.time || '99');
const charCount = t => [...(t || '').replace(/\r?\n/g, '')].length;
const findCompany = id => state.companies.find(c => c.id === id);
function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function nextEvent(c) {
  const today = todayStr();
  return c.events.filter(e => !e.done && e.date >= today).sort((a, b) => evKey(a).localeCompare(evKey(b)))[0];
}
function stars(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }
const TOKYO_RANK = { only: 3, likely: 2, no: 1, '': 0 };
const postingTokyo = (c, p) => p.tokyo || c.tokyo;
/** 会社として一番東京に近い条件（どれか1つの職種でも東京確実なら ◎） */
function bestTokyo(c) {
  const codes = [c.tokyo, ...c.postings.filter(postingHasData).map(p => postingTokyo(c, p))];
  return codes.reduce((best, x) => (TOKYO_RANK[x] > TOKYO_RANK[best] ? x : best), '');
}
function tokyoBadge(c) { return tokyoBadgeCode(bestTokyo(c)); }
function tokyoBadgeCode(code) {
  const t = TOKYO[code];
  return t ? `<span class="badge ${t.cls}" title="${t.label}">${t.badge}</span>` : '';
}
function hasPosting(c) {
  return c.postings.some(postingHasData);
}
function accountById(id) { return state.accounts.find(a => a.id === id); }
function routeName(c) {
  if (c.route === 'own') return '企業HP';
  return accountById(c.route)?.name || '';
}

function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}
async function copyText(text, label) {
  if (!text) { toast(`${label}が未登録です`); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`);
  } catch {
    prompt(`${label}（コピーしてください）`, text);
  }
}

function gcalUrl(ev, companyName) {
  const d = ev.date.replace(/-/g, '');
  let dates;
  if (ev.time) {
    const [h, m] = ev.time.split(':').map(Number);
    const start = `${d}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const end = h + 1 >= 24 ? `${d}T235900` : `${d}T${String(h + 1).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    dates = `${start}/${end}`;
  } else {
    const [y, mo, da] = ev.date.split('-').map(Number);
    const next = new Date(y, mo - 1, da + 1);
    dates = `${d}/${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, '0')}${String(next.getDate()).padStart(2, '0')}`;
  }
  const p = new URLSearchParams({ action: 'TEMPLATE', text: `【${companyName}】${ev.title}`, dates, location: ev.place || '' });
  return `https://calendar.google.com/calendar/render?${p}`;
}

/* ---------- パスワード ---------- */
// パスワードはこの端末の localStorage にそのまま保存する。
const pwText = v => (typeof v === 'string' ? v : '');

/** パスワード入力欄（「表示 / 隠す」切り替え付き） */
function makePwField(root) {
  const input = root.querySelector('input');
  const btn = root.querySelector('[data-act=toggle]');
  let original = '';
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '表示' : '隠す';
  });
  return {
    load(v) {
      original = v;
      input.value = pwText(v);
      input.type = 'password';
      btn.textContent = '表示';
    },
    value() {
      // 引き継ぎ前の暗号データは、空欄のままなら消さずに残す
      if (!input.value && isCipher(original)) return original;
      return input.value;
    },
  };
}
function copyPassword(v) { copyText(pwText(v), 'パスワード'); }

/* ---------- 旧バージョン（マスターパスワード）からの引き継ぎ ---------- */
const VAULT_CHECK = 'syukatsu-vault-ok';
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, saltB64) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decryptWith(key, obj) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.ct));
  return new TextDecoder().decode(pt);
}
const legacyItems = () => [...state.companies, ...state.accounts].filter(x => isCipher(x.pwd));

const vDialog = $('#vault-dialog');
const vForm = $('#vault-form');
function dropLegacy() {
  legacyItems().forEach(x => { x.pwd = ''; });
  delete state.vault;
  save();
}
function migrateLegacy() {
  if (!legacyItems().length) return;
  if (!state.vault || !crypto?.subtle) { dropLegacy(); return; }
  $('#vault-error').hidden = true;
  vForm.reset();
  vDialog.showModal();
}
async function giveUpLegacy() {
  if (!confirm('引き継がない場合、以前保存したパスワードは削除されます（ID・URLなどは残ります）。よろしいですか？')) return;
  dropLegacy();
  vDialog.close();
  toast('パスワードを削除しました');
  render();
}
vDialog.querySelector('[data-close]').addEventListener('click', giveUpLegacy);
vDialog.addEventListener('cancel', e => { e.preventDefault(); giveUpLegacy(); });
vForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const key = await deriveKey(vForm.pass.value, state.vault.salt);
    if (await decryptWith(key, state.vault.check) !== VAULT_CHECK) throw new Error();
    for (const x of legacyItems()) x.pwd = await decryptWith(key, x.pwd);
    delete state.vault;
    save();
    vDialog.close();
    toast('パスワードを引き継ぎました');
    render();
  } catch {
    $('#vault-error').textContent = 'マスターパスワードが違います';
    $('#vault-error').hidden = false;
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ---------- navigation ---------- */
const TITLES = { home: 'ホーム', companies: '企業', schedule: '予定', compare: '比較', more: 'その他', login: 'ログイン情報', es: 'ESストック' };
const SUB_VIEWS = { login: 'more', es: 'more' }; // 「その他」の中の画面
let currentView = 'home';
function showView(name) {
  if (name !== currentView) closeDocked();
  currentView = name;
  document.body.dataset.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  const tab = SUB_VIEWS[name] || name;
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === tab));
  $('#page-title').textContent = TITLES[name];
  $('#back-btn').hidden = !SUB_VIEWS[name];
  $('#fab').hidden = !['home', 'companies', 'es'].includes(name);
  const now = new Date();
  $('#topbar-sub').textContent = name === 'home' ? `${now.getMonth() + 1}月${now.getDate()}日(${WD[now.getDay()]})` : '';
  render();
  window.scrollTo(0, 0);
}
$$('.tabbar button[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$('#back-btn').addEventListener('click', () => showView(SUB_VIEWS[currentView] || 'home'));
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { showView(g.dataset.goto); return; }
  if (e.target.closest('[data-add-company]')) openCompany(null);
});

/* ---------- filters ---------- */
const filterSel = $('#filter-status');
filterSel.innerHTML =
  '<option value="active">選考中のみ</option><option value="all">すべて</option>' +
  STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
$('#status-select').innerHTML = STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
$('#cmp-metric').innerHTML = METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join('');

function fillRouteFilter() {
  const sel = $('#filter-route');
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">経路: すべて</option>' +
    state.accounts.map(a => `<option value="${a.id}">経路: ${esc(a.name)}</option>`).join('') +
    '<option value="own">経路: 企業HP</option><option value="">経路: 未設定</option>';
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
}

const UI_KEY = STORAGE_KEY + '.ui';
// 業界の選択肢
const industryGroupOf = name => INDUSTRY_BY_NAME[name]?.group || (name ? 'その他' : '');
function fillIndustryFilters() {
  const groups = INDUSTRY_GROUPS.map(g => g.group);
  const used = new Set(state.companies.map(c => industryGroupOf(c.industry)));
  const opts = '<option value="all">業界: すべて</option>' +
    groups.filter(g => used.has(g)).map(g => `<option value="${g}">業界: ${g}</option>`).join('') +
    (used.has('その他') ? '<option value="その他">業界: その他</option>' : '') +
    '<option value="">業界: 未設定</option>';
  ['#filter-industry', '#cmp-industry'].forEach(sel => {
    const el = $(sel);
    const cur = el.value || el.dataset.pref || 'all';
    el.innerHTML = opts;
    el.value = [...el.options].some(o => o.value === cur) ? cur : 'all';
  });
}
const matchIndustry = (c, f) => f === 'all' || industryGroupOf(c.industry) === f;
$('#industry-select').innerHTML = '<option value="">わからない・未設定</option>' +
  INDUSTRY_GROUPS.map(g => `<optgroup label="${g.group}">${g.items.map(it => `<option value="${it.name}">${it.name}</option>`).join('')}</optgroup>`).join('') +
  '<option value="__other">その他（自分で入力）</option>';

const uiControls = ['#filter-status', '#sort', '#filter-tokyo', '#cmp-metric', '#cmp-filter', '#filter-industry', '#cmp-industry'];
try {
  const pref = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  uiControls.forEach(sel => { if (pref[sel] != null) { $(sel).value = pref[sel]; $(sel).dataset.pref = pref[sel]; } });
  if (pref.cmpTokyo) $('#cmp-tokyo').checked = true;
} catch { /* ignore */ }
function saveUiPref() {
  const pref = { cmpTokyo: $('#cmp-tokyo').checked };
  uiControls.forEach(sel => { pref[sel] = $(sel).value; });
  try { localStorage.setItem(UI_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
}
$('#search').addEventListener('input', render);
$('#login-search').addEventListener('input', render);
[...uiControls, '#cmp-tokyo', '#filter-route'].forEach(sel => $(sel).addEventListener('change', () => { saveUiPref(); render(); }));
$('#show-done').addEventListener('change', render);

/* ---------- render ---------- */
function render() {
  const fn = { home: renderHome, companies: renderCompanies, schedule: renderSchedule, compare: renderCompare,
    login: renderLogin, more: renderMore, es: renderStock }[currentView];
  fn?.();
}

function matchTokyo(c, f) { return matchTokyoCode(bestTokyo(c), f); }
function matchTokyoCode(code, f) {
  if (f === 'ok') return code === 'only' || code === 'likely';
  if (f === 'only') return code === 'only';
  if (f === 'notno') return code !== 'no';
  return true;
}

function appliedText(c) {
  const ps = c.postings.filter(postingHasData);
  const applied = ps.map((p, i) => ({ p, i })).filter(x => x.p.applied).map(x => postingTitle(x.p, x.i));
  if (applied.length) return `<span class="applied">応募: ${esc(applied.join('・'))}</span>`;
  return ps.length > 1 ? `<span>職種 ${ps.length}件</span>` : '';
}
function renderCompanies() {
  fillRouteFilter();
  fillIndustryFilters();
  const fi = $('#filter-industry').value;
  const q = $('#search').value.trim().toLowerCase();
  const f = filterSel.value;
  const ft = $('#filter-tokyo').value;
  const fr = $('#filter-route').value;
  const sort = $('#sort').value;

  const counts = {};
  state.companies.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const activeCount = state.companies.filter(c => ACTIVE_STATUSES.has(c.status)).length;
  $('#summary').innerHTML =
    `<button data-f="active" class="${f === 'active' ? 'on' : ''}">進行中<b>${activeCount}</b></button>` +
    `<button data-f="all" class="${f === 'all' ? 'on' : ''}">すべて<b>${state.companies.length}</b></button>` +
    STATUSES.filter(s => counts[s.id]).map(s =>
      `<button data-f="${s.id}" class="${f === s.id ? 'on' : ''}">${s.label}<b>${counts[s.id]}</b></button>`).join('');
  const nFilters = [ft !== 'all', fi !== 'all', fr !== 'all'].filter(Boolean).length;
  $('#filter-count').hidden = !nFilters;
  $('#filter-count').textContent = nFilters;

  const list = state.companies.filter(c => {
    if (f === 'active' && !ACTIVE_STATUSES.has(c.status)) return false;
    if (f !== 'active' && f !== 'all' && c.status !== f) return false;
    if (!matchTokyo(c, ft)) return false;
    if (fr !== 'all' && c.route !== fr) return false;
    if (!matchIndustry(c, fi)) return false;
    if (q && !`${c.name} ${c.industry} ${c.hq} ${c.locations} ${c.memo} ${routeName(c)}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const nextKey = c => { const e = nextEvent(c); return e ? evKey(e) : '9999'; };
  const sorters = {
    next: (a, b) => nextKey(a).localeCompare(nextKey(b)) || b.priority - a.priority,
    priority: (a, b) => b.priority - a.priority || nextKey(a).localeCompare(nextKey(b)),
    updated: (a, b) => b.updatedAt - a.updatedAt,
    name: (a, b) => a.name.localeCompare(b.name, 'ja'),
  };
  list.sort(sorters[sort] || sorters.next);

  $('#company-list').innerHTML = list.map(c => {
    const st = STATUS_MAP[c.status] || STATUSES[0];
    const ne = nextEvent(c);
    let nextHtml = '';
    if (ne) {
      const n = daysFromToday(ne.date);
      const cls = n === 0 ? 'today' : n <= 3 ? 'soon' : '';
      nextHtml = `<div class="card-next ${cls}">${esc(ne.title)}・${fmtDate(ne.date)}${ne.time ? ' ' + ne.time : ''}（${relLabel(ne.date)}）</div>`;
    }
    const rn = routeName(c);
    return `<li class="card ${st.cls}" data-id="${c.id}">
      <div class="card-top">
        <span class="card-name">${esc(c.name)}</span>
        ${tokyoBadge(c)}
        <span class="chip ${st.cls}">${st.label}</span>
      </div>
      <div class="card-sub">
        <span class="stars-view">${stars(c.priority)}</span>
        ${c.industry ? `<span>${esc(c.industry)}</span>` : ''}
        ${rn ? `<span>経路: ${esc(rn)}</span>` : ''}
        ${appliedText(c)}
      </div>
      ${nextHtml}
    </li>`;
  }).join('');

  $('#company-empty').hidden = state.companies.length > 0;
  if (typeof markSelected === 'function') markSelected();
  if (state.companies.length > 0 && list.length === 0) {
    $('#company-list').innerHTML = '<p class="empty">該当する企業はありません。</p>';
  }
}

$('#filter-toggle').addEventListener('click', () => { $('#filter-panel').hidden = !$('#filter-panel').hidden; });
$('#summary').addEventListener('click', e => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filterSel.value = b.dataset.f;
  saveUiPref();
  render();
});
$('#company-list').addEventListener('click', e => {
  const li = e.target.closest('.card');
  if (li) openDetail(li.dataset.id);
});

function renderSchedule() {
  const showAll = $('#show-done').checked;
  const today = todayStr();
  const items = [];
  state.companies.forEach(c => c.events.forEach(ev => {
    if (!showAll && (ev.done || ev.date < today)) return;
    items.push({ c, ev });
  }));
  items.sort((a, b) => evKey(a.ev).localeCompare(evKey(b.ev)));

  const groups = new Map();
  items.forEach(it => {
    if (!groups.has(it.ev.date)) groups.set(it.ev.date, []);
    groups.get(it.ev.date).push(it);
  });

  const thisYear = new Date().getFullYear();
  $('#schedule-list').innerHTML = [...groups].map(([date, arr]) => {
    const n = daysFromToday(date);
    const withYear = Number(date.slice(0, 4)) !== thisYear;
    return `<div class="day-group">
      <div class="day-head ${n === 0 ? 'today' : ''}">${fmtDate(date, withYear)}・${relLabel(date)}</div>
      ${arr.map(({ c, ev }) => `
        <div class="sched-item ${ev.done ? 'done' : ''}">
          <input type="checkbox" data-cid="${c.id}" data-eid="${ev.id}" ${ev.done ? 'checked' : ''} aria-label="完了">
          <span class="sched-time">${ev.time || '終日'}</span>
          <div class="sched-main" data-cid="${c.id}">
            <div class="sched-title">${esc(ev.title)}</div>
            <div class="sched-company">${esc(c.name)}${ev.place ? '・' + esc(ev.place) : ''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  }).join('');
  $('#schedule-empty').hidden = items.length > 0;
}
$('#schedule-list').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  const c = state.companies.find(x => x.id === cb.dataset.cid);
  const ev = c?.events.find(x => x.id === cb.dataset.eid);
  if (!ev) return;
  ev.done = cb.checked;
  c.updatedAt = Date.now();
  save();
  setTimeout(render, 250);
});
$('#ics-btn').addEventListener('click', exportIcs);
$('#schedule-list').addEventListener('click', e => {
  const m = e.target.closest('.sched-main');
  if (m) openDetail(m.dataset.cid);
});

/* ---------- 比較 ---------- */
function compareTargets() {
  const f = $('#cmp-filter').value;
  const tokyoOnly = $('#cmp-tokyo').checked;
  const fi = $('#cmp-industry').value;
  const rows = [];
  state.companies
    .filter(c => (f === 'all' || ACTIVE_STATUSES.has(c.status)) && matchIndustry(c, fi))
    .forEach(c => c.postings.forEach((p, i) => {
      if (!postingHasData(p)) return;
      const tk = postingTokyo(c, p);
      if (tokyoOnly && !matchTokyoCode(tk, 'ok')) return;
      const multi = c.postings.filter(postingHasData).length > 1;
      rows.push({ c, p, tk, title: p.title || (multi ? postingTitle(p, i) : '') });
    }));
  return rows;
}
const rowLabel = r => {
  const sub = [r.title, r.p.prevYear ? '前年度' : ''].filter(Boolean).join('・');
  return `${esc(r.c.name)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
};
const rowText = r => r.c.name + (r.title ? `（${r.title}）` : '');
function renderCompare() {
  fillIndustryFilters();
  const metric = METRICS.find(m => m.key === $('#cmp-metric').value) || METRICS[0];
  const rows = compareTargets();
  const hasAny = rows.length > 0;

  $('#cmp-empty').hidden = hasAny;
  $$('#view-compare .panel').forEach(p => { p.hidden = !hasAny; });
  if (!hasAny) return;

  const val = r => r.p[metric.key];
  const cmp = (a, b) => {
    if (val(a) == null) return val(b) == null ? 0 : 1;
    if (val(b) == null) return -1;
    return metric.better === 'low' ? val(a) - val(b) : val(b) - val(a);
  };
  const withVal = rows.filter(r => val(r) != null).sort(cmp);
  const missing = rows.filter(r => val(r) == null);

  $('#cmp-title').textContent = `${metric.label}（${metric.unit}）`;
  $('#cmp-sub').textContent = metric.better === 'low' ? '少ない順に表示' : '多い順に表示';
  const max = Math.max(...withVal.map(val), 0);
  $('#cmp-chart').innerHTML = withVal.length ? withVal.map(r => {
    const v = val(r);
    const pct = max > 0 ? (v / max) * 100 : 0;
    return `<div class="bar-row" data-id="${r.c.id}" data-pid="${r.p.id}" title="${esc(rowText(r))}: ${esc(metric.fmt(v))}">
      <div class="bar-label">${tokyoBadgeCode(r.tk)}<span class="nm">${rowLabel(r)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:calc((100% - 76px) * ${(pct / 100).toFixed(4)})"></div><span class="bar-val">${esc(metric.fmt(v))}</span></div>
    </div>`;
  }).join('') + (withVal.length >= 2
    ? `<div class="bar-avg">平均 ${esc(metric.fmt(roundFor(metric, withVal.reduce((s, r) => s + val(r), 0) / withVal.length)))}（${withVal.length}件）</div>`
    : '')
    : '<p class="note">この項目が入力された職種はありません。</p>';
  $('#cmp-missing').textContent = missing.length ? `未入力: ${missing.map(rowText).join('、')}` : '';

  // 一覧表（各列でいちばん良い値を強調）
  const sorted = [...rows].sort(cmp);
  const best = {};
  METRICS.forEach(m => {
    const vals = sorted.map(r => r.p[m.key]).filter(v => v != null);
    if (vals.length >= 2) best[m.key] = m.better === 'low' ? Math.min(...vals) : Math.max(...vals);
  });
  $('#cmp-table').innerHTML =
    `<thead><tr><th>企業／職種</th><th>東京</th>${METRICS.map(m => `<th>${m.label}</th>`).join('')}<th>働き方</th><th>勤務地</th><th>本社</th></tr></thead>
    <tbody>${sorted.map(r => `<tr data-id="${r.c.id}" data-pid="${r.p.id}">
      <td>${rowLabel(r)}</td>
      <td class="l">${TOKYO[r.tk]?.badge || '-'}</td>
      ${METRICS.map(m => {
        const v = r.p[m.key];
        return `<td class="${v != null && v === best[m.key] ? 'best' : ''}">${v == null ? '-' : esc(m.fmt(v))}</td>`;
      }).join('')}
      <td class="l">${POSTING_FLAGS.filter(f => r.p[f.key]).map(f => f.label).join('・') || '-'}</td>
      <td class="l" title="${esc(r.p.location || r.c.locations)}">${esc((r.p.location || r.c.locations).split('\n')[0]) || '-'}</td>
      <td class="l">${esc(r.c.hq) || '-'}</td>
    </tr>`).join('')}</tbody>`;
}
$('#cmp-chart').addEventListener('click', e => {
  const r = e.target.closest('.bar-row');
  if (r) openDetail(r.dataset.id, r.dataset.pid);
});
$('#cmp-table').addEventListener('click', e => {
  const r = e.target.closest('tr[data-id]');
  if (r) openDetail(r.dataset.id, r.dataset.pid);
});

/* ---------- ログイン ---------- */
function renderLogin() {
  const q = $('#login-search').value.trim().toLowerCase();
  const hit = s => !q || s.toLowerCase().includes(q);

  const accs = state.accounts.filter(a => hit(a.name) ||
    state.companies.some(c => c.route === a.id && hit(c.name)));
  $('#account-list').innerHTML = accs.length ? accs.map(a => {
    const linked = state.companies.filter(c => c.route === a.id);
    const url = safeUrl(a.url);
    return `<div class="login-card">
      <div class="lc-top"><span class="lc-name" data-edit-account="${a.id}">${esc(a.name)}</span>
        <button class="link small" data-edit-account="${a.id}">編集</button></div>
      ${a.loginId ? `<div class="lc-sub">ID: ${esc(a.loginId)}</div>` : ''}
      ${a.memo ? `<div class="lc-sub">${esc(a.memo)}</div>` : ''}
      <div class="actions">
        ${url ? `<a class="primary" href="${esc(url)}" target="_blank" rel="noopener">開く ↗</a>` : ''}
        <button data-copy-id="a:${a.id}">IDコピー</button>
        <button data-copy-pw="a:${a.id}">PWコピー${a.pwd ? '' : '（未登録）'}</button>
      </div>
      ${linked.length ? `<div class="lc-sub">この経路で応募した企業（${linked.length}社）</div>
        <div class="chips">${linked.map(c => `<span data-open-company="${c.id}">${esc(c.name)}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('') : `<p class="note">${state.accounts.length ? '該当なし' : 'マイナビ・リクナビなど、使っている就活サービスを登録しておくと、各企業にどこから応募したかを紐づけられます。'}</p>`;

  const comps = state.companies
    .filter(c => (c.url || c.loginId || c.pwd || c.route) && (hit(c.name) || hit(routeName(c))))
    .sort((a, b) => (ACTIVE_STATUSES.has(b.status) - ACTIVE_STATUSES.has(a.status)) || a.name.localeCompare(b.name, 'ja'));
  $('#login-company-list').innerHTML = comps.length ? comps.map(c => {
    const url = safeUrl(c.url);
    const rn = routeName(c);
    const acc = accountById(c.route);
    return `<div class="login-card">
      <div class="lc-top"><span class="lc-name" data-open-company="${c.id}">${esc(c.name)}</span>
        <span class="chip ${STATUS_MAP[c.status].cls}">${STATUS_MAP[c.status].label}</span></div>
      <div class="lc-sub">経路: ${rn ? esc(rn) : '未設定'}${c.loginId ? `　/　マイページID: ${esc(c.loginId)}` : ''}</div>
      <div class="actions">
        ${url ? `<a class="primary" href="${esc(url)}" target="_blank" rel="noopener">マイページ ↗</a>` : ''}
        ${c.loginId ? `<button data-copy-id="c:${c.id}">IDコピー</button>` : ''}
        ${c.pwd ? `<button data-copy-pw="c:${c.id}">PWコピー</button>` : ''}
        ${acc && safeUrl(acc.url) ? `<a href="${esc(acc.url)}" target="_blank" rel="noopener">${esc(acc.name)} ↗</a>` : ''}
      </div>
    </div>`;
  }).join('') : `<p class="note">${q ? '該当なし' : '企業の詳細画面で「エントリー経路」やマイページ情報を登録するとここに表示されます。'}</p>`;
}
function itemFromRef(ref) {
  const [kind, id] = ref.split(':');
  return kind === 'a' ? accountById(id) : state.companies.find(c => c.id === id);
}
$('#view-login').addEventListener('click', e => {
  const t = e.target.closest('[data-edit-account],[data-copy-id],[data-copy-pw],[data-open-company]');
  if (!t) return;
  if (t.dataset.editAccount) openAccount(t.dataset.editAccount);
  else if (t.dataset.openCompany) openDetail(t.dataset.openCompany);
  else if (t.dataset.copyId) copyText(itemFromRef(t.dataset.copyId)?.loginId, 'ID');
  else if (t.dataset.copyPw) copyPassword(itemFromRef(t.dataset.copyPw)?.pwd);
});
$('#add-account').addEventListener('click', () => openAccount(null));

/* ---------- その他 ---------- */
function renderMore() {
  $('#version').textContent = 'バージョン ' + APP_VERSION;
  $('#profile-year').value = state.profile.gradYear;
  $('#profile-degree').value = state.profile.degree;
}
(() => {
  const y = new Date().getFullYear();
  $('#profile-year').innerHTML = Array.from({ length: 6 }, (_, i) => y - 1 + i)
    .map(v => `<option value="${v}">${v}年3月卒業（${String(v).slice(2)}卒）</option>`).join('');
  $('#profile-degree').innerHTML = Object.entries(DEGREES).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
})();
['#profile-year', '#profile-degree'].forEach(sel => $(sel).addEventListener('change', () => {
  state.profile = normalizeProfile({ gradYear: $('#profile-year').value, degree: $('#profile-degree').value });
  save();
  toast('保存しました');
}));

/* ---------- company dialog ---------- */
const cDialog = $('#company-dialog');
const cForm = $('#company-form');
const companyPw = makePwField($('#company-pw'));
let editing = null;

function setPriority(v) {
  cForm.priority.value = v;
  $$('#priority-input button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) <= v));
}
$('#priority-input').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setPriority(Number(b.dataset.v));
});

function fillRouteSelect(selected) {
  const sel = $('#route-select');
  sel.innerHTML = '<option value="">未設定</option>' +
    state.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('') +
    '<option value="own">企業HP・直接応募</option><option value="__new">＋ 就活サービスを追加…</option>';
  sel.value = selected;
  updateRouteInfo();
}
function updateRouteInfo() {
  const acc = accountById($('#route-select').value);
  const box = $('#route-info');
  box.hidden = !acc;
  if (!acc) return;
  const url = safeUrl(acc.url);
  box.innerHTML = `<span>${esc(acc.name)}${acc.loginId ? ` ID: ${esc(acc.loginId)}` : ''}</span>
    ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">開く ↗</a>` : ''}
    <button type="button" data-copy-id>IDコピー</button>
    <button type="button" data-copy-pw>PWコピー</button>`;
}
$('#route-info').addEventListener('click', e => {
  const acc = accountById($('#route-select').value);
  if (!acc) return;
  if (e.target.closest('[data-copy-id]')) copyText(acc.loginId, 'ID');
  if (e.target.closest('[data-copy-pw]')) copyPassword(acc.pwd);
});
$('#route-select').addEventListener('change', async e => {
  if (e.target.value !== '__new') { updateRouteInfo(); return; }
  const id = await openAccount(null);
  fillRouteSelect(id || editing.route || '');
});

function updateTokyoHint() {
  const hint = $('#tokyo-hint');
  const text = cForm.hq.value + ' ' + cForm.locations.value;
  if (!cForm.tokyo.value && /東京|都内/.test(text)) {
    hint.textContent = '💡 勤務地に東京が含まれています。「東京で働ける？」を設定しておくと絞り込み・比較で使えます。';
    hint.hidden = false;
  } else hint.hidden = true;
}
['hq', 'locations', 'tokyo'].forEach(n => cForm[n].addEventListener('input', updateTokyoHint));

function updateOpenUrl() {
  const v = safeUrl(cForm.url.value.trim());
  const a = $('#open-url');
  a.hidden = !v;
  a.href = v || '#';
}
cForm.url.addEventListener('input', updateOpenUrl);

function openCompany(id, postingId) {
  const src = id ? state.companies.find(c => c.id === id) : null;
  editing = src ? structuredClone(src) : normalizeCompany({ name: '', createdAt: Date.now() });
  $('#company-dialog-title').textContent = src ? '企業を編集' : '企業を追加';
  ['name', 'status', 'hq', 'locations', 'tokyo', 'url', 'loginId', 'memo'].forEach(k => { cForm[k].value = editing[k]; });
  setIndustry(editing.industry);
  if (!editing.postings.length) editing.postings.push(normalizePosting());
  curPosting = Math.max(0, editing.postings.findIndex(p => p.id === postingId));
  loadPostingForm();
  $('#posting-section').open = hasPosting(editing) || Boolean(postingId) || wideMQ.matches;
  setPriority(editing.priority);
  fillRouteSelect(editing.route);
  companyPw.load(editing.pwd);
  updateOpenUrl();
  updateTokyoHint();
  $('#delete-company').hidden = !src;
  cDialog.showModal();
  cDialog.querySelector('.dialog-body').scrollTop = 0;
  if (!src) setTimeout(() => cForm.name.focus(), 50);
}

/* ---------- 業界の選択・推定 ---------- */
function setIndustry(name) {
  const sel = $('#industry-select');
  if (!name) sel.value = '';
  else if (INDUSTRY_BY_NAME[name]) sel.value = name;
  else { sel.value = '__other'; cForm.industryOther.value = name; }
  if (sel.value !== '__other') cForm.industryOther.value = '';
  updateIndustryUi();
}
function currentIndustry() {
  const v = $('#industry-select').value;
  return v === '__other' ? cForm.industryOther.value.trim() : v;
}
function industryGuessText() {
  return [cForm.name.value, cForm.p_job.value, cForm.p_raw.value, cForm.p_recruiter.value].join('\n');
}
function updateIndustryUi() {
  const sel = $('#industry-select');
  cForm.industryOther.hidden = sel.value !== '__other';
  const it = INDUSTRY_BY_NAME[sel.value];
  const info = $('#industry-info');
  info.hidden = !it;
  if (it) {
    info.innerHTML = `<div class="ii-group">${esc(it.group)}</div><div>${esc(it.desc)}</div><div class="ii-jobs">主な仕事: ${esc(it.jobs)}</div>`;
  }
  // 募集要項などからの推定（未設定のときだけ候補を出す）
  const box = $('#industry-suggest');
  const guesses = sel.value ? [] : guessIndustries(industryGuessText()).slice(0, 3);
  box.hidden = !guesses.length;
  box.innerHTML = guesses.length ? '募集要項から推定: ' +
    guesses.map(g => `<button type="button" data-v="${esc(g.name)}">${esc(g.name)}</button>`).join('') : '';
}
$('#industry-select').addEventListener('change', updateIndustryUi);
$('#industry-suggest').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) setIndustry(b.dataset.v);
});
['name', 'p_job'].forEach(n => cForm[n].addEventListener('change', updateIndustryUi));

/* ---------- 業界ガイド ---------- */
const gDialog = $('#guide-dialog');
let guidePickable = false;
function openGuide(pickable) {
  guidePickable = pickable;
  const current = pickable ? currentIndustry() : '';
  const byIndustry = {};
  state.companies.forEach(c => { if (c.industry) (byIndustry[c.industry] ||= []).push(c); });
  $('#guide-body').innerHTML =
    `<p class="note">${pickable ? '当てはまる業界をタップすると選択されます。' : '登録している企業がある業界には企業名が表示されます。'}迷ったら、企業の「主な事業（何を売って利益を得ているか）」で考えるのがコツです。</p>` +
    INDUSTRY_GROUPS.map(g => `<div class="guide-group"><h3>${esc(g.group)}</h3><p>${esc(g.note)}</p></div>` +
      g.items.map(it => {
        const cs = byIndustry[it.name] || [];
        return `<div class="guide-item ${pickable ? 'pickable' : ''} ${current === it.name ? 'current' : ''}" data-name="${esc(it.name)}">
          <div class="gi-name"><span>${esc(it.name)}</span>${pickable ? `<span class="gi-pick">${current === it.name ? '選択中' : 'これにする'}</span>` : ''}</div>
          <div class="gi-desc">${esc(it.desc)}</div>
          <div class="gi-jobs">主な仕事: ${esc(it.jobs)}</div>
          ${cs.length ? `<div class="chips">${cs.map(c => `<span>${esc(c.name)}</span>`).join('')}</div>` : ''}
        </div>`;
      }).join('')).join('');
  gDialog.showModal();
  const cur = $('#guide-body .current');
  if (cur) cur.scrollIntoView({ block: 'center' });
  else gDialog.querySelector('.dialog-body').scrollTop = 0;
}
$$('[data-open-guide]').forEach(b => b.addEventListener('click', () => openGuide(Boolean(b.closest('#company-dialog')))));
gDialog.querySelector('[data-close]').addEventListener('click', () => gDialog.close());
$('#guide-body').addEventListener('click', e => {
  const item = e.target.closest('.guide-item');
  if (!item || !guidePickable) return;
  setIndustry(item.dataset.name);
  gDialog.close();
});

/* ---------- 職種（募集要項）タブ ---------- */
let curPosting = 0;
function loadPostingForm() {
  const p = editing.postings[curPosting];
  POSTING_TEXT.forEach(k => { cForm['p_' + k].value = p[k]; });
  POSTING_NUM.forEach(k => { cForm['p_' + k].value = p[k] ?? ''; });
  POSTING_FLAGS.forEach(f => { cForm['p_' + f.key].checked = p[f.key]; });
  cForm.p_tokyo.value = p.tokyo;
  cForm.p_applied.checked = p.applied;
  cForm.p_prevYear.checked = p.prevYear;
  showSalaryCandidates();
  renderPostingTabs();
}
function savePostingForm() {
  const p = editing.postings[curPosting];
  if (!p) return;
  POSTING_TEXT.forEach(k => { p[k] = cForm['p_' + k].value.trim(); });
  POSTING_NUM.forEach(k => { p[k] = numOrNull(cForm['p_' + k].value); });
  POSTING_FLAGS.forEach(f => { p[f.key] = cForm['p_' + f.key].checked; });
  p.tokyo = cForm.p_tokyo.value;
  p.applied = cForm.p_applied.checked;
  p.prevYear = cForm.p_prevYear.checked;
}
function renderPostingTabs() {
  const ps = editing.postings;
  $('#posting-tabs').innerHTML = ps.map((p, i) => {
    const title = i === curPosting ? (cForm.p_title.value.trim() || postingTitle(p, i)) : postingTitle(p, i);
    const applied = i === curPosting ? cForm.p_applied.checked : p.applied;
    return `<button type="button" data-i="${i}" class="${i === curPosting ? 'on' : ''}">${esc(title)}${applied ? ' ✓' : ''}</button>`;
  }).join('') + '<button type="button" class="add" data-add>＋ 職種を追加</button>';
  $('#delete-posting').hidden = ps.length <= 1 && !postingHasData(ps[0] || {});
  const target = $('#paste-target');
  target.hidden = ps.length <= 1;
  target.textContent = `→ 選択中の職種「${cForm.p_title.value.trim() || postingTitle(ps[curPosting], curPosting)}」に入力されます`;
}
function switchPosting(i) {
  savePostingForm();
  curPosting = i;
  loadPostingForm();
}
function addPosting(copy) {
  savePostingForm();
  const base = copy ? { ...editing.postings[curPosting], id: '', applied: false, raw: '' } : {};
  if (copy) base.title = base.title ? base.title + '（コピー）' : '';
  editing.postings.push(normalizePosting(base));
  curPosting = editing.postings.length - 1;
  loadPostingForm();
  $('#posting-section').open = true;
  cForm.p_title.focus();
  cForm.p_title.select();
}
$('#posting-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add != null) addPosting(false);
  else if (Number(b.dataset.i) !== curPosting) switchPosting(Number(b.dataset.i));
});
$('#copy-posting').addEventListener('click', () => addPosting(true));
$('#delete-posting').addEventListener('click', () => {
  const name = cForm.p_title.value.trim() || postingTitle(editing.postings[curPosting], curPosting);
  if (!confirm(`職種「${name}」の内容を削除しますか？`)) return;
  editing.postings.splice(curPosting, 1);
  if (!editing.postings.length) editing.postings.push(normalizePosting());
  curPosting = Math.min(curPosting, editing.postings.length - 1);
  loadPostingForm();
});
cForm.p_title.addEventListener('input', renderPostingTabs);
cForm.p_applied.addEventListener('change', renderPostingTabs);

function readCompanyForm() {
  ['name', 'hq', 'locations', 'url', 'loginId'].forEach(k => { editing[k] = cForm[k].value.trim(); });
  editing.industry = currentIndustry();
  editing.status = cForm.status.value;
  editing.tokyo = cForm.tokyo.value;
  const r = cForm.route.value;
  editing.route = r === '__new' ? '' : r;
  editing.priority = Number(cForm.priority.value) || 2;
  editing.memo = cForm.memo.value;
  savePostingForm();
  editing.pwd = companyPw.value();
}

cForm.addEventListener('submit', async e => {
  e.preventDefault();
  readCompanyForm();
  if (!editing.name) { cForm.name.focus(); return; }
  editing.updatedAt = Date.now();
  editing.postings = editing.postings.filter(postingHasData);
  const idx = state.companies.findIndex(c => c.id === editing.id);
  // ステータスが変わったら選考履歴に記録
  const prev = idx >= 0 ? state.companies[idx].status : null;
  if (prev !== editing.status) editing.history.push({ status: editing.status, at: Date.now() });
  if (idx >= 0) state.companies[idx] = editing; else state.companies.push(editing);
  save();
  cDialog.close();
  toast('保存しました');
  render();
  openDetail(editing.id);
});

function hasUnsavedChanges() {
  readCompanyForm();
  const orig = state.companies.find(c => c.id === editing.id);
  if (!orig) return Boolean(editing.name || editing.memo || editing.events.length);
  const strip = o => JSON.stringify({ ...o, updatedAt: 0, postings: o.postings.filter(postingHasData) });
  return strip(orig) !== strip(editing);
}
function tryCloseCompany() {
  if (hasUnsavedChanges() && !confirm('変更が保存されていません。破棄して閉じますか？')) return;
  cDialog.close();
  if (findCompany(editing.id)) openDetail(editing.id); // 詳細から開いた場合は詳細に戻る
}
cDialog.querySelector('[data-close]').addEventListener('click', tryCloseCompany);
cDialog.addEventListener('cancel', e => { e.preventDefault(); tryCloseCompany(); });

$('#delete-company').addEventListener('click', () => {
  if (!confirm(`「${editing.name}」を削除しますか？\n登録した予定やログイン情報も削除されます。`)) return;
  state.companies = state.companies.filter(c => c.id !== editing.id);
  save();
  cDialog.close();
  toast('削除しました');
  render();
});

/* ---------- 募集要項の読み取り ---------- */
// 見出し行（「勤務地」「初任給」など）で区切って各項目に振り分ける
const POSTING_LABELS = [
  ['recruiter',    ['募集者の名称', '募集者', '募集企業', '採用企業', '会社名']],
  ['job',          ['募集職種', '職種', '募集コース', 'コース', '仕事内容', '業務内容']],
  ['eligibility',  ['応募資格', '応募対象', '対象', '対象者', '募集対象', '応募条件', '応募要件', '必須スキル・経験', '必須スキル', '必須条件', '必須要件', '必須経験']],
  ['startDate',    ['入社時期', '入社日', '入社予定日']],
  ['contract',     ['契約期間', '雇用形態', '勤務形態', '雇用区分']],
  ['probation',    ['試用期間']],
  ['locations',    ['勤務地', '勤務場所', '就業場所', '勤務予定地', '配属先']],
  ['hours',        ['勤務時間', '就業時間', '勤務体系']],
  ['salaryNote',   ['初任給', '給与', '給与・待遇', '基本給', '月給', '給与（月給）', '想定給与', '給与条件', '想定年収', '年俸', '報酬', '給与・報酬']],
  ['benefits',     ['福利厚生', '待遇', '社会保険', '待遇・福利厚生', '研修制度', '教育制度', '研修']],
  ['allowances',   ['諸手当', '手当']],
  ['commute',      ['通勤費', '交通費', '通勤手当']],
  ['raise',        ['昇給', '査定', '昇給・賞与']],
  ['bonusNote',    ['賞与', 'ボーナス']],
  ['holidaysNote', ['休日休暇', '休日・休暇', '休日', '休暇', '年間休日']],
  ['hiring',       ['採用予定人数', '募集人数', '採用人数', '採用予定数', '定員', '募集定員']],
  ['hq',           ['本社所在地', '所在地', '本社']],
  ['note',         ['選考フロー', '選考方法', '選考プロセス', '提出書類', '選考の流れ', '応募方法', '選考ステップ']],
  // 読み取らない見出し（前の項目に混ざらないよう区切りとして使う）
  ['_skip',        ['求める人物像', 'ポジションの魅力', '歓迎スキル', '歓迎スキル・経験', '歓迎条件', '歓迎要件', '歓迎経験',
                    '募集拠点', '設立', '資本金', '称号', '商号', '従業員数', '代表者', '売上高', '業務概要']],
];
// 1〜2行で終わるはずの項目（ページ末尾のメニューなどを取り込まないよう行数を制限）
const SHORT_FIELDS = new Set(['hq', 'recruiter', 'startDate', 'contract', 'probation', 'commute', 'raise', 'bonusNote', 'holidaysNote', 'hiring', 'allowances']);

// 募集要項ではない見出し（ここで読み取りを止める）
const STOP_LABELS = ['社風', '企業理念', '経営理念', '会社概要', '企業情報', '会社情報', 'メッセージ', 'よくある質問', 'FAQ',
  'お問い合わせ', '問い合わせ先', '社員紹介', '社員インタビュー', 'インタビュー', '働く環境', 'キャリアパス', '事業内容',
  'プライバシーポリシー', '個人情報の取り扱い', 'ENTRY', 'エントリー', 'MYPAGE', 'マイページ', '採用担当より',
  '採用情報', '関連求人', '求人一覧', '応募する', 'この求人に応募する'];
// 「賞与 年2回」のように、見出しと内容が1行に並んだ行（別の項目の中にあっても振り分ける）
const INLINE_LABELS = [
  ['bonusNote', ['賞与', 'ボーナス']],
  ['raise', ['昇給', '査定']],
  ['probation', ['試用期間']],
  ['commute', ['通勤費', '交通費']],
  ['holidaysNote', ['年間休日']],
];
function matchInline(line) {
  for (const [field, labels] of INLINE_LABELS) {
    for (const l of labels) {
      if (line.startsWith(l) && /^[\s:：]+\S/.test(line.slice(l.length))) return { field, text: line };
    }
  }
  return null;
}
const isStop = line => STOP_LABELS.includes(line.replace(/[\s:：]+$/, ''));
function labelField(t, exactOnly = false) {
  for (const [field, labels] of POSTING_LABELS) {
    for (const l of labels) {
      if (t === l) return field;
      if (!exactOnly && t.startsWith(l) && /^[（(]/.test(t.slice(l.length)) && t.length <= l.length + 14) return field;
    }
  }
  return null;
}
function matchLabel(line) {
  let t = line.replace(/[\s:：]+$/, '');
  // 【基本給】 大学院了：277,000円 のように、見出しと内容が1行にある
  const br = t.match(/^[【\[［]\s*([^】\]］]{1,12}?)\s*[】\]］][\s:：]*(.*)$/);
  if (br) {
    const f = labelField(br[1]);
    if (f) return { field: f, rest: br[2] };
    // 【その他】 ○○ のように内容つきの知らない見出しは「その他」欄へ
    return br[2] ? { field: 'note', rest: line.trim() } : null;
  }
  t = t.replace(/^[■●◆▼◇□]\s*/, '');
  const f = labelField(t);
  if (f) return { field: f, rest: '' };
  // 「応募方法 一次選考について」「賞与 年2回」のようなスペース区切り
  const sp = t.match(/^(\S{2,10}?)[\s:：]+(.+)$/);
  if (sp) {
    const f2 = labelField(sp[1], true);
    if (f2) return { field: f2, rest: sp[2] };
  }
  return null;
}

/** 「、」で区切る（カッコの中の「、」では区切らない） */
function splitTopLevel(line) {
  const out = [];
  let depth = 0, buf = '';
  for (const ch of line) {
    if ('（(「'.includes(ch)) depth++;
    if ('）)」'.includes(ch)) depth = Math.max(0, depth - 1);
    if ((ch === '、' || ch === ',') && depth === 0) { out.push(buf.trim()); buf = ''; } else buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parsePosting(raw) {
  const segs = []; // [{ field, lines }]
  const inline = [];
  let cur = null;
  for (let line of raw.replace(/\r/g, '').split('\n')) {
    // 「見出し<TAB>内容」の表形式にも対応
    const tab = line.split('\t').map(x => x.replace(/[\s\u3000]+/g, ' ').trim());
    line = tab.filter(Boolean).join(' ');
    if (!line) continue;
    const m = matchLabel(tab[0]);
    if (m) {
      cur = { field: m.field, lines: [] };
      segs.push(cur);
      const rest = [m.rest, ...tab.slice(1)].join(' ').trim();
      if (rest) cur.lines.push(rest);
      continue;
    }
    if (isStop(line) || isStop(tab[0])) { cur = null; continue; }
    const il = cur && matchInline(line);
    if (il) { inline.push(il); continue; }
    if (cur) cur.lines.push(line);
  }
  segs.forEach((seg, i) => {
    let lines = seg.lines.slice(0, SHORT_FIELDS.has(seg.field) ? 3 : 20);
    // 最後の項目にはページ末尾のメニュー（短く数字のない行）が続きやすいので、そこで切る
    if (i === segs.length - 1) {
      const cut = lines.findIndex((l, j) => j > 0 && l.length <= 12 && !/\d/.test(l));
      if (cut > 0) lines = lines.slice(0, cut);
    }
    seg.lines = lines;
  });
  const out = {};
  segs.forEach(({ field, lines }) => {
    if (!lines.length || field === '_skip') return;
    out[field] = out[field] ? out[field] + '\n' + lines.join('\n') : lines.join('\n');
  });
  inline.forEach(({ field, text }) => { out[field] = out[field] ? out[field] + '\n' + text : text; });
  // 「昇給年1回（6月）、賞与年2回（7月、12月）」のように1行に並んでいるものを拾う
  for (const line of raw.split('\n')) {
    for (const piece of splitTopLevel(line.replace(/^[【\[［][^】\]］]*[】\]］]/, '').trim())) {
      if (!out.raise && /^昇給/.test(piece)) out.raise = piece;
      if (!out.bonusNote && /^賞与/.test(piece)) out.bonusNote = piece;
    }
  }
  // 「業績により業績賞与の支給あり」のように文中に出てくるもの
  for (const line of raw.split('\n').map(l => l.trim())) {
    if (!out.bonusNote && /賞与/.test(line) && line.length <= 40 && !/^[【\[［■]/.test(line)) out.bonusNote = line;
    if (!out.raise && /昇給/.test(line) && line.length <= 40 && !/^[【\[［■]/.test(line)) out.raise = line;
  }
  return out;
}

const toYen = (n, man) => Math.round(Number(String(n).replace(/,/g, '')) * (man ? 10000 : 1));
function yenAmounts(text) {
  const res = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万)?\s*円/g;
  let m;
  while ((m = re.exec(text || ''))) res.push(toYen(m[1], m[2]));
  return res;
}
function salaryCandidates(text) {
  return [...new Set(yenAmounts(text).filter(v => v >= 150000 && v <= 1500000))];
}
/** 初任給の詳細から、自分の学歴の行の金額を探す */
function salaryForDegree(text, degree) {
  const re = DEGREES[degree]?.re;
  if (!re || !text) return null;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const amt = salaryCandidates(line.slice(m.index))[0];
    if (amt) return amt;
  }
  // 博士の記載がなければ修士の金額を使う
  return degree === 'doctor' ? salaryForDegree(text, 'master') : null;
}
function showSalaryCandidates() {
  const box = $('#salary-candidates');
  const text = cForm.p_salaryNote.value;
  const cands = salaryCandidates(text);
  const mine = salaryForDegree(text, state.profile.degree);
  box.hidden = cands.length < 2;
  box.innerHTML = cands.length < 2 ? '' : '詳細にある金額から選ぶ: ' +
    cands.map(v => `<button type="button" data-v="${v}" class="${v === mine ? 'mine' : ''}">${v === mine ? '★ ' : ''}${v.toLocaleString('ja-JP')}円</button>`).join('') +
    (mine ? `<span>★ = ${DEGREES[state.profile.degree].label}</span>` : '');
}
$('#salary-candidates').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) { cForm.p_salary.value = b.dataset.v; toast('比較用の初任給にセットしました'); }
});
cForm.p_salaryNote.addEventListener('input', showSalaryCandidates);

/** 前年度（1つ上の学年向け）の募集要項か */
function isPrevYearPosting(raw, gradYear) {
  const pat = y => new RegExp(`${y}年(?:度|卒|3月)|${String(y).slice(2)}卒|${y}年\\s*3月`);
  return pat(gradYear - 1).test(raw) && !pat(gradYear).test(raw);
}
function applyPosting(auto = false) {
  const raw = cForm.p_raw.value;
  if (!raw.trim()) { if (!auto) toast('募集要項のテキストを貼り付けてください'); return; }
  const parsed = parsePosting(raw);
  const values = {}; // フォーム要素名 → 値
  for (const [field, text] of Object.entries(parsed)) {
    // 職種が複数あるときは、その職種の勤務地として入れる
    if (field === 'locations') values[editing.postings.length > 1 ? 'p_location' : 'locations'] = text;
    else if (field === 'hiring') {
      const n = text.match(/(\d+)\s*(?:名|人)/);
      if (n) values.p_hiring = n[1];
      values.p_note = (values.p_note ? values.p_note + '\n' : '') + '採用予定人数: ' + text;
    } else if (field === 'note') values.p_note = (values.p_note ? values.p_note + '\n' : '') + text;
    else if (field === 'hq') {
      const hq = text.split('\n').map(l => l.replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim()).filter(Boolean).join(' ');
      if (hq) values.hq = hq;
    }
    else values['p_' + field] = text;
  }
  // 数値の抽出
  const sal = salaryCandidates(parsed.salaryNote);
  const mySal = sal.length > 1 ? salaryForDegree(parsed.salaryNote, state.profile.degree) : null;
  if (sal.length === 1) values.p_salary = sal[0];
  else if (mySal) values.p_salary = mySal;
  // 年俸・想定年収（万円で入力）
  const annualM = (parsed.salaryNote || raw).match(/(?:年俸|想定年収|年収)[^\d\n]{0,8}(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万)?\s*円/);
  const annual = annualM ? toYen(annualM[1], annualM[2]) : 0;
  if (annual >= 1500000 && annual <= 30000000) values.p_annual = Math.round(annual / 10000);
  const fixedOt = /(?:見込み|みなし|固定)残業/.test(parsed.salaryNote || raw);
  // 企業名（「〇〇株式会社」だけの行）
  if (!cForm.name.value.trim()) {
    const nm = raw.split('\n').map(l => l.split('\t').pop().trim())
      .find(l => /^(?:株式会社\S{1,25}|\S{1,25}株式会社)$/.test(l) && !/採用|求人/.test(l));
    if (nm) values.name = nm;
  }
  // 職種名（「2028年新卒エンジニア職」など）
  if (!cForm.p_title.value) {
    const t = raw.split('\n').map(l => l.trim()).find(l => l.length <= 30 && !/株式会社|求人一覧/.test(l) && /新卒.*(?:職|コース|採用)$/.test(l));
    if (t) values.p_title = t;
  }
  const housing = (raw.match(/住宅(?:補助|手当)[^\n]*?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万)?\s*円/) || []);
  if (housing[1]) values.p_housing = toYen(housing[1], housing[2]);
  const bonus = (parsed.bonusNote || '').match(/(\d+(?:\.\d+)?)\s*(?:ヶ月|か月|カ月|ヵ月|ケ月)/);
  if (bonus) values.p_bonus = bonus[1];
  const hol = raw.match(/年間休日[^\d\n]{0,10}(\d{2,3})\s*日/);
  if (hol) values.p_holidays = hol[1];
  const ot = raw.match(/(?:月平均)?残業[^\d\n]{0,10}(\d{1,3}(?:\.\d)?)\s*時間/);
  if (ot) values.p_overtime = ot[1];
  if (!cForm.hq.value) {
    const hq = raw.match(/本社(?:所在地)?(?:の|は|：|:)?\s*((?:東京都|北海道|京都府|大阪府|[^\s、,。]{2,3}県)[^\s、,。（(]*?)(?=など|[\s、,。（(]|$)/);
    if (hq) values.hq = hq[1];
  }
  if (!values.p_probation) {
    const pr = raw.match(/試用期間(?:あり|有り?)[^）)\n]{0,40}/);
    if (pr) values.p_probation = pr[0].replace(/[。、\s]+$/, '');
  }
  if (!cForm.hq.value && !values.hq) {
    const line = (parsed.locations || '').split('\n').find(l => /本社/.test(l));
    if (line) values.hq = line;
  }
  const flags = {
    p_flex: /フレックス|フレキシブル|コアタイム/.test(raw),
    p_discretionary: /裁量労働/.test(raw),
    p_remote: /リモート|在宅|テレワーク/.test(raw),
  };

  const names = Object.keys(values);
  if (!names.length && !Object.values(flags).some(Boolean)) {
    if (auto) toast('自動で読み取れる見出しが見つかりませんでした（原文は保存されます）');
    else alert('項目を読み取れませんでした。\n「勤務地」「初任給」などの見出しが1行ずつになっているか確認してください。');
    return;
  }
  const filled = names.filter(n => String(cForm[n].value).trim() && String(cForm[n].value).trim() !== String(values[n]).trim());
  const overwrite = filled.length > 0 && confirm(`すでに入力済みの項目が ${filled.length} 件あります。読み取った内容で上書きしますか？\n（キャンセル → 空欄の項目だけ入力）`);
  let count = 0;
  for (const n of names) {
    if (String(cForm[n].value).trim() && !overwrite) continue;
    cForm[n].value = values[n];
    count++;
  }
  for (const [n, v] of Object.entries(flags)) if (v && !cForm[n].checked) { cForm[n].checked = true; count++; }
  const prev = isPrevYearPosting(raw, state.profile.gradYear);
  if (prev && !cForm.p_prevYear.checked) { cForm.p_prevYear.checked = true; renderPostingTabs(); }
  showSalaryCandidates();
  updateTokyoHint();
  let industryMsg = '';
  if (!$('#industry-select').value) {
    const g = guessIndustries(industryGuessText())[0];
    if (g) { setIndustry(g.name); industryMsg = `（業界は「${g.name}」と推定）`; }
  } else updateIndustryUi();
  toast(`${count} 項目を入力しました${industryMsg}。内容を確認して保存してください`);
  $('#posting-section').open = true;
  const later = [];
  if (mySal) later.push(`初任給は${DEGREES[state.profile.degree].label}の ${mySal.toLocaleString('ja-JP')}円 にしました`);
  if (values.p_annual && !values.p_salary) later.push(`年俸制のため「想定年収」に ${values.p_annual}万円 を入れました（月額にすると約${Math.round(values.p_annual / 12 * 10) / 10}万円）`);
  if (fixedOt) later.push('見込み残業（固定残業代）を含む給与です。比較するときは注意してください');
  else if (sal.length > 1) later.push(`初任給の候補が ${sal.length} 件あります。自分に当てはまる額をタップしてください`);
  if (prev) later.push(`${String(state.profile.gradYear - 1).slice(2)}卒向け（前年度）の募集要項のようです。「前年度の情報」として記録しました`);
  later.forEach((m, i) => setTimeout(() => toast(m), 2000 * (i + 1)));
}
$('#parse-posting').addEventListener('click', () => applyPosting(false));
// 貼り付けたら自動で読み取る
cForm.p_raw.addEventListener('paste', () => setTimeout(() => applyPosting(true), 0));
$('#paste-clipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('クリップボードが空です'); return; }
    cForm.p_raw.value = text;
    applyPosting(true);
  } catch {
    toast('貼り付けを許可できませんでした。下の欄に長押しで貼り付けてください');
    cForm.p_raw.focus();
  }
});

/* ---------- event dialog ---------- */
const eDialog = $('#event-dialog');
const eForm = $('#event-form');
let evCtx = null; // { cid, eid }

function openEvent(cid, eid) {
  evCtx = { cid, eid };
  const ev = eid ? findCompany(cid)?.events.find(x => x.id === eid) : null;
  $('#event-dialog-title').textContent = ev ? '予定・締切を編集' : '予定・締切を追加';
  eForm.title.value = ev?.title || '';
  eForm.date.value = ev?.date || todayStr();
  eForm.time.value = ev?.time || '';
  eForm.place.value = ev?.place || '';
  eForm.done.checked = Boolean(ev?.done);
  $('#delete-event').hidden = !ev;
  eDialog.showModal();
  if (!ev) setTimeout(() => eForm.title.focus(), 50);
}
function afterChange() {
  save();
  render();
  if (dDialog.open) renderDetail();
}
eForm.addEventListener('submit', e => {
  e.preventDefault();
  const c = findCompany(evCtx.cid);
  if (!c) return;
  const data = {
    title: eForm.title.value.trim(), date: eForm.date.value, time: eForm.time.value,
    place: eForm.place.value.trim(), done: eForm.done.checked,
  };
  if (!data.title || !data.date) return;
  const ev = evCtx.eid && c.events.find(x => x.id === evCtx.eid);
  if (ev) Object.assign(ev, data);
  else c.events.push({ id: uid(), ...data });
  c.updatedAt = Date.now();
  eDialog.close();
  afterChange();
  toast('予定を保存しました');
});
eDialog.querySelector('[data-close]').addEventListener('click', () => eDialog.close());
$('#delete-event').addEventListener('click', () => {
  const c = findCompany(evCtx.cid);
  if (!c || !confirm('この予定を削除しますか？')) return;
  c.events = c.events.filter(x => x.id !== evCtx.eid);
  eDialog.close();
  afterChange();
});
function toggleEventDone(cid, eid, done) {
  const c = findCompany(cid);
  const ev = c?.events.find(x => x.id === eid);
  if (!ev) return;
  ev.done = done;
  c.updatedAt = Date.now();
  save();
  if (dDialog.open) renderDetail();
  setTimeout(render, 250);
}

/* ---------- account dialog ---------- */
const aDialog = $('#account-dialog');
const aForm = $('#account-form');
const accountPw = makePwField($('#account-pw'));
let editingAccount = null;
let accountResolve = null;

function openAccount(id) {
  const src = id ? accountById(id) : null;
  editingAccount = src ? structuredClone(src) : normalizeAccount({ name: '-' });
  if (!src) editingAccount.name = '';
  $('#account-dialog-title').textContent = src ? 'サービスを編集' : 'サービスを追加';
  ['name', 'url', 'loginId', 'memo'].forEach(k => { aForm[k].value = editingAccount[k]; });
  accountPw.load(editingAccount.pwd);
  $('#delete-account').hidden = !src;
  aDialog.showModal();
  if (!src) setTimeout(() => aForm.name.focus(), 50);
  return new Promise(res => { accountResolve = res; });
}
function closeAccount(result) {
  aDialog.close();
  const r = accountResolve; accountResolve = null;
  r?.(result);
}
aForm.addEventListener('submit', async e => {
  e.preventDefault();
  ['name', 'url', 'loginId'].forEach(k => { editingAccount[k] = aForm[k].value.trim(); });
  editingAccount.memo = aForm.memo.value;
  if (!editingAccount.name) return;
  editingAccount.pwd = accountPw.value();
  const idx = state.accounts.findIndex(a => a.id === editingAccount.id);
  if (idx >= 0) state.accounts[idx] = editingAccount; else state.accounts.push(editingAccount);
  save();
  toast('保存しました');
  closeAccount(editingAccount.id);
  render();
});
aDialog.querySelector('[data-close]').addEventListener('click', () => closeAccount(null));
aDialog.addEventListener('cancel', e => { e.preventDefault(); closeAccount(null); });
$('#delete-account').addEventListener('click', () => {
  const n = state.companies.filter(c => c.route === editingAccount.id).length;
  if (!confirm(`「${editingAccount.name}」を削除しますか？${n ? `\nこの経路の企業 ${n} 社は「未設定」になります。` : ''}`)) return;
  state.accounts = state.accounts.filter(a => a.id !== editingAccount.id);
  state.companies.forEach(c => { if (c.route === editingAccount.id) c.route = ''; });
  save();
  closeAccount(null);
  render();
});

/* ---------- FAB ---------- */
$('#fab').addEventListener('click', () => (currentView === 'es' ? openStock(null) : openCompany(null)));

/* ---------- backup ---------- */
$('#export-btn').addEventListener('click', () => {
  const name = `syukatsu-backup-${todayStr()}.json`;
  const blob = new Blob([JSON.stringify({ app: 'syukatsu', version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
  if (isIOS && navigator.canShare) {
    // iPhone では共有シートから「ファイルに保存」や AirDrop で送れるようにする
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(() => {});
      return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.companies)) throw new Error('形式が正しくありません');
    const next = normalizeState(data);
    const preview = mergeState(state, next);
    const r = preview.report;
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
    $('#import-summary').innerHTML =
      `ファイル${when ? `（${esc(when)} に書き出し）` : ''}：企業 ${next.companies.length} 社・サービス ${next.accounts.length} 件・ESストック ${next.stock.length} 件<br>` +
      `統合すると：新しい企業 <b>${r.added}</b> 社、内容が変わる企業 <b>${r.updated}</b> 社、変化なし ${r.same} 社` +
      (r.otherAdded ? `、サービス・ESストック ${r.otherAdded} 件を追加` : '');
    pendingImport = { next, merged: preview.state };
    iDialog.showModal();
  } catch (err) {
    alert('読み込みに失敗しました: ' + err.message);
  }
});

const iDialog = $('#import-dialog');
let pendingImport = null;
function finishImport(newState, msg) {
  pendingImport = null;
  iDialog.close();
  state = newState;
  save();
  toast(msg);
  render();
  migrateLegacy();
}
iDialog.querySelector('[data-close]').addEventListener('click', () => { pendingImport = null; iDialog.close(); });
$('#import-merge').addEventListener('click', () => {
  if (pendingImport) finishImport(pendingImport.merged, '追加・統合しました');
});
$('#import-replace').addEventListener('click', () => {
  if (!pendingImport) return;
  if (!confirm('この端末のデータを消して、ファイルの内容に置き換えます。よろしいですか？')) return;
  finishImport(pendingImport.next, '置き換えました');
});

/* 2つのデータを統合する（どちらのデータも消さない） */
const nameKey = s => str(s).replace(/株式会社|（株）|\(株\)|㈱|[\s　]/g, '').toLowerCase();
function unionById(a, b, pick) {
  const map = new Map(a.map(x => [x.id, x]));
  b.forEach(x => { map.set(x.id, map.has(x.id) ? pick(map.get(x.id), x) : x); });
  return [...map.values()];
}
function mergeCompany(cur, inc) {
  const incNewer = inc.updatedAt > cur.updatedAt;
  const newer = incNewer ? inc : cur;
  const older = incNewer ? cur : inc;
  const pickNewer = (x, y) => (incNewer ? y : x);
  const out = {
    ...newer,
    id: cur.id,
    createdAt: Math.min(cur.createdAt, inc.createdAt),
    updatedAt: Math.max(cur.updatedAt, inc.updatedAt),
    postings: unionById(cur.postings, inc.postings, pickNewer).filter(postingHasData),
    notes: unionById(cur.notes, inc.notes, pickNewer),
    events: unionById(cur.events, inc.events, pickNewer),
  };
  // 新しい方で空欄の項目は、古い方の値で補う
  ['industry', 'hq', 'locations', 'tokyo', 'route', 'url', 'loginId', 'memo'].forEach(k => { if (!out[k] && older[k]) out[k] = older[k]; });
  if (!out.pwd && older.pwd) out.pwd = older.pwd;
  if (!out.postings.length) out.postings = newer.postings;
  const seen = new Set();
  out.history = [...cur.history, ...inc.history]
    .filter(h => { const k = h.status + '@' + h.at; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => x.at - y.at);
  return out;
}
function mergeState(base, inc) {
  const report = { added: 0, updated: 0, same: 0, otherAdded: 0 };
  // サービス（ログイン元）
  const accounts = base.accounts.map(a => ({ ...a }));
  const accIdMap = {};
  inc.accounts.forEach(a => {
    const hit = accounts.find(x => x.id === a.id) || accounts.find(x => nameKey(x.name) === nameKey(a.name));
    if (hit) {
      accIdMap[a.id] = hit.id;
      ['url', 'loginId', 'pwd', 'memo'].forEach(k => { if (!hit[k] && a[k]) hit[k] = a[k]; });
    } else {
      accounts.push({ ...a });
      accIdMap[a.id] = a.id;
      report.otherAdded++;
    }
  });
  // 企業
  const companies = [...base.companies];
  inc.companies.forEach(c0 => {
    const c = { ...c0, route: accIdMap[c0.route] || c0.route };
    const i = companies.findIndex(x => x.id === c.id);
    const j = i >= 0 ? i : companies.findIndex(x => nameKey(x.name) === nameKey(c.name));
    if (j < 0) { companies.push(c); report.added++; return; }
    const merged = mergeCompany(companies[j], c);
    if (JSON.stringify(merged) === JSON.stringify(companies[j])) report.same++;
    else { companies[j] = merged; report.updated++; }
  });
  // ESストック
  const stock = [...base.stock];
  inc.stock.forEach(s => {
    const i = stock.findIndex(x => x.id === s.id);
    if (i >= 0) { if (s.updatedAt > stock[i].updatedAt) stock[i] = s; return; }
    if (stock.some(x => x.title === s.title && x.text === s.text)) return;
    stock.push(s);
    report.otherAdded++;
  });
  const out = { ...base, companies, accounts, stock, profile: base.profile };
  if (!out.vault && inc.vault) out.vault = inc.vault;
  return { state: out, report };
}

$('#clear-btn').addEventListener('click', () => {
  if (!confirm('すべてのデータを削除します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に削除しますか？（事前にバックアップの書き出しをおすすめします）')) return;
  state = { companies: [], accounts: [], stock: [], profile: state.profile };
  save();
  toast('削除しました');
  render();
});

/* ---------- 企業の詳細（閲覧） ---------- */
const dDialog = $('#detail-dialog');
let detailId = null;
const POSTING_TEXT_LABELS = [
  ['recruiter', '募集者'], ['job', '募集職種'], ['eligibility', '応募資格'], ['startDate', '入社時期'],
  ['contract', '契約・雇用形態'], ['probation', '試用期間'], ['hours', '勤務時間'], ['holidaysNote', '休日・休暇'],
  ['salaryNote', '初任給の詳細'], ['bonusNote', '賞与'], ['raise', '昇給'], ['benefits', '福利厚生'],
  ['allowances', '諸手当'], ['commute', '通勤費'], ['note', 'その他'],
];
const NOTE_KIND = { es: 'ES', interview: '面接', other: 'その他' };

/* PC（広い画面）では企業一覧の右側に詳細を並べて表示する */
const wideMQ = matchMedia('(min-width: 1024px)');
const isDocked = () => wideMQ.matches && currentView === 'companies';
function closeDocked() {
  if (dDialog.open && dDialog.classList.contains('docked')) dDialog.close();
  dDialog.classList.remove('docked');
}
dDialog.addEventListener('close', markSelected);
function markSelected() {
  const id = dDialog.open && dDialog.classList.contains('docked') ? detailId : null;
  $$('#company-list .card').forEach(li => li.classList.toggle('selected', li.dataset.id === id));
}
wideMQ.addEventListener('change', closeDocked);
function openDetail(id, postingId) {
  if (!findCompany(id)) return;
  detailId = id;
  renderDetail();
  if (isDocked()) {
    if (dDialog.open && !dDialog.classList.contains('docked')) dDialog.close();
    dDialog.classList.add('docked');
    if (!dDialog.open) dDialog.show();
  } else {
    if (dDialog.open && dDialog.classList.contains('docked')) dDialog.close();
    dDialog.classList.remove('docked');
    if (!dDialog.open) dDialog.showModal();
  }
  markSelected();
  const body = $('#detail-body');
  body.scrollTop = 0;
  if (postingId) {
    const el = body.querySelector(`.pcard[data-pid="${postingId}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
  }
}
function whenBox(date) {
  const n = daysFromToday(date);
  const cls = n === 0 ? 'today' : n < 0 ? 'overdue' : n <= 3 ? 'soon' : '';
  const [, m, d] = date.split('-').map(Number);
  return `<div class="when ${cls}"><b>${m}/${d}</b><small>${relLabel(date)}</small></div>`;
}
function loginActions(c) {
  const acc = accountById(c.route);
  const items = [];
  if (safeUrl(c.url)) items.push(`<a class="primary" href="${esc(c.url)}" target="_blank" rel="noopener">マイページを開く ↗</a>`);
  if (c.loginId) items.push(`<button data-act="copy-cid">IDコピー</button>`);
  if (pwText(c.pwd)) items.push(`<button data-act="copy-cpw">PWコピー</button>`);
  if (acc) {
    if (safeUrl(acc.url)) items.push(`<a href="${esc(acc.url)}" target="_blank" rel="noopener">${esc(acc.name)} ↗</a>`);
    if (acc.loginId) items.push(`<button data-act="copy-aid">${esc(acc.name)} ID</button>`);
    if (pwText(acc.pwd)) items.push(`<button data-act="copy-apw">${esc(acc.name)} PW</button>`);
  }
  return items.length ? `<div class="actions">${items.join('')}</div>` : '';
}
function postingCard(c, p, i, multi) {
  const tk = postingTokyo(c, p);
  const title = p.title || (multi ? postingTitle(p, i) : '募集要項');
  const metrics = METRICS.filter(m => m.key !== 'hiring' || p.hiring != null).map(m => {
    const v = p[m.key];
    return `<div class="metric ${v == null ? 'empty-m' : ''}"><div class="mv">${v == null ? '—' : esc(m.fmt(v))}</div><div class="ml">${m.label}</div></div>`;
  }).join('');
  const flags = POSTING_FLAGS.filter(f => p[f.key]).map(f => `<span class="tag">${f.label}</span>`).join('');
  const rows = POSTING_TEXT_LABELS.filter(([k]) => p[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(p[k])}</dd>`).join('');
  return `<div class="pcard" data-pid="${p.id}">
    <div class="pcard-top"><span class="pcard-title">${esc(title)}</span>${p.prevYear ? '<span class="prev-pill">前年度の情報</span>' : ''}${p.applied ? '<span class="applied-pill">応募</span>' : ''}${tokyoBadgeCode(tk)}</div>
    ${p.location ? `<div class="note small">📍 ${esc(p.location)}</div>` : ''}
    <div class="metric-grid">${metrics}</div>
    ${flags ? `<div>${flags}</div>` : ''}
    ${rows ? `<details><summary>募集要項の詳細を見る</summary><dl class="dl">${rows}</dl></details>` : ''}
  </div>`;
}
function renderDetail() {
  const c = findCompany(detailId);
  if (!c) { dDialog.close(); return; }
  const st = STATUS_MAP[c.status];
  const ne = nextEvent(c);
  let nextHtml = '';
  if (ne) {
    const n = daysFromToday(ne.date);
    nextHtml = `<div class="next-box ${n === 0 ? 'today' : n <= 3 ? 'soon' : ''}" data-act="edit-event" data-eid="${ne.id}">
      <div class="nb-main"><div class="nb-sub">次の予定</div><div class="nb-title">${esc(ne.title)}</div>
      <div class="nb-sub">${fmtDate(ne.date)}${ne.time ? ' ' + ne.time : ''}（${relLabel(ne.date)}）${ne.place ? '・' + esc(ne.place) : ''}</div></div></div>`;
  }
  const rn = routeName(c);
  const ps = c.postings.filter(postingHasData);
  const evs = [...c.events].sort((a, b) => (a.done - b.done) || evKey(a).localeCompare(evKey(b)));
  const tk = TOKYO[bestTokyo(c)];

  $('#detail-body').innerHTML = `
    <div class="hero">
      <h1 class="hero-name">${esc(c.name)}</h1>
      <div class="hero-meta">
        <span class="stars-view">${stars(c.priority)}</span>
        ${c.industry ? `<span>${esc(c.industry)}</span>` : '<span>業界未設定</span>'}
        ${rn ? `<span>経路: ${esc(rn)}</span>` : ''}
      </div>
      <div class="hero-row">
        <span class="status-picker ${st.cls}"><select id="detail-status" aria-label="ステータスを変更">
          ${STATUSES.map(s => `<option value="${s.id}" ${s.id === c.status ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select></span>
        ${tokyoBadge(c)}
      </div>
      ${loginActions(c)}
      ${nextHtml}
    </div>

    <section class="dsec">
      <div class="dsec-head"><h3>予定・締切</h3><button class="btn small" data-act="add-event">＋ 追加</button></div>
      ${evs.length ? evs.map(ev => `
        <div class="ev-row ${ev.done ? 'done' : ev.date < todayStr() ? 'overdue' : ''}">
          <input type="checkbox" data-eid="${ev.id}" ${ev.done ? 'checked' : ''} aria-label="完了">
          <div class="ev-main" data-act="edit-event" data-eid="${ev.id}">
            <div class="ev-title">${esc(ev.title)}</div>
            <div class="ev-date">${!ev.done && ev.date < todayStr() ? '期限切れ・' : ''}${fmtDate(ev.date, true)}${ev.time ? ' ' + ev.time : ''}${ev.place ? '・' + esc(ev.place) : ''}</div>
          </div>
          <a class="gcal" href="${esc(gcalUrl(ev, c.name))}" target="_blank" rel="noopener">Googleカレンダー</a>
        </div>`).join('') : '<p class="muted-empty">予定・締切はまだありません。</p>'}
    </section>

    <section class="dsec">
      <div class="dsec-head"><h3>職種・条件</h3>${ps.length > 1 ? `<span class="note small">${ps.length}職種</span>` : ''}</div>
      ${ps.length ? ps.map((p, i) => postingCard(c, p, i, ps.length > 1)).join('')
        : '<p class="muted-empty">まだ入力されていません。「編集」から募集要項を貼り付けると自動で入力されます。</p>'}
    </section>

    <section class="dsec">
      <div class="dsec-head"><h3>勤務地</h3>${tk ? `<span class="note small">${tk.label}</span>` : ''}</div>
      ${c.hq || c.locations ? `<dl class="dl">
        ${c.hq ? `<dt>本社</dt><dd>${esc(c.hq)}</dd>` : ''}
        ${c.locations ? `<dt>勤務地</dt><dd>${esc(c.locations)}</dd>` : ''}
      </dl>` : '<p class="muted-empty">未入力</p>'}
    </section>

    <section class="dsec">
      <div class="dsec-head"><h3>ES・面接メモ</h3><button class="btn small" data-act="add-note">＋ 追加</button></div>
      ${c.notes.length ? [...c.notes].sort((a, b) => b.at - a.at).map(n => `
        <div class="note-item" data-act="edit-note" data-nid="${n.id}">
          <div class="ni-top"><span class="kind ${n.kind}">${NOTE_KIND[n.kind]}</span><span class="ni-q">${esc(n.q || '（設問なし）')}</span><span class="note small">${charCount(n.a)}字</span></div>
          ${n.a ? `<div class="ni-a">${esc(n.a)}</div>` : ''}
        </div>`).join('') : '<p class="muted-empty">提出したESの内容や、面接で聞かれた質問と答えを残しておくと、次の選考や他社の対策に使えます。</p>'}
    </section>

    ${c.memo ? `<section class="dsec"><div class="dsec-head"><h3>メモ</h3></div><div class="memo-text">${esc(c.memo)}</div></section>` : ''}

    <section class="dsec">
      <div class="dsec-head"><h3>選考履歴</h3></div>
      <ul class="timeline">
        ${[...c.history.map(h => ({ at: h.at, label: STATUS_MAP[h.status].label })), { at: c.createdAt, label: '登録' }]
          .sort((a, b) => b.at - a.at).map(h => `<li><span class="tl-date">${fmtDay(h.at)}</span>${h.label}</li>`).join('')}
      </ul>
    </section>`;
}
function setStatus(c, status) {
  if (c.status === status) return;
  c.status = status;
  c.history.push({ status, at: Date.now() });
  c.updatedAt = Date.now();
  afterChange();
  toast(`ステータスを「${STATUS_MAP[status].label}」にしました`);
}
dDialog.querySelector('[data-close]').addEventListener('click', () => dDialog.close());
$('#detail-edit').addEventListener('click', () => { dDialog.close(); openCompany(detailId); });
$('#detail-body').addEventListener('change', e => {
  const c = findCompany(detailId);
  if (!c) return;
  if (e.target.id === 'detail-status') setStatus(c, e.target.value);
  else if (e.target.matches('input[type=checkbox][data-eid]')) toggleEventDone(c.id, e.target.dataset.eid, e.target.checked);
});
$('#detail-body').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  const c = findCompany(detailId);
  if (!t || !c) return;
  const acc = accountById(c.route);
  switch (t.dataset.act) {
    case 'add-event': openEvent(c.id, null); break;
    case 'edit-event': openEvent(c.id, t.dataset.eid); break;
    case 'add-note': openNote(c.id, null); break;
    case 'edit-note': openNote(c.id, t.dataset.nid); break;
    case 'copy-cid': copyText(c.loginId, 'ID'); break;
    case 'copy-cpw': copyPassword(c.pwd); break;
    case 'copy-aid': copyText(acc?.loginId, 'ID'); break;
    case 'copy-apw': copyPassword(acc?.pwd); break;
  }
});

/* ---------- ES・面接メモ ---------- */
const nDialog = $('#note-dialog');
const nForm = $('#note-form');
let noteCtx = null; // { cid, nid }
function setNoteKind(k) {
  nForm.dataset.kind = k;
  $$('#note-kind button').forEach(b => b.classList.toggle('on', b.dataset.v === k));
}
function updateNoteCount() { $('#note-count').textContent = `${charCount(nForm.a.value)}字`; }
function openNote(cid, nid) {
  noteCtx = { cid, nid };
  const n = nid ? findCompany(cid)?.notes.find(x => x.id === nid) : null;
  setNoteKind(n?.kind || 'es');
  nForm.q.value = n?.q || '';
  nForm.a.value = n?.a || '';
  nForm.memo.value = n?.memo || '';
  updateNoteCount();
  $('#delete-note').hidden = !n;
  const stock = state.stock;
  $('#note-stock').hidden = !stock.length;
  $('#note-stock').innerHTML = stock.length ? 'ESストックから挿入: ' +
    stock.map(x => `<button type="button" data-sid="${x.id}">${esc(x.title)}</button>`).join('') : '';
  nDialog.showModal();
  nDialog.querySelector('.dialog-body').scrollTop = 0;
}
$('#note-kind').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setNoteKind(b.dataset.v); });
nForm.a.addEventListener('input', updateNoteCount);
$('#note-stock').addEventListener('click', e => {
  const b = e.target.closest('button[data-sid]');
  const x = b && state.stock.find(s => s.id === b.dataset.sid);
  if (!x) return;
  nForm.a.value = nForm.a.value.trim() ? nForm.a.value + '\n' + x.text : x.text;
  if (!nForm.q.value.trim()) nForm.q.value = x.title;
  updateNoteCount();
});
nForm.addEventListener('submit', e => {
  e.preventDefault();
  const c = findCompany(noteCtx.cid);
  if (!c || !nForm.q.value.trim()) return;
  const data = { kind: nForm.dataset.kind, q: nForm.q.value.trim(), a: nForm.a.value, memo: nForm.memo.value };
  const n = noteCtx.nid && c.notes.find(x => x.id === noteCtx.nid);
  if (n) Object.assign(n, data);
  else c.notes.push(normalizeNote({ ...data, at: Date.now() }));
  c.updatedAt = Date.now();
  nDialog.close();
  afterChange();
  toast('メモを保存しました');
});
nDialog.querySelector('[data-close]').addEventListener('click', () => nDialog.close());
$('#delete-note').addEventListener('click', () => {
  const c = findCompany(noteCtx.cid);
  if (!c || !confirm('このメモを削除しますか？')) return;
  c.notes = c.notes.filter(x => x.id !== noteCtx.nid);
  nDialog.close();
  afterChange();
});

/* ---------- ESストック ---------- */
const sDialog = $('#stock-dialog');
const sForm = $('#stock-form');
let stockId = null;
function renderStock() {
  const list = [...state.stock].sort((a, b) => b.updatedAt - a.updatedAt);
  $('#stock-empty').hidden = list.length > 0;
  $('#stock-list').innerHTML = list.map(x => `
    <div class="stock-card" data-sid="${x.id}">
      <div class="sc-top"><span class="sc-title" data-act="edit">${esc(x.title)}</span><span class="count">${charCount(x.text)}字</span></div>
      <div class="sc-text" data-act="edit">${esc(x.text) || '（本文なし）'}</div>
      <div class="actions"><button data-act="copy">本文をコピー</button><button data-act="edit">編集</button></div>
    </div>`).join('');
}
$('#stock-list').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  const card = e.target.closest('[data-sid]');
  if (!t || !card) return;
  const x = state.stock.find(s => s.id === card.dataset.sid);
  if (t.dataset.act === 'copy') copyText(x?.text, '本文');
  else openStock(card.dataset.sid);
});
function updateStockCount() { $('#stock-count').textContent = `${charCount(sForm.text.value)}字`; }
function openStock(id) {
  stockId = id;
  const x = id ? state.stock.find(s => s.id === id) : null;
  sForm.title.value = x?.title || '';
  sForm.text.value = x?.text || '';
  updateStockCount();
  $('#delete-stock').hidden = !x;
  sDialog.showModal();
  if (!x) setTimeout(() => sForm.title.focus(), 50);
}
sForm.text.addEventListener('input', updateStockCount);
sForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!sForm.title.value.trim()) return;
  const data = { title: sForm.title.value.trim(), text: sForm.text.value, updatedAt: Date.now() };
  const x = stockId && state.stock.find(s => s.id === stockId);
  if (x) Object.assign(x, data); else state.stock.push(normalizeStock(data));
  save();
  sDialog.close();
  render();
  toast('保存しました');
});
sDialog.querySelector('[data-close]').addEventListener('click', () => sDialog.close());
$('#delete-stock').addEventListener('click', () => {
  if (!confirm('この文章を削除しますか？')) return;
  state.stock = state.stock.filter(s => s.id !== stockId);
  save();
  sDialog.close();
  render();
});

/* ---------- ホーム ---------- */
function renderHome() {
  const cs = state.companies;
  const empty = cs.length === 0;
  $('#home-empty').hidden = !empty;
  $$('#view-home > .panel, #home-stats').forEach(el => { el.hidden = empty; });
  if (empty) return;

  const today = todayStr();
  const upcoming = [];
  const overdue = [];
  cs.forEach(c => c.events.forEach(ev => {
    if (ev.done) return;
    if (ev.date >= today) upcoming.push({ c, ev });
    else if (daysFromToday(ev.date) >= -14) overdue.push({ c, ev });
  }));
  overdue.sort((a, b) => evKey(a.ev).localeCompare(evKey(b.ev)));
  upcoming.sort((a, b) => evKey(a.ev).localeCompare(evKey(b.ev)));
  const week = upcoming.filter(x => daysFromToday(x.ev.date) <= 7).length;
  const count = f => cs.filter(f).length;
  const stats = [
    { v: count(c => IN_PROCESS.has(c.status)), u: '社', l: '選考中', go: 'active' },
    { v: week, u: '件', l: '7日以内の予定', go: 'schedule' },
    { v: count(c => c.status === 'offer'), u: '社', l: '内定', go: 'offer' },
    { v: count(c => bestTokyo(c) === 'only' && ACTIVE_STATUSES.has(c.status)), u: '社', l: '東京◎', go: 'tokyo' },
  ];
  $('#home-stats').innerHTML = stats.map(s => `<button class="stat" data-stat="${s.go}"><div class="sv">${s.v}<small>${s.u}</small></div><div class="sl">${s.l}</div></button>`).join('');

  const shown = [...overdue, ...upcoming.slice(0, 6)];
  $('#home-events').innerHTML = shown.length ? `<div class="mini-list">${shown.map(({ c, ev }) => `
    <div class="mini-item">
      ${whenBox(ev.date)}
      <div class="mi-main" data-open="${c.id}">
        <div class="mi-title">${esc(ev.title)}</div>
        <div class="mi-sub">${ev.date < today ? '<b class="overdue-text">期限切れ</b>・' : ''}${esc(c.name)}${ev.time ? '・' + ev.time : ''}${ev.place ? '・' + esc(ev.place) : ''}</div>
      </div>
      <input type="checkbox" data-cid="${c.id}" data-eid="${ev.id}" aria-label="完了">
    </div>`).join('')}</div>` : '<p class="muted-empty">今後の予定はありません。企業の詳細画面から追加できます。</p>';

  const todo = cs.filter(c => IN_PROCESS.has(c.status) && !nextEvent(c));
  $('#home-todo-panel').hidden = !todo.length;
  $('#home-todo').innerHTML = `<div class="mini-list">${todo.map(c => `
    <div class="mini-item" data-open="${c.id}">
      <div class="mi-main"><div class="mi-title">${esc(c.name)}</div><div class="mi-sub">${STATUS_MAP[c.status].label}</div></div>
      <button class="btn small" data-add-event="${c.id}">＋ 予定</button>
    </div>`).join('')}</div>`;

  const counts = STATUSES.map(s => ({ s, n: count(c => c.status === s.id) })).filter(x => x.n);
  const max = Math.max(...counts.map(x => x.n), 1);
  $('#home-funnel').innerHTML = counts.map(({ s, n }) => `
    <div class="funnel-row ${s.id === 'offer' ? 'offer' : ''}" data-status="${s.id}">
      <span class="fl">${s.label}</span>
      <div class="ft"><div class="ff" style="width:${(n / max) * 100}%"></div></div>
      <span class="fv">${n}</span>
    </div>`).join('');
}
$('#view-home').addEventListener('click', e => {
  const add = e.target.closest('[data-add-event]');
  if (add) { openEvent(add.dataset.addEvent, null); return; }
  const open = e.target.closest('[data-open]');
  if (open) { openDetail(open.dataset.open); return; }
  const stat = e.target.closest('[data-stat]');
  if (stat) {
    const go = stat.dataset.stat;
    if (go === 'schedule') { showView('schedule'); return; }
    filterSel.value = go === 'tokyo' ? 'active' : go;
    $('#filter-tokyo').value = go === 'tokyo' ? 'only' : 'all';
    saveUiPref();
    showView('companies');
    return;
  }
  const row = e.target.closest('[data-status]');
  if (row) { filterSel.value = row.dataset.status; saveUiPref(); showView('companies'); }
});
$('#view-home').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox][data-eid]');
  if (cb) { toggleEventDone(cb.dataset.cid, cb.dataset.eid, cb.checked); toast('完了にしました'); }
});

/* ---------- カレンダー書き出し（.ics） ---------- */
function exportIcs() {
  const icsText = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//syukatsu//JP', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:就活'];
  let n = 0;
  state.companies.forEach(c => c.events.forEach(ev => {
    if (ev.done) return;
    const d = ev.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@syukatsu`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(`【${c.name}】${ev.title}`)}`);
    if (ev.time) {
      const [h, m] = ev.time.split(':').map(Number);
      const endH = Math.min(h + 1, 23);
      lines.push(`DTSTART:${d}T${pad(h)}${pad(m)}00`, `DTEND:${d}T${pad(endH)}${pad(h + 1 > 23 ? 59 : m)}00`);
    } else {
      const [y, mo, da] = ev.date.split('-').map(Number);
      const nx = new Date(y, mo - 1, da + 1);
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nx.getFullYear()}${pad(nx.getMonth() + 1)}${pad(nx.getDate())}`);
    }
    if (ev.place) lines.push(`LOCATION:${icsText(ev.place)}`);
    lines.push('END:VEVENT');
    n++;
  }));
  lines.push('END:VCALENDAR');
  if (!n) { toast('書き出す予定がありません'); return; }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `syukatsu-${todayStr()}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${n}件の予定を書き出しました。ファイルを開くとカレンダーに追加できます`);
}

/* ---------- 外部リンクを Safari で開く ---------- */
// ホーム画面から起動した iPhone のアプリでは、普通のリンクはアプリ内ブラウザで開いてしまう。
// iOS の「x-safari-https://」形式で Safari 本体を開き、開けなかったときだけ従来どおり開く。
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function openInSafari(url) {
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onHide);
  location.href = 'x-safari-' + url;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left && !document.hidden) window.open(url, '_blank', 'noopener');
  }, 1200);
}
document.addEventListener('click', e => {
  if (!isIOS || !isStandalone) return;
  const a = e.target.closest('a[target=_blank]');
  if (!a || !/^https?:\/\//i.test(a.href)) return;
  e.preventDefault();
  openInSafari(a.href);
}, true);

/* ---------- init ---------- */
showView('home');
migrateLegacy();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
