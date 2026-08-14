$ErrorActionPreference = 'Stop'

Write-Host 'Starting DMW backend...'
Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm run dev:server'

Start-Sleep -Seconds 2
Write-Host 'Starting DMW frontend...'
Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "D:/workspace/DMW"; npm run dev:web'

Write-Host 'DMW started. Open http://localhost:5173'
