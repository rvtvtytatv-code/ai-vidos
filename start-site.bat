@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 18 или новее.
  pause
  exit /b 1
)
echo Запуск Royal AI Studio...
start "" http://localhost:3000
node server.js
pause
