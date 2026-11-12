'use strict';

const APP_VERSION = '1.4.0';
const STORAGE_KEY = 'syukatsu.v1';

const STATUSES = [
  { id: 'interest',  label: '興味あり',     cls: 's-pre' },
  { id: 'entry',     label: 'エントリー済', cls: '' },
  { id: 'es',        label: 'ES・書類選考', cls: '' },
  { id: 'test',      label: 'Webテスト',    cls: '' },
  { id: 'gd',        label: 'GD',           cls: '' },
  { id: 'int1',      label: '一次面接',     cls: '' },
  { id: 'int2',      label: '二次面接',     cls: '' },
  { id: 'intf',      label: '最終面接',     cls: '' },
  { id: 'offer',     label: '内定',         cls: 's-offer' },
  { id: 'declined',  label: '辞退',         cls: 's-end' },
  { id: 'rejected',  label: 'お見送り',     cls: 's-end' },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.id, s]));
const ACTIVE_STATUSES = new Set(STATUSES.filter(s => !['declined', 'rejected'].includes(s.id)).map(s => s.id));

const TOKYO = {
  only:   { badge: '東京◎', cls: 'tk-only',   label: '東京勤務が確実' },
  likely: { badge: '東京△', cls: 'tk-likely', label: '東京の可能性あり' },
  no:     { badge: '東京×', cls: 'tk-no',     label: '東京勤務なし' },
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
const POSTING_TEXT = ['job', 'recruiter', 'eligibility', 'startDate', 'contract', 'probation', 'hours', 'holidaysNote',
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
function normalizeCompany(c) {
  const p = c.posting && typeof c.posting === 'object' ? c.posting : {};
  const posting = {};
  POSTING_TEXT.forEach(k => { posting[k] = str(p[k]); });
  POSTING_NUM.forEach(k => { posting[k] = numOrNull(p[k]); });
  POSTING_FLAGS.forEach(f => { posting[f.key] = Boolean(p[f.key]); });
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
    posting,
    memo: str(c.memo),
    events: (Array.isArray(c.events) ? c.events : [])
      .filter(ev => ev && ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date))
      .map(normalizeEvent),
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Date.now(),
  };
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
  const v = d.vault;
  const hasCipher = [...companies, ...accounts].some(x => isCipher(x.pwd));
  if (hasCipher && v && typeof v.salt === 'string' && isCipher(v.check)) {
    return { companies, accounts, vault: { salt: v.salt, check: v.check } };
  }
  // 鍵情報がない暗号データは復元できないので破棄
  [...companies, ...accounts].forEach(x => { if (isCipher(x.pwd)) x.pwd = ''; });
  return { companies, accounts };
}

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return { companies: [], accounts: [] };
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
function nextEvent(c) {
  const today = todayStr();
  return c.events.filter(e => !e.done && e.date >= today).sort((a, b) => evKey(a).localeCompare(evKey(b)))[0];
}
function stars(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }
function tokyoBadge(c) {
  const t = TOKYO[c.tokyo];
  return t ? `<span class="badge ${t.cls}" title="${t.label}">${t.badge}</span>` : '';
}
function hasPosting(c) {
  return POSTING_NUM.some(k => c.posting[k] != null) || POSTING_TEXT.some(k => c.posting[k]) || POSTING_FLAGS.some(f => c.posting[f.key]);
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
const TITLES = { companies: '企業一覧', schedule: '予定', compare: '比較', login: 'ログイン情報', settings: '設定' };
let currentView = 'companies';
function showView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#page-title').textContent = TITLES[name];
  $('#fab').hidden = name !== 'companies';
  render();
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

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
  if (currentView === 'companies') renderCompanies();
  else if (currentView === 'schedule') renderSchedule();
  else if (currentView === 'compare') renderCompare();
  else if (currentView === 'login') renderLogin();
  else if (currentView === 'settings') renderSettings();
}

function matchTokyo(c, f) {
  if (f === 'ok') return c.tokyo === 'only' || c.tokyo === 'likely';
  if (f === 'only') return c.tokyo === 'only';
  if (f === 'notno') return c.tokyo !== 'no';
  return true;
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
    `<button data-f="active" class="${f === 'active' ? 'on' : ''}">選考中 ${activeCount}</button>` +
    `<button data-f="all" class="${f === 'all' ? 'on' : ''}">すべて ${state.companies.length}</button>` +
    STATUSES.filter(s => counts[s.id]).map(s =>
      `<button data-f="${s.id}" class="${f === s.id ? 'on' : ''}">${s.label} ${counts[s.id]}</button>`).join('');

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
      nextHtml = `<div class="card-next ${cls}">📌 ${esc(ne.title)}・${fmtDate(ne.date)}${ne.time ? ' ' + ne.time : ''}（${relLabel(ne.date)}）</div>`;
    }
    const rn = routeName(c);
    return `<li class="card" data-id="${c.id}">
      <div class="card-top">
        <span class="card-name">${esc(c.name)}</span>
        ${tokyoBadge(c)}
        <span class="chip ${st.cls}">${st.label}</span>
      </div>
      <div class="card-sub">
        <span class="stars-view">${stars(c.priority)}</span>
        ${c.industry ? `<span>${esc(c.industry)}</span>` : ''}
        ${c.hq ? `<span>本社: ${esc(c.hq)}</span>` : ''}
        ${rn ? `<span>経路: ${esc(rn)}</span>` : ''}
      </div>
      ${nextHtml}
    </li>`;
  }).join('');

  $('#company-empty').hidden = state.companies.length > 0;
  if (state.companies.length > 0 && list.length === 0) {
    $('#company-list').innerHTML = '<p class="empty">該当する企業はありません。</p>';
  }
}

$('#summary').addEventListener('click', e => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filterSel.value = b.dataset.f;
  saveUiPref();
  render();
});
$('#company-list').addEventListener('click', e => {
  const li = e.target.closest('.card');
  if (li) openCompany(li.dataset.id);
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
$('#schedule-list').addEventListener('click', e => {
  const m = e.target.closest('.sched-main');
  if (m) openCompany(m.dataset.cid);
});

/* ---------- 比較 ---------- */
function compareTargets() {
  const f = $('#cmp-filter').value;
  const tokyoOnly = $('#cmp-tokyo').checked;
  const fi = $('#cmp-industry').value;
  return state.companies.filter(c =>
    (f === 'all' || ACTIVE_STATUSES.has(c.status)) && (!tokyoOnly || matchTokyo(c, 'ok')) && matchIndustry(c, fi));
}
function renderCompare() {
  fillIndustryFilters();
  const metric = METRICS.find(m => m.key === $('#cmp-metric').value) || METRICS[0];
  const targets = compareTargets();
  const hasAny = targets.some(hasPosting);

  $('#cmp-empty').hidden = hasAny;
  $$('#view-compare .panel').forEach(p => { p.hidden = !hasAny; });
  if (!hasAny) return;

  const withVal = targets.filter(c => c.posting[metric.key] != null);
  const missing = targets.filter(c => c.posting[metric.key] == null);
  withVal.sort((a, b) => metric.better === 'low'
    ? a.posting[metric.key] - b.posting[metric.key]
    : b.posting[metric.key] - a.posting[metric.key]);

  $('#cmp-title').textContent = `${metric.label}（${metric.unit}）`;
  $('#cmp-sub').textContent = metric.better === 'low' ? '少ない順に表示' : '多い順に表示';
  const max = Math.max(...withVal.map(c => c.posting[metric.key]), 0);
  $('#cmp-chart').innerHTML = withVal.length ? withVal.map(c => {
    const v = c.posting[metric.key];
    const pct = max > 0 ? (v / max) * 100 : 0;
    return `<div class="bar-row" data-id="${c.id}" title="${esc(c.name)}: ${esc(metric.fmt(v))}">
      <div class="bar-label">${tokyoBadge(c)}<span class="nm">${esc(c.name)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:calc((100% - 76px) * ${(pct / 100).toFixed(4)})"></div><span class="bar-val">${esc(metric.fmt(v))}</span></div>
    </div>`;
  }).join('') + (withVal.length >= 2
    ? `<div class="bar-avg">平均 ${esc(metric.fmt(roundFor(metric, withVal.reduce((s, c) => s + c.posting[metric.key], 0) / withVal.length)))}（${withVal.length}社）</div>`
    : '')
    : '<p class="note">この項目が入力された企業はありません。</p>';
  $('#cmp-missing').textContent = missing.length ? `未入力: ${missing.map(c => c.name).join('、')}` : '';

  // 一覧表（各列でいちばん良い値を強調）
  const rows = targets.filter(hasPosting);
  rows.sort((a, b) => {
    const av = a.posting[metric.key], bv = b.posting[metric.key];
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return metric.better === 'low' ? av - bv : bv - av;
  });
  const best = {};
  METRICS.forEach(m => {
    const vals = rows.map(c => c.posting[m.key]).filter(v => v != null);
    if (vals.length >= 2) best[m.key] = m.better === 'low' ? Math.min(...vals) : Math.max(...vals);
  });
  $('#cmp-table').innerHTML =
    `<thead><tr><th>企業</th><th>東京</th>${METRICS.map(m => `<th>${m.label}</th>`).join('')}<th>働き方</th><th>職種</th><th>本社</th></tr></thead>
    <tbody>${rows.map(c => `<tr data-id="${c.id}">
      <td>${esc(c.name)}</td>
      <td class="l">${TOKYO[c.tokyo]?.badge || '-'}</td>
      ${METRICS.map(m => {
        const v = c.posting[m.key];
        return `<td class="${v != null && v === best[m.key] ? 'best' : ''}">${v == null ? '-' : esc(m.fmt(v))}</td>`;
      }).join('')}
      <td class="l">${POSTING_FLAGS.filter(f => c.posting[f.key]).map(f => f.label).join('・') || '-'}</td>
      <td class="l" title="${esc(c.posting.job)}">${esc(c.posting.job.split('\n')[0]) || '-'}</td>
      <td class="l">${esc(c.hq) || '-'}</td>
    </tr>`).join('')}</tbody>`;
}
$('#cmp-chart').addEventListener('click', e => {
  const r = e.target.closest('.bar-row');
  if (r) openCompany(r.dataset.id);
});
$('#cmp-table').addEventListener('click', e => {
  const r = e.target.closest('tr[data-id]');
  if (r) openCompany(r.dataset.id);
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
        <button class="link" data-edit-account="${a.id}">編集</button></div>
      ${a.loginId ? `<div class="lc-sub">ID: ${esc(a.loginId)}</div>` : ''}
      ${a.memo ? `<div class="lc-sub">${esc(a.memo)}</div>` : ''}
      <div class="lc-actions">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">開く ↗</a>` : ''}
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
      <div class="lc-actions">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">マイページ ↗</a>` : ''}
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
  else if (t.dataset.openCompany) openCompany(t.dataset.openCompany);
  else if (t.dataset.copyId) copyText(itemFromRef(t.dataset.copyId)?.loginId, 'ID');
  else if (t.dataset.copyPw) copyPassword(itemFromRef(t.dataset.copyPw)?.pwd);
});
$('#add-account').addEventListener('click', () => openAccount(null));

/* ---------- 設定 ---------- */
function renderSettings() {
  $('#version').textContent = 'バージョン ' + APP_VERSION;
}

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

function openCompany(id) {
  const src = id ? state.companies.find(c => c.id === id) : null;
  editing = src ? structuredClone(src) : normalizeCompany({ name: '', createdAt: Date.now() });
  $('#company-dialog-title').textContent = src ? '企業の詳細' : '企業を追加';
  ['name', 'status', 'hq', 'locations', 'tokyo', 'url', 'loginId', 'memo'].forEach(k => { cForm[k].value = editing[k]; });
  setIndustry(editing.industry);
  POSTING_TEXT.forEach(k => { cForm['p_' + k].value = editing.posting[k]; });
  POSTING_NUM.forEach(k => { cForm['p_' + k].value = editing.posting[k] ?? ''; });
  POSTING_FLAGS.forEach(f => { cForm['p_' + f.key].checked = editing.posting[f.key]; });
  $('#posting-section').open = hasPosting(editing);
  showSalaryCandidates();
  setPriority(editing.priority);
  fillRouteSelect(editing.route);
  companyPw.load(editing.pwd);
  updateOpenUrl();
  updateTokyoHint();
  $('#delete-company').hidden = !src;


  renderEvents();
  cDialog.showModal();
  cDialog.querySelector('.dialog-body').scrollTop = 0;
  if (!src) setTimeout(() => cForm.name.focus(), 50);
}

function renderEvents() {
  const evs = [...editing.events].sort((a, b) => evKey(a).localeCompare(evKey(b)));
  $('#event-list').innerHTML = evs.length ? evs.map(ev => `
    <li class="event-item ${ev.done ? 'done' : ''}">
      <input type="checkbox" data-eid="${ev.id}" ${ev.done ? 'checked' : ''} aria-label="完了">
      <div class="ev-main" data-eid="${ev.id}">
        <div class="ev-title">${esc(ev.title)}</div>
        <div class="ev-date">${fmtDate(ev.date, true)}${ev.time ? ' ' + ev.time : ''}${ev.place ? '・' + esc(ev.place) : ''}</div>
      </div>
      <a class="gcal" href="${esc(gcalUrl(ev, cForm.name.value || editing.name))}" target="_blank" rel="noopener">カレンダー</a>
    </li>`).join('') : '<li class="event-empty">予定はまだありません</li>';
}
$('#event-list').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox]');
  const ev = cb && editing.events.find(x => x.id === cb.dataset.eid);
  if (ev) { ev.done = cb.checked; renderEvents(); }
});
$('#event-list').addEventListener('click', e => {
  const m = e.target.closest('.ev-main');
  if (m) openEvent(m.dataset.eid);
});
$('#add-event').addEventListener('click', () => openEvent(null));

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

function readCompanyForm() {
  ['name', 'hq', 'locations', 'url', 'loginId'].forEach(k => { editing[k] = cForm[k].value.trim(); });
  editing.industry = currentIndustry();
  editing.status = cForm.status.value;
  editing.tokyo = cForm.tokyo.value;
  const r = cForm.route.value;
  editing.route = r === '__new' ? '' : r;
  editing.priority = Number(cForm.priority.value) || 2;
  editing.memo = cForm.memo.value;
  POSTING_TEXT.forEach(k => { editing.posting[k] = cForm['p_' + k].value.trim(); });
  POSTING_NUM.forEach(k => { editing.posting[k] = numOrNull(cForm['p_' + k].value); });
  POSTING_FLAGS.forEach(f => { editing.posting[f.key] = cForm['p_' + f.key].checked; });
  editing.pwd = companyPw.value();
}

cForm.addEventListener('submit', async e => {
  e.preventDefault();
  readCompanyForm();
  if (!editing.name) { cForm.name.focus(); return; }
  editing.updatedAt = Date.now();
  const idx = state.companies.findIndex(c => c.id === editing.id);
  if (idx >= 0) state.companies[idx] = editing; else state.companies.push(editing);
  save();
  cDialog.close();
  toast('保存しました');
  render();
});

function hasUnsavedChanges() {
  readCompanyForm();
  const orig = state.companies.find(c => c.id === editing.id);
  if (!orig) return Boolean(editing.name || editing.memo || editing.events.length);
  const strip = o => JSON.stringify({ ...o, updatedAt: 0 });
  return strip(orig) !== strip(editing);
}
function tryCloseCompany() {
  if (hasUnsavedChanges() && !confirm('変更が保存されていません。破棄して閉じますか？')) return;
  cDialog.close();
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
  ['eligibility',  ['応募資格', '応募対象', '対象', '対象者', '募集対象']],
  ['startDate',    ['入社時期', '入社日', '入社予定日']],
  ['contract',     ['契約期間', '雇用形態']],
  ['probation',    ['試用期間']],
  ['locations',    ['勤務地', '勤務場所', '就業場所', '勤務予定地', '配属先']],
  ['hours',        ['勤務時間', '就業時間', '勤務形態']],
  ['salaryNote',   ['初任給', '給与', '給与・待遇', '基本給', '月給', '給与（月給）']],
  ['benefits',     ['福利厚生', '待遇', '社会保険', '待遇・福利厚生']],
  ['allowances',   ['諸手当', '手当']],
  ['commute',      ['通勤費', '交通費', '通勤手当']],
  ['raise',        ['昇給']],
  ['bonusNote',    ['賞与', 'ボーナス']],
  ['holidaysNote', ['休日休暇', '休日・休暇', '休日', '休暇', '年間休日']],
  ['hiring',       ['採用予定人数', '募集人数', '採用人数', '採用予定数']],
  ['note',         ['選考フロー', '選考方法', '選考プロセス', '提出書類', '選考の流れ']],
];
// 1〜2行で終わるはずの項目（ページ末尾のメニューなどを取り込まないよう行数を制限）
const SHORT_FIELDS = new Set(['recruiter', 'startDate', 'contract', 'probation', 'commute', 'raise', 'bonusNote', 'holidaysNote', 'hiring', 'allowances']);

function matchLabel(line) {
  const t = line.replace(/[\s:：]+$/, '').replace(/^[■●◆▼【\[]\s*/, '').replace(/[】\]]$/, '');
  for (const [field, labels] of POSTING_LABELS) {
    for (const l of labels) {
      if (t === l) return { field, rest: '' };
      if (t.startsWith(l) && /^[（(]/.test(t.slice(l.length)) && t.length <= l.length + 14) return { field, rest: '' };
    }
  }
  return null;
}

function parsePosting(raw) {
  const segs = []; // [{ field, lines }]
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
      const rest = tab.slice(1).join(' ').trim();
      if (rest) cur.lines.push(rest);
      continue;
    }
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
    if (!lines.length) return;
    out[field] = out[field] ? out[field] + '\n' + lines.join('\n') : lines.join('\n');
  });
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
function showSalaryCandidates() {
  const box = $('#salary-candidates');
  const cands = salaryCandidates(cForm.p_salaryNote.value);
  box.hidden = cands.length < 2;
  box.innerHTML = cands.length < 2 ? '' : '詳細にある金額から選ぶ: ' +
    cands.map(v => `<button type="button" data-v="${v}">${v.toLocaleString('ja-JP')}円</button>`).join('');
}
$('#salary-candidates').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) { cForm.p_salary.value = b.dataset.v; toast('比較用の初任給にセットしました'); }
});
cForm.p_salaryNote.addEventListener('input', showSalaryCandidates);

function applyPosting(auto = false) {
  const raw = cForm.p_raw.value;
  if (!raw.trim()) { if (!auto) toast('募集要項のテキストを貼り付けてください'); return; }
  const parsed = parsePosting(raw);
  const values = {}; // フォーム要素名 → 値
  for (const [field, text] of Object.entries(parsed)) {
    if (field === 'locations') values.locations = text;
    else if (field === 'hiring') {
      const n = text.match(/(\d+)\s*(?:名|人)/);
      if (n) values.p_hiring = n[1];
      values.p_note = (values.p_note ? values.p_note + '\n' : '') + '採用予定人数: ' + text;
    } else if (field === 'note') values.p_note = (values.p_note ? values.p_note + '\n' : '') + text;
    else values['p_' + field] = text;
  }
  // 数値の抽出
  const sal = salaryCandidates(parsed.salaryNote);
  if (sal.length === 1) values.p_salary = sal[0];
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
  const flags = {
    p_flex: /フレックス|フレキシブル|コアタイム/.test(raw),
    p_discretionary: /裁量労働/.test(raw),
    p_remote: /リモート|在宅勤務|テレワーク/.test(raw),
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
  showSalaryCandidates();
  updateTokyoHint();
  let industryMsg = '';
  if (!$('#industry-select').value) {
    const g = guessIndustries(industryGuessText())[0];
    if (g) { setIndustry(g.name); industryMsg = `（業界は「${g.name}」と推定）`; }
  } else updateIndustryUi();
  toast(`${count} 項目を入力しました${industryMsg}。内容を確認して保存してください`);
  $('#posting-section').open = true;
  if (sal.length > 1) setTimeout(() => toast(`初任給の候補が ${sal.length} 件あります。自分に当てはまる額をタップしてください`), 2000);
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
let editingEventId = null;

function openEvent(eid) {
  editingEventId = eid;
  const ev = eid ? editing.events.find(x => x.id === eid) : null;
  eForm.title.value = ev?.title || '';
  eForm.date.value = ev?.date || todayStr();
  eForm.time.value = ev?.time || '';
  eForm.place.value = ev?.place || '';
  eForm.done.checked = Boolean(ev?.done);
  $('#delete-event').hidden = !ev;
  eDialog.showModal();
  if (!ev) setTimeout(() => eForm.title.focus(), 50);
}
eForm.addEventListener('submit', e => {
  e.preventDefault();
  const data = {
    title: eForm.title.value.trim(), date: eForm.date.value, time: eForm.time.value,
    place: eForm.place.value.trim(), done: eForm.done.checked,
  };
  if (!data.title || !data.date) return;
  if (editingEventId) Object.assign(editing.events.find(x => x.id === editingEventId), data);
  else editing.events.push({ id: uid(), ...data });
  eDialog.close();
  renderEvents();
});
eDialog.querySelector('[data-close]').addEventListener('click', () => eDialog.close());
$('#delete-event').addEventListener('click', () => {
  if (!confirm('この予定を削除しますか？')) return;
  editing.events = editing.events.filter(x => x.id !== editingEventId);
  eDialog.close();
  renderEvents();
});

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
$('#fab').addEventListener('click', () => openCompany(null));

/* ---------- backup ---------- */
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'syukatsu', version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `syukatsu-backup-${todayStr()}.json`;
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
    if (!confirm(`${next.companies.length} 社・サービス ${next.accounts.length} 件のデータを読み込みます。\n現在のデータは置き換えられます。よろしいですか？`)) return;
    state = next;
    save();
    toast('読み込みました');
    render();
    migrateLegacy();
  } catch (err) {
    alert('読み込みに失敗しました: ' + err.message);
  }
});

$('#clear-btn').addEventListener('click', () => {
  if (!confirm('すべてのデータを削除します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に削除しますか？（事前にバックアップの書き出しをおすすめします）')) return;
  state = { companies: [], accounts: [] };
  save();
  toast('削除しました');
  render();
});

/* ---------- init ---------- */
render();
migrateLegacy();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
