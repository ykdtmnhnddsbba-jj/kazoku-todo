-- 家族ToDo通知のデータベース（Cloudflare D1）
-- 初回だけ: npx wrangler d1 execute kazoku-todo --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🙂',
  is_admin INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  checklist TEXT NOT NULL DEFAULT '[]',   -- ["上靴","体操服"]
  assignees TEXT NOT NULL DEFAULT '[]',   -- ["papa","mama"]
  mode TEXT NOT NULL DEFAULT 'each',      -- each=全員それぞれ / any=誰か1人でOK
  sched TEXT NOT NULL,                    -- {"type":"weekly","days":[2],"time":"18:30"} / {"type":"once","date":"2026-11-12","time":"07:30"}
  snooze_min INTEGER NOT NULL DEFAULT 10,
  max_renotify INTEGER NOT NULL DEFAULT 2,
  done_label TEXT NOT NULL DEFAULT '完了',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS occ (
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  target TEXT NOT NULL,                   -- 担当者ID、または '*'（誰か1人でOK）
  notify_count INTEGER NOT NULL DEFAULT 0,
  last_notified INTEGER,
  snooze_until INTEGER,
  done_at INTEGER,
  done_by TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (task_id, date, target)
);

CREATE TABLE IF NOT EXISTS skips (
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (task_id, date)
);

CREATE TABLE IF NOT EXISTS subs (
  endpoint TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER
);

-- 家族（名前はアプリの設定画面で変えられる）
INSERT OR IGNORE INTO members (id, name, emoji, is_admin, sort) VALUES
  ('papa', 'パパ', '👨', 1, 1),
  ('mama', 'ママ', '👩', 0, 2),
  ('ane',  '長女', '👧', 0, 3),
  ('imo',  '次女', '🧒', 0, 4);

-- 最初のルーティーン（時間・スヌーズはアプリから変更できる）
INSERT OR IGNORE INTO tasks (id, title, note, checklist, assignees, mode, sched, snooze_min, max_renotify, done_label, created_by, updated_at) VALUES
  ('juku-tue', '塾の迎え（火）', '行ける人が「行く」を押してね', '[]', '["papa","mama"]', 'any',
   '{"type":"weekly","days":[2],"time":"18:30"}', 10, 2, '行く', 'papa', 0),
  ('juku-thu', '塾の迎え（木）', '行ける人が「行く」を押してね', '[]', '["papa","mama"]', 'any',
   '{"type":"weekly","days":[4],"time":"20:00"}', 10, 2, '行く', 'papa', 0),
  ('fri-wash', '洗うもの・出すもの、全部出して！', '上靴は毎週必ず！', '["上靴","体操服","給食エプロン","提出物・プリント"]', '["ane","imo"]', 'each',
   '{"type":"weekly","days":[5],"time":"17:00"}', 30, 3, '出した', 'papa', 0),
  ('gomi', 'ゴミ出し（8:20まで）', '', '[]', '["papa"]', 'each',
   '{"type":"weekly","days":[1,4],"time":"07:50"}', 10, 2, '出した', 'papa', 0);
