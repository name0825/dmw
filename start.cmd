@echo off
setlocal

cd /d "%~dp0"

set MODE=dev
if "%DMW_LOCAL%"=="1" (set USELOCAL=1) else (set USELOCAL=0)

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="dev" (set MODE=dev& shift& goto parse)
if /i "%~1"=="prod" (set MODE=prod& shift& goto parse)
if /i "%~1"=="agent" (set MODE=agent& shift& goto parse)
if /i "%~1"=="local" (set USELOCAL=1& shift& goto parse)
if /i "%~1"=="help" goto usage
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
goto usage_error
:parsed

if "%USELOCAL%"=="1" goto local

where docker >nul 2>&1
if errorlevel 1 goto no_docker
docker compose version >nul 2>&1
if errorlevel 1 goto no_docker

if "%MODE%"=="dev" (
  echo Starting DMW dev stack in Docker...
  echo Open http://localhost:5173
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
  if errorlevel 1 exit /b 1
  exit /b 0
)

if "%MODE%"=="prod" (
  if not exist ".env" (
    if "%JWT_SECRET%"=="" (
      echo No .env found and JWT_SECRET is unset.
      echo Create a repo-root .env with at least JWT_SECRET, ADMIN_PASSWORD
      echo and CORS_ORIGIN; the server refuses to start on the defaults.
      exit /b 1
    )
  )
  echo Starting DMW prod stack in Docker...
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  if errorlevel 1 exit /b 1
  echo DMW production started. Open http://localhost:5173
  echo Server ^(host network^): http://localhost:3001  WS: ws://localhost:3002
  echo Logs: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f    Stop: docker compose -f docker-compose.yml -f docker-compose.prod.yml down
  exit /b 0
)

if "%MODE%"=="agent" (
  echo Starting DMW dev stack in Docker for agent pairing...
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
  if errorlevel 1 exit /b 1
  echo Issue a pairing code from the web UI, then run the agent on the
  echo machine you want to monitor ^(the agent is not containerized^):
  echo   npm run agent -- --server http://localhost:3001 --code ^<pairing-code^>
  echo Or run it without arguments to be prompted:
  echo   npm run agent
  echo See agent/README.md for details.
  exit /b 0
)

:local
echo Local (non-Docker) execution.

if "%MODE%"=="dev" (
  echo Starting DMW in DEV mode...
  start "DMW Backend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:web"
  echo DMW started. Open http://localhost:5173
  exit /b 0
)

if "%MODE%"=="prod" (
  echo Starting DMW in PROD mode...
  if not exist "server\.env" (
    echo server/.env not found. Copy server/.env.production.example to server/.env first.
    exit /b 1
  )
  call npm ci --ignore-scripts
  if errorlevel 1 exit /b 1
  call npm rebuild sqlite3
  if errorlevel 1 exit /b 1
  call npm run build
  if errorlevel 1 exit /b 1
  start "DMW Backend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace server run start"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Prod)" cmd /k "cd /d "%~dp0" && npm --workspace web run preview -- --host 0.0.0.0 --port 4173"
  echo DMW production started. Open http://localhost:4173
  exit /b 0
)

if "%MODE%"=="agent" (
  echo Starting Agent mode...
  echo Starting DMW backend for agent...
  start "DMW Backend (Agent)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 3 /nobreak >nul
  echo Issue a pairing code from the web UI, then run the agent:
  echo   npm run agent -- --server http://localhost:3001 --code ^<pairing-code^>
  echo Or run it without arguments to be prompted:
  echo   npm run agent
  echo See agent/README.md for details.
  exit /b 0
)

:no_docker
echo Docker Compose v2 is not available. Install Docker, or run locally:
echo   start.cmd %MODE% local
exit /b 1

:usage_error
call :usage
exit /b 1

:usage
echo Usage: start.cmd [dev^|prod^|agent] [local]
echo   dev    (default)  Docker stack with hot reload
echo   prod              Docker stack, production images, detached
echo   agent             Docker dev stack + agent pairing instructions
echo   local             run directly on this machine, without Docker
echo.
echo Docker is the primary path. Wake-on-LAN needs the server on the host
echo network, which only works on a Linux host; on Windows/macOS use the
echo local path for WOL-less development.
echo.
echo Examples:
echo   start.cmd dev
echo   start.cmd prod
echo   start.cmd dev local     (same as set DMW_LOCAL=1 ^&^& start.cmd dev)
exit /b 0
