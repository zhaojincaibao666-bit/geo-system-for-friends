$ErrorActionPreference = "Stop"

if ($env:GEO_INTERACTIVE_LAUNCH -ne "1") {
  throw "正式豆包网页监测必须从项目根目录双击 启动星图GEO.cmd 启动，以保证 Chromium 运行在当前 Windows 交互桌面会话。"
}

$root = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $root "data\\logs"
$logFile = Join-Path $logDirectory "local-service.log"
$secretStore = Join-Path $PSScriptRoot "secret-store.ps1"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

try {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $token = (& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $secretStore -Action get -Name "geo-system-agent-token").Trim()

  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "The local service access token is unavailable."
  }

  $env:AGENT_TOKEN = $token
  $env:HOST = "127.0.0.1"
  Set-Location -LiteralPath $root
  "$(Get-Date -Format o) Starting GEO Content Ops at http://127.0.0.1:4318" | Add-Content -LiteralPath $logFile -Encoding utf8
  & $node "server.mjs" *>> $logFile
  if ($LASTEXITCODE -ne 0) {
    throw "The local service stopped unexpectedly with exit code $LASTEXITCODE."
  }
} catch {
  "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content -LiteralPath $logFile -Encoding utf8
  throw
}
