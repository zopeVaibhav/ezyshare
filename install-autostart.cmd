@echo off
REM Install ezyshare so it starts hidden at every login. No admin needed.
REM Run with no arguments: the daemon uses this PC's own name.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
for /f "delims=" %%N in ('where node') do set "NODE=%%N" & goto :gotnode
:gotnode

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\ezyshare.vbs"
set "CFG=%APPDATA%\ezyshare-name.txt"
if exist "%CFG%" del "%CFG%"

set "NAME=%~1"
if not "!NAME!"=="" (
  REM Written with delayed expansion so metacharacters cannot break out of this line,
  REM then validated from the file rather than from the command line.
  > "%CFG%" echo !NAME!
  findstr /R /C:"^[A-Za-z0-9 ._-][A-Za-z0-9 ._-]*$" "%CFG%" >nul || (
    del "%CFG%"
    echo Bad name. Use letters, digits, space, dot, underscore or hyphen only.
    pause
    exit /b 1
  )
)

REM The VBS re-validates the name at every login, so a later write to that file
REM cannot turn it into extra arguments or extra commands.
> "%VBS%" echo Set fso = CreateObject("Scripting.FileSystemObject")
>>"%VBS%" echo Set s = CreateObject("WScript.Shell")
>>"%VBS%" echo Set re = New RegExp
>>"%VBS%" echo re.Pattern = "^[A-Za-z0-9 ._-]{1,64}$"
>>"%VBS%" echo dir = "%~dp0"
>>"%VBS%" echo cfg = "%CFG%"
>>"%VBS%" echo cmd = """%NODE%"" """ ^& dir ^& "daemon\ezyshare.mjs"""
>>"%VBS%" echo If fso.FileExists(cfg) Then
>>"%VBS%" echo   n = Trim(fso.OpenTextFile(cfg, 1).ReadLine)
>>"%VBS%" echo   If re.Test(n) Then cmd = cmd ^& " --name """ ^& n ^& """"
>>"%VBS%" echo End If
>>"%VBS%" echo s.CurrentDirectory = dir
>>"%VBS%" echo s.Run cmd, 0, False

echo installed: %VBS%
if "!NAME!"=="" (echo name:      this PC's own name) else (echo name:      !NAME!)
echo remove:    uninstall-autostart.cmd
echo.
echo Starting it now...
start "" wscript.exe "%VBS%"
echo Allow the Windows Firewall prompt so friends on the same wifi can reach you.
pause
