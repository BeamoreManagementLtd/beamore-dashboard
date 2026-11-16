@echo off
rem Double-click to set up the Beamore Word helper on this PC (see install-word-helper.ps1).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-word-helper.ps1"
echo.
pause
