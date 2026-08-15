# start-service.ps1
# Script to start CloudObjectIQ API Gateway and Docker dependencies.

$ErrorActionPreference = "Stop"

# 1. Configuration
$Port = 3002
$ApiGatewayDir = $PSScriptRoot
$ExpectedContainers = @("cloudobject_iq_minio", "mysql-db", "oracle-db", "spark-master", "spark-worker")

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "     Starting CloudObjectIQ Services         " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 2. Check if API Gateway is already running
Write-Host "[1/3] Checking if port $Port is already in use..." -ForegroundColor Yellow
$ExistingConnection = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($ExistingConnection) {
    $ProcessId = $ExistingConnection[0].OwningProcess
    $ProcessName = (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue).Name
    Write-Host "[!] Port $Port is already occupied by process '$ProcessName' (PID: $ProcessId)." -ForegroundColor Red
    Write-Host "If you want to restart it, please run .\stop-service.ps1 first." -ForegroundColor Yellow
    Exit
}
Write-Host "[OK] Port $Port is available." -ForegroundColor Green

# 3. Check and start Docker dependencies
Write-Host "`n[2/3] Checking Docker dependencies..." -ForegroundColor Yellow
$DockerCheck = Get-Command docker -ErrorAction SilentlyContinue
if (-not $DockerCheck) {
    Write-Host "[!] Docker is not installed or not in PATH. Skipping container checks." -ForegroundColor Yellow
} else {
    # Check if Docker Daemon is running
    try {
        $null = docker ps -q
    } catch {
        Write-Host "[ERROR] Docker daemon is not running. Please start Docker Desktop and try again." -ForegroundColor Red
        Exit
    }

    # Start expected containers if they are stopped
    $RunningContainers = docker ps --format '{{.Names}}'
    foreach ($Container in $ExpectedContainers) {
        if ($RunningContainers -contains $Container) {
            Write-Host "[OK] Container '$Container' is already running." -ForegroundColor Green
        } else {
            # Check if container exists at all
            $Exists = docker ps -a --filter "name=$Container" --format '{{.Names}}'
            if ($Exists) {
                Write-Host "Starting stopped container '$Container'..." -ForegroundColor Yellow
                docker start $Container | Out-Null
                Write-Host "[OK] Container '$Container' started successfully." -ForegroundColor Green
            } else {
                Write-Host "[!] Expected container '$Container' not found on this system." -ForegroundColor Yellow
            }
        }
    }
}

# 4. Start the API Gateway in a new terminal window
Write-Host "`n[3/3] Launching API Gateway (port $Port)..." -ForegroundColor Yellow
if (Test-Path $ApiGatewayDir) {
    # We launch it in a new cmd window so logs are visible to the user
    Start-Process cmd -ArgumentList "/k title CloudObjectIQ API Gateway && set PORT=$Port && npm start" -WorkingDirectory $ApiGatewayDir
    
    # Wait and poll for startup validation
    Write-Host "Waiting for service to bind to port $Port..." -NoNewline
    $Success = $false
    for ($i = 1; $i -le 10; $i++) {
        Start-Sleep -Seconds 1
        Write-Host "." -NoNewline
        $FinalCheck = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
        if ($FinalCheck) {
            $Success = $true
            break
        }
    }
    Write-Host ""
    
    if ($Success) {
        Write-Host "`n[SUCCESS] CloudObjectIQ services started successfully!" -ForegroundColor Green
        Write-Host "[LINK] Web Portal is available at: http://localhost:$Port" -ForegroundColor Cyan
    } else {
        Write-Host "`n[!] Service launched, but port $Port is not responding yet. Please check the log window." -ForegroundColor Yellow
    }
} else {
    Write-Host "[ERROR] API Gateway directory not found at: $ApiGatewayDir" -ForegroundColor Red
}
Write-Host "=============================================" -ForegroundColor Cyan
