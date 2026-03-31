@echo off
setlocal
set "CODEX_BRIDGE_IDLE_MIN=0"
if "%CODEX_BRIDGE_PORT%"=="" set "CODEX_BRIDGE_PORT=18080"
set "BRIDGE_STATUS_URL=http://127.0.0.1:%CODEX_BRIDGE_PORT%/_bridge_status"
:: Ensure codex-bridge is running. Safe to call repeatedly.
curl -s "%BRIDGE_STATUS_URL%" >nul 2>&1 && exit /b 0
start /b "" node "%~dp0bridge.mjs" >nul 2>&1
timeout /t 2 /nobreak >nul
curl -s "%BRIDGE_STATUS_URL%" >nul 2>&1 && exit /b 0
echo [codex-bridge] failed to start
exit /b 1
