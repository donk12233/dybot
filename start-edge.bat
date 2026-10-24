@echo off
chcp 65001 >nul
title Dybot Dedicated Edge (CDP 9222)
setlocal enabledelayedexpansion
set "LOG=%~dp0state\edge-launch.log"
if not exist "%~dp0state" mkdir "%~dp0state"
echo [%date% %time%] ---- launch attempt ---- >> "%LOG%"

powershell -NoProfile -Command "if (Test-NetConnection 127.0.0.1 -Port 9222 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo  [OK] 调试端口 9222 已经在监听，浏览器可以直接用。
  echo       这个窗口可以关掉。
  echo.
  pause
  exit /b 0
)

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto noedge

echo.
echo  Starting dedicated Edge with CDP port 9222 ...
echo.
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%~dp0.edge-profile" --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled "https://www.douyin.com/chat"
echo [%date% %time%] started: %EDGE% >> "%LOG%"

set "OK="
for /l %%i in (1,1,20) do (
  if not defined OK (
    timeout /t 1 /nobreak >nul
    powershell -NoProfile -Command "if (Test-NetConnection 127.0.0.1 -Port 9222 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "OK=1"
  )
)

if defined OK (
  echo  [OK] 调试端口 9222 已就绪。
  echo       浏览器窗口请保持开着，可以最小化，但不要关。
  echo       只登录 AI 账号，不要登录你的主号。
  echo [%date% %time%] port 9222 OK >> "%LOG%"
  echo.
  pause
  exit /b 0
)

echo.
echo  [FAIL] 20 秒内没等到 9222。
echo         最常见原因：Edge 已经开着普通窗口，新启动被它接管了。
echo         做法：关掉所有 Edge 窗口，再跑一次本文件。
echo [%date% %time%] port 9222 TIMEOUT >> "%LOG%"
echo.
pause
exit /b 1

:noedge
echo [ERROR] msedge.exe not found. >> "%LOG%"
echo  [ERROR] 找不到 msedge.exe
pause
exit /b 1