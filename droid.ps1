# Launch codex-bridge proxy + droid, clean up on exit
$ErrorActionPreference = "SilentlyContinue"

$bridgePid = $null
$bridgeStarted = $false
$bridgePort = $env:CODEX_BRIDGE_PORT
if ([string]::IsNullOrWhiteSpace($bridgePort)) { $bridgePort = "18080" }
$bridgeUrl = "http://127.0.0.1:$bridgePort"
$maxBridgeAttempts = 50
$bridgeSleepMs = 100

function Resolve-SafePath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ""
  }
  try {
    return (Resolve-Path $Path).Path
  } catch {
    return $Path
  }
}

function Test-BridgeRunning {
  try {
    Invoke-RestMethod -Uri "$bridgeUrl/health" -Method Get -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ForBridge {
  param([int]$attempts = $maxBridgeAttempts)
  for ($i = 0; $i -lt $attempts; $i++) {
    if (Test-BridgeRunning) {
      return $true
    }
    Start-Sleep -Milliseconds $bridgeSleepMs
  }
  return $false
}

function Get-DroidCommand {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_DROID_CMD)) {
    return $env:CODEX_DROID_CMD
  }

  $self = ""
  if ($PSCommandPath) {
    try {
      $self = (Resolve-Path $PSCommandPath).Path
    } catch {}
  }

  $candidates = @("droid.exe", "droid", "droid.cmd")
  foreach ($name in $candidates) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    if ($self -and $cmd.Source -and (Resolve-SafePath $cmd.Source) -eq $self) { continue }
    if ($cmd.CommandType -eq "Application") {
      return $cmd.Source
    }
  }

  # Fallback to any droid binary that is not this script (for unusual PATH layouts).
  $cmd = Get-Command droid -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -in @("Application", "ExternalScript") } | Select-Object -First 1
  if ($cmd -and (-not $self -or -not $cmd.Source -or (Resolve-SafePath $cmd.Source) -ne $self)) {
    return $cmd.Source
  }

  throw "Unable to resolve droid executable. Set `$env:CODEX_DROID_CMD to your droid binary path."
}

if (-not (Test-BridgeRunning)) {
  $bridgeProc = Start-Process node -ArgumentList "$PSScriptRoot\bridge.mjs" -WindowStyle Hidden -PassThru
  $bridgePid = $bridgeProc.Id
  $bridgeStarted = $true

  if (-not (Wait-ForBridge)) {
    Write-Warning "codex-bridge did not become available at $bridgeUrl"
  }
}

$droidCommand = Get-DroidCommand

try {
  & $droidCommand @args
} finally {
  if ($bridgeStarted -and $bridgePid) {
    Stop-Process -Id $bridgePid -Force 2>$null
  }
}
