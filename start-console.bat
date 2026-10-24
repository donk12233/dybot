@echo off
chcp 65001 >nul
title Dybot 控制台
setlocal
cd /d "%~dp0"
echo.
echo  控制台启动中：http://127.0.0.1:3200
echo  关闭这个窗口即停止（配置已写盘，不会丢）
echo.
start "" http://127.0.0.1:3200
node console\server.mjs
pause
