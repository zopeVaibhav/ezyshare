@echo off
REM Install ezyshare so it starts hidden at every login. No admin needed.
REM Run with no arguments: the daemon uses this PC's own name.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
for /f "delims=" %%N in ('where node') do set "NODE=%%N" & goto :gotnode
:gotnode

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\ezyshare.vbs"
set "CFG=%~dp0.autostart-name"
if exist "%CFG%" del "%CFG%"

set "NAME=%~1"
if not "%NAME%"=="" (
  REM An override ends up in a file that runs at every login, so allow safe characters only.
  echo %NAME%| findstr /R /C:"^[A-Za-z0-9 ._-][A-Za-z0-9 ._-]*$" >nul || (
    echo Bad name. Use letters, digits, space, dot, underscore or hyphen only.
    pause
    exit /b 1
  )
  REM Stored as data and read at login, never pasted into the script body.
  > "%CFG%" echo %NAME%
)

> "%VBS%" echo Set fso = CreateObject("Scripting.FileSystemObject")
>>"%VBS%" echo Set s = CreateObject("WScript.Shell")
>>"%VBS%" echo dir = "%~dp0"
>>"%VBS%" echo cmd = """%NODE%"" """ ^& dir ^& "daemon\ezyshare.mjs"""
>>"%VBS%" echo If fso.FileExists(dir ^& ".autostart-name") Then
>>"%VBS%" echo   cmd = cmd ^& " --name """ ^& Trim(fso.OpenTextFile(dir ^& ".autostart-name", 1).ReadLine) ^& """"
>>"%VBS%" echo End If
>>"%VBS%" echo s.CurrentDirectory = dir
>>"%VBS%" echo s.Run cmd, 0, False

echo installed: %VBS%
if "%NAME%"=="" (echo name:      this PC's own name) else (echo name:      %NAME%)
echo remove:    uninstall-autostart.cmd
echo.
echo Starting it now...
start "" wscript.exe "%VBS%"
echo Allow the Windows Firewall prompt so friends on the same wifi can reach you.
pause
