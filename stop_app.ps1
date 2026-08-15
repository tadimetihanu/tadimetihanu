# Stop any process running on port 4000

Write-Host ">>> Searching for process on port 4000..." -ForegroundColor Yellow

# Find the PID using Get-NetTCPConnection (more reliable in PowerShell) or fallback to netstat
$connection = Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($connection) {
    $foundPid = $connection.OwningProcess
    if ($foundPid -eq $pid) {
        Write-Warning "Skipping self-termination of the current PowerShell process!"
        exit 0
    }
    Write-Host ">>> Found process with PID: $foundPid" -ForegroundColor Cyan
    try {
        Stop-Process -Id $foundPid -Force -ErrorAction Stop
        Write-Host ">>> Process terminated successfully." -ForegroundColor Green
    } catch {
        Write-Error "Failed to terminate process with PID $foundPid."
    }
} else {
    Write-Host ">>> No process found on port 4000." -ForegroundColor Gray
}
