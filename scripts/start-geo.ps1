$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$port = 4318
$runtimeUrl = "http://127.0.0.1:$port/api/runtime"

function Stop-WithMessage([string]$message) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  Write-Host ""
  Read-Host "按 Enter 键关闭窗口"
  exit 1
}

function Get-PortListenerPid([int]$targetPort) {
  $line = netstat -ano -p tcp | Where-Object { $_ -match "127\.0\.0\.1:$targetPort\s+.*LISTENING\s+(\d+)$" } | Select-Object -First 1
  if ($line -match "(\d+)\s*$") { return [int]$Matches[1] }
  return $null
}

function Get-GeoRuntime {
  try {
    return Invoke-RestMethod -Uri $runtimeUrl -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

Clear-Host
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "              星图 GEO 本地启动器" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Stop-WithMessage "未检测到 Node.js，无法启动星图 GEO。请安装 Node.js LTS 后重新双击启动器。" }
Write-Host "已检测到 Node.js $(node.exe -v)" -ForegroundColor Green

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmd) { Write-Host "npm.cmd 可用：$(& $npmCmd.Source -v)" -ForegroundColor Green }
else { Write-Host "未检测到 npm.cmd；当前服务仍可直接通过 node.exe 启动。" -ForegroundColor Yellow }

$pnpmCmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($pnpmCmd -and $pnpmCmd.Source -notmatch '[\\/]\.cache[\\/]codex-runtimes[\\/]') {
  Write-Host "pnpm 可用：$(& $pnpmCmd.Source -v)" -ForegroundColor Green
} else {
  Write-Host "未检测到 pnpm。本项目不依赖 pnpm 启动，将使用 node.exe server.mjs。" -ForegroundColor Yellow
  Write-Host "如需安装 pnpm，可执行：corepack enable；corepack prepare pnpm@latest --activate" -ForegroundColor DarkYellow
}

if (-not (Test-Path (Join-Path $root "node_modules\playwright\package.json"))) {
  Stop-WithMessage "未检测到项目依赖 node_modules\playwright。请在项目目录执行：npm.cmd install"
}

$listenerPid = Get-PortListenerPid $port
if ($listenerPid) {
  $runtime = Get-GeoRuntime
  if ($runtime -and $runtime.project -eq "geo-system" -and [int]$runtime.pid -eq $listenerPid) {
    Write-Host ""
    Write-Host "检测到已有星图 GEO 服务正在运行。" -ForegroundColor Yellow
    Write-Host "PID：$listenerPid  端口：$port"
    Write-Host "服务实例：$($runtime.serverInstanceId)"
    Write-Host "启动时间：$($runtime.startedAt)"
    Write-Host "交互桌面启动：$($runtime.interactiveSession)"
    $action = Read-Host "输入 S 停止该已确认 GEO 服务并启动新服务；输入 O 打开现有服务；其他任意键取消"
    if ($action -match '^[Oo]$') { Start-Process "http://127.0.0.1:$port/"; exit 0 }
    if ($action -notmatch '^[Ss]$') { Write-Host "已取消。"; exit 0 }
    Write-Host "正在停止已确认的星图 GEO 服务 PID $listenerPid ..."
    Stop-Process -Id $listenerPid -ErrorAction Stop
    Start-Sleep -Seconds 2
  } else {
    Stop-WithMessage "端口 $port 已被 PID $listenerPid 占用，但无法确认它是星图 GEO 服务。为避免影响无关程序，启动器不会停止它。"
  }
}

Write-Host ""
Write-Host "正在当前 Windows 交互桌面会话启动星图 GEO ..." -ForegroundColor Cyan
$env:GEO_INTERACTIVE_LAUNCH = "1"
$env:GEO_STARTUP_SOURCE = "desktop_launcher"
$server = Start-Process -FilePath $node.Source -ArgumentList "server.mjs" -WorkingDirectory $root -NoNewWindow -PassThru

$ready = $null
for ($attempt = 1; $attempt -le 20; $attempt += 1) {
  Start-Sleep -Seconds 1
  $ready = Get-GeoRuntime
  if ($ready -and $ready.project -eq "geo-system" -and [int]$ready.pid -eq $server.Id) { break }
  $ready = $null
}

if (-not $ready) {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
  Stop-WithMessage "星图 GEO 服务未能在 20 秒内 Ready，因此不会打开网页。请查看本窗口中的 Node 错误信息。"
}

Write-Host ""
Write-Host "服务已就绪。" -ForegroundColor Green
Write-Host "服务实例：$($ready.serverInstanceId)"
Write-Host "PID：$($ready.pid)"
Write-Host "启动时间：$($ready.startedAt)"
Write-Host "交互桌面启动：$($ready.interactiveSession)"
Write-Host ""
Start-Process "http://127.0.0.1:$port/"
Write-Host "网页已打开。请保持此控制台窗口打开；按 Ctrl+C 可停止当前服务。" -ForegroundColor Cyan
Wait-Process -Id $server.Id
