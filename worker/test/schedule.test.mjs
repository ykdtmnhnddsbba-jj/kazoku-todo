import test from 'node:test';
import assert from 'node:assert/strict';
import { planNotifications, isDueOn, jstParts } from '../src/schedule.js';

// JST の日時 → ms
const jst = (s) => Date.parse(s + '+09:00');
const gomi = { id: 'gomi', active: true, mode: 'each', assignees: ['papa'], sched: { type: 'weekly', days: [1, 4], time: '07:50' }, snooze_min: 10, max_renotify: 2 };
const juku = { id: 'juku', active: true, mode: 'any', assignees: ['papa', 'mama'], sched: { type: 'weekly', days: [2], time: '18:30' }, snooze_min: 10, max_renotify: 2 };
const fri = { id: 'fri', active: true, mode: 'each', assignees: ['ane', 'imo'], sched: { type: 'weekly', days: [5], time: '17:00' }, snooze_min: 30, max_renotify: 3 };
const none = new Map(), noSkip = new Set();

test('JST の日付と曜日', () => {
  const p = jstParts(new Date(jst('2026-11-10T00:30:00')));
  assert.deepEqual([p.ymd, p.dow, p.minutes], ['2026-11-10', 2, 30]);
});

test('曜日が合う日だけ対象', () => {
  assert.ok(isDueOn(gomi, '2026-11-09'));   // 月
  assert.ok(!isDueOn(gomi, '2026-11-10'));  // 火
  assert.ok(isDueOn({ ...gomi, sched: { type: 'once', date: '2026-11-10', time: '07:00' } }, '2026-11-10'));
  assert.ok(!isDueOn({ ...gomi, active: false }, '2026-11-09'));
});

test('時刻前は鳴らない・時刻になったら鳴る', () => {
  assert.equal(planNotifications([gomi], none, noSkip, jst('2026-11-09T07:49:00')).length, 0);
  const p = planNotifications([gomi], none, noSkip, jst('2026-11-09T07:50:00'));
  assert.equal(p.length, 1); assert.equal(p[0].kind, 'first');
});

test('再通知は間隔ごと・回数上限まで', () => {
  const occ = (count, lastJst) => new Map([['gomi|2026-11-09|papa', { notify_count: count, last_notified: jst(lastJst) }]]);
  assert.equal(planNotifications([gomi], occ(1, '2026-11-09T07:50:00'), noSkip, jst('2026-11-09T07:55:00')).length, 0);
  assert.equal(planNotifications([gomi], occ(1, '2026-11-09T07:50:00'), noSkip, jst('2026-11-09T08:00:00'))[0].kind, 'renotify');
  assert.equal(planNotifications([gomi], occ(2, '2026-11-09T08:00:00'), noSkip, jst('2026-11-09T08:10:00')).length, 1);
  assert.equal(planNotifications([gomi], occ(3, '2026-11-09T08:10:00'), noSkip, jst('2026-11-09T08:20:00')).length, 0);
});

test('完了済み・スキップは鳴らない', () => {
  const done = new Map([['gomi|2026-11-09|papa', { notify_count: 1, last_notified: jst('2026-11-09T07:50:00'), done_at: 1 }]]);
  assert.equal(planNotifications([gomi], done, noSkip, jst('2026-11-09T08:00:00')).length, 0);
  assert.equal(planNotifications([gomi], none, new Set(['gomi|2026-11-09']), jst('2026-11-09T07:50:00')).length, 0);
});

test('スヌーズは指定時刻まで待ち、上限を超えていても1回鳴る', () => {
  const occ = new Map([['gomi|2026-11-09|papa', { notify_count: 3, last_notified: jst('2026-11-09T08:10:00'), snooze_until: jst('2026-11-09T08:15:00') }]]);
  assert.equal(planNotifications([gomi], occ, noSkip, jst('2026-11-09T08:14:00')).length, 0);
  assert.equal(planNotifications([gomi], occ, noSkip, jst('2026-11-09T08:15:00'))[0].kind, 'snooze');
});

test('誰か1人でOKは宛先1つ、全員それぞれは人数分', () => {
  const a = planNotifications([juku], none, noSkip, jst('2026-11-10T18:30:00'));
  assert.deepEqual(a.map((x) => x.target), ['*']);
  const b = planNotifications([fri], none, noSkip, jst('2026-11-13T17:00:00'));
  assert.deepEqual(b.map((x) => x.target), ['ane', 'imo']);
});

test('予定時刻から3時間以上たってからの初回通知は出さない', () => {
  assert.equal(planNotifications([gomi], none, noSkip, jst('2026-11-09T11:00:00')).length, 0);
});

test('「いつか」ToDo はどの日にも通知されない', () => {
  const someday = { id: 's1', active: true, mode: 'each', assignees: ['papa'], sched: { type: 'someday' }, snooze_min: 10, max_renotify: 2 };
  assert.ok(!isDueOn(someday, '2026-11-10'));
  assert.equal(planNotifications([someday], none, noSkip, jst('2026-11-10T12:00:00')).length, 0);
});
