@echo off
:: Ensure codex-bridge is running. Safe to call repeatedly.
curl -s http://127.0.0.1:18080/health >nul 2>&1 && exit /b 0
start /b "" node "%~dp0bridge.mjs" >nul 2>&1
timeout /t 2 /nobreak >nul
curl -s http://127.0.0.1:18080/health >nul 2>&1 && exit /b 0
echo [codex-bridge] failed to start
exit /b 1
