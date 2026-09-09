@echo off
REM Install ezyshare so it starts hidden at every login. No admin needed.
REM Run with no arguments: the daemon uses this PC's own name.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where bun >nul 2>nul || where node >nul 2>nul || (echo Neither bun nor node found. Install bun from https://bun.sh & pause & exit /b 1)
for /f "delims=" %%N in ('where bun 2^>nul') do set "RUNTIME=%%N" & goto :gotruntime
for /f "delims=" %%N in ('where node') do set "RUNTIME=%%N" & goto :gotruntime
:gotruntime

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
>>"%VBS%" echo cmd = """%RUNTIME%"" """ ^& dir ^& "daemon\ezyshare.ts"""
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
