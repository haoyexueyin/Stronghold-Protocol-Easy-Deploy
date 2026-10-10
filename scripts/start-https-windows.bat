@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
rem Custom certificates take priority; only generate a local certificate when none is configured.
if defined SP_TLS_PFX goto :start
if defined SP_TLS_CERT goto :start
if defined SP_TLS_KEY goto :start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-https-cert.ps1"
if errorlevel 1 (
  echo HTTPS certificate creation failed. See the error above.
  pause
  exit /b 1
)
:start
set "SP_HTTPS=1"
call "%~dp0start-windows.bat" %*
exit /b %errorlevel%
