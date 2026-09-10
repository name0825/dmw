# Windows PowerShell 5.1 compatible: no '&&' operator, no ternary.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$composeDev = @('-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml')
$composeProd = @('-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml')

function Show-Usage {
    Write-Host 'Usage: start.ps1 [dev|prod|agent] [local]'
    Write-Host '  dev    (default)  Docker stack with hot reload'
    Write-Host '  prod              Docker stack, production images, detached'
    Write-Host '  agent             Docker dev stack + agent pairing instructions'
    Write-Host '  local             run directly on this machine, without Docker'
    Write-Host ''
    Write-Host 'Docker is the primary path. Wake-on-LAN needs the server on the host'
    Write-Host 'network, which only works on a Linux host; on Windows/macOS use the'
    Write-Host 'local path for WOL-less development.'
    Write-Host ''
    Write-Host 'Examples:'
    Write-Host '  start.ps1 dev'
    Write-Host '  start.ps1 prod'
    Write-Host '  start.ps1 dev local     (same as $env:DMW_LOCAL=1; start.ps1 dev)'
}

$mode = 'dev'
$useLocal = $false
if ($env:DMW_LOCAL -eq '1') { $useLocal = $true }

foreach ($arg in $args) {
    switch ($arg) {
        'dev'    { $mode = 'dev' }
        'prod'   { $mode = 'prod' }
        'agent'  { $mode = 'agent' }
        'local'  { $useLocal = $true }
        '-h'     { Show-Usage; exit 0 }
        '--help' { Show-Usage; exit 0 }
        'help'   { Show-Usage; exit 0 }
        default  { Show-Usage; exit 1 }
    }
}

function Test-DockerCompose {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host 'Docker Compose v2 is not available. Install Docker, or run locally:'
        Write-Host "  start.ps1 $mode local"
        exit 1
    }
    & docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Docker Compose v2 is not available. Install Docker, or run locally:'
        Write-Host "  start.ps1 $mode local"
        exit 1
    }
}

if (-not $useLocal) {
    Test-DockerCompose

    if ($mode -eq 'dev') {
        Write-Host 'Starting DMW dev stack in Docker...'
        Write-Host 'Open http://localhost:5173'
        & docker compose @composeDev up --build
        exit $LASTEXITCODE
    }
    elseif ($mode -eq 'prod') {
        if ((-not (Test-Path '.env')) -and (-not $env:JWT_SECRET)) {
            Write-Host 'No .env found and JWT_SECRET is unset.'
            Write-Host 'Create a repo-root .env with at least JWT_SECRET, ADMIN_PASSWORD'
            Write-Host 'and CORS_ORIGIN; the server refuses to start on the defaults.'
            exit 1
        }
        Write-Host 'Starting DMW prod stack in Docker...'
        & docker compose @composeProd up -d --build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'DMW production started. Open http://localhost:5173'
        Write-Host 'Server (host network): http://localhost:3001  WS: ws://localhost:3002'
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

Write-Host 'Local (non-Docker) execution.'

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
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm rebuild sqlite3
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
