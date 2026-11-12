'use strict';

const APP_VERSION = '1.0.0';
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

/* ---------- storage ---------- */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.companies)) return data;
    }
  } catch (e) { console.error(e); }
  return { companies: [] };
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert('保存に失敗しました: ' + e.message);
  }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
function nextEvent(c) {
  const today = todayStr();
  return c.events
    .filter(e => !e.done && e.date >= today)
    .sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')))[0];
}
function stars(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }

function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

function gcalUrl(ev, companyName) {
  const d = ev.date.replace(/-/g, '');
  let dates;
  if (ev.time) {
    const [h, m] = ev.time.split(':').map(Number);
    const start = `${d}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const endH = h + 1;
    // 23時台の予定は終了を 23:59 に丸める
    const end = endH >= 24 ? `${d}T235900` : `${d}T${String(endH).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    dates = `${start}/${end}`;
  } else {
    const [y, mo, da] = ev.date.split('-').map(Number);
    const next = new Date(y, mo - 1, da + 1);
    dates = `${d}/${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, '0')}${String(next.getDate()).padStart(2, '0')}`;
  }
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: `【${companyName}】${ev.title}`,
    dates,
    location: ev.place || '',
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

/* ---------- navigation ---------- */
const TITLES = { companies: '企業一覧', schedule: '予定', settings: '設定' };
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

try {
  const pref = JSON.parse(localStorage.getItem(STORAGE_KEY + '.ui') || '{}');
  if (pref.filter) filterSel.value = pref.filter;
  if (pref.sort) $('#sort').value = pref.sort;
} catch { /* ignore */ }
function saveUiPref() {
  try { localStorage.setItem(STORAGE_KEY + '.ui', JSON.stringify({ filter: filterSel.value, sort: $('#sort').value })); } catch { /* ignore */ }
}

$('#search').addEventListener('input', render);
filterSel.addEventListener('change', () => { saveUiPref(); render(); });
$('#sort').addEventListener('change', () => { saveUiPref(); render(); });
$('#show-done').addEventListener('change', render);

/* ---------- render ---------- */
function render() {
  if (currentView === 'companies') renderCompanies();
  else if (currentView === 'schedule') renderSchedule();
  else if (currentView === 'settings') $('#version').textContent = 'バージョン ' + APP_VERSION;
}

function renderCompanies() {
  const q = $('#search').value.trim().toLowerCase();
  const f = filterSel.value;
  const sort = $('#sort').value;

  // summary chips
  const counts = {};
  state.companies.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const activeCount = state.companies.filter(c => ACTIVE_STATUSES.has(c.status)).length;
  $('#summary').innerHTML =
    `<button data-f="active" class="${f === 'active' ? 'on' : ''}">選考中 ${activeCount}</button>` +
    `<button data-f="all" class="${f === 'all' ? 'on' : ''}">すべて ${state.companies.length}</button>` +
    STATUSES.filter(s => counts[s.id]).map(s =>
      `<button data-f="${s.id}" class="${f === s.id ? 'on' : ''}">${s.label} ${counts[s.id]}</button>`).join('');

  let list = state.companies.filter(c => {
    if (f === 'active' && !ACTIVE_STATUSES.has(c.status)) return false;
    if (f !== 'active' && f !== 'all' && c.status !== f) return false;
    if (q && !`${c.name} ${c.industry} ${c.memo}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const nextKey = c => { const e = nextEvent(c); return e ? e.date + (e.time || '99') : '9999'; };
  const sorters = {
    next: (a, b) => nextKey(a).localeCompare(nextKey(b)) || b.priority - a.priority,
    priority: (a, b) => b.priority - a.priority || nextKey(a).localeCompare(nextKey(b)),
    updated: (a, b) => b.updatedAt - a.updatedAt,
    name: (a, b) => a.name.localeCompare(b.name, 'ja'),
  };
  list.sort(sorters[sort]);

  $('#company-list').innerHTML = list.map(c => {
    const st = STATUS_MAP[c.status] || STATUSES[0];
    const ne = nextEvent(c);
    let nextHtml = '';
    if (ne) {
      const n = daysFromToday(ne.date);
      const cls = n === 0 ? 'today' : n <= 3 ? 'soon' : '';
      nextHtml = `<div class="card-next ${cls}">📌 ${esc(ne.title)}・${fmtDate(ne.date)}${ne.time ? ' ' + ne.time : ''}（${relLabel(ne.date)}）</div>`;
    }
    return `<li class="card" data-id="${c.id}">
      <div class="card-top">
        <span class="card-name">${esc(c.name)}</span>
        <span class="chip ${st.cls}">${st.label}</span>
      </div>
      <div class="card-sub">
        <span class="stars-view">${stars(c.priority)}</span>
        ${c.industry ? `<span>${esc(c.industry)}</span>` : ''}
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
  items.sort((a, b) => (a.ev.date + (a.ev.time || '99')).localeCompare(b.ev.date + (b.ev.time || '99')));

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

/* ---------- company dialog ---------- */
const cDialog = $('#company-dialog');
const cForm = $('#company-form');
let editing = null;  // working copy of company
let isNew = false;

function setPriority(v) {
  cForm.priority.value = v;
  $$('#priority-input button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) <= v));
}
$('#priority-input').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setPriority(Number(b.dataset.v));
});

function openCompany(id) {
  const src = id ? state.companies.find(c => c.id === id) : null;
  isNew = !src;
  editing = src ? structuredClone(src) : {
    id: uid(), name: '', industry: '', status: 'interest', priority: 2,
    url: '', loginId: '', memo: '', events: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  $('#company-dialog-title').textContent = isNew ? '企業を追加' : '企業の詳細';
  cForm.name.value = editing.name;
  cForm.industry.value = editing.industry;
  cForm.status.value = editing.status;
  cForm.url.value = editing.url;
  cForm.loginId.value = editing.loginId;
  cForm.memo.value = editing.memo;
  setPriority(editing.priority);
  updateOpenUrl();
  $('#delete-company').hidden = isNew;

  const industries = [...new Set(state.companies.map(c => c.industry).filter(Boolean))];
  $('#industry-list').innerHTML = industries.map(i => `<option value="${esc(i)}">`).join('');

  renderEvents();
  cDialog.showModal();
  cDialog.querySelector('.dialog-body').scrollTop = 0;
  if (isNew) setTimeout(() => cForm.name.focus(), 50);
}

function renderEvents() {
  const evs = [...editing.events].sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
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

function readCompanyForm() {
  editing.name = cForm.name.value.trim();
  editing.industry = cForm.industry.value.trim();
  editing.status = cForm.status.value;
  editing.priority = Number(cForm.priority.value) || 2;
  editing.url = cForm.url.value.trim();
  editing.loginId = cForm.loginId.value.trim();
  editing.memo = cForm.memo.value;
}

cForm.addEventListener('submit', e => {
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

function updateOpenUrl() {
  const v = cForm.url.value.trim();
  const a = $('#open-url');
  a.hidden = !/^https?:\/\//i.test(v);
  a.href = a.hidden ? '#' : v;
}
cForm.url.addEventListener('input', updateOpenUrl);

$('#delete-company').addEventListener('click', () => {
  if (!confirm(`「${editing.name}」を削除しますか？\n登録した予定も削除されます。`)) return;
  state.companies = state.companies.filter(c => c.id !== editing.id);
  save();
  cDialog.close();
  toast('削除しました');
  render();
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
    title: eForm.title.value.trim(),
    date: eForm.date.value,
    time: eForm.time.value,
    place: eForm.place.value.trim(),
    done: eForm.done.checked,
  };
  if (!data.title || !data.date) return;
  if (editingEventId) {
    Object.assign(editing.events.find(x => x.id === editingEventId), data);
  } else {
    editing.events.push({ id: uid(), ...data });
  }
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

/* ---------- FAB ---------- */
$('#fab').addEventListener('click', () => openCompany(null));

/* ---------- settings ---------- */
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'syukatsu', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
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
    const companies = data.companies
      .filter(c => c && typeof c.name === 'string')
      .map(c => ({
        id: String(c.id || uid()),
        name: c.name,
        industry: String(c.industry || ''),
        status: STATUS_MAP[c.status] ? c.status : 'interest',
        priority: [1, 2, 3].includes(Number(c.priority)) ? Number(c.priority) : 2,
        url: String(c.url || ''),
        loginId: String(c.loginId || ''),
        memo: String(c.memo || ''),
        events: (Array.isArray(c.events) ? c.events : [])
          .filter(ev => ev && ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date))
          .map(ev => ({ id: String(ev.id || uid()), title: String(ev.title), date: ev.date, time: String(ev.time || ''), place: String(ev.place || ''), done: Boolean(ev.done) })),
        createdAt: Number(c.createdAt) || Date.now(),
        updatedAt: Number(c.updatedAt) || Date.now(),
      }));
    if (!confirm(`${companies.length} 社のデータを読み込みます。\n現在のデータ（${state.companies.length} 社）は置き換えられます。よろしいですか？`)) return;
    state = { companies };
    save();
    toast('読み込みました');
    render();
  } catch (err) {
    alert('読み込みに失敗しました: ' + err.message);
  }
});

$('#clear-btn').addEventListener('click', () => {
  if (!confirm('すべてのデータを削除します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に削除しますか？（事前にバックアップの書き出しをおすすめします）')) return;
  state = { companies: [] };
  save();
  toast('削除しました');
  render();
});

/* ---------- init ---------- */
render();

// 日付が変わったときなどに「あと◯日」を更新
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

// 永続ストレージをリクエスト（ブラウザによる自動削除を防ぐ）
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
