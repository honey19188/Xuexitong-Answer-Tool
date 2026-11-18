@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title PagePilot 启动器

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次运行，正在安装依赖（可能需要几分钟）...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Electron 未安装成功，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist "server\dist\index.js" (
  echo [2/2] 正在构建服务端...
  call npm run build
)

echo 正在启动 PagePilot 桌面端...
start "" "node_modules\electron\dist\electron.exe" desktop\main.js %*
exit /b 0
