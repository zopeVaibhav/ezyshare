@echo off
REM Start the ezyshare daemon in the foreground. Ctrl-C to stop.
setlocal
cd /d "%~dp0"

where bun >nul 2>nul && (bun daemon\ezyshare.ts %* & exit /b %errorlevel%)
where node >nul 2>nul && (node daemon\ezyshare.ts %* & exit /b %errorlevel%)

echo Neither bun nor node found. Install bun from https://bun.sh
pause
exit /b 1
