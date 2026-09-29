$ErrorActionPreference = 'Stop'
$geoProjectRoot = Split-Path -Parent $PSScriptRoot
foreach ($geoPort in @(4319, 4318)) {
  $geoRuntime = $null
  try { $geoRuntime = Invoke-RestMethod -Uri "http://127.0.0.1:$geoPort/api/runtime" -TimeoutSec 3 } catch {}
  if (-not $geoRuntime) { continue }
  if ($geoRuntime.project -ne 'geo-system') { throw "Port $geoPort belongs to another application." }
  foreach ($geoPlatform in @('doubao_web','deepseek_web')) {
    $geoRun = Invoke-RestMethod -Uri "http://127.0.0.1:$geoPort/api/browser-monitor-runs/active?platform=$geoPlatform" -TimeoutSec 5
    if ($geoRun.run -and $geoRun.run.status -in @('queued','running','preparing_browser','waiting_for_login','needs_human_action')) { throw 'A monitoring run is active; restart postponed.' }
  }
  $geoPublication = $null
  try { $geoPublication = Invoke-RestMethod -Uri "http://127.0.0.1:$geoPort/api/publisher" -TimeoutSec 5 } catch {}
  if ($geoPublication.busy) { throw 'A publishing operation is active; restart postponed.' }
  try {
    $geoProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($geoRuntime.pid)" -ErrorAction Stop
    if ($geoProcess.Name -ne 'node.exe' -or $geoProcess.CommandLine -notmatch 'server\.mjs') { throw 'The reported process is not the GEO server.' }
  } catch [Microsoft.Management.Infrastructure.CimException] {
    # Some managed Windows sessions deny Win32_Process command-line reads.
    # The local runtime endpoint already proved the process belongs to this
    # project; retain a minimum executable-name check before stopping it.
    $geoProcess = Get-Process -Id ([int]$geoRuntime.pid) -ErrorAction Stop
    if ($geoProcess.ProcessName -ne 'node') { throw 'The reported process is not the GEO server.' }
  }
  Stop-Process -Id ([int]$geoRuntime.pid)
}
$geoToken = (& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'secret-store.ps1') -Action get -Name 'geo-system-agent-token').Trim()
if (-not $geoToken) { throw 'Local service token is unavailable.' }
$env:AGENT_TOKEN = $geoToken
$env:PORT = '4318'
$env:GEO_INTERACTIVE_LAUNCH = '1'
$env:GEO_STARTUP_SOURCE = 'desktop_launcher'
Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'server.mjs' -WorkingDirectory $geoProjectRoot -WindowStyle Hidden
Start-Sleep -Seconds 3
Invoke-RestMethod -Uri 'http://127.0.0.1:4318/api/runtime' | ConvertTo-Json -Compress
