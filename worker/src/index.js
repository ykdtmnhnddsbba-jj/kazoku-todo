// 家族ToDo通知：API + 毎分の通知チェック（Cloudflare Workers）
import { sendPush } from './webpush.js';
import { jstParts, isDueOn, targetsOf, planNotifications, recipientsOf, hmToMin } from './schedule.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Family-Key',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

const parseTask = (r) => ({
  ...r,
  checklist: JSON.parse(r.checklist || '[]'),
  assignees: JSON.parse(r.assignees || '[]'),
  sched: JSON.parse(r.sched || '{}'),
  active: !!r.active,
});

const vapidOf = (env) => ({
  publicKey: env.VAPID_PUBLIC,
  privateKey: env.VAPID_PRIVATE,
  subject: env.VAPID_SUBJECT || 'https://github.com/',
});

async function loadTasks(db, activeOnly = false) {
  const { results } = await db.prepare(`SELECT * FROM tasks ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).all();
  return results.map(parseTask);
}

// 既存のDBに後から足した列を自動で追加する（手作業のマイグレーション不要）
let schemaChecked = false;
async function ensureSchema(db) {
  if (schemaChecked) return;
  try { await db.prepare('SELECT avatar FROM members LIMIT 1').all(); }
  catch (e) { await db.prepare('ALTER TABLE members ADD COLUMN avatar TEXT').run(); }
  schemaChecked = true;
}

async function loadMembers(db) {
  const { results } = await db.prepare('SELECT * FROM members ORDER BY sort, id').all();
  return results;
}

// ---- 通知の送信 ----
async function pushToMember(env, memberId, payload) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM subs WHERE member_id = ?').bind(memberId).all();
  let sent = 0;
  for (const sub of subs) {
    try {
      const r = await sendPush(sub, { ...payload, member: memberId }, vapidOf(env));
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(sub.endpoint).run();
      } else if (r.ok) sent++;
      else console.log('push failed', r.status, r.text);
    } catch (e) {
      console.log('push error', String(e));
    }
  }
  return sent;
}

function reminderPayload(task, date, target, kind) {
  const prefix = kind === 'first' ? '' : '（再）';
  const body = [task.note, task.checklist.length ? task.checklist.join('・') : ''].filter(Boolean).join('\n');
  return {
    title: `${prefix}${task.title}`,
    body: body || `${task.sched.time} の予定`,
    tag: `${task.id}|${date}|${target}`,
    renotify: true,
    requireInteraction: true,
    data: { task_id: task.id, date, target },
    actions: [
      // ボタンは1つだけ（Androidは最大3つで、Chromeの「登録解除」「常に許可」の場所を空けるため）
      { action: 'done', title: task.done_label || '完了' },
    ],
  };
}

async function runCron(env, nowMs = Date.now()) {
  const db = env.DB;
  const { ymd } = jstParts(new Date(nowMs));
  const tasks = (await loadTasks(db, true)).filter((t) => isDueOn(t, ymd));
  if (!tasks.length) return { sent: 0 };

  const { results: occs } = await db.prepare('SELECT * FROM occ WHERE date = ?').bind(ymd).all();
  const occMap = new Map(occs.map((o) => [`${o.task_id}|${o.date}|${o.target}`, o]));
  const { results: skips } = await db.prepare('SELECT * FROM skips WHERE date = ?').bind(ymd).all();
  const skipSet = new Set(skips.map((s) => `${s.task_id}|${s.date}`));

  const plan = planNotifications(tasks, occMap, skipSet, nowMs);
  let sent = 0;
  for (const p of plan) {
    // 先に回数を記録（完了済みなら更新されない＝送らない）
    const upd = await db.prepare(
      `INSERT INTO occ (task_id, date, target, notify_count, last_notified) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(task_id, date, target) DO UPDATE SET
         notify_count = notify_count + 1, last_notified = ?4, snooze_until = NULL
       WHERE done_at IS NULL`
    ).bind(p.task.id, p.date, p.target, nowMs).run();
    if (!upd.meta.changes) continue;
    const payload = reminderPayload(p.task, p.date, p.target, p.kind);
    for (const m of recipientsOf(p.task, p.target)) sent += await pushToMember(env, m, payload);
  }
  return { sent, planned: plan.length };
}

// ---- 画面用：ある日の一覧 ----
// ymd に 'someday' を渡すと「いつか」ToDo の一覧（完了状態は date='someday' に記録）
async function dayView(env, ymd) {
  const db = env.DB;
  const tasks = (await loadTasks(db, true)).filter((t) => (ymd === 'someday' ? t.sched.type === 'someday' : isDueOn(t, ymd)));
  const { results: occs } = await db.prepare('SELECT * FROM occ WHERE date = ?').bind(ymd).all();
  const { results: skips } = await db.prepare('SELECT * FROM skips WHERE date = ?').bind(ymd).all();
  const skipSet = new Set(skips.map((s) => s.task_id));
  const occMap = new Map(occs.map((o) => [`${o.task_id}|${o.target}`, o]));
  return tasks
    .sort((a, b) => hmToMin(a.sched.time) - hmToMin(b.sched.time) || (b.updated_at || 0) - (a.updated_at || 0))
    .map((t) => ({
      task: t,
      skipped: skipSet.has(t.id),
      targets: targetsOf(t).map((target) => {
        const o = occMap.get(`${t.id}|${target}`);
        return {
          target,
          done_at: o?.done_at || null,
          done_by: o?.done_by || null,
          notify_count: o?.notify_count || 0,
          checks: o ? JSON.parse(o.checks || '[]') : [],
        };
      }),
    }));
}

// ---- 完了・スヌーズなど ----
async function markDone(env, { task_id, date, target, by, undo }) {
  const db = env.DB;
  const now = Date.now();
  if (undo) {
    await db.prepare('UPDATE occ SET done_at = NULL, done_by = NULL WHERE task_id = ? AND date = ? AND target = ?')
      .bind(task_id, date, target).run();
    return;
  }
  // 時間前に済ませた場合も記録する（その日は通知されなくなる）
  await db.prepare(
    `INSERT INTO occ (task_id, date, target, done_at, done_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(task_id, date, target) DO UPDATE SET done_at = ?4, done_by = ?5, snooze_until = NULL`
  ).bind(task_id, date, target, now, by).run();

  // 「誰か1人でOK」のときは、ほかの担当者の通知を「◯◯が対応」に置き換える
  const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
  if (!row) return;
  const task = parseTask(row);
  if (task.mode === 'any') {
    const occ = await db.prepare('SELECT notify_count FROM occ WHERE task_id = ? AND date = ? AND target = ?').bind(task_id, date, target).first();
    if (occ && occ.notify_count > 0) {
      const member = await db.prepare('SELECT name FROM members WHERE id = ?').bind(by).first();
      for (const m of task.assignees.filter((a) => a !== by)) {
        await pushToMember(env, m, {
          title: `${member?.name || '誰か'}が「${task.done_label}」`,
          body: task.title,
          tag: `${task_id}|${date}|${target}`,
          silent: true,
          data: { task_id, date, target, info: true },
          actions: [],
        });
      }
    }
  }
}

async function handleApi(req, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  await ensureSchema(db);

  if (path === '/api/state' && req.method === 'GET') {
    const date = url.searchParams.get('date') || jstParts().ymd;
    return json({
      today: jstParts().ymd,
      date,
      members: await loadMembers(db),
      tasks: await loadTasks(db),
      day: await dayView(env, date),
      someday: await dayView(env, 'someday'),
    });
  }

  if (path === '/api/subscribe' && req.method === 'POST') {
    const { member_id, subscription } = body;
    if (!member_id || !subscription?.endpoint) return json({ error: 'bad request' }, 400);
    await db.prepare(
      `INSERT INTO subs (endpoint, member_id, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET member_id = ?2, p256dh = ?3, auth = ?4`
    ).bind(subscription.endpoint, member_id, subscription.keys.p256dh, subscription.keys.auth, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/unsubscribe' && req.method === 'POST') {
    await db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(body.endpoint || '').run();
    return json({ ok: true });
  }

  if (path === '/api/test-push' && req.method === 'POST') {
    const sent = await pushToMember(env, body.member_id, {
      title: 'HOME MISSION テスト', body: 'この端末で通知を受け取れます', tag: 'test', data: { info: true }, actions: [],
    });
    return json({ ok: true, sent });
  }

  if (path === '/api/tasks' && req.method === 'POST') {
    const t = body.task || {};
    if (!t.title) return json({ error: 'タイトルを入れてね' }, 400);
    if (t.sched?.type !== 'someday' && !t.sched?.time) return json({ error: '時刻を入れてね' }, 400);
    const id = t.id || crypto.randomUUID().slice(0, 8);
    await db.prepare(
      `INSERT INTO tasks (id, title, note, checklist, assignees, mode, sched, snooze_min, max_renotify, done_label, active, created_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(id) DO UPDATE SET title = ?2, note = ?3, checklist = ?4, assignees = ?5, mode = ?6, sched = ?7,
         snooze_min = ?8, max_renotify = ?9, done_label = ?10, active = ?11, updated_at = ?13`
    ).bind(
      id, String(t.title).slice(0, 80), String(t.note || '').slice(0, 300),
      JSON.stringify((t.checklist || []).filter(Boolean).slice(0, 20)),
      JSON.stringify(t.assignees || []), t.mode === 'any' ? 'any' : 'each', JSON.stringify(t.sched),
      Math.max(1, Math.min(240, Number(t.snooze_min) || 10)),
      Number.isFinite(Number(t.max_renotify)) ? Math.max(0, Math.min(10, Number(t.max_renotify))) : 2,
      String(t.done_label || '完了').slice(0, 10), t.active === false ? 0 : 1, body.by || null, Date.now()
    ).run();
    return json({ ok: true, id });
  }

  const delMatch = path.match(/^\/api\/tasks\/([\w-]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = delMatch[1];
    await db.batch([
      db.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
      db.prepare('DELETE FROM occ WHERE task_id = ?').bind(id),
      db.prepare('DELETE FROM skips WHERE task_id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/done' && req.method === 'POST') {
    await markDone(env, body);
    return json({ ok: true });
  }

  if (path === '/api/snooze' && req.method === 'POST') {
    const { task_id, date, target } = body;
    const row = await db.prepare('SELECT snooze_min FROM tasks WHERE id = ?').bind(task_id).first();
    const until = Date.now() + (row?.snooze_min || 10) * 60000;
    await db.prepare(
      `INSERT INTO occ (task_id, date, target, notify_count, snooze_until) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(task_id, date, target) DO UPDATE SET snooze_until = ?4`
    ).bind(task_id, date, target, until).run();
    return json({ ok: true, until });
  }

  if (path === '/api/check' && req.method === 'POST') {
    const { task_id, date, target, checks } = body;
    await db.prepare(
      `INSERT INTO occ (task_id, date, target, checks) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(task_id, date, target) DO UPDATE SET checks = ?4`
    ).bind(task_id, date, target, JSON.stringify(checks || [])).run();
    return json({ ok: true });
  }

  if (path === '/api/skip' && req.method === 'POST') {
    const { task_id, date, undo } = body;
    if (undo) await db.prepare('DELETE FROM skips WHERE task_id = ? AND date = ?').bind(task_id, date).run();
    else await db.prepare('INSERT OR IGNORE INTO skips (task_id, date) VALUES (?, ?)').bind(task_id, date).run();
    return json({ ok: true });
  }

  if (path === '/api/avatar' && req.method === 'POST') {
    const { member_id, data } = body;
    if (data && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 80000)) {
      return json({ error: '画像が大きすぎるか、形式が違うよ' }, 400);
    }
    await db.prepare('UPDATE members SET avatar = ? WHERE id = ?').bind(data || null, member_id).run();
    return json({ ok: true });
  }

  if (path === '/api/members' && req.method === 'POST') {
    const stmts = (body.members || []).map((m) =>
      db.prepare('UPDATE members SET name = ?, emoji = ? WHERE id = ?').bind(String(m.name).slice(0, 12), String(m.emoji || '🙂').slice(0, 4), m.id)
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/api/vapid') return json({ publicKey: env.VAPID_PUBLIC });
    if (url.pathname === '/') return json({ ok: true, app: 'kazoku-todo' });
    if (!env.FAMILY_KEY || req.headers.get('X-Family-Key') !== env.FAMILY_KEY) return json({ error: 'unauthorized' }, 401);
    try {
      return await handleApi(req, env, url);
    } catch (e) {
      console.log('api error', String(e?.stack || e));
      return json({ error: String(e?.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.scheduledTime).then((r) => console.log('cron', JSON.stringify(r))));
  },
};

export { runCron, dayView, markDone };
