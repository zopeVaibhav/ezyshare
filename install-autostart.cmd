@echo off
REM Install ezyshare so it starts hidden at every login. No admin needed.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
for /f "delims=" %%N in ('where node') do set "NODE=%%N" & goto :gotnode
:gotnode

set "NAME=%~1"
if "%NAME%"=="" set "NAME=%COMPUTERNAME%"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\ezyshare.vbs"

REM A VBScript wrapper keeps the console window hidden at login.
> "%VBS%" echo Set s = CreateObject("WScript.Shell")
>>"%VBS%" echo s.CurrentDirectory = "%~dp0"
>>"%VBS%" echo s.Run """%NODE%"" ""%~dp0daemon\ezyshare.mjs"" --name ""%NAME%""", 0, False

echo installed: %VBS%
echo name:      %NAME%
echo remove:    uninstall-autostart.cmd
echo.
echo Starting it now...
start "" wscript.exe "%VBS%"
echo Allow the Windows Firewall prompt so friends on the same wifi can reach you.
pause
