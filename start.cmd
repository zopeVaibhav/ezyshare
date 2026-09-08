@echo off
REM Start the ezyshare daemon in the foreground. Ctrl-C to stop.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
node daemon\ezyshare.mjs %*
