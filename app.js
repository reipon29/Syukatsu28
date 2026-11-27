'use strict';

const APP_VERSION = '2.20.0';
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
// 比較画面だけで使う項目（初任給＋家賃補助の手取りの目安）
const NET_RATE = 0.8; // 手取りの目安（額面の約8割）
const CMP_METRICS = [
  { key: 'net', label: '実質の月収（手取り目安）', unit: '円', better: 'high', fmt: v => v.toLocaleString('ja-JP') + '円' },
  ...METRICS,
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
/** 「25.5万」「255,000円」「２５５０００」などを円に。1000未満は万円とみなす（「25」→ 250000） */
function parseYen(v) {
  const t = String(v ?? '').normalize('NFKC').replace(/[,，\s円]/g, '').replace(/^(?:月給|月額)/, '');
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)(万)?(\d{1,4})?$/);
  if (!m) return NaN;
  let n = Number(m[1]);
  if (m[2]) n = n * 10000 + (m[3] ? Number(m[3]) : 0);
  else if (m[3]) return NaN;
  else if (n < 1000) n *= 10000;
  return Math.round(n);
}
const YEN_FIELDS = new Set(['salary', 'housing']);
const parseNumField = (k, v) => {
  if (YEN_FIELDS.has(k)) { const n = parseYen(v); return Number.isFinite(n) ? n : null; }
  return numOrNull(String(v ?? '').normalize('NFKC').replace(/,/g, '').trim());
};
const isCipher = v => v && typeof v === 'object' && typeof v.iv === 'string' && typeof v.ct === 'string';

function normalizePwd(v) {
  if (typeof v === 'string') return v;
  if (isCipher(v)) return { iv: v.iv, ct: v.ct }; // v1.1〜1.2 で暗号化されたもの（引き継ぎ待ち）
  return '';
}
function normalizeEvent(ev) {
  return { id: str(ev.id) || uid(), title: str(ev.title), date: ev.date, time: str(ev.time), endTime: ev.time ? str(ev.endTime) : '', place: str(ev.place), done: Boolean(ev.done) };
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
    site: str(c.site), // 採用サイト
    homepage: str(c.homepage), // 公式ホームページ
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
    triagedAt: Number(c.triagedAt) || 0, // 志望度の仕分けをした日時（0 = まだ）
    scores: Object.fromEntries(['money', 'life', 'skill', 'future'].map(k => {
      const v = Number(c.scores?.[k]);
      return [k, v >= 1 && v <= 5 ? v : 0]; // 0 = 未設定（お金・生活は自動）
    })),
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
  const c = p.cond && typeof p.cond === 'object' ? p.cond : {};
  const w = p.weights && typeof p.weights === 'object' ? p.weights : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  return {
    gradYear: y >= 2020 && y <= 2040 ? y : 2028,
    degree: ['master', 'doctor', 'bachelor', 'junior'].includes(p.degree) ? p.degree : 'master',
    cond: { salary: num(c.salary, 300000), holidays: num(c.holidays, 125), tokyo: c.tokyo !== false, housing: c.housing !== false },
    weights: { money: num(w.money, 40), life: num(w.life, 25), skill: num(w.skill, 20), future: num(w.future, 15) },
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
  if (typeof scheduleCalPush === 'function') scheduleCalPush();
  if (typeof cloudAfterSave === 'function') cloudAfterSave();
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
/** 「14:00〜15:30」「14:00」など */
const timeRange = ev => (ev.time ? ev.time + (ev.endTime ? '〜' + ev.endTime : '') : '');
/** 終了時刻（未入力なら開始の1時間後、日をまたぐ場合は 23:59） */
function endTimeOf(ev) {
  if (ev.endTime) return ev.endTime;
  const [h, m] = ev.time.split(':').map(Number);
  return h + 1 >= 24 ? '23:59' : `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
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
/** ボタン用の短いサービス名（「マイナビ2028（大学院生向け…）」→「マイナビ2028」） */
const accShort = a => { const n = a.name.replace(/\s*[（(【\[].*$/, '').trim() || a.name; return n.length > 12 ? n.slice(0, 11) + '…' : n; };
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
    const hm = t => t.replace(':', '') + '00';
    dates = `${d}T${hm(ev.time)}/${d}T${hm(endTimeOf(ev))}`;
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
  $('#fab').hidden = !['home', 'companies', 'schedule', 'es'].includes(name);
  $('#fab').setAttribute('aria-label', name === 'schedule' ? '予定を追加' : name === 'es' ? '文章を追加' : '企業を追加');
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
  if (e.target.closest('[data-add-company]')) openQuickAdd();
  if (e.target.closest('[data-open-triage]')) openTriage();
});

/* ---------- filters ---------- */
const filterSel = $('#filter-status');
filterSel.innerHTML =
  '<option value="active">選考中のみ</option><option value="all">すべて</option><option value="match">条件クリア</option>' +
  STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
$('#status-select').innerHTML = STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
$('#cmp-metric').innerHTML = CMP_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join('');

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

// 職種の分類（比較で同じ職種どうしを並べるため。上から順に判定）
const JOB_KINDS = [
  { key: 'consult', label: 'コンサル',   re: /コンサル/ },
  { key: 'sales',   label: '営業',       re: /営業|セールス|MR\b|販売/i },
  { key: 'it',      label: 'IT・SE',     re: /エンジニア|SE\b|システム|\bIT|ＩＴ|プログラ|ソフトウェア|インフラ|データ|デジタル|DX|アプリ|Web|ネットワーク|情報/i },
  { key: 'rd',      label: '研究・技術', re: /研究|開発|設計|技術|生産|品質|製造|R&D|機械|電気|電子|化学/i },
  { key: 'plan',    label: '企画・マーケ', re: /企画|マーケ|商品|広報|宣伝|デザイン/ },
  { key: 'corp',    label: '事務・管理', re: /事務|管理|経理|財務|人事|総務|法務|コーポレート|スタッフ/ },
  { key: 'general', label: '総合職',     re: /総合職|オープン|ゼネラル/ },
];
/** 職種名（なければ仕事内容）から職種の分類を決める */
function jobKind(p) {
  for (const text of [p.title, p.job]) {
    if (!text) continue;
    const k = JOB_KINDS.find(k => k.re.test(text));
    if (k) return k.key;
  }
  return 'other';
}
const jobKindLabel = key => JOB_KINDS.find(k => k.key === key)?.label || 'その他';
function fillJobKindFilter() {
  const el = $('#cmp-job');
  const cur = el.value || el.dataset.pref || 'all';
  const count = {};
  state.companies.forEach(c => c.postings.forEach(p => {
    if (postingHasData(p)) { const k = jobKind(p); count[k] = (count[k] || 0) + 1; }
  }));
  el.innerHTML = '<option value="all">すべて</option>' +
    [...JOB_KINDS.map(k => k.key), 'other'].filter(k => count[k])
      .map(k => `<option value="${k}">${jobKindLabel(k)}（${count[k]}）</option>`).join('');
  el.value = [...el.options].some(o => o.value === cur) ? cur : 'all';
}

const uiControls = ['#filter-status', '#sort', '#filter-tokyo', '#cmp-metric', '#cmp-filter', '#filter-industry', '#cmp-industry', '#cmp-job'];
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
    `<button data-f="match" class="match ${f === 'match' ? 'on' : ''}">✓ 条件クリア<b>${state.companies.filter(c => ACTIVE_STATUSES.has(c.status) && condStatus(c) === 'ok').length}</b></button>` +
    STATUSES.filter(s => counts[s.id]).map(s =>
      `<button data-f="${s.id}" class="${f === s.id ? 'on' : ''}">${s.label}<b>${counts[s.id]}</b></button>`).join('');
  const nFilters = [ft !== 'all', fi !== 'all', fr !== 'all'].filter(Boolean).length;
  $('#filter-count').hidden = !nFilters;
  $('#filter-count').textContent = nFilters;

  const list = state.companies.filter(c => {
    if ((f === 'active' || f === 'match') && !ACTIVE_STATUSES.has(c.status)) return false;
    if (f === 'match' && condStatus(c) !== 'ok') return false;
    if (!['active', 'all', 'match'].includes(f) && c.status !== f) return false;
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
    score: (a, b) => (totalScore(b)?.total ?? -1) - (totalScore(a)?.total ?? -1) || b.priority - a.priority,
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
      nextHtml = `<div class="card-next ${cls}">${esc(ne.title)}・${fmtDate(ne.date)}${ne.time ? ' ' + timeRange(ne) : ''}（${relLabel(ne.date)}）</div>`;
    } else {
      const last = splitMemo(c.memo).gmLines.slice(-1)[0];
      if (last) nextHtml = `<div class="card-last">📬 ${esc(last.slice(1).trim())}</div>`;
    }
    const rn = routeName(c);
    const keyP = c.postings.find(p => p.applied && postingHasData(p)) || c.postings.find(p => p.salary != null) || c.postings.find(postingHasData);
    const facts = keyP ? [
      keyP.salary != null && `初任給 <b>${Math.round(keyP.salary / 1000) / 10}万円</b>`,
      keyP.salary == null && keyP.annual != null && `年収 <b>${keyP.annual}万円</b>`,
      keyP.holidays != null && `休日 <b>${keyP.holidays}日</b>`,
      keyP.overtime != null && `残業 <b>${keyP.overtime}h</b>`,
    ].filter(Boolean) : [];
    return `<li class="card ${st.cls}" data-id="${c.id}">
      <div class="card-row">
        ${avatar(c)}
        <div class="card-main">
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
        </div>
      </div>
      ${progressBar(c)}
      ${condChips(c)}
      ${facts.length ? `<div class="card-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>` : ''}
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
  const mode = schedMode();
  $$('#sched-mode button').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  $('#month-view').hidden = mode !== 'month';
  $('#schedule-list').hidden = mode === 'month';
  $('#show-done').closest('label').style.visibility = mode === 'month' ? 'hidden' : '';
  if (mode === 'month') { $('#schedule-empty').hidden = true; renderMonth(); return; }
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
          <span class="sched-time">${ev.time ? `${ev.time}${ev.endTime ? `<small>〜${ev.endTime}</small>` : ''}` : '終日'}</span>
          <div class="sched-main" data-cid="${c.id}" data-eid="${ev.id}">
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
  if (m) openEvent(m.dataset.cid, m.dataset.eid);
});

/* ---------- 比較 ---------- */
function compareTargets() {
  const f = $('#cmp-filter').value;
  const tokyoOnly = $('#cmp-tokyo').checked;
  const fi = $('#cmp-industry').value;
  const fj = $('#cmp-job').value || 'all';
  const rows = [];
  state.companies
    .filter(c => (f === 'all' || ACTIVE_STATUSES.has(c.status)) && matchIndustry(c, fi))
    .forEach(c => c.postings.forEach((p, i) => {
      if (!postingHasData(p)) return;
      const kind = jobKind(p);
      if (fj !== 'all' && kind !== fj) return;
      const tk = postingTokyo(c, p);
      if (tokyoOnly && !matchTokyoCode(tk, 'ok')) return;
      const multi = c.postings.filter(postingHasData).length > 1;
      rows.push({ c, p, tk, kind, title: p.title || (multi ? postingTitle(p, i) : '') });
    }));
  return rows;
}
/** 「株式会社」などを省いた企業名（狭い場所で使う） */
const shortName = n => n.replace(/株式会社|有限会社|合同会社|[（(]株[)）]/g, '').trim() || n;
const rowLabel = r => {
  const sub = [r.title, r.p.prevYear ? '前年度' : ''].filter(Boolean).join('・');
  return `${esc(shortName(r.c.name))}${sub ? `<small>${esc(sub)}</small>` : ''}`;
};
const rowText = r => r.c.name + (r.title ? `（${r.title}）` : '');
function renderCompare() {
  renderBulkBanner();
  fillIndustryFilters();
  fillJobKindFilter();
  const metric = CMP_METRICS.find(m => m.key === $('#cmp-metric').value) || CMP_METRICS[0];
  const rows = compareTargets().map(r => ({ ...r, p: { ...r.p, net: netMonthly(r.p) } }));
  const hasAny = rows.length > 0;

  const fj = $('#cmp-job').value;
  $('#cmp-empty').hidden = hasAny;
  $('#cmp-empty').innerHTML = fj && fj !== 'all' && state.companies.some(c => c.postings.some(postingHasData))
    ? `「${esc(jobKindLabel(fj))}」の職種は、いまの条件では見つかりません。<br>職種・対象・業界の絞り込みを変えてみてください。`
    : '募集要項が入力された企業がありません。<br>企業の詳細の「🔎 募集要項を探す」か、編集画面への貼り付けで入力すると、初任給・休日などを並べて比較できます。';
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

  $('#cmp-title').textContent = `${metric.label}（${metric.unit}）${fj && fj !== 'all' ? ' ― ' + jobKindLabel(fj) : ''}`;
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
  CMP_METRICS.forEach(m => {
    const vals = sorted.map(r => r.p[m.key]).filter(v => v != null);
    if (vals.length >= 2) best[m.key] = m.better === 'low' ? Math.min(...vals) : Math.max(...vals);
  });
  $('#cmp-table').innerHTML =
    `<thead><tr><th>企業／職種</th><th>分類</th><th>東京</th>${CMP_METRICS.map(m => `<th>${m.label}</th>`).join('')}<th>働き方</th><th>勤務地</th><th>本社</th></tr></thead>
    <tbody>${sorted.map(r => `<tr data-id="${r.c.id}" data-pid="${r.p.id}">
      <td>${rowLabel(r)}</td>
      <td class="l">${esc(jobKindLabel(r.kind))}</td>
      <td class="l">${TOKYO[r.tk]?.badge || '-'}</td>
      ${CMP_METRICS.map(m => {
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
        ${acc && safeUrl(acc.url) ? `<a href="${esc(acc.url)}" target="_blank" rel="noopener" title="${esc(acc.name)}">${esc(accShort(acc))} ↗</a>` : ''}
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
  renderCondSettings();
}
(() => {
  const y = new Date().getFullYear();
  $('#profile-year').innerHTML = Array.from({ length: 6 }, (_, i) => y - 1 + i)
    .map(v => `<option value="${v}">${v}年3月卒業（${String(v).slice(2)}卒）</option>`).join('');
  $('#profile-degree').innerHTML = Object.entries(DEGREES).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
})();
['#profile-year', '#profile-degree'].forEach(sel => $(sel).addEventListener('change', () => {
  state.profile = normalizeProfile({ ...state.profile, gradYear: $('#profile-year').value, degree: $('#profile-degree').value });
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
  editing = src ? structuredClone(src) : normalizeCompany({ name: '', status: 'entry', createdAt: Date.now() });
  $('#company-dialog-title').textContent = src ? '企業を編集' : '企業を追加';
  ['name', 'status', 'hq', 'locations', 'tokyo', 'url', 'homepage', 'loginId', 'memo'].forEach(k => { cForm[k].value = editing[k]; });
  $('#posting-url').value = editing.site;
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
  // 企業名・募集者名は重く見る
  const names = [cForm.name.value, cForm.p_recruiter.value].join('\n');
  return [names, names, names, cForm.p_job.value, cForm.p_raw.value].join('\n');
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
  updateYenPreviews();
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
  POSTING_NUM.forEach(k => { p[k] = parseNumField(k, cForm['p_' + k].value); });
  POSTING_FLAGS.forEach(f => { p[f.key] = cForm['p_' + f.key].checked; });
  p.tokyo = cForm.p_tokyo.value;
  p.applied = cForm.p_applied.checked;
  p.prevYear = cForm.p_prevYear.checked;
}
/** 初任給・住宅補助の欄の下に、読み取った金額を表示する */
function updateYenPreviews() {
  $$('.yen-preview').forEach(el => {
    const raw = cForm[el.dataset.for].value.trim();
    const n = parseYen(raw);
    el.classList.toggle('bad', Number.isNaN(n));
    el.textContent = !raw ? '' : Number.isNaN(n) ? '数字で入力してください（例 255000 / 25.5万）'
      : `= ${n.toLocaleString('ja-JP')}円${String(n) === raw ? '' : ' として保存'}`;
  });
}
$$('[data-yen]').forEach(inp => inp.addEventListener('input', updateYenPreviews));
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
  ['name', 'hq', 'locations', 'url', 'homepage', 'loginId'].forEach(k => { editing[k] = cForm[k].value.trim(); });
  editing.site = $('#posting-url').value.trim();
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
  const badYen = $$('[data-yen]').find(inp => Number.isNaN(parseYen(inp.value)));
  if (badYen) {
    $('#posting-section').open = true;
    badYen.focus();
    toast('金額を読み取れません。数字で入力してください（例 255000 / 25.5万）');
    return;
  }
  readCompanyForm();
  if (!editing.name) { cForm.name.focus(); toast('企業名を入力してください'); return; }
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
  if (reviewQueue.length) { setTimeout(openNextReview, 250); return; }
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
  if (reviewQueue.length) {
    if (confirm(`まとめて取得した募集要項の確認が、あと ${reviewQueue.length}社 あります。続けますか？`)) { setTimeout(openNextReview, 250); return; }
    reviewQueue = [];
  }
  if (findCompany(editing.id)) openDetail(editing.id); // 詳細から開いた場合は詳細に戻る
}
cDialog.querySelector('[data-close]').addEventListener('click', tryCloseCompany);
cDialog.addEventListener('cancel', e => { e.preventDefault(); tryCloseCompany(); });

$('#delete-company').addEventListener('click', () => {
  if (!confirm(`「${editing.name}」を削除しますか？\n登録した予定やログイン情報も削除されます。`)) return;
  state.companies = state.companies.filter(c => c.id !== editing.id);
  gsyncIgnore(editing); // Gmail同期で復活しないようにする
  cloudTomb(editing.id); // ほかの端末のデータと統合しても復活しないようにする
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
  ['eligibility',  ['応募資格', '応募対象', '対象', '対象者', '募集対象', '応募条件', '応募要件', '必須スキル・経験', '必須スキル', '必須条件', '必須要件', '必須経験', '募集学科', '対象学科', '募集学部', '対象学部', '学部学科', '募集学部・学科']],
  ['startDate',    ['入社時期', '入社日', '入社予定日']],
  ['contract',     ['契約期間', '雇用形態', '勤務形態', '雇用区分']],
  ['probation',    ['試用期間']],
  ['locations',    ['勤務地', '勤務場所', '就業場所', '勤務予定地', '配属先']],
  ['hours',        ['勤務時間', '就業時間', '勤務体系', '時間外労働', '残業時間', '残業']],
  ['salaryNote',   ['初任給', '給与', '給与・待遇', '基本給', '月給', '給与（月給）', '想定給与', '給与条件', '想定年収', '年俸', '報酬', '給与・報酬']],
  ['benefits',     ['福利厚生', '待遇', '社会保険', '待遇・福利厚生', '研修制度', '教育制度', '研修', '人材開発制度', '人材育成制度']],
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
                    '募集拠点', '受動喫煙防止措置', '受動喫煙対策', '設立', '資本金', '称号', '商号', '従業員数', '代表者', '売上高', '業務概要']],
];
// 1〜2行で終わるはずの項目（ページ末尾のメニューなどを取り込まないよう行数を制限）
const SHORT_FIELDS = new Set(['hq', 'recruiter', 'startDate', 'contract', 'probation', 'commute', 'raise', 'bonusNote', 'holidaysNote', 'hiring', 'allowances']);

// 募集要項ではない見出し（ここで読み取りを止める）
const STOP_LABELS = ['社風', '企業理念', '経営理念', '会社概要', '企業情報', '会社情報', 'メッセージ', 'よくある質問', 'FAQ',
  'お問い合わせ', '問い合わせ先', '社員紹介', '社員インタビュー', 'インタビュー', '働く環境', 'キャリアパス', '事業内容',
  'プライバシーポリシー', '個人情報の取り扱い', 'ENTRY', 'エントリー', 'MYPAGE', 'マイページ', '採用担当より',
  '採用情報', '関連求人', '求人一覧', '応募する', 'この求人に応募する', '連絡先', '問合せ先', '問い合わせ'];
/** 読み取りの前の下ごしらえ：全角数字を半角に、「１．募集職種」「① 初任給」の番号を外して1項目1行に */
function prepPosting(raw) {
  return (raw || '').replace(/\r/g, '')
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/(\d)[，](?=\d{3})/g, '$1,').replace(/(\d)[．](?=\d)/g, '$1.')
    // 「５．入社後の待遇 ① 初任給 …」→ 丸数字の前で改行
    .replace(/(^|[ \t　])([①-⑳])[ \t　]*/gm, (m, sp, n) => '\n' + n + ' ')
    .split('\n').map(l => l.replace(/^[ \t　]*(?:\d{1,2}[.．、)）](?!\d)|[(（]\d{1,2}[)）]|[①-⑳]|[一二三四五六七八九十]{1,3}[、．.])[ \t　]*/, ''))
    .join('\n');
}
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
      // 「初任給（月額）」は見出し。ただし「本社（東京都港区）」のようにカッコの中が住所なら内容の行
      if (!exactOnly && t.startsWith(l) && /^[（(]/.test(t.slice(l.length)) && t.length <= l.length + 14 &&
        !/東京都|北海道|京都府|大阪府|[^\s（(）)]{1,3}県|[^\s（(）)]{1,5}[市区町村]/.test(t.slice(l.length))) return field;
    }
  }
  return null;
}
function matchLabel(line) {
  let t = line.replace(/[\s:：]+$/, '');
  // 【基本給】 大学院了：277,000円 のように、見出しと内容が1行にある
  const br = t.match(/^[【\[［]\s*([^】\]］]{1,12}?)\s*[】\]］][\s:：]*(.*)$/);
  if (br) {
    // 【雇入れ直後】東京 のような法律の決まり文句は見出しではない（前の項目の続き）
    if (/^(?:雇入れ直後|変更の範囲)$/.test(br[1])) return null;
    if (STOP_LABELS.includes(br[1])) return { field: '_skip', rest: '' };
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
  raw = prepPosting(raw);
  for (let line of raw.split('\n')) {
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
  if (b) { cForm.p_salary.value = b.dataset.v; updateYenPreviews(); toast('比較用の初任給にセットしました'); }
});
cForm.p_salaryNote.addEventListener('input', showSalaryCandidates);

/** 前年度（1つ上の学年向け）の募集要項か */
function isPrevYearPosting(raw, gradYear) {
  const pat = y => new RegExp(`${y}年(?:度|卒|3月)|${String(y).slice(2)}卒|${y}年\\s*3月`);
  // 「2028年度新卒採用インターンシップ」のような、インターンについての行は年度の判定に使わない
  const body = raw.split('\n').filter(l => !/インターン|internship/i.test(l)).join('\n');
  return pat(gradYear - 1).test(body) && !pat(gradYear).test(body);
}
/** 募集職種の欄から職種名の一覧を取り出す（「総合職\nバックオフィス職」→ 2つ） */
function jobLines(jobText) {
  let lines = (jobText || '').split('\n').map(l => l.trim().replace(/^[・■●◆\-－]\s*/, ''))
    .filter(l => l && !/^※/.test(l) && !/^[【\[（(](?:雇入れ直後|変更の範囲)/.test(l));
  if (lines.length === 1) {
    lines = lines[0].split(/\s*[／/]\s*/).filter(Boolean);
    if (lines.length === 1) lines = splitTopLevel(lines[0]).map(x => x.trim()).filter(Boolean);
  }
  // 「システム開発エンジニア(アプリケーション開発、…)」→ 名前と説明に分ける
  return lines.map(l => {
    const m = l.match(/^(.+?)\s*[（(]([^]*)[)）]\s*$/);
    return m ? { name: m[1].trim(), desc: m[2].trim(), line: l } : { name: l, desc: '', line: l };
  });
}
function detectJobs(jobText) {
  // 先頭から「職種名らしい行」が続くところまでを職種とみなす（後ろの業務内容の説明などは含めない）
  const names = [];
  for (const j of jobLines(jobText)) {
    if (j.name.length > 25 || /^[（(※＊*]|[。．]|上記|同上|以下/.test(j.name)) break;
    names.push(j.name);
  }
  const ok = names.length >= 2 && names.length <= 8 && names.every(n => n.length <= 25 && !/[。．]/.test(n));
  return ok ? [...new Set(names)] : [];
}
/** 職種の「仕事内容」欄に入れる文（説明があれば付ける） */
function jobText(job, jobText) {
  const j = jobLines(jobText).find(x => x.name === job);
  return j && j.desc ? `${job}（${j.desc}）` : job;
}
/** その行が「総合職：〜」「総合職（修士卒）〜」のように、どの職種の行か（なければ null） */
function lineJob(line, jobs) {
  const t = line.trim().replace(/^[・■●◆\-－]\s*/, '');
  return [...jobs].sort((a, b) => b.length - a.length)
    .find(j => t.startsWith(j) && (t.length === j.length || /^[\s（(：:【\[]/.test(t.slice(j.length)))) || null;
}
/** 募集要項から、ほかの職種だけに当てはまる行を除いたテキスト */
function rawForJob(raw, jobs, job) {
  return raw.split('\n').flatMap(line => {
    const j = lineJob(line, jobs);
    if (j && j !== job) return [];
    if (j === job && line.trim() !== job) return [line.replace(new RegExp(`^(\\s*)${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`), '$1')];
    return [line];
  }).join('\n');
}
async function applyPosting(auto = false) {
  // ブックマークでコピーしたテキストなら、先頭の URL・ページ名を取り出して使う
  const clip = splitClip(cForm.p_raw.value);
  if (clip) { cForm.p_raw.value = clip.text; fillClipMeta(clip); }
  const raw = cForm.p_raw.value;
  if (!raw.trim()) { if (!auto) toast('募集要項のテキストを貼り付けてください'); return; }
  // Claude で整形した答え（JSON）を貼り付けたとき
  const ai = parseAiPosting(raw);
  if (ai) { await applyAiPosting(ai); return; }
  if (looksLikeAi(raw)) { alert(aiErrorMsg()); return; } // JSON が崩れているときは、普通の文章として読まない
  const allJobText = parsePosting(raw).job;
  const canSplit = editing.postings.length === 1 && !cForm.p_title.value.trim();
  const jobs = canSplit ? detectJobs(allJobText) : [];
  if (!jobs.length) {
    const blocks = canSplit ? jobBlocks(raw) : [];
    if (blocks.length) await applyJobBlocks(raw, blocks, auto);
    else fillPostingFromText(raw, auto);
    return;
  }

  // 「募集職種」の一覧の行そのものは、職種ごとに違う条件とはみなさない
  const listLines = new Set(jobLines(allJobText).map(j => j.line));
  const specific = raw.split('\n').some(l => {
    const j = lineJob(l, jobs);
    const t = l.trim().replace(/^[・■●◆\-－]\s*/, '');
    return j && t !== j && !listLines.has(t);
  });
  const picked = await pickJobs(jobLines(allJobText).filter(j => jobs.includes(j.name)), specific);
  if (!picked) { fillPostingFromText(raw, auto); return; } // まとめて1つ
  if (picked.length === 1) {
    fillPostingFromText(rawForJob(raw, jobs, picked[0]), auto, { title: picked[0] });
    cForm.p_job.value = jobText(picked[0], allJobText);
    return;
  }

  // 会社全体の勤務地には、すべての職種の勤務地を入れておく
  const allLoc = parsePosting(raw).locations;
  if (allLoc && !cForm.locations.value.trim()) cForm.locations.value = allLoc;
  const results = [];
  picked.forEach((job, i) => {
    if (i > 0) addPosting(false);
    results.push({ job, ...fillPostingFromText(rawForJob(raw, jobs, job), auto, { title: job, quiet: true, perPosting: true }) });
    cForm.p_job.value = jobText(job, allJobText);
    cForm.p_raw.value = raw;
  });
  finishMultiJobs(results);
}
function finishMultiJobs(results) {
  switchPosting(0);
  $('#posting-section').open = true;
  const sal = results.map(r => `${r.job} ${r.salary ? r.salary.toLocaleString('ja-JP') + '円' : '初任給なし'}`).join(' / ');
  toast(`${results.length}つの職種に分けて入力しました（${sal}）。タブで切り替えて確認してください`);
  const later = [...new Set(results.flatMap(r => r.later || []).filter(m => !/^初任給/.test(m)))];
  later.forEach((m, i) => setTimeout(() => toast(m), 2500 * (i + 1)));
}

/* ---- Claude で整えた答えを貼り付けて入力 ----
   「入力の型」を Claude に渡して募集要項を決まった形（JSON）にしてもらい、その答えを貼るだけで入力する */
const AI_FORMAT = 'syukatsu-posting-v1';
const AI_TEXT_KEYS = ['title', 'job', 'location', 'eligibility', 'startDate', 'contract', 'probation', 'hours', 'holidaysNote',
  'salaryNote', 'bonusNote', 'raise', 'benefits', 'allowances', 'commute', 'note'];
function aiTemplate() {
  const p = state.profile;
  const deg = DEGREES[p.degree]?.label || '大学院（修士）';
  const example = {
    format: AI_FORMAT, company: '株式会社〇〇', homepage: 'https://www.example.co.jp/', recruitUrl: 'https://recruit.example.co.jp/',
    hq: '東京都港区', locations: '東京、大阪',
    jobs: [{
      title: 'システムエンジニア', job: '仕事内容の説明', location: '',
      salary: 300000, annual: null, bonus: 5.2, holidays: 125, overtime: 20, housing: 30000, hiring: 50,
      flex: true, remote: false, discretionary: false, prevYear: false,
      salaryNote: '修士 300,000円\n学士 280,000円', eligibility: '', startDate: '', contract: '', probation: '', hours: '',
      holidaysNote: '', bonusNote: '', raise: '', benefits: '', allowances: '', commute: '', note: '選考の流れ・提出書類など',
    }],
  };
  return `【就活管理アプリ 入力の型】
送られてきた新卒採用の募集要項を、次の形のJSONに変換してください。

ルール
- 答えは \`\`\`json のコードブロックだけ。説明の文章は不要です。
- 書かれていないことは推測せず "" か null にしてください（homepage と recruitUrl は、会社の公式サイト・採用サイトの URL が確実にわかるときだけ）。
- 職種が複数あるときは jobs に職種ごとに分けてください（条件が同じでも職種名ごとに1つ）。
- 複数の会社の募集要項が送られてきたら、会社ごとに別のコードブロックにしてください。
- salary：私（${deg}・${p.gradYear}年卒）に当てはまる月額の初任給を円の整数で。学歴で違うなら私の学歴の額。年俸制なら null にして annual に入れる。
- annual：想定年収・年俸（万円の整数）／bonus：賞与の月数（数値）／holidays：年間休日（日）／overtime：月平均残業（時間）／housing：住宅手当・家賃補助の月額（円）／hiring：採用予定人数
- location：その職種だけの勤務地（会社全体の locations と同じなら ""）
- flex：フレックスあり、remote：在宅・リモート勤務あり、discretionary：裁量労働制
- prevYear：${p.gradYear}年卒向けではなく前年度（${p.gradYear - 1}年卒向け）の内容なら true
- 文章の項目は原文の言葉のまま、改行は \\n で。「（雇入れ直後）」「（変更の範囲）」のような法律の決まり文句は省いてかまいません。

形
\`\`\`json
${JSON.stringify(example, null, 1)}
\`\`\``;
}
/** 貼り付けた文から、入力の型の JSON をすべて取り出す */
/** Claude の答えによくある崩れを直す（文字列の中の改行・末尾の「,」・全角の引用符・コメント・数字のカンマなど） */
function repairJson(t) {
  t = t.replace(/^﻿/, '').replace(/[“”＂]/g, '"').replace(/ /g, ' ');
  let out = '', inStr = false, bs = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (bs) { out += ch; bs = false; }
      else if (ch === '\\') { out += ch; bs = true; }
      else if (ch === '"') { out += ch; inStr = false; }
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch !== '\r') out += ch;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 1; continue; }
    out += ch;
  }
  return out
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/:(\s*)(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?=\s*[,}\]\n])/g, (m, sp, n) => ':' + sp + n.replace(/,/g, ''))
    .replace(/:(\s*)(?:None|undefined|NaN)\b/g, ':$1null').replace(/:(\s*)True\b/g, ':$1true').replace(/:(\s*)False\b/g, ':$1false');
}
/** 貼り付けた文が入力の型の答え（JSON）らしいか */
const looksLikeAi = raw => /\{[\s\S]*["“”]?(?:jobs|company|format)["“”]?\s*:/.test(raw || '');
let aiParseError = '';
/** 1つの JSON ブロックを読む（失敗したら直してからもう一度） */
function parseJsonLoose(b) {
  try { return JSON.parse(b); } catch { /* 直してからもう一度 */ }
  const fixed = repairJson(b);
  try { return JSON.parse(fixed); } catch (err) {
    // 「{…}{…}」のように会社ごとのオブジェクトが並んでいる
    try { return JSON.parse(`[${fixed.replace(/}\s*{/g, '},{')}]`); } catch { /* 下で報告 */ }
    const pos = Number((String(err.message).match(/position (\d+)/) || [])[1]);
    aiParseError = Number.isFinite(pos) ? `${pos}文字目あたりの形が崩れています（…${fixed.slice(Math.max(0, pos - 25), pos + 15).replace(/\n/g, ' ')}…）` : String(err.message);
    return null;
  }
}
/** 会社1つ分に整える（jobs が無く、職種の項目が会社と同じ階層にある答えにも対応） */
function aiCompany(x) {
  if (!x || typeof x !== 'object') return null;
  let jobs = x.jobs ?? x.positions ?? x.postings;
  if (jobs && !Array.isArray(jobs)) jobs = [jobs];
  if (!jobs || !jobs.length) {
    if (['title', 'salary', 'salaryNote', 'job'].some(k => x[k] != null && x[k] !== '')) jobs = [x];
    else return null;
  }
  return { ...x, company: x.company ?? x.companyName ?? x.name ?? '', jobs: jobs.filter(j => j && typeof j === 'object') };
}
/** 貼り付けた文から、入力の型の JSON をすべて取り出す */
function parseAiAll(raw) {
  aiParseError = '';
  if (!looksLikeAi(raw)) return [];
  let blocks = [...raw.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)].map(m => m[1]).filter(b => b.includes('{'));
  if (!blocks.length) {
    const i = raw.search(/[{[]/);
    blocks = [raw.slice(i, Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']')) + 1)];
  }
  const out = [];
  for (const b of blocks) {
    const o = parseJsonLoose(b.trim());
    if (o == null) continue;
    const list = Array.isArray(o) ? o : Array.isArray(o.companies) ? o.companies : [o];
    list.map(aiCompany).filter(x => x && x.jobs.length).forEach(x => out.push(x));
  }
  if (!out.length && !aiParseError) aiParseError = '会社や職種（jobs）の項目が見つかりません';
  return out;
}
const aiErrorMsg = () => `Claude の答えを読み取れませんでした。\n${aiParseError}\n\nClaude の答えの右下（または右上）の「コピー」ボタンで、答え全体をコピーし直して貼り付けてください。直らないときは Claude に「JSONの形が崩れています。もう一度、正しいJSONだけで出してください」と頼んでください。`;
const parseAiPosting = raw => parseAiAll(raw)[0] || null;
const aiNum = v => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null; };
/** 入力の型の1職種 → アプリの職種データ */
function aiPostingData(j, single) {
  const d = { prevYear: Boolean(j.prevYear) };
  AI_TEXT_KEYS.forEach(k => { d[k] = str(j[k]).trim(); });
  if (single && !d.title) d.title = '';
  POSTING_NUM.forEach(k => { d[k] = aiNum(j[k]); });
  POSTING_FLAGS.forEach(f => { d[f.key] = Boolean(j[f.key]); });
  return d;
}
/** 編集画面に入力（貼り付けた答えが1社分のとき） */
async function applyAiPosting(o) {
  const jobs = o.jobs.map((j, i) => ({ ...j, name: str(j.title).trim() || `職種${i + 1}`, desc: str(j.job).slice(0, 60) }));
  let sel = jobs.slice(0, 1);
  if (jobs.length > 1) {
    const picked = await pickJobs(jobs, true);
    if (picked) sel = jobs.filter(j => picked.includes(j.name));
  }
  savePostingForm();
  // 同じ職種名のタブがあればそこを更新、なければ空のタブ、それもなければタブを足す（入力済みの職種は上書きしない）
  const tkey = t => str(t).replace(/[\s（）()]/g, '');
  const slotFor = j => {
    let i = editing.postings.findIndex(p => p.title && tkey(p.title) === tkey(j.title));
    if (i < 0) i = editing.postings.findIndex(p => !postingHasData(p) || (!p.title && p.salary == null && !p.salaryNote));
    if (i >= 0) switchPosting(i); else addPosting(false);
  };
  const setIf = (n, v) => { if (v != null && String(v).trim() !== '') cForm[n].value = String(v).trim(); };
  if (!cForm.name.value.trim()) setIf('name', o.company);
  if (!cForm.hq.value.trim()) setIf('hq', o.hq);
  if (!cForm.locations.value.trim()) setIf('locations', o.locations);
  if (!cForm.homepage.value.trim() && safeUrl(o.homepage)) setIf('homepage', o.homepage);
  if (!$('#posting-url').value.trim() && safeUrl(o.recruitUrl)) $('#posting-url').value = o.recruitUrl;
  const results = [];
  sel.forEach(j => {
    slotFor(j);
    const d = aiPostingData(j, jobs.length === 1);
    AI_TEXT_KEYS.forEach(k => { if (d[k]) cForm['p_' + k].value = d[k]; });
    POSTING_NUM.forEach(k => { if (d[k] != null) cForm['p_' + k].value = d[k]; });
    POSTING_FLAGS.forEach(f => { if (d[f.key]) cForm['p_' + f.key].checked = true; });
    cForm.p_prevYear.checked = d.prevYear;
    cForm.p_raw.value = '';
    savePostingForm();
    results.push({ job: j.name, salary: Number(cForm.p_salary.value) || null });
  });
  renderPostingTabs();
  showSalaryCandidates();
  updateYenPreviews();
  updateTokyoHint();
  if (!$('#industry-select').value) {
    const g = guessIndustries(industryGuessText())[0];
    if (g) setIndustry(g.name);
  } else updateIndustryUi();
  if (results.length > 1) finishMultiJobs(results);
  else {
    $('#posting-section').open = true;
    toast('入力しました。内容を確認して保存してください');
  }
}
/** 答えの会社に当たる登録済みの企業（company と aliases の名前を順に照合） */
function findAiCompany(o) {
  const names = [o.company, ...(Array.isArray(o.aliases) ? o.aliases : [])].map(nameKey).filter(Boolean);
  for (const k of names) {
    const hit = state.companies.find(c => nameKey(c.name) === k);
    if (hit) return hit;
  }
  return null;
}
/** 編集画面の外で貼り付けたとき：1社なら編集画面で確認、複数社ならまとめて登録
    "replace": true の会社は、登録済みなら職種をまとめて置き換える（ステータス・予定・メモはそのまま） */
async function importAiAnswer(text) {
  const list = parseAiAll(text);
  if (!list.length) {
    if (looksLikeAi(text)) { alert(aiErrorMsg()); return true; }
    return false;
  }
  if (list.length === 1 && !list[0].replace) {
    const o = list[0];
    const hit = findAiCompany(o);
    if (hit && hasPosting(hit) && !confirm(`「${hit.name}」はすでに募集要項が入っています。職種を追加しますか？`)) return true;
    openCompany(hit ? hit.id : null);
    if (!hit) { cForm.status.value = 'interest'; }
    await applyAiPosting(o);
    $('.paste-box')?.scrollIntoView({ block: 'start' });
    return true;
  }
  const toReplace = list.filter(o => o.replace).map(findAiCompany).filter(c => c && hasPosting(c));
  if (toReplace.length && !confirm(`${toReplace.length}社（${toReplace.slice(0, 5).map(c => c.name).join('、')}${toReplace.length > 5 ? ' など' : ''}）は、入力済みの職種を読み込む内容に置き換えます。よろしいですか？`)) return true;
  let added = 0, updated = 0, replaced = 0;
  for (const o of list) {
    const name = str(o.company).trim();
    if (!name) continue;
    const postings = o.jobs.map(j => normalizePosting(aiPostingData(j, o.jobs.length === 1)));
    const hit = findAiCompany(o);
    if (hit && o.replace) {
      hit.postings = postings;
      ['hq', 'locations'].forEach(k => { if (str(o[k]).trim()) hit[k] = str(o[k]).trim(); });
      if (!hit.homepage && safeUrl(o.homepage)) hit.homepage = o.homepage;
      if (!hit.site && safeUrl(o.recruitUrl)) hit.site = o.recruitUrl;
      hit.updatedAt = Date.now();
      replaced++;
    } else if (hit) {
      const titles = new Set(hit.postings.filter(postingHasData).map(p => p.title));
      hit.postings = [...hit.postings.filter(postingHasData), ...postings.filter(p => !titles.has(p.title))];
      ['hq', 'locations'].forEach(k => { if (!hit[k] && o[k]) hit[k] = str(o[k]); });
      if (!hit.homepage && safeUrl(o.homepage)) hit.homepage = o.homepage;
      if (!hit.site && safeUrl(o.recruitUrl)) hit.site = o.recruitUrl;
      hit.updatedAt = Date.now();
      updated++;
    } else {
      state.companies.push(normalizeCompany({ name, status: 'interest', hq: str(o.hq), locations: str(o.locations),
        homepage: safeUrl(o.homepage), site: safeUrl(o.recruitUrl), postings, createdAt: Date.now(), updatedAt: Date.now() }));
      added++;
    }
  }
  save();
  render();
  toast(`Claude の答えから ${added}社 を追加` + (updated ? `、${updated}社 に職種を追加` : '') + (replaced ? `、${replaced}社 の職種を置き換え` : '') + 'しました');
  return true;
}
async function copyAiTemplate() {
  const t = aiTemplate();
  try { await navigator.clipboard.writeText(t); toast('入力の型をコピーしました。Claude に貼り付けて、続けて募集要項を送ってください'); }
  catch { window.prompt('次の文をコピーしてください', t); }
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-ai-template]')) copyAiTemplate();
  if (e.target.closest('[data-ai-show]')) {
    const box = $('#ai-template-text');
    box.hidden = !box.hidden;
    if (!box.hidden) box.value = aiTemplate();
  }
});
$('#ai-paste-new').addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { toast('貼り付けを許可できませんでした。Ctrl+V（スマホは長押し）で貼り付けてください'); return; }
  qDialog.close();
  if (!(await importAiAnswer(text))) toast('コピーした内容に入力の型の答え（JSON）が見つかりませんでした');
});
// PC：画面のどこでも Ctrl+V で Claude の答えを貼り付けられる（入力欄の中は除く）
document.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text') || '';
  if (!looksLikeAi(text)) return;
  const open = $$('dialog[open]');
  // 「企業を追加」の画面では、企業名の欄に貼っても答えとして読む
  if (open.length === 1 && open[0].id === 'quick-dialog') { e.preventDefault(); qDialog.close(); importAiAnswer(text); return; }
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
  if (open.length) return;
  e.preventDefault();
  importAiAnswer(text);
});

/* 「戦略コンサルタント職（RDE）」→ 説明文 → 給与・勤務地…のように、職種ごとに区切られたページ */
const JOB_HEAD_RE = /^[^\s。、，,：:※・]{2,22}(?:職|コース|部門|エンジニア|コンサルタント)(?:\s*[（(][^（(）)]{1,15}[）)])?$/;
function jobBlocks(raw) {
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const heads = [];
  lines.forEach((l, i) => {
    if (!JOB_HEAD_RE.test(l) || matchLabel(l) || isStop(l)) return;
    // 見出しのすぐ下に説明の文章がある（ただの職種の一覧とは区別する）
    const next = lines[i + 1] || '';
    if (next.length >= 30 && !JOB_HEAD_RE.test(next)) heads.push(i);
  });
  if (heads.length < 2 || heads.length > 10) return [];
  const maxSize = Math.max(...heads.slice(1).map((h, k) => h - heads[k]));
  return heads.map((h, k) => {
    let body = lines.slice(h + 1, k + 1 < heads.length ? heads[k + 1] : h + maxSize);
    const stop = body.findIndex(l => isStop(l) || /^(?:関連情報|関連リンク)$/.test(l));
    if (stop > 0) body = body.slice(0, stop);
    const intro = body[0];
    return { name: lines[h], desc: intro.length > 60 ? intro.slice(0, 60) + '…' : intro, intro, body: body.join('\n') };
  });
}
async function applyJobBlocks(raw, blocks, auto) {
  const picked = await pickJobs(blocks, true);
  if (!picked) { fillPostingFromText(raw, auto); return; }
  const sel = blocks.filter(b => picked.includes(b.name));
  if (sel.length === 1) {
    fillPostingFromText(sel[0].body, auto, { title: sel[0].name });
    cForm.p_job.value = sel[0].intro;
    return;
  }
  const results = [];
  sel.forEach((b, i) => {
    if (i > 0) addPosting(false);
    results.push({ job: b.name, ...fillPostingFromText(b.body, auto, { title: b.name, quiet: true, perPosting: true }) });
    cForm.p_job.value = b.intro;
    cForm.p_raw.value = raw;
  });
  finishMultiJobs(results);
}
/** 募集要項のテキストを、いま選んでいる職種の欄に読み取って入れる */
function fillPostingFromText(raw, auto = false, opts = {}) {
  raw = prepPosting(raw);
  const parsed = parsePosting(raw);
  // 「初任給」の見出しがなく「月額基本給：459,084円」のように書かれているとき
  if (!parsed.salaryNote) {
    const ls = raw.split('\n').map(l => l.trim());
    const pick = [];
    ls.forEach((l, i) => {
      if (!/(?:年収|基本給|月給|初任給|給与)[^\n]*?\d[\d,.]*\s*万?\s*円/.test(l)) return;
      pick.push(l);
      for (let j = i + 1; j < ls.length && /^※/.test(ls[j]) && /金額|給|支給|手当|改定/.test(ls[j]); j++) pick.push(ls[j]);
    });
    if (pick.length) parsed.salaryNote = [...new Set(pick)].join('\n');
  }
  const values = {}; // フォーム要素名 → 値
  for (const [field, text] of Object.entries(parsed)) {
    // 職種が複数あるときは、その職種の勤務地として入れる
    if (field === 'locations') values[opts.perPosting || editing.postings.length > 1 ? 'p_location' : 'locations'] = text;
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
  if (opts.title && !cForm.p_title.value) values.p_title = opts.title;
  if (!cForm.p_title.value && !values.p_title) {
    const t = raw.split('\n').map(l => l.trim()).find(l => l.length <= 30 && !/株式会社|求人一覧/.test(l) && /新卒.*(?:職|コース|採用)$/.test(l));
    if (t) values.p_title = t;
  }
  const housing = (raw.match(/住宅(?:補助|手当)[^\n]*?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万)?\s*円/) || []);
  if (housing[1]) values.p_housing = toYen(housing[1], housing[2]);
  const bonus = (parsed.bonusNote || '').match(/(\d+(?:\.\d+)?)\s*(?:ヶ月|か月|カ月|ヵ月|ケ月)/);
  if (bonus) values.p_bonus = bonus[1];
  const hol = raw.match(/年間休日[^\n]{0,15}?(\d{2,3})\s*日/);
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
    // 「本社(東京)、北海道、岩手、…」のような勤務地の一覧は本社所在地ではない
    const line = (parsed.locations || '').split('\n').find(l => /本社/.test(l) && l.length <= 40 && (l.match(/[、,]/g) || []).length < 2);
    if (line) values.hq = line;
  }
  const flags = {
    p_flex: /フレックス|フレキシブル|コアタイム/.test(raw),
    p_discretionary: /裁量労働/.test(raw),
    p_remote: /リモート|在宅|テレワーク/.test(raw),
  };

  const names = Object.keys(values);
  if (!names.length && !Object.values(flags).some(Boolean)) {
    if (opts.quiet) return {};
    if (auto) toast('自動で読み取れる見出しが見つかりませんでした（原文は保存されます）');
    else alert('項目を読み取れませんでした。\n「勤務地」「初任給」などの見出しが1行ずつになっているか確認してください。');
    return;
  }
  const filled = names.filter(n => String(cForm[n].value).trim() && String(cForm[n].value).trim() !== String(values[n]).trim());
  const overwrite = filled.length > 0 && !opts.quiet && confirm(`すでに入力済みの項目が ${filled.length} 件あります。読み取った内容で上書きしますか？\n（キャンセル → 空欄の項目だけ入力）`);
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
  updateYenPreviews();
  updateTokyoHint();
  let industryMsg = '';
  if (!$('#industry-select').value) {
    const g = guessIndustries(industryGuessText())[0];
    if (g) { setIndustry(g.name); industryMsg = `（業界は「${g.name}」と推定）`; }
  } else updateIndustryUi();
  if (!opts.quiet) toast(`${count} 項目を入力しました${industryMsg}。内容を確認して保存してください`);
  $('#posting-section').open = true;
  const later = [];
  if (mySal) later.push(`初任給は${DEGREES[state.profile.degree].label}の ${mySal.toLocaleString('ja-JP')}円 にしました`);
  if (values.p_annual && !values.p_salary) later.push(`年俸制のため「想定年収」に ${values.p_annual}万円 を入れました（月額にすると約${Math.round(values.p_annual / 12 * 10) / 10}万円）`);
  if (fixedOt) later.push('見込み残業（固定残業代）を含む給与です。比較するときは注意してください');
  else if (sal.length > 1) later.push(`初任給の候補が ${sal.length} 件あります。自分に当てはまる額をタップしてください`);
  if (prev) later.push(`${String(state.profile.gradYear - 1).slice(2)}卒向け（前年度）の募集要項のようです。「前年度の情報」として記録しました`);
  if (opts.quiet) return { count, salary: Number(cForm.p_salary.value) || null, later };
  later.forEach((m, i) => setTimeout(() => toast(m), 2000 * (i + 1)));
  return { count, later };
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
  if (!state.companies.length) {
    toast('先に企業を登録してください。予定は企業ごとに登録します');
    openCompany(null);
    return;
  }
  evCtx = { cid, eid };
  const ev = eid ? findCompany(cid)?.events.find(x => x.id === eid) : null;
  // 企業を指定せずに開いたとき（予定画面・ホーム）は企業を選んでもらう
  const pick = !cid;
  $('#event-company-row').hidden = !pick;
  if (pick) {
    const cs = [...state.companies].sort((a, b) =>
      (ACTIVE_STATUSES.has(b.status) - ACTIVE_STATUSES.has(a.status)) || b.updatedAt - a.updatedAt);
    $('#event-company').innerHTML = '<option value="">企業を選んでください</option>' +
      cs.map(c => `<option value="${c.id}">${esc(c.name)}（${STATUS_MAP[c.status].label}）</option>`).join('');
  }
  $('#event-dialog-title').textContent = ev ? '予定・締切を編集' : '予定・締切を追加';
  eForm.title.value = ev?.title || '';
  eForm.date.value = ev?.date || todayStr();
  eForm.time.value = ev?.time || '';
  eForm.endTime.value = ev?.endTime || '';
  eForm.place.value = ev?.place || '';
  eForm.done.checked = Boolean(ev?.done);
  $('#delete-event').hidden = !ev;
  const c = cid ? findCompany(cid) : null;
  $('#event-company-info').hidden = !c;
  $('#event-company-name').textContent = c ? c.name : '';
  $('#event-cal').hidden = !ev;
  if (ev) $('#event-google').href = gcalUrl(ev, c.name);
  eDialog.showModal();
  if (!ev) setTimeout(() => (pick ? $('#event-company') : eForm.title).focus(), 50);
}
function afterChange() {
  save();
  render();
  if (dDialog.open) renderDetail();
}
eForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!evCtx.cid) {
    evCtx.cid = eForm.cid.value;
    if (!evCtx.cid) { toast('企業を選んでください'); $('#event-company').focus(); return; }
  }
  const c = findCompany(evCtx.cid);
  if (!c) return;
  const data = {
    title: eForm.title.value.trim(), date: eForm.date.value, time: eForm.time.value, endTime: eForm.time.value ? eForm.endTime.value : '',
    place: eForm.place.value.trim(), done: eForm.done.checked,
  };
  if (!data.title || !data.date) return;
  if (!data.time && eForm.endTime.value) { toast('開始時刻も入力してください'); eForm.time.focus(); return; }
  if (data.endTime && data.endTime <= data.time) { toast('終了時刻は開始時刻より後にしてください'); eForm.endTime.focus(); return; }
  const ev = evCtx.eid && c.events.find(x => x.id === evCtx.eid);
  if (ev) Object.assign(ev, data);
  else c.events.push({ id: uid(), ...data });
  c.updatedAt = Date.now();
  eDialog.close();
  afterChange();
  toast(`${c.name} に予定を保存しました`);
});
eDialog.querySelector('[data-close]').addEventListener('click', () => eDialog.close());
$('#event-open-company').addEventListener('click', () => { eDialog.close(); openDetail(evCtx.cid); });
$('#event-apple').addEventListener('click', () => {
  const c = findCompany(evCtx.cid);
  const ev = c?.events.find(x => x.id === evCtx.eid);
  if (ev) openIcs([{ c, ev }], `${ev.date}-${ev.title}`);
});
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
$('#fab').addEventListener('click', () => {
  if (currentView === 'es') openStock(null);
  else if (currentView === 'schedule') openEvent(null, null);
  else openQuickAdd();
});
$('#add-event-btn').addEventListener('click', () => openEvent(null, null));

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

function showImportPreview(data, label) {
  if (!Array.isArray(data.companies)) throw new Error('形式が正しくありません');
  const next = normalizeState(data);
  const preview = mergeState(state, next);
  const r = preview.report;
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
  $('#import-summary').innerHTML =
    `${esc(label)}${when ? `（${esc(when)}）` : ''}：企業 ${next.companies.length} 社・サービス ${next.accounts.length} 件・ESストック ${next.stock.length} 件<br>` +
    `統合すると：新しい企業 <b>${r.added}</b> 社、内容が変わる企業 <b>${r.updated}</b> 社、変化なし ${r.same} 社` +
    (r.otherAdded ? `、サービス・ESストック ${r.otherAdded} 件を追加` : '');
  pendingImport = { next, merged: preview.state };
  iDialog.showModal();
}
/** バックアップの JSON か（入力の型の JSON と見分ける） */
function isBackupJson(text) {
  try {
    const d = JSON.parse(text);
    return d?.app === 'syukatsu' || (Array.isArray(d?.companies) && d.companies.some(c => c && typeof c.name === 'string' && !c.jobs));
  } catch { return false; }
}
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    // 入力の型（Claude の答え）の JSON ファイルなら、貼り付けたときと同じように企業・職種を登録する
    if (!isBackupJson(text) && await importAiAnswer(text)) return;
    showImportPreview(JSON.parse(text), 'ファイル');
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
  ['industry', 'hq', 'locations', 'tokyo', 'route', 'url', 'site', 'homepage', 'loginId', 'memo'].forEach(k => { if (!out[k] && older[k]) out[k] = older[k]; });
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
  if (safeUrl(c.homepage)) items.push(`<a href="${esc(c.homepage)}" target="_blank" rel="noopener">🏠 ホームページ ↗</a>`);
  if (safeUrl(c.site)) items.push(`<a href="${esc(c.site)}" target="_blank" rel="noopener">採用サイト ↗</a>`);
  if (pwText(c.pwd)) items.push(`<button data-act="copy-cpw">PWコピー</button>`);
  if (acc) {
    if (safeUrl(acc.url)) items.push(`<a href="${esc(acc.url)}" target="_blank" rel="noopener" title="${esc(acc.name)}">${esc(accShort(acc))} ↗</a>`);
    if (acc.loginId) items.push(`<button data-act="copy-aid" title="${esc(acc.name)}">${esc(accShort(acc))} ID</button>`);
    if (pwText(acc.pwd)) items.push(`<button data-act="copy-apw" title="${esc(acc.name)}">${esc(accShort(acc))} PW</button>`);
  }
  return items.length ? `<div class="actions">${items.join('')}</div>` : '';
}
/* ---- 職種カード（募集要項の表示） ---- */
const fmtMan = v => `${(Math.round(v / 1000) / 10).toLocaleString('ja-JP')}万円`;
// 法律で書くことになっている決まり文句（読む必要が少ない）
const BOILERPLATE_RE = /^[（(](?:雇入れ直後|変更の範囲)[)）]/;
/** 初任給の詳細：1行ずつ表にして、自分の学歴の行を強調 */
function salaryRows(text) {
  const re = DEGREES[state.profile.degree]?.re;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => {
    const m = l.match(/^(.*?)[\s:：]*((?:月給|月額|基本給)?\s*[\d,.]+\s*万?\s*円.*)$/);
    return m && m[1] ? { k: m[1], v: m[2], me: re ? re.test(m[1]) : false } : { k: '', v: l, me: false };
  });
  if (rows.filter(r => r.k).length < 2) return `<div class="pf-text">${esc(text)}</div>`;
  return `<div class="sal-rows">${rows.map(r => r.k
    ? `<div class="sal-row ${r.me ? 'me' : ''}"><span>${esc(r.k)}${r.me ? '<em>あなた</em>' : ''}</span><b>${esc(r.v)}</b></div>`
    : `<div class="sal-note">${esc(r.v)}</div>`).join('')}</div>`;
}
/** 勤務地から法律の決まり文句の行を除く */
function cleanLoc(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(l => l && !BOILERPLATE_RE.test(l)).join('\n');
}
/** 長い文章の1行目（閉じているときに見せる） */
function previewLine(text) {
  const first = text.split('\n').map(l => l.trim()).find(l => l && !BOILERPLATE_RE.test(l)) || text.trim();
  return first.length > 38 ? first.slice(0, 38) + '…' : first;
}
function postingCard(c, p, i, multi) {
  const tk = postingTokyo(c, p);
  const title = p.title || (multi ? postingTitle(p, i) : '募集要項');
  const net = netMonthly(p);
  const tiles = [
    p.salary != null && { l: '初任給', v: fmtMan(p.salary), sub: `${p.salary.toLocaleString('ja-JP')}円`, key: true },
    net != null && { l: '手取りの目安', v: fmtMan(net), sub: p.housing ? '家賃補助込み' : '額面の約8割' },
    p.holidays != null && { l: '年間休日', v: `${p.holidays}日` },
    p.housing != null && { l: '住宅補助', v: fmtMan(p.housing), sub: '月額' },
    p.annual != null && { l: '想定年収', v: `${p.annual.toLocaleString('ja-JP')}万円` },
    p.bonus != null && { l: '賞与', v: `${p.bonus}ヶ月` },
    p.overtime != null && { l: '月平均残業', v: `${p.overtime}時間` },
    p.hiring != null && { l: '採用予定', v: `${p.hiring.toLocaleString('ja-JP')}人` },
  ].filter(Boolean);
  const hl = housingLevel(c, p);
  const chips = [
    ...POSTING_FLAGS.filter(f => p[f.key]).map(f => `<span class="pchip">${f.label}</span>`),
    !p.housing && hl === 'yes' ? '<span class="pchip good">🏠 家賃補助・社宅あり</span>' : '',
    hl === 'dorm' ? '<span class="pchip">🏠 寮のみ</span>' : '',
  ].join('');
  // 出典の URL は「その他」から取り出してリンクにする
  const src = (p.note.match(/出典:\s*(https?:\/\/\S+)/) || [])[1];
  const note = p.note.replace(/^出典:\s*https?:\/\/\S+\s*$/m, '').trim();
  const loc = cleanLoc(p.location);
  const quick = [
    loc && ['📍', '勤務地', loc],
    p.job && ['💼', '仕事内容', p.job],
  ].filter(Boolean);
  const fields = POSTING_TEXT_LABELS.filter(([k]) => k !== 'note' && k !== 'job' && p[k]).map(([k, l]) => [k, l, p[k]]);
  if (note) fields.push(['note', 'その他', note]);
  return `<div class="pcard" data-pid="${p.id}">
    <div class="pcard-top">
      <span class="pcard-title">${esc(title)}</span>
      ${p.applied ? '<span class="applied-pill">応募</span>' : ''}
      ${p.prevYear ? `<span class="prev-pill" title="前年度の募集要項の内容です">${String(state.profile.gradYear - 1).slice(2)}卒向け（前年度）</span>` : ''}
      ${tokyoBadgeCode(tk)}
    </div>
    ${tiles.length ? `<div class="ptiles">${tiles.map(t => `<div class="ptile ${t.key ? 'key' : ''}"><span class="pt-l">${t.l}</span><b class="pt-v">${esc(t.v)}</b>${t.sub ? `<span class="pt-s">${esc(t.sub)}</span>` : ''}</div>`).join('')}</div>` : ''}
    ${chips ? `<div class="pchips">${chips}</div>` : ''}
    ${quick.length ? `<div class="pquick">${quick.map(([ico, l, v]) => `<div class="pq"><span class="pq-i" aria-hidden="true">${ico}</span><span class="pq-l">${l}</span><span class="pq-v">${esc(v)}</span></div>`).join('')}</div>` : ''}
    ${fields.length ? `<div class="pfields">${fields.map(([k, l, v]) => `
      <details class="pfield">
        <summary><span class="pf-l">${l}</span><span class="pf-p">${esc(previewLine(v))}</span></summary>
        ${k === 'salaryNote' ? salaryRows(v) : `<div class="pf-text">${esc(v)}</div>`}
      </details>`).join('')}</div>` : ''}
    ${src ? `<a class="psrc" href="${esc(src)}" target="_blank" rel="noopener">📄 募集要項のページを開く ↗</a>` : ''}
  </div>`;
}
function renderDetail() {
  const c = findCompany(detailId);
  if (!c) { dDialog.close(); return; }
  const st = STATUS_MAP[c.status];
  const ne = nextEvent(c);
  const rn = routeName(c);
  const ps = c.postings.filter(postingHasData);
  const evs = [...c.events].sort((a, b) => evKey(a).localeCompare(evKey(b)));
  const openEvs = evs.filter(ev => !ev.done);
  const doneEvs = evs.filter(ev => ev.done).reverse();
  const evRow = ev => `
        <div class="ev-row ${ev.done ? 'done' : ev.date < todayStr() ? 'overdue' : ''} ${ne && ev.id === ne.id ? 'next' : ''}">
          <input type="checkbox" data-eid="${ev.id}" ${ev.done ? 'checked' : ''} aria-label="完了">
          ${whenBox(ev.date)}
          <div class="ev-main" data-act="edit-event" data-eid="${ev.id}">
            <div class="ev-title">${esc(ev.title)}</div>
            <div class="ev-date">${!ev.done && ev.date < todayStr() ? '期限切れ・' : ''}${timeRange(ev) || '終日'}${ev.place ? '・' + esc(ev.place) : ''}</div>
          </div>
          <button class="gcal" data-act="ics-event" data-eid="${ev.id}" title="Appleカレンダーに追加" aria-label="Appleカレンダーに追加"><svg><use href="#i-calendar"/></svg></button>
        </div>`;
  const tk = TOKYO[bestTokyo(c)];

  $('#detail-body').innerHTML = `
    <div class="hero hero-color" style="--h:${hueOf(c)}">
      <div class="hero-top">
        ${avatar(c, 'lg')}
        <div class="hero-titles">
          <h1 class="hero-name">${esc(c.name)}</h1>
          <div class="hero-meta">
            <span class="stars-view">${stars(c.priority)}</span>
            ${c.industry ? `<span>${esc(c.industry)}</span>` : '<span>業界未設定</span>'}
            ${tokyoBadge(c)}
            ${rn ? `<span>経路: ${esc(rn)}</span>` : ''}
          </div>
        </div>
      </div>
      ${statusStepper(c)}
      ${loginActions(c)}
    </div>

    ${scoreSection(c)}

    <section class="dsec">
      <div class="dsec-head"><h3>予定・締切</h3><button class="btn small" data-act="add-event">＋ 追加</button></div>
      ${openEvs.map(evRow).join('') || '<p class="muted-empty">今後の予定はありません。「＋ 追加」から面接日や締切を登録できます。</p>'}
      ${doneEvs.length ? `<details class="done-evs"><summary>完了した予定（${doneEvs.length}件）</summary>${doneEvs.map(evRow).join('')}</details>` : ''}
    </section>

    <section class="dsec">
      <div class="dsec-head"><h3>職種・条件</h3>${ps.length > 1 ? `<span class="note small">${ps.length}職種</span>` : ''}</div>
      ${ps.length ? ps.map((p, i) => postingCard(c, p, i, ps.length > 1)).join('')
        : emptyPostingCta(c)}
    </section>

    ${c.hq || cleanLoc(c.locations) ? `<section class="dsec">
      <div class="dsec-head"><h3>勤務地</h3>${tk ? `<span class="note small">${tk.label}</span>` : ''}</div>
      <dl class="dl">
        ${c.hq ? `<dt>本社</dt><dd>${esc(c.hq)}</dd>` : ''}
        ${cleanLoc(c.locations) ? `<dt>勤務地</dt><dd>${esc(cleanLoc(c.locations))}</dd>` : ''}
      </dl>
    </section>` : ''}

    <section class="dsec">
      <div class="dsec-head"><h3>ES・面接メモ</h3><button class="btn small" data-act="add-note">＋ 追加</button></div>
      ${c.notes.length ? [...c.notes].sort((a, b) => b.at - a.at).map(n => `
        <div class="note-item" data-act="edit-note" data-nid="${n.id}">
          <div class="ni-top"><span class="kind ${n.kind}">${NOTE_KIND[n.kind]}</span><span class="ni-q">${esc(n.q || '（設問なし）')}</span><span class="note small">${charCount(n.a)}字</span></div>
          ${n.a ? `<div class="ni-a">${esc(n.a)}</div>` : ''}
        </div>`).join('') : '<p class="muted-empty">提出したESの内容や、面接で聞かれた質問と答えを残しておくと、次の選考や他社の対策に使えます。</p>'}
    </section>

    ${memoSections(c)}

    <section class="dsec">
      <div class="dsec-head"><h3>選考履歴</h3></div>
      <ul class="timeline">
        ${[...c.history.map(h => ({ at: h.at, label: STATUS_MAP[h.status].label })), { at: c.createdAt, label: '登録' }]
          .sort((a, b) => b.at - a.at).map(h => `<li><span class="tl-date">${fmtDay(h.at)}</span>${h.label}</li>`).join('')}
      </ul>
    </section>`;
  // 段階表示：今の段階を真ん中に
  requestAnimationFrame(() => {
    const bar = $('#detail-body .stepper');
    const now = bar?.querySelector('.step.now');
    if (bar && now) bar.scrollLeft = now.offsetLeft - bar.offsetLeft - (bar.clientWidth - now.offsetWidth) / 2;
  });
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
    case 'ics-event': { const ev = c.events.find(x => x.id === t.dataset.eid); if (ev) openIcs([{ c, ev }], `${ev.date}-${ev.title}`); break; }
    case 'add-note': openNote(c.id, null); break;
    case 'edit-note': openNote(c.id, t.dataset.nid); break;
    case 'copy-cid': copyText(c.loginId, 'ID'); break;
    case 'set-status': setStatus(c, t.dataset.st); break;
    case 'set-score': setScore(c, t.dataset.k, Number(t.dataset.v)); break;
    case 'find-posting': startFindPosting(c); break;
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
  $$('#view-home > .panel, #home-stats, #home-triage').forEach(el => { el.hidden = empty; });
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
    { v: week, u: '件', l: '7日以内', go: 'schedule' },
    { v: count(c => c.status === 'offer'), u: '社', l: '内定', go: 'offer' },
    { v: count(c => bestTokyo(c) === 'only' && ACTIVE_STATUSES.has(c.status)), u: '社', l: '東京◎', go: 'tokyo' },
  ];
  const h = new Date().getHours();
  const hello = h < 5 ? 'おつかれさまです' : h < 11 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'こんばんは';
  const todayN = todayItems().length;
  $('#home-hello').innerHTML = `<b>${hello}</b><span>${todayN ? `今日やることが <em>${todayN}件</em> あります` : '今日やることはありません。いい調子です'}${week ? `・7日以内の予定 ${week}件` : ''}</span>`;
  $('#home-stats').innerHTML = stats.map(s => `<button class="stat" data-stat="${s.go}"><div class="sv">${s.v}<small>${s.u}</small></div><div class="sl">${s.l}</div></button>`).join('');

  const shown = [...overdue, ...upcoming.slice(0, 6)];
  $('#home-events').innerHTML = shown.length ? `<div class="mini-list">${shown.map(({ c, ev }) => `
    <div class="mini-item">
      ${whenBox(ev.date)}
      <div class="mi-main" data-edit-cid="${c.id}" data-edit-eid="${ev.id}">
        <div class="mi-title">${esc(ev.title)}</div>
        <div class="mi-sub">${ev.date < today ? '<b class="overdue-text">期限切れ</b>・' : ''}${esc(c.name)}${ev.time ? '・' + timeRange(ev) : ''}${ev.place ? '・' + esc(ev.place) : ''}</div>
      </div>
      <input type="checkbox" data-cid="${c.id}" data-eid="${ev.id}" aria-label="完了">
    </div>`).join('')}</div>` : '<p class="muted-empty">今後の予定はありません。右上の「＋ 追加」から登録できます。</p>';

  renderTriageBanner();
  renderToday();
  renderRanking();

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
  if (e.target.closest('[data-start-triage]')) { openTriage(); return; }
  if (e.target.closest('[data-rank-all]')) { $('#sort').value = 'score'; filterSel.value = 'active'; saveUiPref(); showView('companies'); return; }
  if (e.target.closest('[data-today-all]')) { $('#home-today').dataset.all = '1'; renderToday(); return; }
  const rd = e.target.closest('[data-reply-done]');
  if (rd) { markReplyDone(rd.dataset.replyDone); return; }
  if (e.target.closest('a[href]')) return;
  const add = e.target.closest('[data-add-event]');
  if (add) { openEvent(add.dataset.addEvent, null); return; }
  const edit = e.target.closest('[data-edit-eid]');
  if (edit) { openEvent(edit.dataset.editCid, edit.dataset.editEid); return; }
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
function buildIcs(items) {
  const icsText = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const hm = t => t.replace(':', '') + '00';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//syukatsu//JP', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  items.forEach(({ c, ev }) => {
    const d = ev.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@syukatsu`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(`【${c.name}】${ev.title}`)}`);
    if (ev.time) {
      lines.push(`DTSTART:${d}T${hm(ev.time)}`, `DTEND:${d}T${hm(endTimeOf(ev))}`);
    } else {
      const [y, mo, da] = ev.date.split('-').map(Number);
      const nx = new Date(y, mo - 1, da + 1);
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nx.getFullYear()}${pad(nx.getMonth() + 1)}${pad(nx.getDate())}`);
    }
    if (ev.place) {
      lines.push(`LOCATION:${icsText(ev.place)}`);
      if (/^https?:\/\//.test(ev.place)) lines.push(`URL:${ev.place}`);
    }
    // 通知: 時刻ありは1時間前、終日（締切など）は前日の9時
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(ev.title)}`,
      `TRIGGER:${ev.time ? '-PT1H' : '-PT15H'}`, 'END:VALARM');
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
/** .ics を開く。iPhone・iPad はカレンダーの「追加」画面が出る形で開き、それ以外はファイルとして保存する */
function openIcs(items, name) {
  const text = buildIcs(items);
  if (isIOS) {
    location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(text);
    return;
  }
  const blob = new Blob([text], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('カレンダーのファイルを保存しました。開くとカレンダーに追加できます');
}
function exportIcs() {
  const today = todayStr();
  const items = [];
  state.companies.forEach(c => c.events.forEach(ev => { if (!ev.done && ev.date >= today) items.push({ c, ev }); }));
  if (!items.length) { toast('追加する今後の予定がありません'); return; }
  if (!confirm(`今後の予定 ${items.length}件 をカレンダーに追加します。\n※前に追加した予定をもう一度追加すると、カレンダー上で重複することがあります。`)) return;
  openIcs(items, `syukatsu-${today}`);
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

/* ---------- 採用ページから取り込む（ブックマークレット） ---------- */
// ブックマークレットは、開いているページの文章を
//  ・open: このアプリを新しいタブで開き、postMessage で渡す（PC・Safari で使う場合）
//  ・copy: 先頭に「#就活管理 URL」を付けてクリップボードにコピーする（iPhone のホーム画面アプリ用。
//          Safari とホーム画面のアプリは保存場所が別なので、貼り付けで渡す）
const CLIP_MARK = '#就活管理 ';
const CLIP_MAX = 30000;
function splitClip(raw) {
  if (!raw.startsWith(CLIP_MARK)) return null;
  const [head, title = '', ...rest] = raw.split('\n');
  return { url: head.slice(CLIP_MARK.length).trim(), title: title.trim(), text: rest.join('\n').trim() };
}
/** ページ名や本文から企業名を推定する（「株式会社〇〇」「〇〇株式会社」） */
function guessCompanyName(title, text) {
  const re = /(?:株式会社|\(株\)|（株）)\s?[^\s|｜\-–—:：【】\[\]()（）「」『』/・,、。]{1,20}|[^\s|｜\-–—:：【】\[\]()（）「」『』/・,、。]{1,20}\s?(?:株式会社|\(株\)|（株）)/;
  for (const src of [title, text.slice(0, 3000)]) {
    const m = String(src).match(re);
    if (m && !/採用|求人|応募|マイページ|ログイン/.test(m[0])) return m[0].replace(/\s+/g, ' ').trim();
  }
  return '';
}
function fillClipMeta(clip) {
  if (!cForm.url.value.trim() && /^https?:\/\//.test(clip.url)) { cForm.url.value = clip.url; updateOpenUrl(); }
  if (!cForm.name.value.trim()) {
    const nm = guessCompanyName(clip.title, clip.text);
    if (nm) { cForm.name.value = nm; updateIndustryUi(); }
  }
}
/** 登録済みの企業のうち、ページに名前が出てくるもの（長い名前を優先） */
function findClipCompany(clip) {
  const hay = nameKey(`${clip.title}\n${clip.text.slice(0, 3000)}`);
  return state.companies
    .filter(c => { const k = nameKey(c.name); return k.length >= 2 && hay.includes(k); })
    .sort((a, b) => nameKey(b.name).length - nameKey(a.name).length)[0] || null;
}
function receiveClip(d) {
  const clip = { url: str(d.url), title: str(d.title), text: str(d.text).slice(0, CLIP_MAX) };
  if (!clip.text.trim()) { toast('ページの文章を読み取れませんでした'); return; }
  if (cDialog.open) cDialog.close();
  const hit = findClipCompany(clip);
  const useHit = hit && confirm(`「${hit.name}」のページとして取り込みますか？\n\nキャンセル → 新しい企業として追加`);
  openCompany(useHit ? hit.id : null);
  cForm.p_raw.value = `${CLIP_MARK}${clip.url}\n${clip.title}\n\n${clip.text}`;
  applyPosting(true);
  if (!cForm.name.value.trim()) setTimeout(() => toast('企業名を読み取れませんでした。企業名を入力して保存してください'), 2500);
}
// ブックマークレットから開かれたとき（#clip）は、開いたページからデータを受け取る
if (location.hash === '#clip') {
  history.replaceState(null, '', location.pathname + location.search);
  let got = false;
  window.addEventListener('message', e => {
    if (got || !window.opener || e.source !== window.opener || !e.data || typeof e.data.syukatsuClip !== 'object') return;
    got = true;
    receiveClip(e.data.syukatsuClip);
  });
  if (window.opener) window.opener.postMessage('syukatsu-ready', '*');
  setTimeout(() => {
    if (!got) toast('ページの内容を受け取れませんでした。内容はコピーされているので「企業を追加」→「コピーした募集要項を貼り付け」を試してください');
  }, 4000);
}

function bookmarkletCode(mode) {
  const app = location.origin + location.pathname;
  const src = `(()=>{
const A=${JSON.stringify(app)},M=${JSON.stringify(mode)},K=${JSON.stringify(CLIP_MARK)};
const g=d=>{let t='';try{t=d.body.innerText||''}catch(e){}try{for(const f of d.querySelectorAll('iframe,frame')){try{t+='\\n'+g(f.contentDocument)}catch(e){}}}catch(e){}return t};
const s=String(getSelection()||'').trim();
const t=(s.length>20?s:g(document)).replace(/[ \\t\\u3000]+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,${CLIP_MAX});
const d={title:document.title,url:location.href,text:t};
const c=K+location.href+'\\n'+document.title+'\\n\\n'+t;
const done=()=>alert('就活管理用にコピーしました（'+t.length+'文字）。\\nアプリで「企業を追加」→「コピーした募集要項を貼り付け」を押してください。');
const ex=()=>{const a=document.createElement('textarea');a.value=c;a.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(a);a.select();let ok=false;try{ok=document.execCommand('copy')}catch(e){}a.remove();return ok};
const wc=()=>navigator.clipboard?navigator.clipboard.writeText(c):Promise.reject();
const clip=()=>wc().then(done,()=>{if(ex()){done();return}const b=document.createElement('button');b.textContent='就活管理用にコピー';b.style.cssText='position:fixed;z-index:2147483647;top:12px;right:12px;padding:14px 18px;font-size:16px;background:#2563eb;color:#fff;border:0;border-radius:10px';b.onclick=()=>{b.remove();if(ex())done();else wc().then(done,()=>alert('コピーできませんでした'))};document.body.appendChild(b)});
if(!t){alert('ページの文章を読み取れませんでした');return}
if(M==='copy'){clip();return}
wc().catch(()=>{});
const w=window.open(A+'#clip','_blank');
if(!w){clip();return}
const o=new URL(A).origin;
const f=e=>{if(e.source===w&&e.data==='syukatsu-ready'){w.postMessage({syukatsuClip:d},o);removeEventListener('message',f)}};
addEventListener('message',f);
})()`;
  return 'javascript:' + encodeURIComponent(src.replace(/\n/g, ''));
}
const CLIP_MODE_KEY = 'syukatsu.clipMode';
function renderClipper() {
  const sel = $('#clipper-mode');
  const mode = sel.value;
  const code = bookmarkletCode(mode);
  const link = $('#clipper-link');
  link.href = code;
  link.hidden = isIOS; // PC ではブックマークバーにドラッグして登録できる
  $('#clipper-mode-note').textContent = mode === 'copy'
    ? '押すとページの文章がコピーされます。アプリで「企業を追加」→「コピーした募集要項を貼り付け」で入力されます（URL・企業名も自動で入ります）。'
    : '押すとこのアプリが新しいタブで開き、そのまま登録画面に入力されます。' +
      (isIOS ? '※ホーム画面に追加したアプリを使っている場合は、Safari とデータが別々なので「コピーだけする」を選んでください。' : '');
  const use = '使うとき：採用ページを開いて、ブックマークの「就活管理に取り込む」を押す。';
  $('#clipper-steps').innerHTML = (isIOS ? [
    '上のボタンでコードをコピーする',
    'Safari で何かのページを開き、共有ボタン →「ブックマークを追加」（名前は「就活管理に取り込む」）',
    'ブックマーク一覧 →「編集」→ 今追加したブックマークを開き、アドレスを全部消してコピーしたコードを貼り付ける',
    use + 'アドレスバーに「就活」と入力すると候補に出るので、そこから押すと早い',
  ] : [
    '「📥 就活管理に取り込む」ボタンをブラウザのブックマークバーにドラッグする（ドラッグできないときは、コードをコピーして新しいブックマークの URL に貼り付ける）',
    use,
  ]).map(s => `<li>${esc(s)}</li>`).join('');
}
$('#clipper-mode').value = localStorage.getItem(CLIP_MODE_KEY) || (isIOS && isStandalone ? 'copy' : 'open');
$('#clipper-mode').addEventListener('change', e => {
  try { localStorage.setItem(CLIP_MODE_KEY, e.target.value); } catch { /* ignore */ }
  renderClipper();
});
$('#clipper-link').addEventListener('click', e => { e.preventDefault(); toast('このボタンをブックマークバーにドラッグして登録してください'); });
$('#clipper-copy').addEventListener('click', async () => {
  const code = bookmarkletCode($('#clipper-mode').value);
  try { await navigator.clipboard.writeText(code); toast('コードをコピーしました。ブックマークのアドレスに貼り付けてください'); }
  catch { prompt('このコードをコピーしてください', code); }
});
renderClipper();

/* ---------- Gmailから自動で取り込む（gas/gmail-sync.gs と連携） ---------- */
const GSYNC_KEY = 'syukatsu.gsync';      // { url, at }
const GSYNC_IGNORE_KEY = 'syukatsu.gsyncIgnore'; // 削除した企業（nameKey）
const GSYNC_MEMO = '【Gmail同期】';
const GSYNC_REPLY_KEY = 'syukatsu.gsyncReplies'; // { nameKey: [{ thread, at, subject, url }] }
const GSYNC_DONE_KEY = 'syukatsu.gsyncReplyDone'; // 「済」にしたスレッド
const GSYNC_AUTO_MS = 3 * 3600e3;
const gsyncConf = () => { try { return JSON.parse(localStorage.getItem(GSYNC_KEY) || '{}'); } catch { return {}; } };
const gsyncSetConf = o => { try { localStorage.setItem(GSYNC_KEY, JSON.stringify({ ...gsyncConf(), ...o })); } catch { /* ignore */ } };
function gsyncIgnored() { try { return new Set(JSON.parse(localStorage.getItem(GSYNC_IGNORE_KEY) || '[]')); } catch { return new Set(); } }
function gsyncIgnore(c) {
  const s = gsyncIgnored();
  s.add(nameKey(c.name));
  try { localStorage.setItem(GSYNC_IGNORE_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}
/** メモの【Gmail同期】より後ろを、新しい内容に置き換える（自分で書いた部分は残す） */
function replaceGmailMemo(memo, block) {
  const i = memo.indexOf(GSYNC_MEMO);
  const own = (i >= 0 ? memo.slice(0, i) : memo).trimEnd();
  return own ? `${own}\n\n${block}` : block;
}
/** 同期データを統合する。既存の企業は「空欄を埋める・予定を足す・ステータスを先に進める」だけ */
function applyGmailSync(data) {
  const rank = s => STATUSES.findIndex(x => x.id === s);
  const ignored = gsyncIgnored();
  const now = Date.now();
  const report = { added: [], updated: [], advanced: [] };
  for (const inc of Array.isArray(data.companies) ? data.companies : []) {
    if (!inc || !inc.name) continue;
    const key = nameKey(inc.name);
    if (!key || ignored.has(key)) continue;
    const events = (Array.isArray(inc.events) ? inc.events : []).filter(ev => ev && ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date));
    const statusAt = Number(inc.statusAt) || now;
    const cur = state.companies.find(c => c.id === inc.id) || state.companies.find(c => nameKey(c.name) === key);
    if (!cur) {
      const c = normalizeCompany({
        id: inc.id, name: inc.name, status: inc.status, priority: inc.priority, url: inc.url, site: inc.site, loginId: inc.loginId,
        memo: inc.memo, events, createdAt: now, updatedAt: now,
        history: STATUS_MAP[inc.status] && inc.status !== 'interest' ? [{ status: inc.status, at: statusAt }] : [],
      });
      if (!c.industry) c.industry = guessIndustries(c.name)[0]?.name || '';
      state.companies.push(c);
      report.added.push(c.name);
      continue;
    }
    const before = JSON.stringify(cur);
    if (!cur.url && inc.url) cur.url = str(inc.url);
    if (!cur.loginId && inc.loginId) cur.loginId = str(inc.loginId);
    if (!cur.site && inc.site) cur.site = str(inc.site);
    for (const ev of events) {
      if (cur.events.some(e => e.id === ev.id || (e.date === ev.date && e.title === ev.title))) continue;
      cur.events.push(normalizeEvent(ev));
    }
    if (inc.memo) cur.memo = replaceGmailMemo(cur.memo, str(inc.memo));
    // ステータス：自分で変更した日より新しいメールのときだけ、先に進める（お見送りも反映）
    const lastSet = Math.max(cur.createdAt, ...cur.history.map(h => h.at));
    const next = inc.status;
    const canMove = STATUS_MAP[next] && statusAt > lastSet && !['offer', 'declined'].includes(cur.status);
    const forward = rank(next) > rank(cur.status) && !['rejected', 'declined'].includes(next) && cur.status !== 'rejected';
    const rejected = next === 'rejected' && IN_PROCESS.has(cur.status);
    if (canMove && (forward || rejected)) {
      cur.status = next;
      cur.history.push({ status: next, at: statusAt });
      report.advanced.push(`${cur.name}→${STATUS_MAP[next].label}`);
    }
    if (JSON.stringify(cur) !== before) { cur.updatedAt = now; report.updated.push(cur.name); }
  }
  // 返信が必要なメール（「今日やること」に出す）
  const replies = {};
  for (const inc of Array.isArray(data.companies) ? data.companies : []) {
    if (inc && inc.name && Array.isArray(inc.replies) && inc.replies.length) replies[nameKey(inc.name)] = inc.replies;
  }
  try { localStorage.setItem(GSYNC_REPLY_KEY, JSON.stringify(replies)); } catch { /* ignore */ }
  return report;
}
let gsyncBusy = false;
async function runGmailSync(manual) {
  const url = gsyncConf().url;
  if (!url) { if (manual) toast('先に同期用 URL を貼り付けてください'); return; }
  if (gsyncBusy) return;
  gsyncBusy = true;
  const btn = $('#gsync-run');
  btn.disabled = true;
  btn.textContent = '同期中…（最大30秒ほど）';
  try {
    const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    const data = await res.json();
    if (data.error) throw new Error(data.error === 'unauthorized' ? 'URL のトークンが違います' : data.error);
    if (data.source !== 'gmail-sync') throw new Error('同期用 URL ではないようです');
    const r = applyGmailSync(data);
    save();
    render();
    gsyncSetConf({ at: Date.now(), complete: Boolean(data.complete) });
    const parts = [];
    if (r.added.length) parts.push(`${r.added.length}社を追加`);
    if (r.advanced.length) parts.push(`選考が進んだ企業：${r.advanced.slice(0, 3).join('、')}${r.advanced.length > 3 ? ' ほか' : ''}`);
    if (r.updated.length - r.advanced.length > 0) parts.push(`${r.updated.length - r.advanced.length}社の予定・メモを更新`);
    if (manual || parts.length) toast(parts.length ? `Gmail同期：${parts.join(' / ')}` : 'Gmail同期：新しい情報はありませんでした');
  } catch (err) {
    if (manual) alert('Gmailから同期できませんでした：' + err.message + '\n\n同期用 URL が正しいか、スクリプトのデプロイで「アクセスできるユーザー：全員」になっているか確認してください。');
    else console.warn('gmail sync failed', err);
  } finally {
    gsyncBusy = false;
    btn.disabled = false;
    btn.textContent = 'Gmailから同期';
    renderGsync();
  }
}
function renderGsync() {
  const conf = gsyncConf();
  $('#gsync-url').value = conf.url || '';
  $('#gsync-status').textContent = !conf.url ? '' : conf.at
    ? `前回の同期：${new Date(conf.at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}` +
      (conf.complete === false ? '（過去のメールはまだ読み込み中。1時間ごとに増えていきます）' : '') +
      ' ・アプリを開いたときにも自動で同期します'
    : 'まだ同期していません';
}
$('#gsync-url').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (v && /\/dev\?/.test(v)) {
    alert('「…/dev?token=…」はテスト用の URL で、アプリからは読めません。\n「デプロイ」→「デプロイを管理」の「ウェブアプリ」の URL（…/exec で終わるもの）の後ろに ?token=… を付けて貼り付けてください。');
    e.target.value = gsyncConf().url || '';
    return;
  }
  if (v && !/^https:\/\/script\.google(?:usercontent)?\.com\/.+token=/.test(v)) {
    alert('script.google.com の「…/exec?token=…」の URL を貼り付けてください（setup の実行ログに出ます）');
    e.target.value = gsyncConf().url || '';
    return;
  }
  gsyncSetConf({ url: v, at: null });
  renderGsync();
  if (v) runGmailSync(true);
});
$('#gsync-run').addEventListener('click', () => runGmailSync(true));
// 設置用のスクリプト・設定をコピー（.gs はブラウザで開くとダウンロードされてしまうため）
$('#gsync-panel').addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-gas]');
  if (!b) return;
  try {
    const text = await (await fetch(b.dataset.copyGas, { cache: 'no-store' })).text();
    await navigator.clipboard.writeText(text);
    toast(`コピーしました（${text.split('\n').length}行）。エディタに貼り付けてください`);
  } catch {
    toast('コピーできませんでした。PC のブラウザで試してください');
  }
});
renderGsync();
// 開いたとき・アプリに戻ってきたときに、前回から3時間以上たっていれば自動で同期
function gsyncAuto() {
  const conf = gsyncConf();
  if (conf.url && navigator.onLine && (!conf.at || Date.now() - conf.at > GSYNC_AUTO_MS)) runGmailSync(false);
}
setTimeout(gsyncAuto, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) gsyncAuto(); });

/* ---------- 募集要項を URL から取り込む（gas/gmail-sync.gs 経由） ---------- */
// アプリ（GitHub Pages）からは他社のサイトを直接読めないので、自分の Google スクリプトに読んでもらう
const BLOCKED_SITE = /(?:^|\.)(?:mynavi\.jp|rikunabi\.com|onecareer\.jp|offerbox\.jp|gaishishukatsu\.com|unistyle\.jp)$/i;
async function gasCall(action, url) {
  const base = gsyncConf().url;
  if (!base) throw new Error('Gmail同期の設定（その他 →「Gmailから自動で取り込む」）をすると使えます');
  const res = await fetch(`${base}&action=${action}&url=${encodeURIComponent(url)}`, { cache: 'no-store' });
  const data = await res.json();
  if (data.error === 'unauthorized') throw new Error('同期用 URL のトークンが違います');
  if (!data.ok) {
    // 古いスクリプトは action を知らずに同期データを返す
    if (data.source === 'gmail-sync') throw new Error('Google のスクリプトが古いままです。新しいスクリプトを貼り付けて「新バージョン」でデプロイしてください');
    throw new Error(data.error || '読み込めませんでした');
  }
  return data;
}
function updateFetchUi() {
  const ready = Boolean(gsyncConf().url);
  ['#posting-find', '#posting-fetch'].forEach(s => { $(s).disabled = !ready; });
  if (!ready) $('#posting-fetch-status').textContent = 'URL から取り込むには、その他 →「Gmailから自動で取り込む」の設定が必要です。下の貼り付けはいつでも使えます。';
}
function checkPostingUrl(url) {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return '採用サイトの URL（https://〜）を入力してください';
  const host = (url.match(/^https?:\/\/([^/?#:]+)/) || [])[1] || '';
  if (BLOCKED_SITE.test(host)) return 'マイナビ・リクナビなどの就活サイトは利用規約で自動取得が禁止されているので読めません。企業の採用サイトの URL を入れるか、ブックマークで取り込んでください';
  return '';
}
/** 取得した本文を募集要項の欄に流し込む */
async function fillFetchedPosting(data) {
  // ページの見出しと内容の間に空行があると読み取れないので詰める
  cForm.p_raw.value = data.text.replace(/\n[ \t\u3000]*\n+/g, '\n');
  if (!cForm.name.value.trim()) {
    const nm = guessCompanyName(data.title, data.text);
    if (nm) { cForm.name.value = nm; updateIndustryUi(); }
  }
  await applyPosting(true);
  // どのページから読んだかを職種の「その他」に残す
  if (!cForm.p_note.value.includes(data.url)) cForm.p_note.value = `${cForm.p_note.value ? cForm.p_note.value + '\n' : ''}出典: ${data.url}`;
}
async function importPostingFromUrl(action) {
  const url = $('#posting-url').value.trim();
  const status = $('#posting-fetch-status');
  const bad = checkPostingUrl(url);
  if (bad) { status.textContent = bad; $('#posting-url').focus(); return; }
  const btns = ['#posting-find', '#posting-fetch'].map(s => $(s));
  btns.forEach(b => { b.disabled = true; });
  status.textContent = action === 'find' ? '採用サイトの中から募集要項を探しています…（最大30秒ほど）' : 'ページを読み込んでいます…';
  try {
    const data = await gasCall(action, url);
    if (action === 'find' && !data.found) {
      status.innerHTML = `募集要項らしいページが見つかりませんでした（${data.tried?.length || 1}ページを確認）。募集要項のページを開いてその URL を入れ、「このページを読む」を試すか、ブックマークで取り込んでください。`;
      return;
    }
    await fillFetchedPosting(data);
    status.innerHTML = `「${esc(data.title || data.url)}」から読み取りました。<a href="${esc(data.url)}" target="_blank" rel="noopener">ページを開く</a>`;
  } catch (err) {
    status.textContent = err.message;
  } finally {
    updateFetchUi();
    btns.forEach(b => { if (gsyncConf().url) b.disabled = false; });
  }
}

/* ---------- 自分の条件・実質の月収・志望度スコア ---------- */
/** その企業の代表の職種（応募した職種 → 初任給が分かる職種 → 何か入っている職種） */
function keyPosting(c) {
  return c.postings.find(p => p.applied && postingHasData(p)) || c.postings.find(p => p.salary != null) || c.postings.find(postingHasData) || null;
}
/** 家賃補助：yes（手当・社宅あり）/ dorm（寮だけ）/ ''（不明） */
function housingLevel(c, p) {
  if (p && p.housing > 0) return 'yes';
  const t = [p?.benefits, p?.allowances, p?.salaryNote, p?.note, p?.raw?.slice(0, 20000)].filter(Boolean).join('\n');
  if (/住宅手当|家賃補助|住宅補助|住居手当|家賃手当|借上社宅|借り上げ社宅|社宅/.test(t)) return 'yes';
  if (/独身寮|社員寮|寮/.test(t)) return 'dorm';
  return '';
}
/** 初任給＋家賃補助の手取りの目安（円） */
function netMonthly(p) {
  if (!p) return null;
  const base = p.salary ?? (p.annual != null ? Math.round(p.annual * 10000 / 16) : null);
  if (base == null) return null;
  return Math.round((base + (p.housing || 0)) * NET_RATE / 1000) * 1000;
}
/** 条件ごとの判定（true=満たす / false=満たさない / null=不明・一部） */
function condChecks(c) {
  const cond = state.profile.cond;
  const p = keyPosting(c);
  const out = [];
  if (cond.salary > 0) {
    const v = p?.salary ?? null;
    out.push({ k: 'salary', label: '給', name: '初任給', ok: v == null ? null : v >= cond.salary, text: v == null ? '不明' : `${Math.round(v / 1000) / 10}万円` });
  }
  if (cond.holidays > 0) {
    const v = p?.holidays ?? null;
    out.push({ k: 'holidays', label: '休', name: '年間休日', ok: v == null ? null : v >= cond.holidays, text: v == null ? '不明' : `${v}日` });
  }
  if (cond.tokyo) {
    const t = bestTokyo(c);
    out.push({ k: 'tokyo', label: '東', name: '東京勤務', ok: t === 'only' ? true : t === 'no' ? false : null, text: TOKYO[t]?.label || '不明' });
  }
  if (cond.housing) {
    const h = housingLevel(c, p);
    out.push({ k: 'housing', label: '住', name: '家賃補助', ok: h === 'yes' ? true : null, text: h === 'yes' ? (p?.housing ? `${(p.housing / 10000).toFixed(1)}万円` : 'あり') : h === 'dorm' ? '寮のみ' : '不明' });
  }
  return out;
}
function condStatus(c) {
  const ch = condChecks(c);
  if (!ch.length) return '';
  if (ch.some(x => x.ok === false)) return 'ng';
  return ch.every(x => x.ok === true) ? 'ok' : 'unknown';
}
function condChips(c) {
  if (!keyPosting(c) && !bestTokyo(c)) return '';
  const ch = condChecks(c);
  if (!ch.length) return '';
  const st = condStatus(c);
  return `<div class="cond-chips ${st}">${st === 'ok' ? '<span class="cond-all">✓ 条件クリア</span>' : ''}${ch.map(x =>
    `<span class="cc ${x.ok === true ? 'y' : x.ok === false ? 'n' : 'q'}" title="${esc(x.name)}：${esc(x.text)}">${x.label}${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'}</span>`).join('')}</div>`;
}

const AXES = [
  { k: 'money', label: 'お金', hint: '初任給＋家賃補助' },
  { k: 'life', label: '生活', hint: '休日・東京勤務・残業・リモート' },
  { k: 'skill', label: '得意が活きる', hint: 'Web開発などの得意を評価してくれるか' },
  { k: 'future', label: '将来の選択肢', hint: '転職でも通用する経験・会社の安定性' },
];
const clamp5 = v => Math.max(1, Math.min(5, Math.round(v)));
/** お金・生活の自動の点数（募集要項がなければ 0） */
function autoScores(c) {
  const p = keyPosting(c);
  const cond = state.profile.cond;
  const out = { money: 0, life: 0 };
  if (p && (p.salary != null || p.annual != null)) {
    const base = (p.salary ?? Math.round(p.annual * 10000 / 16)) + (p.housing || 0);
    const target = cond.salary || 300000;
    const d = base - target;
    let s = d < -40000 ? 1 : d < -15000 ? 2 : d < 0 ? 3 : d < 30000 ? 4 : 5;
    if (!p.housing && housingLevel(c, p) === 'yes' && s < 5) s += 0.5; // 金額は不明だが補助あり
    out.money = clamp5(s);
  }
  const tk = bestTokyo(c);
  if (p || tk) {
    let s = 3;
    const hol = p?.holidays;
    if (hol != null) s += hol >= (cond.holidays || 125) ? 1 : hol < (cond.holidays || 125) - 5 ? -1 : 0;
    if (tk === 'only') s += 1; else if (tk === 'no') s -= 2;
    if (p?.overtime != null) s += p.overtime <= 20 ? 0.5 : p.overtime > 40 ? -1 : 0;
    if (p?.remote || p?.flex) s += 0.5;
    out.life = clamp5(s);
  }
  return out;
}
/** 志望度スコア（0〜100）。軸がひとつも分からなければ null */
function totalScore(c) {
  const auto = autoScores(c);
  const w = state.profile.weights;
  const vals = {};
  let known = 0;
  AXES.forEach(({ k }) => {
    const v = c.scores[k] || auto[k] || 0;
    vals[k] = v;
    if (v) known++;
  });
  if (!known) return null;
  let sum = 0, wsum = 0;
  AXES.forEach(({ k }) => { const wk = Math.max(0, w[k] || 0); sum += wk * (vals[k] || 3) / 5; wsum += wk; });
  return { total: wsum ? Math.round(sum / wsum * 100) : 0, vals, auto, known };
}
function scoreSection(c) {
  const sc = totalScore(c);
  const ch = condChecks(c);
  const rows = AXES.map(({ k, label, hint }) => {
    const manual = c.scores[k];
    const v = manual || sc?.auto[k] || 0;
    const isAuto = !manual && sc?.auto[k];
    return `<div class="axis">
      <div class="axis-l"><b>${label}</b><small>${isAuto ? '<span class="auto-tag">自動</span>' : ''}${hint}</small></div>
      <div class="axis-dots">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="dot ${n <= v ? 'on' : ''} ${isAuto ? 'auto' : ''}" data-act="set-score" data-k="${k}" data-v="${n}" aria-label="${label} ${n}"></button>`).join('')}</div>
    </div>`;
  }).join('');
  return `<section class="dsec score-sec">
    <div class="dsec-head"><h3>志望度スコア</h3><span class="score-big">${sc ? sc.total : '–'}<small>/100</small></span></div>
    ${ch.length ? `<div class="cond-list">${ch.map(x => `<span class="cc ${x.ok === true ? 'y' : x.ok === false ? 'n' : 'q'}">${x.name}：${esc(x.text)}${x.ok === true ? ' ✓' : x.ok === false ? ' ✗' : ''}</span>`).join('')}</div>` : ''}
    <div class="axes">${rows}</div>
    <p class="note small">● をタップして点数を付けます（同じ点をもう一度タップで取り消し）。重みは「その他 → 自分の条件」で変えられます。</p>
  </section>`;
}
function setScore(c, k, v) {
  c.scores[k] = c.scores[k] === v ? 0 : v;
  c.updatedAt = Date.now();
  save();
  renderDetail();
  render();
}
function renderRanking() {
  const list = state.companies.filter(c => ACTIVE_STATUSES.has(c.status))
    .map(c => ({ c, s: totalScore(c) })).filter(x => x.s)
    .sort((a, b) => b.s.total - a.s.total || b.c.priority - a.c.priority);
  $('#home-rank-panel').hidden = !list.length;
  $('#home-rank').innerHTML = `<div class="mini-list">${list.slice(0, 5).map(({ c, s }, i) => `
    <div class="mini-item rank-item" data-open="${c.id}">
      <span class="rank-no">${i + 1}</span>
      ${avatar(c)}
      <div class="mi-main"><div class="mi-title">${esc(c.name)}</div>
        <div class="rank-bar"><span style="width:${s.total}%"></span></div></div>
      <span class="rank-score">${s.total}</span>
    </div>`).join('')}</div>${list.length < 3 ? '<p class="note small">企業の詳細で「得意が活きる」「将来の選択肢」を付けると、ランキングに入ります。</p>' : ''}`;
}
function renderCondSettings() {
  const { cond, weights } = state.profile;
  $('#cond-salary').value = cond.salary ? cond.salary / 10000 : '';
  $('#cond-holidays').value = cond.holidays || '';
  $('#cond-tokyo').checked = cond.tokyo;
  $('#cond-housing').checked = cond.housing;
  $('#weights').innerHTML = AXES.map(({ k, label }) => `<label class="weight"><span>${label}</span>
    <input type="range" min="0" max="60" step="5" data-w="${k}" value="${weights[k]}"><b>${weights[k]}%</b></label>`).join('');
}
function saveCond() {
  const yen = parseFloat($('#cond-salary').value);
  state.profile = normalizeProfile({ ...state.profile, cond: {
    salary: Number.isFinite(yen) ? Math.round(yen * 10000) : 0,
    holidays: parseInt($('#cond-holidays').value, 10) || 0,
    tokyo: $('#cond-tokyo').checked, housing: $('#cond-housing').checked,
  } });
  save();
}
['#cond-salary', '#cond-holidays', '#cond-tokyo', '#cond-housing'].forEach(s => $(s).addEventListener('change', () => { saveCond(); toast('条件を保存しました'); }));
$('#weights').addEventListener('input', e => {
  const r = e.target.closest('[data-w]');
  if (!r) return;
  r.nextElementSibling.textContent = r.value + '%';
});
$('#weights').addEventListener('change', e => {
  const r = e.target.closest('[data-w]');
  if (!r) return;
  state.profile.weights[r.dataset.w] = Number(r.value);
  save();
  toast('重みを保存しました');
});

/* ---------- Google カレンダー ---------- */
// 予定を保存したら数秒待ってから、まとめて「就活」カレンダーに反映する
var calTimer = null;
var calBusy = false;
var CAL_HASH_KEY = 'syukatsu.calHash';
function calRange() {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  return { from: d(-60), to: d(400) };
}
function calPayload() {
  const { from, to } = calRange();
  const events = [];
  state.companies.forEach(c => c.events.forEach(ev => {
    if (ev.date < from || ev.date > to) return;
    events.push({ id: `${c.id}_${ev.id}`, title: `${ev.title}（${c.name}）`, date: ev.date, time: ev.time, endTime: ev.endTime, place: ev.place,
      description: `${c.name}・${STATUS_MAP[c.status].label}\n就活管理アプリから自動で登録された予定です。` });
  }));
  return { from, to, events };
}
function scheduleCalPush() {
  try {
    if (!gsyncConf().url || !gsyncConf().calPush) return;
    clearTimeout(calTimer);
    calTimer = setTimeout(() => pushCalendar(false), 4000);
  } catch { /* 起動中は何もしない */ }
}
async function pushCalendar(manual) {
  const conf = gsyncConf();
  if (!conf.url || calBusy) return;
  const body = calPayload();
  const hash = JSON.stringify(body.events);
  if (!manual && localStorage.getItem(CAL_HASH_KEY) === hash) return;
  calBusy = true;
  try {
    const res = await fetch(conf.url, { method: 'POST', body: JSON.stringify({ action: 'calendar', ...body }) });
    const data = await res.json();
    if (data.error === 'unauthorized') throw new Error('同期用 URL のトークンが違います');
    if (!data.ok) throw new Error(data.error === 'unknown action' || !data.error ? 'Google のスクリプトが古いままです。最新のスクリプトを貼り付けて「新バージョン」でデプロイしてください' : data.error);
    try { localStorage.setItem(CAL_HASH_KEY, hash); } catch { /* ignore */ }
    gsyncSetConf({ calAt: Date.now() });
    const msg = `Googleカレンダー「${data.calendar}」に反映しました（追加${data.created}・変更${data.updated}・削除${data.deleted}）`;
    if (manual || data.created || data.deleted) toast(msg);
  } catch (err) {
    const m = String(err.message || err);
    if (manual) alert('Google カレンダーに登録できませんでした：' + (m === 'Failed to fetch' || m === 'Load failed' ? 'Google のスクリプトが古いか、カレンダーの許可が済んでいません。最新のスクリプトで setup を実行し、「新バージョン」でデプロイしてください' : m));
    else console.warn('calendar push failed', err);
  } finally {
    calBusy = false;
    renderGcalOpts();
  }
}
function renderGcalOpts() {
  const conf = gsyncConf();
  $('#gcal-opts').hidden = !conf.url;
  $('#gcal-push').checked = Boolean(conf.calPush);
  $('#gcal-show').checked = Boolean(conf.calShow);
  $('#gcal-status').textContent = conf.calPush && conf.calAt
    ? `前回の登録：${new Date(conf.calAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}（予定を保存すると自動で反映されます）` : '';
}
$('#gcal-push').addEventListener('change', e => {
  gsyncSetConf({ calPush: e.target.checked });
  if (e.target.checked) pushCalendar(true);
  renderGcalOpts();
});
$('#gcal-show').addEventListener('change', e => {
  gsyncSetConf({ calShow: e.target.checked });
  gcalCache.clear();
  renderGcalOpts();
});
renderGcalOpts();

/* ---------- PC とスマホで同じデータを使う（自分の Google ドライブに保存・自動バックアップ） ---------- */
// 変更するたびに数秒後にドライブへ保存し、アプリを開いたとき・戻ってきたときに新しいデータを取ってくる。
// 両方の端末で変更していたら（rev がずれていたら）統合してから保存し直す。
var CLOUD_KEY = 'syukatsu.cloud';            // { on, rev, dirty, at, device }
var CLOUD_TOMB_KEY = 'syukatsu.cloudTomb';   // この端末で削除した企業（統合で復活させない）
var CLOUD_PREV_KEY = 'syukatsu.beforeCloud'; // ドライブの内容で置き換える直前のデータ（念のため）
var cloudTimer = null, cloudBusy = false, cloudApplying = false, cloudSeq = 0;
const DEVICE_NAME = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'PC';
const cloudConf = () => { try { return JSON.parse(localStorage.getItem(CLOUD_KEY) || '{}'); } catch { return {}; } };
const cloudSet = o => { try { localStorage.setItem(CLOUD_KEY, JSON.stringify({ ...cloudConf(), ...o })); } catch { /* ignore */ } };
const cloudReady = () => Boolean(gsyncConf().url && cloudConf().on);
function cloudTomb(id) {
  try {
    const t = JSON.parse(localStorage.getItem(CLOUD_TOMB_KEY) || '[]');
    localStorage.setItem(CLOUD_TOMB_KEY, JSON.stringify([...t, id].slice(-300)));
  } catch { /* ignore */ }
}
function cloudAfterSave() {
  if (cloudApplying || !cloudConf().on) return;
  cloudSeq++;
  cloudSet({ dirty: true });
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudPush(false), 3000);
}
async function cloudFetch(params, body) {
  const base = gsyncConf().url;
  const res = body
    ? await fetch(base, { method: 'POST', body: JSON.stringify(body) })
    : await fetch(`${base}&${params}`, { cache: 'no-store' });
  const data = await res.json();
  if (data.error === 'unauthorized') throw new Error('同期用 URL のトークンが違います');
  if (data.ok === false && !data.conflict) throw new Error(data.error === 'unknown action' || !data.error ? 'Google のスクリプトが古いままです（v4 が必要）' : data.error);
  if (data.ok === undefined && !data.conflict) throw new Error('Google のスクリプトが古いままです（v4 が必要）。最新のスクリプトを貼り付けて setup を実行し、「新バージョン」でデプロイしてください');
  return data;
}
/** ドライブのデータとこの端末のデータを統合（この端末で消した企業は戻さない） */
function cloudMerge(remote) {
  let tomb = [];
  try { tomb = JSON.parse(localStorage.getItem(CLOUD_TOMB_KEY) || '[]'); } catch { /* ignore */ }
  const merged = mergeState(normalizeState(remote), state).state;
  const dead = new Set(tomb);
  merged.companies = merged.companies.filter(c => !dead.has(c.id));
  return merged;
}
function cloudApply(next, rev, at, device) {
  // 編集中の画面があるときは、閉じたあとに入れ替える
  try { localStorage.setItem(CLOUD_PREV_KEY, JSON.stringify(state)); } catch { /* 容量不足のときは省く */ }
  cloudApplying = true;
  state = next;
  save();
  cloudApplying = false;
  cloudSet({ rev, at, device });
  render();
}
async function cloudPush(manual) {
  if (!cloudReady()) return;
  if (cloudBusy) { clearTimeout(cloudTimer); cloudTimer = setTimeout(() => cloudPush(manual), 2000); return; }
  cloudBusy = true;
  const seq = cloudSeq;
  try {
    for (let tries = 0; tries < 3; tries++) {
      const d = await cloudFetch('', { action: 'save', baseRev: cloudConf().rev || 0, device: DEVICE_NAME, state });
      if (d.conflict) {
        // ほかの端末で先に変更されていた → 統合してから保存し直す
        cloudApply(cloudMerge(d.state || { companies: [] }), d.rev, d.at, d.device);
        continue;
      }
      cloudSet({ rev: d.rev, at: d.at, device: DEVICE_NAME, error: '' });
      if (seq === cloudSeq) { cloudSet({ dirty: false }); localStorage.removeItem(CLOUD_TOMB_KEY); }
      if (manual) toast('Google ドライブに保存しました');
      break;
    }
  } catch (err) {
    cloudSet({ error: cloudErrText(err) });
    if (manual) alert('Google ドライブに保存できませんでした：' + cloudErrText(err));
  } finally {
    cloudBusy = false;
    renderCloud();
  }
}
const cloudErrText = err => {
  const m = String(err && err.message || err);
  return m === 'Failed to fetch' || m === 'Load failed' ? '通信できませんでした（オフライン、またはスクリプトが古い・ドライブの許可が済んでいない）' : m;
};
async function cloudPull(manual) {
  if (!cloudReady() || cloudBusy || !navigator.onLine) return;
  if (document.querySelector('dialog[open]')) return; // 編集中は入れ替えない
  cloudBusy = true;
  let pushAfter = false;
  try {
    const conf = cloudConf();
    const d = await cloudFetch('action=load');
    if (d.empty) pushAfter = true; // ドライブにまだ何もない → この端末のデータを保存
    else if (d.rev !== conf.rev) {
      if (!conf.rev) {
        // この端末で初めて使う：両方のデータを統合（どちらも消さない）
        cloudApply(cloudMerge(d.state), d.rev, d.at, d.device);
        pushAfter = true;
      } else if (conf.dirty) {
        cloudApply(cloudMerge(d.state), d.rev, d.at, d.device);
        pushAfter = true;
      } else {
        cloudApply(normalizeState(d.state), d.rev, d.at, d.device);
        if (manual) toast(`${d.device || 'ほかの端末'}で変更した内容に更新しました`);
      }
    } else {
      pushAfter = Boolean(conf.dirty);
      if (manual && !pushAfter) toast('最新の状態です');
    }
    cloudSet({ error: '', checkedAt: Date.now() });
  } catch (err) {
    cloudSet({ error: cloudErrText(err) });
    if (manual) alert('Google ドライブから読み込めませんでした：' + cloudErrText(err));
  } finally {
    cloudBusy = false;
    renderCloud();
  }
  if (pushAfter) { cloudSeq++; cloudSet({ dirty: true }); await cloudPush(manual); }
}
function renderCloud() {
  const conf = cloudConf();
  const ready = Boolean(gsyncConf().url);
  $('#cloud-on').checked = Boolean(conf.on);
  $('#cloud-on').disabled = !ready;
  $('#cloud-now').hidden = !conf.on;
  $('#cloud-backups-box').hidden = !ready;
  const fmt = t => new Date(t).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  $('#cloud-status').textContent = !ready ? '先に「Gmailから自動で取り込む」の同期用 URL を設定してください。'
    : !conf.on ? '' : conf.error ? `⚠️ ${conf.error}`
    : conf.dirty ? '保存待ちの変更があります…'
    : conf.at ? `✅ 最新（${fmt(conf.at)} に${conf.device || ''}で保存）` : '準備中…';
  const badge = $('#cloud-badge');
  if (badge) {
    badge.hidden = !conf.on;
    badge.textContent = conf.error ? '☁️⚠️' : conf.dirty ? '☁️…' : '☁️';
    badge.title = $('#cloud-status').textContent;
  }
}
$('#cloud-on').addEventListener('change', e => {
  cloudSet({ on: e.target.checked, rev: e.target.checked ? cloudConf().rev : 0, error: '' });
  if (e.target.checked) cloudPull(true);
  renderCloud();
});
$('#cloud-now').addEventListener('click', () => cloudPull(true));
$('#cloud-backups-box').addEventListener('toggle', async e => {
  if (!e.target.open) return;
  const box = $('#cloud-backups');
  box.innerHTML = '<p class="note small">読み込み中…</p>';
  try {
    const d = await cloudFetch('action=backups');
    box.innerHTML = (d.backups.length ? `<ul class="backup-list">${d.backups.map(b => `<li><span>${esc(b.name.slice(7, 17))} の朝の状態 <small>${Math.round(b.size / 1024)}KB</small></span>
      <button type="button" class="btn small" data-restore="${esc(b.name)}">この内容を読み込む</button></li>`).join('')}</ul>` : '<p class="note small">まだバックアップはありません（変更を保存した日ごとに1つ作られます）。</p>') +
      `<p class="note small"><a href="${esc(safeUrl(d.folder))}" target="_blank" rel="noopener">Google ドライブのフォルダを開く ↗</a></p>`;
  } catch (err) {
    box.innerHTML = `<p class="note small">⚠️ ${esc(cloudErrText(err))}</p>`;
  }
});
$('#cloud-backups').addEventListener('click', async e => {
  const b = e.target.closest('[data-restore]');
  if (!b) return;
  try {
    const d = await cloudFetch('action=load&name=' + encodeURIComponent(b.dataset.restore));
    if (d.empty || !d.state) throw new Error('バックアップが見つかりません');
    showImportPreview({ ...d.state, exportedAt: d.at ? new Date(d.at).toISOString() : '' }, `${b.dataset.restore.slice(7, 17)} のバックアップ`);
  } catch (err) { alert('読み込めませんでした：' + cloudErrText(err)); }
});
renderCloud();
setTimeout(() => cloudPull(false), 1200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) cloudPull(false); else if (cloudConf().dirty) cloudPush(false); });
window.addEventListener('online', () => cloudPull(false));
// ダイアログを閉じたら、後回しにしていた読み込みをする
document.addEventListener('close', () => setTimeout(() => { if (!document.querySelector('dialog[open]')) cloudPull(false); }, 300), true);

/* ---------- 予定：月のカレンダー ---------- */
const SCHED_MODE_KEY = 'syukatsu.schedMode';
const schedMode = () => localStorage.getItem(SCHED_MODE_KEY) || 'month';
let monthCursor = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let monthSel = todayStr();
const gcalCache = new Map(); // 'YYYY-MM' → events[] | 'loading' | 'error'
const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function gcalFor(start, end) {
  const conf = gsyncConf();
  if (!conf.url || !conf.calShow) return [];
  const key = ymdOf(start).slice(0, 7);
  const hit = gcalCache.get(key);
  if (Array.isArray(hit)) return hit;
  if (hit) return [];
  gcalCache.set(key, 'loading');
  fetch(`${conf.url}&action=gcal&from=${ymdOf(start)}&to=${ymdOf(end)}`, { cache: 'no-store' })
    .then(r => r.json()).then(d => {
      if (!d.ok) throw new Error(d.error || 'error');
      gcalCache.set(key, d.events || []);
      if (currentView === 'schedule' && schedMode() === 'month') renderMonth();
    }).catch(err => { gcalCache.set(key, 'error'); console.warn('gcal', err); });
  return [];
}
function renderMonth() {
  const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
  $('#month-title').textContent = `${y}年${m + 1}月`;
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); // 日曜はじまり
  const end = new Date(start); end.setDate(start.getDate() + 41);
  const today = todayStr();
  const byDay = {};
  state.companies.forEach(c => c.events.forEach(ev => { (byDay[ev.date] ||= []).push({ c, ev }); }));
  Object.values(byDay).forEach(a => a.sort((p, q) => evKey(p.ev).localeCompare(evKey(q.ev))));
  const gByDay = {};
  gcalFor(start, end).forEach(g => {
    for (let d = new Date(g.date + 'T00:00'); ymdOf(d) <= (g.endDate || g.date); d.setDate(d.getDate() + 1)) (gByDay[ymdOf(d)] ||= []).push(g);
  });
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = ymdOf(d);
    const evs = byDay[ds] || [];
    const gs = gByDay[ds] || [];
    const chips = evs.slice(0, 2).map(({ c, ev }) => `<span class="mchip ${ev.done ? 'done' : ''}" style="--h:${hueOf(c)}">${esc(ev.title)}</span>`).join('');
    const more = evs.length > 2 ? `<span class="mmore">+${evs.length - 2}</span>` : '';
    cells.push(`<button type="button" class="mday ${d.getMonth() !== m ? 'out' : ''} ${ds === today ? 'today' : ''} ${ds === monthSel ? 'sel' : ''} ${d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : ''}" data-day="${ds}">
      <span class="mnum">${d.getDate()}</span>${chips}${more}${gs.length ? `<span class="gdots">${'•'.repeat(Math.min(3, gs.length))}</span>` : ''}</button>`);
  }
  $('#month-grid').innerHTML = ['日', '月', '火', '水', '木', '金', '土'].map((w, i) => `<span class="mwd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('') + cells.join('');
  // 選んだ日の予定
  const evs = byDay[monthSel] || [];
  const gs = gByDay[monthSel] || [];
  const [sy, sm, sd] = monthSel.split('-').map(Number);
  $('#month-day').innerHTML = `<div class="day-head ${monthSel === today ? 'today' : ''}">${sm}月${sd}日（${'日月火水木金土'[new Date(sy, sm - 1, sd).getDay()]}）・${relLabel(monthSel)}
      <button type="button" class="link small" data-add-day="${monthSel}">＋ この日に予定</button></div>` +
    (evs.length || gs.length ? evs.map(({ c, ev }) => `
      <div class="sched-item ${ev.done ? 'done' : ''}">
        <input type="checkbox" data-cid="${c.id}" data-eid="${ev.id}" ${ev.done ? 'checked' : ''} aria-label="完了">
        <span class="sched-time">${ev.time ? `${ev.time}${ev.endTime ? `<small>〜${ev.endTime}</small>` : ''}` : '終日'}</span>
        <div class="sched-main" data-cid="${c.id}" data-eid="${ev.id}">
          <div class="sched-title"><span class="mdot" style="--h:${hueOf(c)}"></span>${esc(ev.title)}</div>
          <div class="sched-company">${esc(c.name)}${ev.place ? '・' + esc(ev.place) : ''}</div>
        </div>
      </div>`).join('') + gs.map(g => `
      <div class="sched-item gcal-item">
        <span class="sched-time">${g.allDay ? '終日' : `${g.time}${g.endTime ? `<small>〜${g.endTime}</small>` : ''}`}</span>
        <div class="sched-main"><div class="sched-title">${esc(g.title)}</div><div class="sched-company">Google カレンダー・${esc(g.calendar)}</div></div>
      </div>`).join('')
    : '<p class="muted-empty">予定はありません</p>');
}
$('#sched-mode').addEventListener('click', e => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  try { localStorage.setItem(SCHED_MODE_KEY, b.dataset.m); } catch { /* ignore */ }
  renderSchedule();
});
$('#month-view').addEventListener('click', e => {
  const mv = e.target.closest('[data-mv]');
  if (mv) {
    const n = Number(mv.dataset.mv);
    if (n === 0) { const d = new Date(); monthCursor = new Date(d.getFullYear(), d.getMonth(), 1); monthSel = todayStr(); }
    else monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + n, 1);
    renderMonth();
    return;
  }
  const day = e.target.closest('[data-day]');
  if (day) {
    monthSel = day.dataset.day;
    if (day.classList.contains('out')) monthCursor = new Date(Number(monthSel.slice(0, 4)), Number(monthSel.slice(5, 7)) - 1, 1);
    renderMonth();
    return;
  }
  const add = e.target.closest('[data-add-day]');
  if (add) { openEvent(null, null); setTimeout(() => { const f = $('#event-form'); if (f?.date) f.date.value = add.dataset.addDay; }, 0); return; }
  const main = e.target.closest('.sched-main[data-eid]');
  if (main) openEvent(main.dataset.cid, main.dataset.eid);
});
$('#month-view').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox][data-eid]');
  if (cb) { toggleEventDone(cb.dataset.cid, cb.dataset.eid, cb.checked); renderMonth(); }
});
// 横にスワイプで月を移動
(() => {
  let sx = 0, sy = 0;
  const g = $('#month-grid');
  g.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  g.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + (dx < 0 ? 1 : -1), 1);
      renderMonth();
    }
  });
})();

/* ---------- 職種を選ぶ ---------- */
const jDialog = $('#job-dialog');
const ENGINEER_RE = /エンジニア|開発|SE\b|システム|技術|IT|プログラ|データ|デジタル|ソフトウェア|インフラ|研究/i;
/** 職種が複数ある募集要項で、どれを登録するか選んでもらう（null = まとめて1つで登録） */
function pickJobs(jobs, specific) {
  return new Promise(resolve => {
    // 最初から選んでおくのは、エンジニア系の最初の1つ（なければ先頭）
    const checked = new Set([(jobs.find(j => ENGINEER_RE.test(j.name)) || jobs[0]).name]);
    $('#job-count').textContent = `${jobs.length}つ`;
    $('#job-hint').textContent = specific ? '給与・勤務地などが職種ごとに違う項目があります。複数選ぶと、職種ごとにタブを分けて入力します。'
      : '複数選ぶと、職種ごとにタブを分けて入力します。';
    $('#job-list').innerHTML = jobs.map(j => `<label class="job-opt">
      <input type="checkbox" value="${esc(j.name)}" ${checked.has(j.name) ? 'checked' : ''}>
      <span><b>${esc(j.name)}</b>${j.desc ? `<small>${esc(j.desc)}</small>` : ''}</span></label>`).join('');
    const done = v => { jDialog.close(); cleanup(); resolve(v); };
    const onOk = () => {
      const v = $$('#job-list input:checked').map(i => i.value);
      if (!v.length) { toast('職種を1つ以上選んでください'); return; }
      done(v);
    };
    const onAll = () => done(null);
    const onCancel = e => { e.preventDefault(); done(null); };
    const cleanup = () => {
      $('#job-ok').removeEventListener('click', onOk);
      $('#job-all').removeEventListener('click', onAll);
      jDialog.removeEventListener('cancel', onCancel);
    };
    $('#job-ok').addEventListener('click', onOk);
    $('#job-all').addEventListener('click', onAll);
    jDialog.addEventListener('cancel', onCancel);
    jDialog.showModal();
  });
}

/* ---------- 見た目の部品 ---------- */
const HUES = [221, 262, 190, 152, 28, 200, 280, 170, 45, 320];
/** 企業ごとの色（企業名から決める。一覧で見分けやすくするため） */
function hueOf(c) {
  const key = c.name.replace(/株式会社|\(株\)|（株）|㈱|\s/g, '');
  let h = 2166136261; // FNV-1a（文字が少し違うだけでも色がばらけるように）
  for (const ch of key) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return HUES[h % HUES.length];
}
/** 企業名の頭文字アイコン（「株式会社」などは飛ばす） */
function avatar(c, size = '') {
  const nm = c.name.replace(/^(?:株式会社|\(株\)|（株）|㈱)\s*/, '').trim() || c.name;
  return `<span class="avatar ${size}" style="--h:${hueOf(c)}" aria-hidden="true">${esc([...nm][0] || '?')}</span>`;
}
const STAGES = [
  { label: 'エントリー', ids: ['entry'] },
  { label: '書類・テスト', ids: ['es', 'test', 'gd'] },
  { label: '面接', ids: ['int1', 'int2', 'intf'] },
  { label: '内定', ids: ['offer'] },
];
/** 一覧カードの進捗バー（エントリー → 書類・テスト → 面接 → 内定） */
function progressBar(c) {
  const i = STAGES.findIndex(s => s.ids.includes(c.status));
  if (i < 0) return '';
  return `<div class="prog" title="${STAGES[i].label}">${STAGES.map((s, j) => `<span class="${j < i ? 'done' : j === i ? 'now' : ''}"></span>`).join('')}</div>`;
}
/** 詳細のステータス：タップで変更できる段階表示 */
function statusStepper(c) {
  const flow = STATUSES.filter(s => !['declined', 'rejected'].includes(s.id));
  const cur = flow.findIndex(s => s.id === c.status);
  const ended = c.status === 'declined' || c.status === 'rejected';
  return `<div class="stepper-wrap">
    <div class="stepper ${ended ? 'ended' : ''}">${flow.map((s, i) => `<button type="button" class="step ${i < cur ? 'done' : i === cur ? 'now' : ''}" data-act="set-status" data-st="${s.id}">${s.label}</button>`).join('')}</div>
    <div class="stepper-end">
      ${ended ? `<span class="chip ${STATUS_MAP[c.status].cls}">${STATUS_MAP[c.status].label}</span>` : ''}
      <button type="button" class="link small" data-act="set-status" data-st="declined">辞退した</button>
      <button type="button" class="link small" data-act="set-status" data-st="rejected">お見送り</button>
    </div>
  </div>`;
}

/** 詳細画面：募集要項が空のときの案内 */
function emptyPostingCta(c) {
  return `<div class="posting-cta">
    <p class="note">Claude に「入力の型」と募集要項を送り、返ってきた答えを貼り付けると、初任給・勤務地・休日などがまとめて入力されます。</p>
    <button class="btn primary full-w" data-act="find-posting">📋 募集要項を入力する</button>
  </div>`;
}
function startFindPosting(c) {
  dDialog.close();
  openCompany(c.id);
  $('#posting-section').open = true;
  $('.paste-box').scrollIntoView({ block: 'start' });
}
/** 詳細画面：自分のメモと、Gmail からわかった経緯を分けて表示 */
function memoSections(c) {
  const { own, gmSummary, gmLines } = splitMemo(c.memo);
  let html = own ? `<section class="dsec"><div class="dsec-head"><h3>メモ</h3></div><div class="memo-text">${esc(own)}</div></section>` : '';
  if (gmLines.length || gmSummary) {
    html += `<section class="dsec"><div class="dsec-head"><h3>📬 Gmail からわかったこと</h3>${gmSummary ? `<span class="note small">${esc(gmSummary)}</span>` : ''}</div>
      ${gmLines.length ? `<ul class="timeline gm-timeline">${[...gmLines].reverse().map(l => {
        const m = l.slice(1).trim().match(/^(\d{2}\/\d{2})\s+(.*)$/);
        return `<li><span class="tl-date">${esc(m ? m[1] : '')}</span>${esc(m ? m[2] : l.slice(1))}</li>`;
      }).join('')}</ul>` : '<p class="muted-empty">案内メールが届いているだけで、自分から動いた記録はまだありません。</p>'}
    </section>`;
  }
  return html;
}

/* ---------- ★3の企業の募集要項をまとめて取得 → 1社ずつ確認して保存 ---------- */
let reviewQueue = []; // [{ id, data }]
const bulkTargets = () => state.companies.filter(c => c.priority === 3 && ACTIVE_STATUSES.has(c.status) && !hasPosting(c));
function renderBulkBanner() {
  const el = $('#bulk-posting');
  const all = bulkTargets();
  const withSite = all.filter(c => c.site);
  el.hidden = true; // 採用サイトから読み取る機能はやめた（Claude で整えて貼り付ける）
  if (el.hidden) return;
  el.innerHTML = `<div class="tb-text"><b>★3なのに募集要項が未入力の企業が ${all.length}社</b>
    <span>${withSite.length ? `採用サイトが分かっている ${withSite.length}社 をまとめて探し、1社ずつ確認して保存できます。` : ''}${all.length > withSite.length ? `${all.length - withSite.length}社は採用サイトの URL が未登録です（企業の編集画面で入力できます）。` : ''}</span></div>
    ${withSite.length ? '<button class="btn primary" data-bulk-find>まとめて探す</button>' : ''}`;
}
let bulkBusy = false;
async function bulkFindPostings() {
  if (bulkBusy) return;
  const targets = bulkTargets().filter(c => c.site && !checkPostingUrl(c.site));
  if (!targets.length) return;
  if (!confirm(`${targets.length}社の採用サイトから募集要項を探します（1社10〜30秒ほど。この画面を開いたままにしてください）。`)) return;
  bulkBusy = true;
  const btn = $('[data-bulk-find]');
  const found = [];
  const failed = [];
  for (const [i, c] of targets.entries()) {
    if (btn) btn.textContent = `探しています… ${i + 1}/${targets.length}`;
    try {
      const data = await gasCall('find', c.site);
      if (data.found) found.push({ id: c.id, data }); else failed.push(c.name);
    } catch { failed.push(c.name); }
  }
  bulkBusy = false;
  renderBulkBanner();
  if (failed.length) toast(`見つからなかった企業：${failed.slice(0, 4).join('、')}${failed.length > 4 ? ' ほか' : ''}（ブックマークで取り込めます）`);
  if (!found.length) return;
  reviewQueue = found;
  alert(`${found.length}社の募集要項が見つかりました。1社ずつ内容を確認して「保存」してください（保存すると次の企業に進みます）。`);
  openNextReview();
}
function openNextReview() {
  const r = reviewQueue.shift();
  if (!r) return;
  if (!findCompany(r.id)) { openNextReview(); return; }
  openCompany(r.id);
  $('#posting-section').open = true;
  fillFetchedPosting(r.data);
  $('#posting-fetch-status').innerHTML = `「${esc(r.data.title || r.data.url)}」から読み取りました${reviewQueue.length ? `（このあと ${reviewQueue.length}社）` : ''}。内容を確認して保存してください。`;
}
$('#view-compare').addEventListener('click', e => { if (e.target.closest('[data-bulk-find]')) bulkFindPostings(); });

/* ---------- 今日やること ---------- */
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const DAY_MS = 864e5;
/** 最後に動きがあった日時（登録・ステータス変更・過ぎた予定） */
function lastActivity(c) {
  const today = todayStr();
  return Math.max(c.createdAt, ...c.history.map(h => h.at),
    ...c.events.filter(ev => ev.date <= today).map(ev => new Date(`${ev.date}T${ev.time || '12:00'}`).getTime()));
}
function todayItems() {
  const cs = state.companies;
  const items = [];
  // 1. 返信が必要なメール
  const done = new Set(loadJSON(GSYNC_DONE_KEY, []));
  for (const [key, list] of Object.entries(loadJSON(GSYNC_REPLY_KEY, {}))) {
    const c = cs.find(x => nameKey(x.name) === key);
    if (!c || !ACTIVE_STATUSES.has(c.status)) continue;
    for (const r of list) if (!done.has(r.thread) && Date.now() - r.at < 30 * DAY_MS) items.push({ kind: 'reply', c, r });
  }
  // 2. 今日・明日の予定の準備
  cs.forEach(c => c.events.forEach(ev => {
    const d = daysFromToday(ev.date);
    if (!ev.done && (d === 0 || d === 1)) items.push({ kind: 'prep', c, ev, d });
  }));
  // 3. 選考中なのに次の予定がない（10日以上動きがなければ結果待ち）
  const WAITING = new Set(['es', 'test', 'gd', 'int1', 'int2', 'intf']);
  cs.filter(c => IN_PROCESS.has(c.status) && !nextEvent(c)).forEach(c => {
    const days = Math.floor((Date.now() - lastActivity(c)) / DAY_MS);
    items.push({ kind: WAITING.has(c.status) && days >= 10 ? 'wait' : 'noevent', c, days });
  });
  const order = { reply: 0, prep: 1, wait: 2, noevent: 3 };
  return items.sort((a, b) => order[a.kind] - order[b.kind] || (b.days || 0) - (a.days || 0));
}
function renderToday() {
  const items = todayItems();
  $('#home-today-count').textContent = items.length ? `${items.length}件` : '';
  const ext = (href, label) => href ? `<a class="btn small" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : '';
  const KIND = { '📩': 'k-reply', '🎯': 'k-prep', '⏳': 'k-wait', '📅': 'k-noevent' };
  const row = (ico, title, sub, actions, open) => `
    <div class="mini-item today-item ${KIND[ico] || ''}"${open ? ` data-open="${open}"` : ''}>
      <span class="ti-ico" aria-hidden="true">${ico}</span>
      <div class="mi-main"><div class="mi-title">${title}</div><div class="mi-sub">${sub}</div></div>
      <div class="ti-actions">${actions}</div>
    </div>`;
  const LIMIT = 5;
  const showAll = $('#home-today').dataset.all === '1';
  const more = items.length > LIMIT && !showAll ? `<button class="link small today-more" data-today-all>残り ${items.length - LIMIT}件 を表示</button>` : '';
  $('#home-today').innerHTML = items.length ? `<div class="mini-list">${(showAll ? items : items.slice(0, LIMIT)).map(it => {
    const c = it.c;
    if (it.kind === 'reply') return row('📩', `返信が必要：${esc(it.r.subject)}`, `${esc(c.name)}・${fmtDay(it.r.at)} に届いたメール`,
      ext(it.r.url, 'Gmailで開く') + `<button class="btn small" data-reply-done="${esc(it.r.thread)}">済</button>`);
    if (it.kind === 'prep') return row('🎯', `${it.d === 0 ? '今日' : '明日'}：${esc(it.ev.title)}`,
      `${esc(c.name)}${it.ev.time ? '・' + timeRange(it.ev) : ''}${it.ev.place ? '・' + esc(it.ev.place) : ''}`,
      '<span class="btn small ghost">準備する</span>', c.id);
    if (it.kind === 'wait') return row('⏳', `${esc(c.name)}：${it.days > 60 ? '2か月以上' : it.days + '日'} 動きなし`,
      `${STATUS_MAP[c.status].label}のあと連絡がありません。マイページで結果を確認しましょう`,
      ext(c.url, 'マイページ') + `<button class="btn small" data-add-event="${c.id}">＋予定</button>`, c.id);
    return row('📅', `${esc(c.name)}：次の予定が未登録`, `${STATUS_MAP[c.status].label}・忘れている締切がないか確認`,
      `<button class="btn small" data-add-event="${c.id}">＋予定</button>`, c.id);
  }).join('')}</div>${more}` : '<p class="muted-empty">今日やることはありません 🎉</p>';
}
function markReplyDone(thread) {
  const done = loadJSON(GSYNC_DONE_KEY, []);
  done.push(thread);
  try { localStorage.setItem(GSYNC_DONE_KEY, JSON.stringify(done.slice(-300))); } catch { /* ignore */ }
  toast('返信済みにしました');
  render();
}

/* ---------- 志望度の仕分け（スワイプ） ---------- */
const untriaged = () => state.companies.filter(c => c.status === 'interest' && !c.triagedAt);
function renderTriageBanner() {
  const n = untriaged().length;
  const el = $('#home-triage');
  el.hidden = !n;
  el.innerHTML = n ? `
    <div class="tb-text"><b>未仕分けの企業が ${n}社</b><span>スワイプで「受けたい・保留・受けない」に（1社5秒）</span></div>
    <button class="btn primary" data-start-triage>仕分ける</button>` : '';
}
const tDialog = $('#triage-dialog');
let triageQueue = [];
let triageIdx = 0;
let triageHist = [];
function openTriage() {
  let list = untriaged();
  let again = false;
  if (!list.length) { list = state.companies.filter(c => c.status === 'interest' && c.priority === 2); again = true; }
  if (!list.length) { toast('仕分ける企業はありません'); return; }
  // 自分が動いた企業・メールが多い企業から
  const score = c => c.priority * 100 + (c.memo.match(/に (\d+)通/) || [0, 0])[1] * 1;
  triageQueue = list.sort((a, b) => score(b) - score(a)).map(c => c.id);
  triageIdx = 0;
  triageHist = [];
  if (again) toast('「保留」にした企業をもう一度仕分けます');
  renderTriage();
  tDialog.showModal();
}
function splitMemo(memo) {
  const i = memo.indexOf(GSYNC_MEMO);
  const own = (i >= 0 ? memo.slice(0, i) : memo).trim();
  const gm = i >= 0 ? memo.slice(i + GSYNC_MEMO.length).trim().split('\n').filter(Boolean) : [];
  return { own, gmSummary: gm[0] && !gm[0].startsWith('・') ? gm[0] : '', gmLines: gm.filter(l => l.startsWith('・')) };
}
function triageCard(c, behind) {
  const { own, gmSummary, gmLines } = splitMemo(c.memo);
  const ev = nextEvent(c);
  return `<div class="tcard${behind ? ' behind' : ''}"${behind ? '' : ' id="tcard"'}>
    ${behind ? '' : '<div class="tc-stamp yes">受けたい</div><div class="tc-stamp no">受けない</div><div class="tc-stamp maybe">保留</div>'}
    <div class="tc-name">${esc(c.name)}</div>
    <div class="tc-badges">${c.industry ? `<span class="chip g-pre">${esc(c.industry)}</span>` : ''}${tokyoBadge(c)}<span class="stars-view">${stars(c.priority)}</span></div>
    ${gmLines.length ? `<div class="tc-sec"><div class="tc-h">自分がしたこと・届いた連絡</div><ul>${gmLines.slice(-4).map(l => `<li>${esc(l.slice(1))}</li>`).join('')}</ul></div>` : ''}
    ${gmSummary ? `<div class="tc-meta">📬 ${esc(gmSummary)}</div>` : ''}
    ${ev ? `<div class="tc-meta">📅 ${fmtDate(ev.date)} ${esc(ev.title)}</div>` : ''}
    ${own ? `<div class="tc-memo">${esc(own.slice(0, 140))}</div>` : ''}
    ${!gmLines.length && !gmSummary && !own ? '<div class="tc-meta">メモはまだありません</div>' : ''}
  </div>`;
}
function renderTriage() {
  const total = triageQueue.length;
  $('#triage-progress').textContent = `${Math.min(triageIdx + 1, total)} / ${total}`;
  $('#triage-undo').disabled = !triageHist.length;
  const stage = $('#triage-stage');
  const btns = $('.triage-buttons');
  if (triageIdx >= total) {
    const cnt = k => triageHist.filter(h => h.kind === k).length;
    btns.hidden = true;
    stage.innerHTML = `<div class="tcard done-card"><div class="tc-name">おつかれさまでした！</div>
      <p>受けたい <b>${cnt('yes')}</b>社・保留 <b>${cnt('maybe')}</b>社・受けない <b>${cnt('no')}</b>社</p>
      <p class="note">「受けたい」は ★★★、「受けない」は「辞退」になりました（企業一覧の「すべて」で確認・変更できます）。</p>
      <button type="button" class="btn primary" data-close-triage>閉じる</button></div>`;
    return;
  }
  btns.hidden = false;
  const c = findCompany(triageQueue[triageIdx]);
  const next = findCompany(triageQueue[triageIdx + 1]);
  stage.innerHTML = (next ? triageCard(next, true) : '') + triageCard(c, false);
  bindSwipe($('#tcard'));
}
function decideTriage(kind) {
  const c = findCompany(triageQueue[triageIdx]);
  if (!c) return;
  triageHist.push({ kind, id: c.id, prev: { status: c.status, priority: c.priority, triagedAt: c.triagedAt, historyLen: c.history.length } });
  const now = Date.now();
  c.triagedAt = now;
  c.updatedAt = now;
  if (kind === 'yes') c.priority = 3;
  if (kind === 'maybe') c.priority = 2;
  if (kind === 'no') { c.priority = 1; c.status = 'declined'; c.history.push({ status: 'declined', at: now }); }
  save();
  triageIdx++;
  renderTriage();
}
function undoTriage() {
  const h = triageHist.pop();
  if (!h) return;
  const c = findCompany(h.id);
  if (c) {
    Object.assign(c, { status: h.prev.status, priority: h.prev.priority, triagedAt: h.prev.triagedAt });
    c.history = c.history.slice(0, h.prev.historyLen);
    save();
  }
  triageIdx = Math.max(0, triageIdx - 1);
  renderTriage();
}
/** カードを指でスワイプ（右=受けたい / 左=受けない / 上=保留） */
function bindSwipe(card) {
  if (!card) return;
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  const stamps = { yes: card.querySelector('.tc-stamp.yes'), no: card.querySelector('.tc-stamp.no'), maybe: card.querySelector('.tc-stamp.maybe') };
  const kindOf = () => (dy < -90 && Math.abs(dy) > Math.abs(dx) ? 'maybe' : dx > 90 ? 'yes' : dx < -90 ? 'no' : null);
  const paint = () => {
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    stamps.yes.style.opacity = Math.max(0, Math.min(1, dx / 90));
    stamps.no.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    stamps.maybe.style.opacity = Math.abs(dy) > Math.abs(dx) ? Math.max(0, Math.min(1, -dy / 90)) : 0;
  };
  card.addEventListener('pointerdown', e => {
    dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    paint();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    const kind = kindOf();
    if (kind) flyOut(kind); else { dx = dy = 0; paint(); }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}
function flyOut(kind) {
  const card = $('#tcard');
  if (!card || card.classList.contains('out')) return;
  const to = { yes: 'translate(140%, 0) rotate(18deg)', no: 'translate(-140%, 0) rotate(-18deg)', maybe: 'translate(0, -140%)' }[kind];
  const stamp = card.querySelector(`.tc-stamp.${kind}`);
  if (stamp) stamp.style.opacity = 1;
  card.classList.add('out');
  card.style.transform = to;
  card.style.opacity = '0';
  setTimeout(() => decideTriage(kind), 220);
}
$('.triage-buttons').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) flyOut(b.dataset.t); });
$('#triage-undo').addEventListener('click', undoTriage);
tDialog.addEventListener('click', e => {
  if (e.target.closest('[data-close]') || e.target.closest('[data-close-triage]')) tDialog.close();
});
tDialog.addEventListener('keydown', e => {
  const k = { ArrowRight: 'yes', ArrowLeft: 'no', ArrowUp: 'maybe' }[e.key];
  if (k && triageIdx < triageQueue.length) { e.preventDefault(); flyOut(k); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undoTriage(); }
});
tDialog.addEventListener('close', () => render());

/* ---------- クイック追加 ---------- */
const qDialog = $('#quick-dialog');
const qOne = $('#quick-one');
const qMany = $('#quick-many');
let quickStatus = 'interest';
let quickPriority = 2;
function setPills(rowSel, v) { $$(`${rowSel} button`).forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); }
function setQuickMode(mode) {
  $$('#quick-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  qOne.hidden = mode !== 'one';
  qMany.hidden = mode !== 'many';
  setTimeout(() => (mode === 'one' ? qOne.name : qMany.names).focus(), 50);
}
function openQuickAdd() {
  qOne.reset();
  qMany.reset();
  quickStatus = 'interest';
  quickPriority = 2;
  setPills('#quick-status', quickStatus);
  setPills('#quick-priority', quickPriority);
  updateQuickHints();
  updateManyPreview();
  qDialog.showModal();
  setQuickMode('one');
}
const findByName = name => state.companies.find(c => nameKey(c.name) === nameKey(name));
function updateQuickHints() {
  const name = qOne.name.value.trim();
  const dup = name && findByName(name);
  const box = $('#quick-dup');
  box.hidden = !dup;
  box.innerHTML = dup ? `「${esc(dup.name)}」はすでに登録されています（${STATUS_MAP[dup.status].label}）。 <button type="button" class="link" data-quick-open="${dup.id}">開く</button>` : '';
  const g = name ? guessIndustries(name)[0] : null;
  $('#quick-industry').textContent = g ? `業界：${g.name}（企業名から推定）` : '';
}
function quickCompany(name, status, priority, triaged) {
  const now = Date.now();
  const c = normalizeCompany({
    name, status, priority, industry: guessIndustries(name)[0]?.name || '',
    history: status !== 'interest' ? [{ status, at: now }] : [], createdAt: now, updatedAt: now, triagedAt: triaged ? now : 0,
  });
  state.companies.push(c);
  return c;
}
$('#quick-mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setQuickMode(b.dataset.mode); });
$('#quick-status').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { quickStatus = b.dataset.v; setPills('#quick-status', quickStatus); } });
$('#quick-priority').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { quickPriority = Number(b.dataset.v); setPills('#quick-priority', quickPriority); } });
qOne.name.addEventListener('input', updateQuickHints);
qDialog.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { qDialog.close(); return; }
  const o = e.target.closest('[data-quick-open]');
  if (o) { qDialog.close(); openDetail(o.dataset.quickOpen); }
});
qOne.addEventListener('submit', e => {
  e.preventDefault();
  const name = qOne.name.value.trim();
  if (!name) return;
  if (findByName(name) && !confirm(`「${name}」はすでに登録されています。もう1社追加しますか？`)) return;
  const c = quickCompany(name, quickStatus, quickPriority, true);
  save();
  render();
  toast(`「${c.name}」を追加しました${c.industry ? `（${c.industry}）` : ''}`);
  qOne.name.value = '';
  updateQuickHints();
  qOne.name.focus();
});
$('#quick-detail').addEventListener('click', () => {
  const name = qOne.name.value.trim();
  qDialog.close();
  openCompany(null);
  cForm.name.value = name;
  cForm.status.value = quickStatus;
  setPriority(quickPriority);
  updateIndustryUi();
});
function parseNameList(text) {
  const seen = new Set();
  return text.split(/[\n\t,、，]+/)
    .map(l => l.replace(/^\s*(?:[-・*●■□◆◇○◎▼▶]|\d+[.)．）])\s*/, '').trim())
    .filter(l => l && l.length <= 40)
    .filter(l => { const k = nameKey(l); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}
function updateManyPreview() {
  const names = parseNameList(qMany.names.value);
  const fresh = names.filter(n => !findByName(n));
  $('#quick-many-preview').textContent = names.length
    ? `${fresh.length}社を追加します${names.length > fresh.length ? `（${names.length - fresh.length}社は登録済みなのでスキップ）` : ''}。「興味あり」で登録され、あとでスワイプで仕分けできます。`
    : 'メモ帳や Excel からコピーして貼り付けられます。「興味あり」で登録され、あとでスワイプで仕分けできます。';
}
qMany.names.addEventListener('input', updateManyPreview);
qMany.addEventListener('submit', e => {
  e.preventDefault();
  const fresh = parseNameList(qMany.names.value).filter(n => !findByName(n));
  if (!fresh.length) { toast('追加する企業がありません'); return; }
  fresh.forEach(n => quickCompany(n, 'interest', 2, false));
  save();
  qDialog.close();
  render();
  toast(`${fresh.length}社を追加しました。ホームの「仕分ける」で志望度を分けられます`);
});

/* ---------- 表示テーマ ---------- */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && darkMQ.matches);
  $('#theme-color').content = dark ? '#101114' : '#f5f6f8';
  $('#theme-select').value = t;
}
applyTheme(document.documentElement.dataset.theme || 'light');
darkMQ.addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));
$('#theme-select').addEventListener('change', e => {
  try { localStorage.setItem('syukatsu.theme', e.target.value); } catch {}
  applyTheme(e.target.value);
});

/* ---------- init ---------- */
showView('home');
migrateLegacy();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
