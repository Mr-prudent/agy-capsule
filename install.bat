@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-plugin.ps1" -Action install %*
if errorlevel 1 exit /b %errorlevel%
rem Offer the debugging-port switch the footer capsule needs (asks first; see issue #5).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\enable-cdp.ps1" -Ask
exit /b 0
