@echo off
REM Remove the ezyshare login item and stop the running daemon.
setlocal
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ezyshare.vbs"
if exist "%VBS%" (del "%VBS%" & echo removed: %VBS%) else (echo nothing installed)
taskkill /f /im node.exe /fi "WINDOWTITLE eq ezyshare*" >nul 2>nul
echo Any daemon still running: close its window, or end node.exe in Task Manager.
pause
