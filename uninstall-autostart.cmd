@echo off
REM Remove the ezyshare login item and stop the running daemon.
setlocal
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ezyshare.vbs"
set "CFG=%APPDATA%\ezyshare-name.txt"

if exist "%VBS%" (del "%VBS%" & echo removed: %VBS%) else (echo no login item installed)
if exist "%CFG%" del "%CFG%"

REM The daemon runs hidden with no window title, so match on the command line instead.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ezyshare.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('stopped pid ' + $_.ProcessId) }"

echo done.
pause
