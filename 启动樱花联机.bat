@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0scripts\start-sakura-windows.bat" %*
exit /b %errorlevel%
