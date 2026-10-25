@echo off
rem One-click launcher for the A-share screener (double-click this file).
rem
rem IMPORTANT: keep this file ASCII-only. cmd.exe decodes .bat files with the
rem active OEM code page, so non-ASCII bytes in comments can be misparsed as
rem commands. All Chinese messages come from scripts\launcher.py instead.
setlocal

set "ROOT=%~dp0"
set "PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if exist "%PY%" goto run

where python >nul 2>nul
if errorlevel 1 goto nopython
set "PY=python"

:run
"%PY%" -X utf8 "%ROOT%scripts\launcher.py" %*
if errorlevel 1 pause
goto :eof

:nopython
echo [ERROR] Python not found.
echo         Please install Python 3.11+ and try again.
pause
