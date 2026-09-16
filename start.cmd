@echo off
setlocal

cd /d "%~dp0"

if exist "dmw.conf" (
  for /f "usebackq tokens=1,2 delims==" %%A in ("dmw.conf") do (
    echo %%A| findstr /r "^#" >nul || if not "%%A"=="" if not defined %%A set "%%A=%%B"
  )
)
if not defined SERVER_PORT set "SERVER_PORT=3001"
if not defined WEB_DEV_PORT set "WEB_DEV_PORT=5173"
if not defined WEB_PREVIEW_PORT set "WEB_PREVIEW_PORT=4173"

REM Default to dev mode if no argument provided
if "%~1"=="" (set ENV=dev) else (set ENV=%~1)

REM Dev mode
if "%ENV%"=="dev" (
  echo Starting DMW in DEV mode...
  start "DMW Backend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:web"
  echo DMW started. Open http://localhost:%WEB_DEV_PORT%
)

REM Prod mode
if "%ENV%"=="prod" (
  echo Starting DMW in PROD mode...
  if not exist "server\.env" (
    echo server/.env not found. Copy server/.env.production.example to server/.env first.
    exit /b 1
  )
  call npm ci
  if errorlevel 1 exit /b 1
  call npm run build
  if errorlevel 1 exit /b 1
  start "DMW Backend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace server run start"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace web run preview -- --host 0.0.0.0 --port %WEB_PREVIEW_PORT%"
  echo DMW production started. Open http://localhost:%WEB_PREVIEW_PORT%
)

REM Agent mode
if "%ENV%"=="agent" (
  echo Starting Agent mode...
  echo Starting DMW backend for agent...
  start "DMW Backend (Agent)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 3 /nobreak >nul
  echo Issue a pairing code from the web UI, then run the agent:
  echo   npm run agent -- --server http://localhost:%SERVER_PORT% --code ^<pairing-code^>
  echo Or run it without arguments to be prompted:
  echo   npm run agent
  echo See agent/README.md for details.
)

REM Invalid argument
if not "%ENV%"=="dev" if not "%ENV%"=="prod" if not "%ENV%"=="agent" (
  echo Usage: start.cmd [dev^|prod^|agent]
  echo Example: start.cmd dev   ^(default^)
  echo Example: start.cmd prod
  echo Example: start.cmd agent
  exit /b 1
)
