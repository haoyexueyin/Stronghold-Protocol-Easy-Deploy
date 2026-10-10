@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."
title Stronghold Protocol - SakuraFrp HTTPS
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-sakura-windows.ps1" %*
if errorlevel 1 (
  echo SakuraFrp startup failed. See the error above.
  pause
  exit /b 1
)
exit /b 0
