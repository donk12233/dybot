@echo off
chcp 65001 >nul
title Dybot 一键启动
setlocal
set "ROOT=%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
echo.
echo  ============================================
echo   Dybot 一键启动：Edge(9222) + 控制台(3200)
echo  ============================================
echo.
if not exist "%EDGE%" goto noedge

echo [1/3] 启动专用 Edge（独立 profile + 调试端口 9222）...
start "Dybot Edge" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%ROOT%\.edge-profile" --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled "https://www.douyin.com/?recommend=1"

timeout /t 6 >nul

echo [2/3] 启动控制台（新窗口）...
start "Dybot 控制台" cmd /k "cd /d %ROOT% && node console\server.mjs"

timeout /t 3 >nul

echo [3/3] 打开面板...
start "" http://127.0.0.1:3200

echo.
echo  接下来你要做的：
echo   1) 看一眼 Edge 里抖音是不是登录状态；没登录就扫码
echo   2) 控制台 -^> 运行 -^> 点「启动」
echo.
echo  提示：这个窗口可以关掉，Edge 和控制台是独立进程。
echo  要停：控制台点「停止」，再关掉 Edge 和那个控制台窗口。
echo.
pause
exit /b 0

:noedge
echo [ERROR] 找不到 msedge.exe，请手动改脚本里的路径。
pause
exit /b 1
