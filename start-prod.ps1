$ErrorActionPreference = 'Stop'

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
