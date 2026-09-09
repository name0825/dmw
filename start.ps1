$ErrorActionPreference = 'Stop'

# Default to dev mode if no argument provided
$env = if ($args.Count -eq 0) { 'dev' } else { $args[0] }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($env -eq 'dev') {
    Write-Host 'Starting DMW in DEV mode...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm run dev:server"
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm run dev:web"
    Write-Host 'DMW started. Open http://localhost:5173'
}
elseif ($env -eq 'prod') {
    Write-Host 'Starting DMW in PROD mode...'
    Set-Location $root

    if (-not (Test-Path "server/.env")) {
        Write-Error "server/.env not found. Copy server/.env.production.example to server/.env first."
        exit 1
    }

    Write-Host 'Building DMW for production...'
    npm install --ignore-scripts
    npm run build

    Write-Host 'Starting DMW backend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm --workspace server run start"
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend preview...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd `"$root`"; npm --workspace web run preview -- --host 0.0.0.0 --port 4173"
    Write-Host 'DMW production started. Open http://localhost:4173'
}
elseif ($env -eq 'agent') {
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
else {
    Write-Host 'Usage: start.ps1 [dev|prod|agent]'
    Write-Host 'Example: start.ps1 dev   (default)'
    Write-Host 'Example: start.ps1 prod'
    Write-Host 'Example: start.ps1 agent'
    exit 1
}
