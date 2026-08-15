# restart_app.ps1
# Stops the app (if running) and starts it again

$scriptDir = Split-Path $MyInvocation.MyCommand.Definition -Parent
$stopScript = Join-Path $scriptDir "stop_app.ps1"
$startScript = Join-Path $scriptDir "start_app.ps1"

Write-Host ">>> Restarting CloudObjectIQ App..." -ForegroundColor Cyan

# Run stop script
& $stopScript

# Wait a moment for process cleanup
Start-Sleep -Seconds 2

# Run start script
& $startScript
