@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  live-archive : one-click publish
rem    publish.cmd            normal (waits until stream has been quiet 10 min)
rem    publish.cmd --force    publish right now even if stream just ended
rem    publish.cmd --dry-run  show what would change, change nothing
rem    publish.cmd --no-push  commit locally only
rem ============================================================

cd /d "%~dp0"

set "PY="
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)
if not defined PY (
  where py >nul 2>nul && set "PY=py"
)
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found. Install Python 3.11+ and retry.
  pause
  exit /b 1
)

echo [live-archive] publishing...
echo.
"%PY%" "tools\publish.py" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [done] site: https://hibane-hinome.github.io/live-archive/
) else (
  echo [failed] exit code %RC% -- see .state\publish.log
)
echo.
pause
exit /b %RC%
