# Launch codex-bridge proxy + droid, clean up on exit
$ErrorActionPreference = "SilentlyContinue"

$bridgePid = $null
$bridgeStartedByThisScript = $false
$bridgeOwnerId = $null
$bridgePort = $env:CODEX_BRIDGE_PORT
if ([string]::IsNullOrWhiteSpace($bridgePort)) { $bridgePort = "18080" }
$bridgeUrl = "http://127.0.0.1:$bridgePort"
$bridgeHealthUrl = "$bridgeUrl/_bridge_status"
$bridgeStatusUrl = "$bridgeUrl/_bridge_status"
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
    Invoke-RestMethod -Uri "$bridgeStatusUrl" -Method Get -TimeoutSec 1 | Out-Null
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

function Get-BridgeOwnerId {
  try {
    $status = Invoke-RestMethod -Uri "$bridgeStatusUrl" -Method Get -TimeoutSec 1 -ErrorAction Stop
    return $status.ownerId
  } catch {
    return $null
  }
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

  $cmd = Get-Command droid -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -in @("Application", "ExternalScript") } | Select-Object -First 1
  if ($cmd -and (-not $self -or -not $cmd.Source -or (Resolve-SafePath $cmd.Source) -ne $self)) {
    return $cmd.Source
  }

  throw "Unable to resolve droid executable. Set `$env:CODEX_DROID_CMD to your droid binary path."
}

if (-not (Test-BridgeRunning)) {
  $bridgeOwnerId = [guid]::NewGuid().ToString()
  $previousBridgeIdleMin = $env:CODEX_BRIDGE_IDLE_MIN
  $previousBridgeOwnerId = $env:CODEX_BRIDGE_OWNER_ID
  $env:CODEX_BRIDGE_OWNER_ID = $bridgeOwnerId
  $env:CODEX_BRIDGE_IDLE_MIN = "0"

  $bridgeProc = Start-Process node -ArgumentList "$PSScriptRoot\bridge.mjs" -WindowStyle Hidden -PassThru
  $bridgePid = $bridgeProc.Id

  if (Wait-ForBridge) {
    $ownerId = Get-BridgeOwnerId
    if ($ownerId -eq $bridgeOwnerId) {
      $bridgeStartedByThisScript = $true
    }
    else {
      Write-Warning "codex-bridge started by another process; shared instance will remain running."
    }
  }
  else {
    Write-Warning "codex-bridge did not become available at $bridgeHealthUrl"
    $proc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $bridgePid -Force 2>$null
    }
    $bridgePid = $null
  }

  if ($null -eq $previousBridgeIdleMin) {
    Remove-Item Env:CODEX_BRIDGE_IDLE_MIN -ErrorAction SilentlyContinue
  } else {
    $env:CODEX_BRIDGE_IDLE_MIN = $previousBridgeIdleMin
  }
  if ([string]::IsNullOrWhiteSpace($previousBridgeOwnerId)) {
    Remove-Item Env:CODEX_BRIDGE_OWNER_ID -ErrorAction SilentlyContinue
  } else {
    $env:CODEX_BRIDGE_OWNER_ID = $previousBridgeOwnerId
  }
}

$droidCommand = Get-DroidCommand

try {
  & $droidCommand @args
}
finally {
  if ($bridgeStartedByThisScript -and $bridgePid) {
    $currentOwner = Get-BridgeOwnerId
    if ($currentOwner -eq $bridgeOwnerId) {
      $proc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $bridgePid -Force 2>$null
      }
    }
  }
}
