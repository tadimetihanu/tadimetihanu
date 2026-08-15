# stop_enterprise.ps1
# Stop any process running on port 4000

$port = 4000
Write-Host ">>> Searching for process on port $port..." -ForegroundColor Yellow

$connection = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($connection) {
    $foundPid = $connection.OwningProcess
    Write-Host ">>> Found process with PID: $foundPid" -ForegroundColor Cyan
    try {
        Stop-Process -Id $foundPid -Force -ErrorAction Stop
        Write-Host ">>> Process terminated successfully." -ForegroundColor Green
    } catch {
        Write-Error "Failed to terminate process with PID $foundPid."
    }
} else {
    Write-Host ">>> No process found on port $port." -ForegroundColor Gray
}
