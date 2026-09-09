@echo off
REM One-command setup: install, build, start, and print what to paste into Chrome.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "AUTOSTART=1"
set "NAME="
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="--no-autostart" (set "AUTOSTART=0" & shift & goto parse)
if /I "%~1"=="-h" (echo Usage: setup.cmd ["Your Name"] [--no-autostart] & exit /b 0)
set "NAME=%~1"
shift
goto parse
:parsed

echo ==^> Checking for bun
where bun >nul 2>nul || (
  echo.
  echo bun is not installed. Install it, then run this again:
  echo.
  echo     powershell -c "irm bun.sh/install.ps1 ^| iex"
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('bun --version') do echo     bun %%V

echo ==^> Installing dependencies
call bun install --silent || (echo Install failed & pause & exit /b 1)

echo ==^> Building the extension
call bun run build >nul || (echo Build failed & pause & exit /b 1)

set "EXT_PATH=%~dp0dist\extension"

if "%AUTOSTART%"=="1" (
  echo ==^> Installing the login item so the daemon starts with your machine
  if "!NAME!"=="" (call install-autostart.cmd) else (call install-autostart.cmd "!NAME!")
) else (
  echo ==^> Skipping the login item
  echo     start it yourself with: start.cmd
)

echo !EXT_PATH!| clip

echo.
echo Done. One manual step is left, because Chrome will not let a script install an extension.
echo.
echo   1. Open  chrome://extensions
echo   2. Turn on  Developer mode  ^(top right^)
echo   3. Click  Load unpacked  and choose this folder ^(copied to your clipboard^):
echo.
echo        !EXT_PATH!
echo.
echo   4. Click the ezyshare icon in the toolbar.
echo.
echo Tick "Private networks" on the firewall prompt, or nobody will be able to reach you.
echo Everyone you want to share with runs these same steps on their own machine.
echo.
pause
