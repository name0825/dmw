@echo off
setlocal

cd /d "%~dp0"

if not exist "server\.env" (
  echo server/.env not found. Copy server/.env.production.example to server/.env first.
  exit /b 1
)

call npm install --ignore-scripts
call npm run build

start "DMW Production Backend" cmd /k "cd /d "%~dp0" && npm --workspace server run start"

timeout /t 2 /nobreak >nul

start "DMW Production Frontend" cmd /k "cd /d "%~dp0" && npm --workspace web run preview -- --host 0.0.0.0 --port 4173"

echo DMW production started. Open http://localhost:4173
