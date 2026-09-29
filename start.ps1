# Windows PowerShell 5.1 compatible: no '&&' operator, no ternary.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$composeDev = @('-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml')
$composeProd = @('-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml')

function Show-Usage {
    Write-Host 'Usage: start.ps1 [dev|prod|agent] [docker]'
    Write-Host '  dev    (default)  backend + frontend with hot reload'
    Write-Host '  prod              production build'
    Write-Host '  agent             backend + agent pairing instructions'
    Write-Host '  docker            use the Docker Compose stack instead of running'
    Write-Host '                    directly on this machine (dev: hot reload, prod: detached)'
    Write-Host ''
    Write-Host 'The Docker stack uses host networking, which only works on a Linux host.'
    Write-Host ''
    Write-Host 'Examples:'
    Write-Host '  start.ps1 dev'
    Write-Host '  start.ps1 prod docker'
    Write-Host '  start.ps1 dev docker     (same as $env:DMW_DOCKER=1; start.ps1 dev)'
}

$mode = 'dev'
$useDocker = $false
if ($env:DMW_DOCKER -eq '1') { $useDocker = $true }

foreach ($arg in $args) {
    switch ($arg) {
        'dev'    { $mode = 'dev' }
        'prod'   { $mode = 'prod' }
        'agent'  { $mode = 'agent' }
        'docker' { $useDocker = $true }
        '-h'     { Show-Usage; exit 0 }
        '--help' { Show-Usage; exit 0 }
        'help'   { Show-Usage; exit 0 }
        default  { Show-Usage; exit 1 }
    }
}

function Test-DockerCompose {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host 'Docker Compose v2 is not available. Install Docker, or run locally:'
        Write-Host "  start.ps1 $mode"
        exit 1
    }
    & docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Docker Compose v2 is not available. Install Docker, or run locally:'
        Write-Host "  start.ps1 $mode"
        exit 1
    }
    if ((-not (Test-Path '.env')) -and ((-not $env:JWT_SECRET) -or (-not $env:ADMIN_PASSWORD))) {
        Write-Host 'No .env found and JWT_SECRET/ADMIN_PASSWORD are unset.'
        Write-Host 'Create a repo-root .env (see .env.example) with at least JWT_SECRET'
        Write-Host 'and ADMIN_PASSWORD; docker compose refuses to start without them.'
        exit 1
    }
}

if ($useDocker) {
    Test-DockerCompose

    if ($mode -eq 'dev') {
        Write-Host 'Starting DMW dev stack in Docker...'
        Write-Host 'Open http://localhost:5173'
        & docker compose @composeDev up --build
        exit $LASTEXITCODE
    }
    elseif ($mode -eq 'prod') {
        Write-Host 'Starting DMW prod stack in Docker...'
        & docker compose @composeProd up -d --build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'DMW production started. Open http://localhost:5173'
        Write-Host 'Logs: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f    Stop: docker compose -f docker-compose.yml -f docker-compose.prod.yml down'
    }
    elseif ($mode -eq 'agent') {
        Write-Host 'Starting DMW dev stack in Docker for agent pairing...'
        & docker compose @composeDev up -d --build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'Issue a pairing code from the web UI, then run the agent on the'
        Write-Host 'machine you want to monitor (the agent is not containerized):'
        Write-Host '  npm run agent -- --server http://localhost:3001 --code <pairing-code>'
        Write-Host 'Or run it without arguments to be prompted:'
        Write-Host '  npm run agent'
        Write-Host 'See agent/README.md for details.'
    }
    exit 0
}

if ($mode -eq 'dev') {
    Write-Host 'Starting DMW in DEV mode...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm run dev:server"
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm run dev:web"
    Write-Host 'DMW started. Open http://localhost:5173'
}
elseif ($mode -eq 'prod') {
    Write-Host 'Starting DMW in PROD mode...'

    if (-not (Test-Path 'server/.env')) {
        Write-Error 'server/.env not found. Copy server/.env.production.example to server/.env first.'
        exit 1
    }

    Write-Host 'Building DMW for production...'
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host 'Starting DMW backend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm --workspace server run start"
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend preview...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm --workspace web run preview -- --host 0.0.0.0 --port 4173"
    Write-Host 'DMW production started. Open http://localhost:4173'
}
elseif ($mode -eq 'agent') {
    Write-Host 'Starting Agent mode...'
    Write-Host 'Starting DMW backend for agent...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm run dev:server"
    Start-Sleep -Seconds 3
    Write-Host 'Issue a pairing code from the web UI, then run the agent:'
    Write-Host '  npm run agent -- --server http://localhost:3001 --code <pairing-code>'
    Write-Host 'Or run it without arguments to be prompted:'
    Write-Host '  npm run agent'
    Write-Host 'See agent/README.md for details.'
}
