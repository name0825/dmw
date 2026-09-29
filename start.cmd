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

set MODE=dev
if "%DMW_DOCKER%"=="1" (set USEDOCKER=1) else (set USEDOCKER=0)

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="dev" (set MODE=dev& shift& goto parse)
if /i "%~1"=="prod" (set MODE=prod& shift& goto parse)
if /i "%~1"=="agent" (set MODE=agent& shift& goto parse)
if /i "%~1"=="docker" (set USEDOCKER=1& shift& goto parse)
if /i "%~1"=="help" goto usage
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
goto usage_error
:parsed

if not "%USEDOCKER%"=="1" goto local

where docker >nul 2>&1
if errorlevel 1 goto no_docker
docker compose version >nul 2>&1
if errorlevel 1 goto no_docker

if not exist ".env" (
  if "%JWT_SECRET%"=="" goto no_env
  if "%ADMIN_PASSWORD%"=="" goto no_env
)

if "%MODE%"=="dev" (
  echo Starting DMW dev stack in Docker...
  echo Open http://localhost:%WEB_DEV_PORT%
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
  if errorlevel 1 exit /b 1
  exit /b 0
)

if "%MODE%"=="prod" (
  echo Starting DMW prod stack in Docker...
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  if errorlevel 1 exit /b 1
  echo DMW production started. Open http://localhost:%WEB_DEV_PORT%
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
if "%MODE%"=="dev" (
  echo Starting DMW in DEV mode...
  start "DMW Backend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 2 /nobreak >nul
  start "DMW Frontend (Dev)" cmd /k "cd /d "%~dp0" && npm run dev:web"
  echo DMW started. Open http://localhost:%WEB_DEV_PORT%
  exit /b 0
)

if "%MODE%"=="prod" (
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
  exit /b 0
)

if "%MODE%"=="agent" (
  echo Starting Agent mode...
  echo Starting DMW backend for agent...
  start "DMW Backend (Agent)" cmd /k "cd /d "%~dp0" && npm run dev:server"
  timeout /t 3 /nobreak >nul
  echo Issue a pairing code from the web UI, then run the agent:
  echo   npm run agent -- --server http://localhost:%SERVER_PORT% --code ^<pairing-code^>
  echo Or run it without arguments to be prompted:
  echo   npm run agent
  echo See agent/README.md for details.
  exit /b 0
)

:no_docker
echo Docker Compose v2 is not available. Install Docker, or run locally:
echo   start.cmd %MODE%
exit /b 1

:no_env
echo No .env found and JWT_SECRET/ADMIN_PASSWORD are unset.
echo Create a repo-root .env ^(see .env.example^) with at least JWT_SECRET
echo and ADMIN_PASSWORD; docker compose refuses to start without them.
exit /b 1

:usage_error
call :usage
exit /b 1

:usage
echo Usage: start.cmd [dev^|prod^|agent] [docker]
echo   dev    (default)  backend + frontend with hot reload
echo   prod              production build
echo   agent             backend + agent pairing instructions
echo   docker            use the Docker Compose stack instead of running
echo                     directly on this machine (dev: hot reload, prod: detached)
echo.
echo The Docker stack uses host networking, which only works on a Linux host.
echo.
echo Examples:
echo   start.cmd dev
echo   start.cmd prod docker
echo   start.cmd dev docker     (same as set DMW_DOCKER=1 ^&^& start.cmd dev)
exit /b 0
