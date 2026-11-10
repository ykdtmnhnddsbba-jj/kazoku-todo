# かぞくToDo 初回セットアップ（Windows PowerShell）
# 使い方: worker フォルダで  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# 2回目以降に実行しても安全（作成済みのものは飛ばす）。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

Write-Host '== 1/5 部品のインストール ==' -ForegroundColor Cyan
npm install --no-fund --no-audit

Write-Host '== 2/5 データベース(D1)の作成 ==' -ForegroundColor Cyan
$toml = [IO.File]::ReadAllText("$PSScriptRoot\wrangler.toml")
if ($toml -match 'REPLACE_WITH_D1_ID') {
  $out = (npx wrangler d1 create kazoku-todo 2>&1 | Out-String)
  Write-Host $out
  $m = [regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if (-not $m.Success) {
    $list = (npx wrangler d1 list --json 2>$null | Out-String) | ConvertFrom-Json
    $db = $list | Where-Object { $_.name -eq 'kazoku-todo' } | Select-Object -First 1
    if (-not $db) { throw 'database_id が取得できなかった。上のメッセージをClaudeに見せてね' }
    $id = $db.uuid
  } else { $id = $m.Value }
  $toml = $toml -replace 'REPLACE_WITH_D1_ID', $id
  [IO.File]::WriteAllText("$PSScriptRoot\wrangler.toml", $toml, $utf8)
  Write-Host "database_id = $id を wrangler.toml に書いたよ"
} else { Write-Host 'D1 は作成済み（スキップ）' }

Write-Host '== 3/5 テーブルと初期データ ==' -ForegroundColor Cyan
npx wrangler d1 execute kazoku-todo --remote --file=schema.sql --yes

Write-Host '== 4/5 通知の鍵と家族キー ==' -ForegroundColor Cyan
$keyFile = "$PSScriptRoot\.keys.json"
$newKeys = $false
if (-not (Test-Path $keyFile)) {
  $json = (node gen-keys.mjs | Out-String).Trim()
  [IO.File]::WriteAllText($keyFile, $json, $utf8)
  $newKeys = $true
  Write-Host '鍵を作ったよ（worker\.keys.json に保存。消さないでね）'
} else { Write-Host '鍵は作成済み（.keys.json を使う）' }
$keys = Get-Content $keyFile -Raw | ConvertFrom-Json

Write-Host '== 5/5 デプロイ ==' -ForegroundColor Cyan
$dep = (npx wrangler deploy 2>&1 | Out-String)
Write-Host $dep
$url = [regex]::Match($dep, 'https://kazoku-todo\.[a-z0-9-]+\.workers\.dev').Value
if (-not $url) { throw 'Worker のURLが見つからなかった。上のメッセージをClaudeに見せてね' }

if ($newKeys -or $env:KAZOKU_RESET_SECRETS) {
  $keys.publicKey  | npx wrangler secret put VAPID_PUBLIC
  $keys.privateKey | npx wrangler secret put VAPID_PRIVATE
  $keys.familyKey  | npx wrangler secret put FAMILY_KEY
}

$invite = "https://ykdtmnhnddsbba-jj.github.io/kazoku-todo/?api=$([uri]::EscapeDataString($url))&k=$($keys.familyKey)"
[IO.File]::WriteAllText("$PSScriptRoot\.invite.txt", $invite, $utf8)
Write-Host ''
Write-Host '✅ 完了！ 下の招待リンクを家族に送ってね（.invite.txt にも保存した）' -ForegroundColor Green
Write-Host $invite -ForegroundColor Yellow
