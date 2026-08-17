$ErrorActionPreference = 'Stop'

# Default to dev mode if no argument provided
$env = if ($args.Count -eq 0) { 'dev' } else { $args[0] }

if ($env -eq 'dev') {
    Write-Host 'Starting DMW in DEV mode...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm run dev:server'
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm run dev:web'
    Write-Host 'DMW started. Open http://localhost:5173'
}
elseif ($env -eq 'prod') {
    Write-Host 'Starting DMW in PROD mode...'
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $root

    if (-not (Test-Path "server/.env")) {
        Write-Error "server/.env not found. Copy server/.env.production.example to server/.env first."
        exit 1
    }

    Write-Host 'Building DMW for production...'
    npm install --ignore-scripts
    npm run build

    Write-Host 'Starting DMW backend...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm --workspace server run start'
    Start-Sleep -Seconds 2
    Write-Host 'Starting DMW frontend preview...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm --workspace web run preview -- --host 0.0.0.0 --port 4173'
    Write-Host 'DMW production started. Open http://localhost:4173'
}
elseif ($env -eq 'agent') {
    Write-Host 'Starting Agent mode...'
    Write-Host 'Starting DMW backend for agent...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm run dev:server'
    Start-Sleep -Seconds 3
    Write-Host 'Please set PAIRING_CODE environment variable and run:'
    Write-Host '  $env:PAIRING_CODE = "your-pairing-code"'
    Write-Host 'Then run:'
    Write-Host '  Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd "D:/workspace/DMW"; node agent-demo\agent-win.js"'
}
else {
    Write-Host 'Usage: start.ps1 [dev|prod|agent]'
    Write-Host 'Example: start.ps1 dev   (default)'
    Write-Host 'Example: start.ps1 prod'
    Write-Host 'Example: start.ps1 agent'
    exit 1
}
