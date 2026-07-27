@echo off
rem Double-click launcher, so the app can be reopened without a terminal.
title AiCut
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or npm is not on the PATH.
  echo Install Node.js from https://nodejs.org and run this again.
  goto :failed
)

if not exist "node_modules" (
  echo First run: installing dependencies. This takes a few minutes.
  call npm install
  if errorlevel 1 goto :failed
)

echo Starting AiCut.
echo Keep this window open while you edit. Closing it closes the app.
echo.
call npm run dev
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo AiCut could not start. The messages above say why.
pause
exit /b 1
