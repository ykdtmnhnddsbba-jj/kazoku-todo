// いつ・誰に通知するかを決める純粋な関数（テストしやすいようにDBに触らない）

const JST_OFFSET_MIN = 9 * 60;
// 予定時刻からこれ以上たっていたら、最初の通知は出さない（夜中に作った朝のToDoが即鳴るのを防ぐ）
export const FIRST_NOTIFY_WINDOW_MIN = 180;

export function jstParts(date = new Date()) {
  const t = new Date(date.getTime() + JST_OFFSET_MIN * 60000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return { ymd: `${y}-${m}-${d}`, dow: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function dowOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function hmToMin(hm) {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// その日にタスクがあるか
export function isDueOn(task, ymd) {
  if (!task.active) return false;
  const s = task.sched || {};
  if (s.type === 'once') return s.date === ymd;
  if (s.type === 'weekly') {
    if (s.from && ymd < s.from) return false;
    if (s.until && ymd > s.until) return false;
    return Array.isArray(s.days) && s.days.includes(dowOf(ymd));
  }
  return false;
}

// 通知の宛先単位。誰か1人でOKなら '*'、全員それぞれなら担当者ごと
export function targetsOf(task) {
  return task.mode === 'any' ? ['*'] : (task.assignees || []);
}

/**
 * 今この瞬間に送るべき通知を返す
 * @param tasks   タスク一覧（sched/assignees は配列やオブジェクトに展開済み）
 * @param occMap  `${task_id}|${date}|${target}` -> occ行
 * @param skipSet `${task_id}|${date}` の集合
 * @param nowMs   現在時刻(ms)
 */
export function planNotifications(tasks, occMap, skipSet, nowMs) {
  const now = jstParts(new Date(nowMs));
  const out = [];
  for (const task of tasks) {
    if (!isDueOn(task, now.ymd)) continue;
    if (skipSet.has(`${task.id}|${now.ymd}`)) continue;
    const at = hmToMin(task.sched.time);
    if (now.minutes < at) continue;
    for (const target of targetsOf(task)) {
      const occ = occMap.get(`${task.id}|${now.ymd}|${target}`);
      if (occ && occ.done_at) continue;
      const count = occ ? occ.notify_count : 0;
      if (occ && occ.snooze_until) {
        if (nowMs >= occ.snooze_until) out.push({ task, target, date: now.ymd, kind: 'snooze' });
        continue;
      }
      if (count === 0) {
        if (now.minutes - at <= FIRST_NOTIFY_WINDOW_MIN) out.push({ task, target, date: now.ymd, kind: 'first' });
        continue;
      }
      const renotifyDone = count - 1; // 1回目は最初の通知
      if (renotifyDone >= (task.max_renotify ?? 0)) continue;
      const interval = Math.max(1, task.snooze_min || 10) * 60000;
      // Cronの実行が数秒遅れても1分ずれないよう30秒の余裕を見る
      const last = occ.last_notified || 0;
      if (nowMs - last >= interval - 30000) out.push({ task, target, date: now.ymd, kind: 'renotify' });
    }
  }
  return out;
}

// 通知を受け取る家族
export function recipientsOf(task, target) {
  return target === '*' ? (task.assignees || []) : [target];
}
