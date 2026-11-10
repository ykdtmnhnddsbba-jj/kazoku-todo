# かぞくToDo 初回セットアップ（Windows PowerShell）
# 使い方: worker フォルダで  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# 2回目以降に実行しても安全（作成済みのものは飛ばす）。
Set-Location $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# wrangler を cmd 経由で実行（PowerShell 5.1 が警告で止まらないように）。出力を全部表示して返す
function Wr([string]$argline, [string]$stdin = $null) {
  if ($stdin) { $out = cmd /c "echo $stdin| npx wrangler $argline 2>&1" }
  else { $out = cmd /c "npx wrangler $argline 2>&1" }
  $text = ($out | Out-String)
  if ($stdin) { Write-Host "(wrangler $argline)" } else { Write-Host $text }
  return @{ text = $text; code = $LASTEXITCODE }
}
function Fail([string]$msg) {
  Write-Host ''
  Write-Host "❌ $msg" -ForegroundColor Red
  Write-Host '   この画面の内容をそのままClaudeに見せてね' -ForegroundColor Red
  exit 1
}

Write-Host '== 1/6 部品のインストール ==' -ForegroundColor Cyan
cmd /c "npm install --no-fund --no-audit 2>&1"
if ($LASTEXITCODE -ne 0) { Fail 'npm install に失敗' }

Write-Host '== 2/6 Cloudflare のログイン確認 ==' -ForegroundColor Cyan
$who = Wr 'whoami'
if ($who.text -match 'not authenticated|You are not logged in') {
  Write-Host 'ログインが必要。ブラウザが開くので「Allow」を押してね' -ForegroundColor Yellow
  cmd /c "npx wrangler login"
  $who = Wr 'whoami'
}

Write-Host '== 3/6 データベース(D1)の作成 ==' -ForegroundColor Cyan
$toml = [IO.File]::ReadAllText("$PSScriptRoot\wrangler.toml")
if ($toml -match 'REPLACE_WITH_D1_ID') {
  $id = $null
  $list = Wr 'd1 list'
  $m = [regex]::Match($list.text, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\S*\s*kazoku-todo\b')
  if ($m.Success) { $id = $m.Groups[1].Value; Write-Host "既にあるD1を使う: $id" }
  else {
    $r = Wr 'd1 create kazoku-todo'
    $m = [regex]::Match($r.text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    if (-not $m.Success) { Fail 'D1 の作成に失敗' }
    $id = $m.Value
  }
  $toml = $toml -replace 'REPLACE_WITH_D1_ID', $id
  [IO.File]::WriteAllText("$PSScriptRoot\wrangler.toml", $toml, $utf8)
  Write-Host "database_id = $id を wrangler.toml に書いたよ"
} else { Write-Host 'D1 は設定済み（スキップ）' }

Write-Host '== 4/6 テーブルと初期データ ==' -ForegroundColor Cyan
$r = Wr 'd1 execute kazoku-todo --remote --file=schema.sql --yes'
if ($r.code -ne 0) { Fail 'テーブル作成に失敗' }

Write-Host '== 5/6 通知の鍵と家族キー ==' -ForegroundColor Cyan
$keyFile = "$PSScriptRoot\.keys.json"
$newKeys = $false
if (-not (Test-Path $keyFile)) {
  $json = (cmd /c "node gen-keys.mjs" | Out-String).Trim()
  if (-not $json.StartsWith('{')) { Fail "鍵の作成に失敗: $json" }
  [IO.File]::WriteAllText($keyFile, $json, $utf8)
  $newKeys = $true
  Write-Host '鍵を作ったよ（worker\.keys.json に保存。消さないでね）'
} else { Write-Host '鍵は作成済み（.keys.json を使う）' }
$keys = Get-Content $keyFile -Raw | ConvertFrom-Json

Write-Host '== 6/6 デプロイ ==' -ForegroundColor Cyan
$dep = Wr 'deploy'
$url = [regex]::Match($dep.text, 'https://kazoku-todo\.[a-z0-9-]+\.workers\.dev').Value
if (-not $url) { Fail 'デプロイに失敗（WorkerのURLが見つからない）' }

if ($newKeys -or $env:KAZOKU_RESET_SECRETS) {
  foreach ($p in @(@('VAPID_PUBLIC', $keys.publicKey), @('VAPID_PRIVATE', $keys.privateKey), @('FAMILY_KEY', $keys.familyKey))) {
    $r = Wr "secret put $($p[0])" $p[1]
    if ($r.code -ne 0) { Write-Host $r.text; Fail "シークレット $($p[0]) の登録に失敗" }
  }
  Write-Host 'シークレットを登録したよ'
}

$invite = "https://ykdtmnhnddsbba-jj.github.io/kazoku-todo/?api=$([uri]::EscapeDataString($url))&k=$($keys.familyKey)&openExternalBrowser=1"
[IO.File]::WriteAllText("$PSScriptRoot\.invite.txt", $invite, $utf8)
Write-Host ''
Write-Host '✅ 完了！ 下の招待リンクを家族に送ってね（.invite.txt にも保存した）' -ForegroundColor Green
Write-Host $invite -ForegroundColor Yellow
