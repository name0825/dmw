@echo off
setlocal

cd /d "%~dp0"

REM Default to dev mode if no argument provided
if "%~1"=="" set ENV=dev

REM Dev mode
if "%ENV%"=="dev" (
  echo Starting DMW in DEV mode...
  start "DMW Backend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:web"
  echo DMW started. Open http://localhost:5173
)

REM Prod mode
if "%ENV%"=="prod" (
  echo Starting DMW in PROD mode...
  if not exist "server\.env" (
    echo server/.env not found. Copy server/.env.production.example to server/.env first.
    exit /b 1
  )
  call npm install --ignore-scripts
  call npm run build
  start "DMW Backend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace server run start"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace web run preview -- --host 0.0.0.0 --port 4173"
  echo DMW production started. Open http://localhost:4173
)

REM Agent mode
if "%ENV%"=="agent" (
  echo Starting Agent mode...
  echo Starting DMW backend for agent...
  start "DMW Backend (Agent)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 3 /nobreak >nul
  echo Please set PAIRING_CODE environment variable and run:
  echo   set PAIRING_CODE=your-pairing-code
  echo Then run:
  echo   start "Agent" cmd /k "cd /d "%~dp0" && node agent-demo\agent-win.js"
)

REM Invalid argument
if "%ENV%" NEQ "dev" AND "%ENV%" NEQ "prod" AND "%ENV%" NEQ "agent" (
  echo Usage: start.cmd [dev|prod|agent]
  echo Example: start.cmd dev   (default)
  echo Example: start.cmd prod
  echo Example: start.cmd agent
  exit /b 1
)
