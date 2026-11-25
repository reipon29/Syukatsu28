/**
 * 就活管理 PWA — Gmail 同期スクリプト（Google Apps Script）
 *
 * 自分の Gmail から採用関係のメールを「読み取り専用」で読み、企業ごとに
 *   ・企業名 / マイページの URL・ID
 *   ・選考の進み具合（ES → 適性検査 → 面接 → 結果）
 *   ・面接日・予約したイベント・受検期限などの予定
 *   ・何をしたかの記録（予約した、自分から返信した、インターン合否 など）
 * をまとめ、就活管理アプリの「Gmailから同期」で取り込める形で返します。
 *
 * データはこの Google アカウントのスクリプト内（スクリプト プロパティ）にだけ保存され、
 * 外部のサーバーには送りません。アプリからの取得には秘密のトークンが必要です。
 *
 * 設置方法はアプリの「その他 → Gmailから自動で取り込む」か README を見てください。
 */

/* ===================== 設定 ===================== */
const LOOKBACK_DAYS = 240;            // 最初に何日前までさかのぼるか
const WINDOW_SEC = 7 * 86400;         // 1回の検索で読む期間
const RUN_LIMIT_MS = 4.5 * 60 * 1000; // 1回の実行で使う最大時間（上限6分）
const WEB_LIMIT_MS = 15 * 1000;       // アプリから呼ばれたときに追加で読む時間

// 採用管理システムなど、企業の採用メールがよく使う送信元
const ATS_DOMAINS = ['snar.jp', 'axol.jp', 'e2r.jp', 'saiyo.jp', 'mypage-info.com', 'i-webs.jp', 'hrmos.co',
  'recruit-mg.com', 'disc.co.jp', 'saiyo-jinjibu.jp', 'kic-saiyo.com', 'empweb21.com', 'indeedemail.com'];
// 件名にこれが入っていれば、どこからのメールでも採用関係とみなす
const SUBJECT_WORDS = ['選考', '面接', '説明会', 'インターン', 'インターンシップ', '内定', '内々定', '適性検査',
  'エントリーシート', '新卒', '採用', 'マイページ', '28卒', '2028卒', '仕事体験', 'オープンカンパニー', 'オープン・カンパニー'];
// 多数の企業を紹介する就活サイト・大学などは除く（企業名を取り違えるため）
const EXCLUDE_FROM = ['mynavi.jp', 'rikunabi.com', 'rikunabi-mail.com', 'kimisuka.com', 'lognavi.com', 'offerbox.jp',
  'onecareer.jp', 'labbase.jp', 'career-tasu.jp', 'gaishishukatsu.com', 'unistyle.jp', 'goodfind.jp', 'doda.jp',
  'en-japan.com', 'wantedly.com', 'acaric.jp', 'careerticket.jp', 'syukatsu-kaigi.jp', 'type.jp', 'bizreach.jp',
  'ac.jp', 'matcher.jp', 'digmee.jp', 'jobspring.jp', 'meetscompany.jp', 'irodas.com'];

function buildQuery_() {
  const from = ATS_DOMAINS.map(d => 'from:' + d).join(' OR ');
  const subj = 'subject:(' + SUBJECT_WORDS.join(' OR ') + ')';
  return `(${from} OR ${subj}) ` + EXCLUDE_FROM.map(d => '-from:' + d).join(' ');
}

/* ===================== 実行する関数 ===================== */

/** 最初に1回実行する：トークン作成・1時間ごとの自動実行の登録・最初の読み込み */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('token')) props.setProperty('token', Utilities.getUuid().replace(/-/g, ''));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncTrigger').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncTrigger').timeBased().everyHours(1).create();
  const r = sync_(RUN_LIMIT_MS);
  console.log(`読み込み: ${r.read}通 / 企業 ${r.companies}社 / ${r.done ? '最新まで読み終わりました' : '続きは1時間ごとに自動で読みます'}`);
  showAppUrl();
}

/** アプリに貼り付ける URL を表示する（ウェブアプリとしてデプロイした後に実行） */
function showAppUrl() {
  const token = PropertiesService.getScriptProperties().getProperty('token');
  const url = ScriptApp.getService().getUrl();
  if (!url) { console.log('まだデプロイされていません。「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」でデプロイしてから、もう一度 showAppUrl を実行してください。'); return; }
  console.log('▼ この URL をアプリの「Gmailから自動で取り込む」に貼り付けてください（人に教えないでください）\n' + url + '?token=' + token);
}

/** 1時間ごとに自動で呼ばれる */
function syncTrigger() { sync_(RUN_LIMIT_MS); }

/** 最初から読み直したいときに実行（トークンはそのまま） */
function resetSync() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('token');
  props.deleteAllProperties();
  if (token) props.setProperty('token', token);
  console.log('リセットしました。setup をもう一度実行してください。');
}

/** アプリからの取得 */
function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('token');
  if (!token || !e || !e.parameter || e.parameter.token !== token) return json_({ error: 'unauthorized' });
  let r = null;
  try { r = sync_(WEB_LIMIT_MS); } catch (err) { console.warn(err); }
  const store = loadStore_();
  return json_(exportForApp_(store, r));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================== 読み込み ===================== */

function sync_(limitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return { read: 0, companies: 0, done: false, busy: true };
  const started = Date.now();
  try {
    const store = loadStore_();
    const ctx = { store, me: (Session.getActiveUser().getEmail() || '').toLowerCase(), read: 0 };
    const now = Math.floor(Date.now() / 1000);
    if (!store.meta.cursor) store.meta.cursor = now - LOOKBACK_DAYS * 86400;
    const query = buildQuery_();
    while (store.meta.cursor < now && Date.now() - started < limitMs) {
      const a = store.meta.cursor;
      const b = Math.min(a + WINDOW_SEC, now);
      for (let start = 0; ; start += 100) {
        const threads = GmailApp.search(`${query} after:${a} before:${b}`, start, 100);
        threads.forEach(t => processThread_(t.getMessages().map(wrapMessage_), ctx, a * 1000, b * 1000, t.getId()));
        if (threads.length < 100) break;
      }
      store.meta.cursor = b;
      store.meta.syncedAt = Date.now();
      saveStore_(store);
    }
    return { read: ctx.read, companies: Object.keys(store.companies).length, done: store.meta.cursor >= now - 60 };
  } finally {
    lock.releaseLock();
  }
}

function wrapMessage_(m) {
  let body = null;
  return {
    id: m.getId(), at: m.getDate().getTime(), from: m.getFrom(), subject: m.getSubject() || '',
    body: () => { if (body === null) body = String(m.getPlainBody() || '').slice(0, 10000); return body; },
  };
}

/* ===================== 保存 ===================== */
// スクリプト プロパティ（1件9KBまで）に 企業ごと（c:キー）・送信元ごと（s:アドレス）に分けて保存する

function loadStore_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const store = { meta: {}, companies: {}, senders: {}, dirty: new Set() };
  for (const [k, v] of Object.entries(all)) {
    try {
      if (k === 'meta') store.meta = JSON.parse(v);
      else if (k.startsWith('c:')) store.companies[k.slice(2)] = JSON.parse(v);
      else if (k.startsWith('s:')) store.senders[k.slice(2)] = v;
    } catch (e) { /* 壊れたデータは無視 */ }
  }
  return store;
}
function saveStore_(store) {
  const out = { meta: JSON.stringify(store.meta) };
  store.dirty.forEach(k => {
    if (k.startsWith('c:')) out[k] = JSON.stringify(trimCompany_(store.companies[k.slice(2)]));
    else if (k.startsWith('s:')) out[k] = store.senders[k.slice(2)];
  });
  PropertiesService.getScriptProperties().setProperties(out);
  store.dirty.clear();
}

/* ===================== 解析（Gmail に依存しない部分） ===================== */

const STATUS_ORDER = ['interest', 'entry', 'es', 'test', 'gd', 'int1', 'int2', 'intf', 'offer'];
const rank_ = s => STATUS_ORDER.indexOf(s);
const norm_ = s => String(s || '').normalize('NFKC');
const nameKey_ = s => norm_(s).replace(/株式会社|\(株\)|㈱|[\s]/g, '').toLowerCase();

const GENERIC_RE = /案内|重要|再送|締切|締め切|〆|リマインド|予約|受付|募集|開催|お知らせ|限定|特別|本日|明日|あと\d|\d+卒|\d+\/\d+|\d+月|\d+日|選考|説明会|インターン|internship|オンライン|イベント|セミナー|応募|要返信|連絡|お詫び|訂正|緊急|追加|直前|開始|迫る|必見|入館|external|^es$|完了|アンケート|更新|確認|参加|面接|結果|マイページ|エントリー|受検|検査|ワークショップ|仕事体験|公開|特典|満席|残り|延長|※|!|^new$|info|配信|ニュース|メルマガ|就活|内定|ありがとう|noreply|no-reply|@|^\d+$/i;
const CORP_RE = /株式会社|\(株\)|グループ|ホールディングス|holdings/i;

/** 送信者名・括弧内の名前から「人事部」「新卒採用担当」などを取り除く */
function cleanName_(s) {
  s = norm_(s).replace(/["']/g, '').replace(/<[^>]*>/g, '').trim();
  s = s.replace(/[\s]*(?:総務局|人事|採用|新卒|インターン|事務局|担当|リクルート|recruit|キャリア|運営|お問い?合わせ|事務|チーム|team\b|hr\b).*$/i, '').trim();
  s = s.replace(/[\s/|・:]+$/, '').trim();
  return s;
}
function isGenericName_(s) {
  if (!s || s.length < 2 || s.length > 30) return true;
  if (CORP_RE.test(s) && !/案内|お知らせ|選考|説明会|インターン/.test(s)) return false;
  return GENERIC_RE.test(s);
}
/** 件名の【】［］＜＞ から企業名を探す（「【重要】【KDDIエンジニアリング】」なら後ろ側） */
function nameFromSubject_(subject) {
  const s = norm_(subject);
  const re = /【([^】]{1,40})】|\[([^\]]{1,40})\]|＜([^＞]{1,40})＞|<([^>]{1,40})>|〈([^〉]{1,40})〉/g;
  let m;
  while ((m = re.exec(s))) {
    const raw = m.slice(1).find(Boolean);
    const nm = cleanName_(raw);
    if (!isGenericName_(nm)) return nm;
  }
  // 末尾の（〇〇株式会社）
  const tail = s.match(/\(([^()]{2,30}(?:株式会社|\(株\))[^()]{0,10}|(?:株式会社)[^()]{2,25})\)\s*$/);
  if (tail) return cleanName_(tail[1]);
  return '';
}
function parseFrom_(from) {
  const f = String(from || '');
  const addr = ((f.match(/<([^>]+)>/) || [, f])[1] || '').trim().toLowerCase();
  const disp = f.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  return { addr, disp: disp === addr ? '' : disp };
}

/** メール1通の内容から、何が起きたかを読み取る */
function classify_(subject, body) {
  const s = norm_(subject);
  const b = norm_(body).slice(0, 4000);
  const both = s + '\n' + b;
  const intern = /インターン|internship|仕事体験|ワークショップ|オープン・?カンパニー|1day|ジョブ/i.test(s);
  const promo = /対策|講座|攻略|練習|模擬|特集|座談会|受付中|受付開始|締切迫|締め切り迫|まもなく|あと\d|募集|特典|直結|目指せる|早期内定|年内内定|内定者|内定直結|スカウト|追加日程|日程追加|予約開始|応募開始|エントリー開始/.test(s);
  const res = [];
  // 不合格
  if (/ご希望に添いかね|ご希望に沿いかね|見送らせ|ご期待に添え|ご期待に沿え|ご縁がなかった|お見送り|残念ながら/.test(b) && /結果|選考|応募|書類/.test(both) && !promo) {
    res.push(intern ? { note: 'インターン選考：不合格' } : { status: 'rejected', note: '選考結果：お見送り' });
    return res;
  }
  // 内定
  if (/内々?定(?:の)?(?:ご連絡|ご通知|通知|のお知らせ|について)/.test(s) && !promo && !intern) {
    res.push({ status: 'offer', note: '内定の連絡' });
    return res;
  }
  // 通過・合格
  if (/合格|通過|お進みいただ|次の選考|次回選考のご案内|として決定|参加が決定|受け入れが決定/.test(both) && /結果|選考|書類/.test(s) && !promo && !/不合格/.test(s)) {
    res.push({ note: intern ? 'インターン選考：通過' : '選考通過', engaged: true });
  }
  // 面接
  // 件名に段階がなければ（「面接日が近づいて」など）本文の最初の方から探す
  const iv = s.match(/(一次|1次|二次|2次|三次|3次|最終|役員)面接/) || (/面接/.test(s) ? b.slice(0, 600).match(/(一次|1次|二次|2次|三次|3次|最終|役員)面接/) : null);
  if (iv && !promo && /案内|日程|予約|受け付け|受付|確認|について|決定|近づ|実施/.test(s)) {
    const lv = /最終|役員|三次|3次/.test(iv[1]) ? 'intf' : /二次|2次/.test(iv[1]) ? 'int2' : 'int1';
    const label = iv[0].replace('1次', '一次').replace('2次', '二次').replace('3次', '三次');
    res.push(intern ? { note: `インターン選考：${label}`, engaged: true } : { status: lv, note: label + 'の案内', engaged: true });
    res.push({ event: { title: (intern ? 'インターン ' : '') + label, keyRe: /日時|日程|開催日|実施日|面接日/ } });
    return res;
  }
  // 適性検査・Webテスト
  if (/適性検査|適正検査|webテスト|spi|玉手箱|受検|受験のお願い/i.test(s) && !promo && /案内|お願い|お知らせ|リマインド|締め?切|期限/.test(s)) {
    res.push(intern ? { note: 'インターン選考：適性検査', engaged: true } : { status: 'test', note: '適性検査の案内', engaged: true });
    res.push({ event: { title: (intern ? 'インターン ' : '') + '適性検査の期限', keyRe: /期限|締め?切|まで/ } });
  }
  // ES 提出
  if (/(?:エントリーシート|ES|書類)[^\n]{0,15}(?:提出(?:が)?完了|受け付けました|受付完了|を受理)|ご提出(?:いただき)?ありがとう/.test(both) && !promo) {
    res.push(intern ? { note: 'インターンのESを提出', engaged: true } : { status: 'es', note: 'ESを提出', engaged: true });
  }
  // 予約・申込の確認
  if (/(?:予約|申込|申し込み|応募)(?:を)?(?:受け付けました|受付完了|完了|ありがとう)|ご予約(?:いただき)?ありがとう|ご予約確認|参加(?:日程)?(?:が)?確定|参加票|ご参加ありがとう|参加後アンケート/.test(s)) {
    const attended = /参加後|ご参加ありがとう/.test(s);
    res.push({ note: (attended ? '参加：' : '予約：') + shortSubject_(s), engaged: true });
    if (!attended) res.push({ event: { title: shortSubject_(s), keyRe: /日時|日程|開催日|実施日|開催日時/ } });
  }
  // エントリー・マイページ登録
  if (/エントリー(?:いただき)?ありがとう|ご?登録(?:いただき)?ありがとう|プレエントリー|マイページ(?:の)?(?:発行|登録完了|登録内容)/.test(s)) {
    res.push({ note: 'エントリー・マイページ登録', engaged: true });
  }
  // 個別の案内（あなた宛ての招待）
  if (/さん限定|様限定|特別招待|ご招待|本選考についてのご連絡|特別選考/.test(s) && !res.length) {
    res.push({ note: '個別の案内：' + shortSubject_(s) });
  }
  return res;
}
/** 返信を求めているメールか（送信専用アドレスやアンケート・宣伝は除く） */
function needsReply_(subject, body) {
  const s = norm_(subject);
  const b = norm_(body).slice(0, 2500);
  if (/アンケート|受付中|予約開始|募集|特典|セミナー|座談会/.test(s)) return false;
  if (/送信専用|配信専用|返信(?:され|いただい)ても|返信できません|ご返信いただいてもお答え/.test(b)) return false;
  return /要返信|ご返信(?:を)?(?:お願い|ください|いただけ)|返信(?:を)?(?:お願い|ください)|ご回答(?:を)?(?:お願い|ください)|候補日|ご都合の(?:良い|よい)|日程(?:の)?(?:再)?調整/.test(s + '\n' + b);
}
function shortSubject_(s) {
  return norm_(s).replace(/【[^】]*】|\[[^\]]*\]|＜[^＞]*＞|<[^>]*>|※[^※]*※/g, '').replace(/^(?:re|fw|fwd):\s*/i, '').trim().slice(0, 40) || norm_(s).slice(0, 40);
}

/** 本文から日時を探す（キーワードの近く → なければ最初の日時） */
function findDate_(body, keyRe, mailAt) {
  const b = norm_(body);
  const dateRe = /(?:(20\d{2})\s*[年/.-]\s*)?(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?\s*(?:\([^)]{1,4}\))?\s*(?:(am|pm|午前|午後)\s*)?(?:(\d{1,2})\s*(?::|時)\s*(\d{2})?\s*分?)?(?:\s*[~〜～\-ー－]\s*(\d{1,2})\s*(?::|時)\s*(\d{2})?)?/i;
  const lines = b.split('\n');
  let hit = null;
  for (let i = 0; i < lines.length && !hit; i++) {
    if (!keyRe.test(lines[i])) continue;
    const chunk = lines.slice(i, i + 3).join(' ');
    const m = chunk.slice(chunk.search(keyRe)).match(dateRe);
    if (m) hit = m;
  }
  if (!hit) return null;
  const mail = new Date(mailAt);
  const mo = Number(hit[2]), d = Number(hit[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let y = hit[1] ? Number(hit[1]) : mail.getFullYear();
  if (!hit[1] && mo < mail.getMonth() + 1 - 6) y++;
  let h = hit[5] != null ? Number(hit[5]) : null;
  if (h != null && /pm|午後/i.test(hit[4] || '') && h < 12) h += 12;
  const pad = n => String(n).padStart(2, '0');
  const time = h != null && h < 24 ? `${pad(h)}:${pad(Number(hit[6] || 0))}` : '';
  const endTime = time && hit[7] != null ? `${pad(Number(hit[7]))}:${pad(Number(hit[8] || 0))}` : '';
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time, endTime };
}

/** マイページの ID・URL を探す */
function findLogin_(body) {
  const b = norm_(body);
  const id = (b.match(/ID(?:番号)?\s*\]?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]{4,19})\b/) || [])[1] || '';
  const url = ((b.match(/マイページ[^\n]{0,30}(?:\n\s*)?[^\n]{0,15}?(https?:\/\/[^\s<>」)\]]+)/) || [])[1] || '').split('?')[0];
  return { id: /^(?:https?|number|password)$/i.test(id) ? '' : id, url };
}

/* ===================== 企業ごとにまとめる ===================== */

function processThread_(msgs, ctx, fromMs, toMs, threadId) {
  const store = ctx.store;
  // スレッドの企業（自分以外が送ったメールから判定）
  let key = null;
  for (const m of msgs) {
    if (isMine_(m, ctx)) continue;
    key = resolveCompany_(m, ctx);
    if (key) break;
  }
  if (!key) return;
  const c = store.companies[key];
  for (const m of msgs) {
    if (m.at < fromMs || m.at >= toMs) continue; // 別の期間で読む
    ctx.read++;
    applyMessage_(c, m, ctx);
  }
  // 返信が必要なメールに、まだ自分が返信していないか（スレッド全体で判定）
  if (threadId) {
    c.replies = c.replies || {};
    let ask = null;
    for (const m of msgs) {
      if (isMine_(m, ctx)) ask = null;
      else if (needsReply_(m.subject, m.body())) ask = m;
    }
    if (ask) c.replies[threadId] = { at: ask.at, subject: shortSubject_(ask.subject) };
    else delete c.replies[threadId];
  }
  store.dirty.add('c:' + key);
}
function isMine_(m, ctx) { return ctx.me && parseFrom_(m.from).addr === ctx.me; }

function resolveCompany_(m, ctx) {
  const store = ctx.store;
  const { addr, disp } = parseFrom_(m.from);
  let name = nameFromSubject_(m.subject);
  let key = name ? nameKey_(name) : store.senders[addr];
  if (!key) {
    name = cleanName_(disp);
    if (isGenericName_(name)) return null;
    key = nameKey_(name);
  }
  if (!key) return null;
  if (addr && !store.senders[addr]) { store.senders[addr] = key; store.dirty.add('s:' + addr); }
  if (!store.companies[key]) store.companies[key] = { key, names: {}, mailCount: 0, firstAt: m.at, lastAt: m.at, status: 'interest', statusAt: 0, engaged: false, ids: {}, urls: {}, notes: [], events: [] };
  const c = store.companies[key];
  if (name) c.names[name] = (c.names[name] || 0) + 1;
  return key;
}

function applyMessage_(c, m, ctx) {
  c.mailCount++;
  c.firstAt = Math.min(c.firstAt, m.at);
  c.lastAt = Math.max(c.lastAt, m.at);
  if (isMine_(m, ctx)) {
    c.engaged = true;
    addNote_(c, m, '自分から返信：' + shortSubject_(m.subject));
    return;
  }
  const body = m.body();
  const login = findLogin_(body);
  if (login.id) c.ids[login.id] = (c.ids[login.id] || 0) + 1;
  if (login.url) c.urls[login.url] = (c.urls[login.url] || 0) + 1;
  for (const r of classify_(m.subject, body)) {
    if (r.engaged) c.engaged = true;
    if (r.note) addNote_(c, m, r.note);
    if (r.status) setStatus_(c, r.status, m.at);
    if (r.event) {
      const d = findDate_(body, r.event.keyRe, m.at);
      if (d) addEvent_(c, { title: r.event.title, ...d });
    }
  }
}
function setStatus_(c, st, at) {
  if (st === 'rejected') { if (at >= c.statusAt) { c.status = 'rejected'; c.statusAt = at; } return; }
  if (c.status === 'rejected' && at > c.statusAt) { c.status = st; c.statusAt = at; return; }
  if (rank_(st) > rank_(c.status)) { c.status = st; c.statusAt = at; }
}
function addNote_(c, m, text) {
  if (c.notes.some(n => n.id === m.id && n.text === text)) return;
  c.notes.push({ id: m.id, at: m.at, text });
}
function addEvent_(c, ev) {
  const id = 'g' + hash_(`${c.key}|${ev.date}|${ev.title}`);
  if (!c.events.some(e => e.id === id)) c.events.push({ id, ...ev });
}
function hash_(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
/** 保存サイズを抑える（1件9KBまで） */
function trimCompany_(c) {
  const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
  c.names = top(c.names, 4);
  c.ids = top(c.ids, 4);
  c.urls = top(c.urls, 3);
  c.notes = c.notes.sort((a, b) => a.at - b.at).slice(-10);
  c.events = c.events.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-10);
  if (c.replies) c.replies = Object.fromEntries(Object.entries(c.replies).sort((a, b) => b[1].at - a[1].at).slice(0, 5));
  return c;
}

/* ===================== アプリ向けに出力 ===================== */

function exportForApp_(store, r) {
  const best = o => (Object.entries(o).sort((a, b) => b[1] - a[1])[0] || [''])[0];
  const fmt = t => Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy/MM/dd');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const companies = Object.values(store.companies).map(c => {
    const name = best(c.names) || c.key;
    const r = rank_(c.status);
    const priority = r >= rank_('es') || c.status === 'offer' ? 3 : (c.engaged || r >= rank_('entry')) ? 2 : 1;
    const memo = ['【Gmail同期】', `${fmt(c.firstAt)}〜${fmt(c.lastAt)} に ${c.mailCount}通`,
      ...c.notes.slice().sort((a, b) => a.at - b.at).map(n => `・${fmt(n.at).slice(5)} ${n.text}`)].join('\n');
    return {
      id: 'gm-' + hash_(c.key), name, status: c.status, statusAt: c.statusAt, priority, engaged: c.engaged,
      url: best(c.urls), loginId: best(c.ids), memo,
      events: c.events.map(e => ({ ...e, done: e.date < today })),
      mailCount: c.mailCount, lastAt: c.lastAt,
      replies: Object.entries(c.replies || {}).map(([thread, r]) => ({ thread, at: r.at, subject: r.subject, url: 'https://mail.google.com/mail/u/0/#all/' + thread })),
    };
  }).filter(c => c.name);
  return {
    app: 'syukatsu', source: 'gmail-sync', version: 1, exportedAt: new Date().toISOString(),
    syncedAt: store.meta.syncedAt || null, complete: store.meta.cursor >= Math.floor(Date.now() / 1000) - 3600 * 2,
    companies,
  };
}
