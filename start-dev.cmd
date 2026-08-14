@echo off
setlocal

cd /d "%~dp0"

echo Starting DMW backend...
start "DMW Backend" cmd /k "cd /d "%~dp0" && npm run dev:server"

timeout /t 2 /nobreak >nul

echo Starting DMW frontend...
start "DMW Frontend" cmd /k "cd /d "%~dp0" && npm run dev:web"

echo DMW started. Open http://localhost:5173
