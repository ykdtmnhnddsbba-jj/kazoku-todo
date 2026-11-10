# かぞくToDo

家族4人のルーティーン・ToDoを管理して、各自のAndroidスマホに通知するアプリ。完全無料（GitHub Pages + Cloudflare Workers/D1）。

- 画面: `docs/`（GitHub Pages、PWA。ホーム画面に追加できる）
- 通知係: `worker/`（Cloudflare Workers。毎分チェックしてWeb Pushを送る。データはD1）
- ファミリーカレンダーとは連携しない（カレンダーは本当の予定だけ）

## できること
- 毎週のルーティーン／日にち指定のToDo。家族の誰でも追加・編集できる
- 通知の［✅完了］［⏰◯分後］ボタン。押すまで再通知（間隔・回数はタスクごとに変更可）
- 「誰か1人でOK」モード（迎えなど）：1人が押すと、ほかの人には「◯◯が行く」と通知
- チェックリスト（金曜の持ち帰り物など）、家族の完了状況の一覧、「今日はなし」スキップ

## セットアップ（初回だけ・Windows）
1. GitHub: Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `/docs` にして保存
2. PCでクローン（Google Driveの外に置く）
   ```powershell
   cd C:\yutaro\App
   git clone https://github.com/ykdtmnhnddsbba-jj/kazoku-todo.git
   cd kazoku-todo\worker
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
3. 最後に表示される招待リンクを家族にLINEで送る → 各自Chromeで開いて「自分」を選び、通知をON → ホーム画面に追加

`worker\.keys.json`（通知の鍵と家族キー）は消さないこと。消すと全員の通知登録がやり直しになる。

## 更新のしかた
- 画面: `docs/` を push すれば数分で反映
- 通知係: `worker` で `npx wrangler deploy`
- テスト: `worker` で `npm test`
