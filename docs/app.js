// かぞくToDo 画面
'use strict';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const $view = document.getElementById('view');
const LS = 'kazoku.cfg';

// ---------- 設定（招待リンクの ?api=&k= を保存） ----------
let cfg = {};
try { cfg = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { cfg = {}; }
(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('api') && p.get('k')) {
    cfg.api = p.get('api').replace(/\/+$/, '');
    cfg.key = p.get('k');
    saveCfg();
    p.delete('api'); p.delete('k'); p.delete('openExternalBrowser');
    history.replaceState(null, '', location.pathname + location.hash);
  }
})();
function saveCfg() {
  try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) { /* 何もしない */ }
  idbSet('cfg', cfg);
}

// Service Worker から読めるように IndexedDB にも置く
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('kazoku', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) { /* 何もしない */ }
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(cfg.api + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Family-Key': cfg.key },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー ${res.status}`);
  return data;
}

// ---------- 小物 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const dowOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const fmtDate = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}月${d}日（${DOW[dowOf(ymd)]}）`; };
const schedText = (s) => s.type === 'once'
  ? `${fmtDate(s.date)} ${s.time}`
  : `毎週 ${[...s.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW[d]).join('・')} ${s.time}`;

// ---------- 状態 ----------
let state = null;          // /api/state の結果
let viewDate = null;       // 表示中の日付
const memberById = (id) => state?.members.find((m) => m.id === id) || { id, name: id, emoji: '🙂' };
const me = () => cfg.me && memberById(cfg.me);

async function load(date) {
  state = await api('/api/state' + (date ? `?date=${date}` : ''));
  if (!viewDate) viewDate = state.today;
  return state;
}

// ---------- ルーター ----------
window.addEventListener('hashchange', route);
async function route() {
  const hash = location.hash.slice(1) || 'today';
  const [name, arg] = hash.split('/');
  document.getElementById('tabs').hidden = !(cfg.api && cfg.me);
  document.querySelectorAll('nav.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (name === 'edit' ? 'list' : name)));

  if (!cfg.api || !cfg.key) return renderNoConfig();
  try {
    if (!state) await load(viewDate);
  } catch (e) {
    $view.innerHTML = `<div class="empty"><div class="em">📡</div><p>つながりませんでした<br><small>${esc(e.message)}</small></p><button class="btn" onclick="location.reload()">もう一度</button></div>`;
    return;
  }
  if (!cfg.me) return renderWho();
  const b = document.getElementById('meBadge');
  b.hidden = false; b.textContent = `${me().emoji} ${me().name}`;

  if (name === 'list') return renderList();
  if (name === 'edit') return renderEdit(arg);
  if (name === 'settings') return renderSettings();
  return renderToday();
}

// ---------- 招待リンクなし ----------
function renderNoConfig() {
  $view.innerHTML = `<div class="empty"><div class="em">🔑</div>
    <p>家族から送られた<b>招待リンク</b>から開いてね</p></div>`;
}

// ---------- 自分は誰？ ----------
function renderWho(fromSettings) {
  $view.innerHTML = `<h2 class="sec">あなたはだれ？</h2>
    <div class="who-pick">${state.members.map((m) =>
      `<button data-id="${m.id}" class="${cfg.me === m.id ? 'on' : ''}"><span class="e">${esc(m.emoji)}</span>${esc(m.name)}</button>`).join('')}</div>
    <p class="hint" style="text-align:center;margin-top:14px">この端末に届く通知の宛先になります</p>
    ${IS_ANDROID && !IS_CHROME ? `<div class="banner" style="margin-top:16px"><span style="font-size:24px">⚠️</span><p>今はChrome以外のブラウザで開いてるよ。通知を使うにはChromeで開いてね</p>${openChromeBtn()}</div>` : ''}`;
  $view.querySelectorAll('.who-pick button').forEach((b) => b.onclick = async () => {
    const changed = cfg.me && cfg.me !== b.dataset.id;
    cfg.me = b.dataset.id; saveCfg();
    if (changed || fromSettings) await subscribePush(true).catch(() => {});
    location.hash = fromSettings ? '#settings' : '#today';
    route();
  });
}

// ---------- 通知の登録 ----------
async function swReg() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('sw.js');
}
// LINEなどアプリ内ブラウザでは通知が使えない
const IN_APP = /\bLine\/|FBAN|FBAV|Instagram|Sleipnir|; wv\)/i.test(navigator.userAgent);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const IS_CHROME = /Chrome\//.test(navigator.userAgent) && !/; wv\)|EdgA|SamsungBrowser|OPR|Sleipnir|Line\//i.test(navigator.userAgent);
function chromeUrl() {
  const q = `?api=${encodeURIComponent(cfg.api)}&k=${encodeURIComponent(cfg.key)}`;
  return `intent://${location.host}${location.pathname}${q}#Intent;scheme=https;package=com.android.chrome;end`;
}
const openChromeBtn = () => (IS_ANDROID && !IS_CHROME) ? `<a class="btn" href="${esc(chromeUrl())}" style="text-decoration:none;white-space:nowrap">Chromeで開く</a>` : '';
async function pushStatus() {
  if (IN_APP) return 'inapp';
  if (!('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function subscribePush(silent) {
  const reg = await swReg();
  if (!reg) throw new Error('この端末は通知に対応していません');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした（ブラウザの設定から許可してね）');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('/api/vapid');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  }
  await api('/api/subscribe', { body: { member_id: cfg.me, subscription: sub.toJSON() } });
  if (!silent) toast('通知をONにしたよ');
}

// ---------- きょう ----------
async function renderToday() {
  const d = state.date;
  const ps = await pushStatus().catch(() => 'off');
  const items = state.day;
  const isToday = d === state.today;
  let html = `<div class="daynav">
      <button class="iconbtn" data-go="-1" aria-label="前の日">◀</button>
      <div class="date">${fmtDate(d)}${isToday ? '<small>きょう</small>' : ''}</div>
      <span class="sp"></span>
      ${isToday ? '' : '<button class="iconbtn" data-go="0">きょう</button>'}
      <button class="iconbtn" data-go="1" aria-label="次の日">▶</button>
    </div>`;
  if (ps !== 'on') {
    html += `<div class="banner"><span style="font-size:24px">🔕</span><p>${ps === 'denied'
      ? 'この端末は通知がブロックされています。Chromeの「サイトの設定」から通知を許可してね'
      : ps === 'inapp' || ps === 'unsupported' ? 'このブラウザでは通知できないよ。Chromeで開き直してね'
      : 'この端末の通知がまだオフです'}</p>${ps === 'off' ? '<button class="btn" id="pushOn">ONにする</button>' : openChromeBtn()}</div>`;
  }
  if (!items.length) {
    html += `<div class="empty"><div class="em">🌿</div><p>この日の予定はないよ</p></div>`;
  } else {
    html += `<div class="grid">${items.map(cardHtml).join('')}</div>`;
  }
  $view.innerHTML = html;

  $view.querySelectorAll('[data-go]').forEach((b) => b.onclick = async () => {
    const n = Number(b.dataset.go);
    viewDate = n === 0 ? state.today : addDays(state.date, n);
    await load(viewDate); renderToday();
  });
  const po = document.getElementById('pushOn');
  if (po) po.onclick = () => subscribePush().then(renderToday).catch((e) => toast(e.message));
  bindCards();
}

function cardHtml(it, idx) {
  const t = it.task;
  const mine = t.assignees.includes(cfg.me);
  const allDone = it.targets.every((x) => x.done_at);
  const myTarget = t.mode === 'any' ? (mine ? it.targets[0] : null) : it.targets.find((x) => x.target === cfg.me);

  let chips;
  if (t.mode === 'any') {
    const x = it.targets[0];
    chips = x.done_at
      ? `<button class="chip done" data-toggle="${idx}|*">✅ ${esc(memberById(x.done_by).emoji)} ${esc(memberById(x.done_by).name)}が${esc(t.done_label)}</button>`
      : t.assignees.map((a) => `<span class="chip ${x.notify_count > 1 ? 'nag' : 'wait'}">${esc(memberById(a).emoji)} ${esc(memberById(a).name)}</span>`).join('')
        + (x.notify_count ? `<span class="chip nag">🔔×${x.notify_count}</span>` : '');
  } else {
    chips = it.targets.map((x) => {
      const m = memberById(x.target);
      const cls = x.done_at ? 'done' : x.notify_count > 1 ? 'nag' : 'wait';
      const mark = x.done_at ? '✅' : x.notify_count ? `🔔${x.notify_count}` : '⬜';
      return `<button class="chip ${cls}" data-toggle="${idx}|${x.target}">${mark} ${esc(m.emoji)} ${esc(m.name)}</button>`;
    }).join('');
  }

  let checks = '';
  if (t.checklist.length && myTarget && !it.skipped) {
    checks = `<ul class="checks">${t.checklist.map((c, i) => {
      const on = !!myTarget.checks[i] || !!myTarget.done_at;
      return `<li><label><input type="checkbox" data-check="${idx}|${i}" ${on ? 'checked' : ''}><span class="${on ? 'on' : ''}">${esc(c)}</span></label></li>`;
    }).join('')}</ul>`;
  }

  let act = '';
  if (it.skipped) {
    act = `<div class="act"><button class="btn ghost big" data-skip="${idx}">今日はなし → 戻す</button></div>`;
  } else if (myTarget) {
    act = myTarget.done_at
      ? `<div class="act"><button class="btn ghost big" data-done="${idx}|undo">取り消す</button></div>`
      : `<div class="act"><button class="btn big" data-done="${idx}">${esc(t.done_label)}！</button></div>`;
  }

  return `<div class="card ${mine ? 'mine' : ''} ${allDone ? 'alldone' : ''} ${it.skipped ? 'skipped' : ''}">
      <div class="row1"><span class="time">${esc(t.sched.time)}</span><h3>${esc(t.title)}</h3>
        <button class="more" data-menu="${idx}" aria-label="メニュー">⋯</button></div>
      ${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
      ${it.skipped ? '<div class="chips"><span class="chip wait">💤 今日はなし</span></div>' : `<div class="chips">${chips}</div>`}
      ${checks}${act}
    </div>`;
}

function bindCards() {
  const date = state.date;
  const busy = async (fn) => { try { await fn(); await load(viewDate); renderToday(); } catch (e) { toast(e.message); } };

  $view.querySelectorAll('[data-done]').forEach((b) => b.onclick = () => {
    const [idx, undo] = b.dataset.done.split('|');
    const it = state.day[idx];
    const target = it.task.mode === 'any' ? '*' : cfg.me;
    b.disabled = true;
    busy(async () => {
      await api('/api/done', { body: { task_id: it.task.id, date, target, by: cfg.me, undo: !!undo } });
      if (!undo) toast('えらい！✨');
    });
  });

  $view.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const [idx, target] = b.dataset.toggle.split('|');
    const it = state.day[idx];
    const x = it.targets.find((y) => y.target === target);
    const who = target === '*' ? '' : `${memberById(target).name}の分を`;
    const msg = x.done_at ? `${who}未完了に戻す？` : `${who}完了にする？`;
    if (!confirm(msg)) return;
    busy(() => api('/api/done', { body: { task_id: it.task.id, date, target, by: target === '*' ? cfg.me : target, undo: !!x.done_at } }));
  });

  $view.querySelectorAll('[data-check]').forEach((c) => c.onchange = async () => {
    const [idx, i] = c.dataset.check.split('|').map(Number);
    const it = state.day[idx];
    const tg = it.task.mode === 'any' ? it.targets[0] : it.targets.find((y) => y.target === cfg.me);
    const checks = it.task.checklist.map((_, k) => !!tg.checks[k]);
    checks[i] = c.checked;
    tg.checks = checks;
    c.nextElementSibling.classList.toggle('on', c.checked);
    try {
      await api('/api/check', { body: { task_id: it.task.id, date, target: tg.target, checks } });
      if (checks.every(Boolean)) toast('全部チェックできたら「' + it.task.done_label + '！」を押してね');
    } catch (e) { toast(e.message); }
  });

  $view.querySelectorAll('[data-skip]').forEach((b) => b.onclick = () => {
    const it = state.day[b.dataset.skip];
    busy(() => api('/api/skip', { body: { task_id: it.task.id, date, undo: true } }));
  });

  $view.querySelectorAll('[data-menu]').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const it = state.day[b.dataset.menu];
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `${it.skipped ? '' : '<button data-a="skip">💤 今日はなし（通知しない）</button>'}<button data-a="edit">✏️ 編集する</button>`;
    b.closest('.card').appendChild(menu);
    menu.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === 'edit') location.hash = '#edit/' + it.task.id;
      if (a === 'skip') busy(() => api('/api/skip', { body: { task_id: it.task.id, date } }));
      menu.remove();
    };
  });
}
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => m.remove()));

// ---------- ルーティーン一覧 ----------
function renderList() {
  const firstDay = (t) => Math.min(...t.sched.days.map((d) => (d + 6) % 7));
  const weekly = state.tasks.filter((t) => t.sched.type === 'weekly')
    .sort((a, b) => firstDay(a) - firstDay(b) || a.sched.time.localeCompare(b.sched.time));
  const once = state.tasks.filter((t) => t.sched.type === 'once').sort((a, b) => (a.sched.date + a.sched.time).localeCompare(b.sched.date + b.sched.time));
  const upcoming = once.filter((t) => t.sched.date >= state.today);
  const past = once.filter((t) => t.sched.date < state.today);
  const row = (t) => `<button class="item ${t.active ? '' : 'off'}" data-id="${t.id}">
      <div class="t"><b>${esc(t.title)}</b><span>${esc(schedText(t.sched))}${t.active ? '' : '（停止中）'}${t.snooze_min ? `・🔁${t.snooze_min}分×${t.max_renotify}` : ''}</span></div>
      <span class="who">${t.assignees.map((a) => esc(memberById(a).emoji)).join('')}</span></button>`;
  $view.innerHTML = `
    <h2 class="sec">毎週のルーティーン</h2>
    <div class="list">${weekly.map(row).join('') || '<p class="hint">まだないよ</p>'}</div>
    <h2 class="sec">日にち指定のToDo</h2>
    <div class="list">${upcoming.map(row).join('') || '<p class="hint">まだないよ</p>'}</div>
    ${past.length ? `<h2 class="sec">終わったToDo</h2><div class="list">${past.slice(-10).reverse().map(row).join('')}</div>` : ''}
    <button class="fab" aria-label="追加" onclick="location.hash='#edit/new'">＋</button>`;
  $view.querySelectorAll('.item').forEach((b) => b.onclick = () => { location.hash = '#edit/' + b.dataset.id; });
}

// ---------- 追加・編集 ----------
function renderEdit(id) {
  const base = state.tasks.find((t) => t.id === id);
  const t = base ? JSON.parse(JSON.stringify(base)) : {
    title: '', note: '', checklist: [], assignees: [cfg.me], mode: 'each',
    sched: { type: 'once', date: viewDate || state.today, time: '07:30', days: [dowOf(state.today)] },
    snooze_min: 10, max_renotify: 2, done_label: '完了', active: true,
  };
  if (!t.sched.days) t.sched.days = [dowOf(t.sched.date || state.today)];
  if (!t.sched.date) t.sched.date = state.today;

  const seg = (name, opts, cur, multi) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) =>
    `<button type="button" data-v="${v}" class="${(multi ? cur.includes(v) : cur === v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  $view.innerHTML = `<h2 class="sec">${base ? '編集' : '新しく追加'}</h2>
  <form class="edit" id="f">
    <div class="field"><label>タイトル</label><input type="text" name="title" value="${esc(t.title)}" placeholder="例：集金袋を出す" required maxlength="80"></div>
    <div class="field"><span class="lbl">いつ</span>${seg('type', [['weekly', '毎週'], ['once', '日にち指定']], t.sched.type)}</div>
    <div class="field" id="daysF"><span class="lbl">曜日</span>${seg('days', [1, 2, 3, 4, 5, 6, 0].map((d) => [d, DOW[d]]), t.sched.days, true)}</div>
    <div class="two">
      <div class="field" id="dateF"><label>日にち</label><input type="date" name="date" value="${esc(t.sched.date)}"></div>
      <div class="field"><label>通知する時刻</label><input type="time" name="time" value="${esc(t.sched.time)}" required></div>
    </div>
    <div class="field"><span class="lbl">だれに</span>${seg('assignees', state.members.map((m) => [m.id, `${m.emoji} ${m.name}`]), t.assignees, true)}</div>
    <div class="field" id="modeF"><span class="lbl">完了のしかた</span>${seg('mode', [['each', '全員それぞれ'], ['any', '誰か1人でOK']], t.mode)}
      <p class="hint">「誰か1人でOK」は、1人が押すとほかの人の通知が止まります（迎えなど）</p></div>
    <div class="two">
      <div class="field"><label>再通知の間隔（分）</label><input type="number" name="snooze_min" min="1" max="240" value="${t.snooze_min}"></div>
      <div class="field"><label>再通知の回数</label><input type="number" name="max_renotify" min="0" max="10" value="${t.max_renotify}"></div>
    </div>
    <p class="hint" id="nagHint" style="margin-top:-8px"></p>
    <div class="field"><label>ボタンの文字</label><input type="text" name="done_label" value="${esc(t.done_label)}" maxlength="10" placeholder="完了"></div>
    <div class="field"><label>メモ（通知にも出ます）</label><input type="text" name="note" value="${esc(t.note)}" maxlength="300"></div>
    <div class="field"><label>チェック項目（1行に1つ・なくてもOK）</label><textarea name="checklist" placeholder="上靴&#10;体操服">${esc(t.checklist.join('\n'))}</textarea></div>
    ${base ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${t.active ? 'checked' : ''} style="width:20px;height:20px"> 有効（オフにすると通知も一覧表示も止まる）</label>` : ''}
    <div class="formact">
      <button type="button" class="btn ghost" onclick="history.back()">もどる</button>
      <button type="submit" class="btn">保存</button>
    </div>
    ${base ? '<button type="button" class="btn danger" id="del">削除する</button>' : ''}
  </form>`;

  const f = document.getElementById('f');
  const sync = () => {
    document.getElementById('daysF').hidden = t.sched.type !== 'weekly';
    document.getElementById('dateF').hidden = t.sched.type !== 'once';
    document.getElementById('modeF').hidden = t.assignees.length < 2;
    const s = Number(f.snooze_min.value) || 0, n = Number(f.max_renotify.value) || 0;
    const [h, m] = (f.time.value || '00:00').split(':').map(Number);
    const times = [h * 60 + m];
    for (let i = 1; i <= n; i++) times.push(times[0] + s * i);
    document.getElementById('nagHint').textContent = '通知：' + times.map((x) => `${Math.floor(x / 60) % 24}:${String(x % 60).padStart(2, '0')}`).join(' → ') + (n ? '（押すまで）' : '');
  };
  f.querySelectorAll('[data-seg]').forEach((g) => g.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const name = g.dataset.seg;
    const v = name === 'days' ? Number(b.dataset.v) : b.dataset.v;
    if (name === 'days' || name === 'assignees') {
      const arr = name === 'days' ? t.sched.days : t.assignees;
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1); else arr.push(v);
      b.classList.toggle('on', i < 0);
    } else {
      if (name === 'type') t.sched.type = v; else t[name] = v;
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    }
    sync();
  });
  ['snooze_min', 'max_renotify', 'time'].forEach((n) => f[n].addEventListener('input', sync));
  sync();

  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!t.assignees.length) return toast('「だれに」を選んでね');
    if (t.sched.type === 'weekly' && !t.sched.days.length) return toast('曜日を選んでね');
    const sched = t.sched.type === 'weekly'
      ? { type: 'weekly', days: t.sched.days.slice().sort(), time: f.time.value }
      : { type: 'once', date: f.date.value, time: f.time.value };
    const task = {
      id: base?.id, title: f.title.value.trim(), note: f.note.value.trim(),
      checklist: f.checklist.value.split('\n').map((s) => s.trim()).filter(Boolean),
      assignees: t.assignees, mode: t.assignees.length < 2 ? 'each' : t.mode, sched,
      snooze_min: Number(f.snooze_min.value), max_renotify: Number(f.max_renotify.value),
      done_label: f.done_label.value.trim() || '完了', active: base ? f.active.checked : true,
    };
    try {
      await api('/api/tasks', { body: { task, by: cfg.me } });
      await load(viewDate); toast('保存したよ'); location.hash = '#list';
    } catch (err) { toast(err.message); }
  };
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`「${base.title}」を削除する？`)) return;
    await api('/api/tasks/' + base.id, { method: 'DELETE' });
    await load(viewDate); toast('削除したよ'); location.hash = '#list';
  };
}

// ---------- 設定 ----------
async function renderSettings() {
  const ps = await pushStatus().catch(() => 'off');
  const psText = { on: '✅ ON', off: '🔕 OFF', denied: '⛔ ブロック中（Chromeのサイト設定で許可してね）', unsupported: '❌ このブラウザでは使えないよ（Chromeで開いてね）', inapp: '❌ このブラウザでは使えないよ（Chromeで開いてね）' }[ps];
  const invite = `${location.origin}${location.pathname}?api=${encodeURIComponent(cfg.api)}&k=${encodeURIComponent(cfg.key)}&openExternalBrowser=1`;
  $view.innerHTML = `
    <div class="panel"><h3>この端末</h3>
      <p>使う人：<b>${esc(me().emoji)} ${esc(me().name)}</b> <button class="btn ghost" id="chgMe" style="padding:6px 10px;margin-left:6px">変更</button></p>
      <p>通知：${psText}</p>
      <div class="act">
        ${ps === 'off' ? '<button class="btn big" id="pushOn">通知をONにする</button>' : ''}
        ${ps === 'on' ? '<button class="btn ghost big" id="testPush">テスト通知を送る</button>' : ''}
        ${ps === 'inapp' || ps === 'unsupported' ? openChromeBtn() : ''}
      </div>
    </div>
    <div class="panel"><h3>📣 通知をポップアップで出すには</h3>
      <p>最初は通知欄に入るだけのことがあるよ。1回だけ設定してね。</p>
      <ol style="margin:6px 0 0;padding-left:20px;font-size:14px;line-height:1.7">
        <li>上の［テスト通知を送る］を押す</li>
        <li>届いた通知を<b>長押し</b> → <b>⚙（設定）</b></li>
        <li>「<b>ポップアップで表示</b>」をON（機種によっては重要度を「<b>緊急</b>」に）</li>
        <li>「音」「バイブ」もONにしておくと気付きやすい</li>
      </ol>
    </div>
    <div class="panel"><h3>家族の名前</h3>
      ${state.members.map((m) => `<div class="mrow" data-id="${m.id}"><input value="${esc(m.emoji)}" maxlength="4" aria-label="絵文字"><input value="${esc(m.name)}" maxlength="12" aria-label="名前"></div>`).join('')}
      <button class="btn" id="saveMembers">名前を保存</button>
    </div>
    <div class="panel"><h3>家族を招待</h3>
      <p>このリンクを家族のスマホに送って、<b>Chromeで開いて</b>もらってね。開いたら「自分」を選んで通知をONにするだけ。</p>
      <code class="url">${esc(invite)}</code>
      <div class="act"><button class="btn ghost big" id="copyInv">リンクをコピー</button></div>
      <p class="hint">⚠️ このリンクを知っている人は誰でも使えるので、家族以外には送らないでね。</p>
    </div>
    <div class="panel"><h3>ホーム画面に追加</h3>
      <p>Chromeの右上「⋮」→「ホーム画面に追加」（または「アプリをインストール」）で、アプリのように開けます。</p>
    </div>`;
  document.getElementById('chgMe').onclick = () => renderWho(true);
  const po = document.getElementById('pushOn');
  if (po) po.onclick = () => subscribePush().then(renderSettings).catch((e) => toast(e.message));
  const tp = document.getElementById('testPush');
  if (tp) tp.onclick = async () => {
    try { await subscribePush(true); const r = await api('/api/test-push', { body: { member_id: cfg.me } }); toast(r.sent ? '送ったよ。数秒で届くはず' : '送れなかった…通知をONにし直してね'); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('saveMembers').onclick = async () => {
    const members = [...document.querySelectorAll('.mrow')].map((r) => {
      const [e, n] = r.querySelectorAll('input');
      return { id: r.dataset.id, emoji: e.value.trim() || '🙂', name: n.value.trim() || r.dataset.id };
    });
    try { await api('/api/members', { body: { members } }); await load(viewDate); toast('保存したよ'); renderSettings(); route(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('copyInv').onclick = async () => {
    try { await navigator.clipboard.writeText(invite); toast('コピーしたよ'); } catch (e) { toast('コピーできなかった…長押しで選択してね'); }
  };
}

// ---------- 起動 ----------
swReg().catch(() => {});
// 「自分は誰か」などの保存内容を、容量不足のときに消されないよう保護を頼む
try { navigator.storage?.persist?.(); } catch (e) { /* 何もしない */ }
if (cfg.api) idbSet('cfg', cfg);
// 画面に戻ってきたら最新にする（通知から完了したときなど）
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && cfg.api && cfg.me) {
    try { await load(viewDate); if ((location.hash || '#today').startsWith('#today')) renderToday(); } catch (e) { /* 何もしない */ }
  }
});
navigator.serviceWorker?.addEventListener('message', async (e) => {
  if (e.data === 'refresh' && cfg.api) { await load(viewDate); route(); }
});
route();
