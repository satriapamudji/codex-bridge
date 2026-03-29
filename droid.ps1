# Launch codex-bridge proxy + droid, clean up on exit
$ErrorActionPreference = "SilentlyContinue"
$bridge = Start-Process node -ArgumentList "$PSScriptRoot\bridge.mjs" -WindowStyle Hidden -PassThru

# Wait for proxy to bind
Start-Sleep -Milliseconds 800

try {
    droid @args
} finally {
    Stop-Process -Id $bridge.Id -Force 2>$null
}
