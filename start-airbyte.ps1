# start-airbyte.ps1
# Script to start Airbyte locally using abctl or Docker Compose

$ErrorActionPreference = "Stop"

function Install-Abctl {
    Write-Host "Installing abctl..." -ForegroundColor Cyan
    $installScript = "curl -LsfS https://get.airbyte.com | bash -"
    # Use PowerShell to invoke bash for the install script
    bash -c $installScript
    if (-not (Get-Command abctl -ErrorAction SilentlyContinue)) {
        Write-Error "Failed to install abctl."
    }
}

function Start-Abctl {
    Write-Host "Starting Airbyte via abctl..." -ForegroundColor Cyan
    # Use low-resource mode for limited machines
    abctl local install --low-resource-mode
    Write-Host "Airbyte started. Access UI at http://localhost:8000" -ForegroundColor Green
}

function Start-DockerCompose {
    if (Test-Path "docker-compose.yml") {
        Write-Host "Launching Airbyte via Docker Compose..." -ForegroundColor Cyan
        docker compose up -d
        Write-Host "Airbyte containers started. Access UI at http://localhost:8000" -ForegroundColor Green
    } else {
        Write-Error "docker-compose.yml not found. Cannot start Airbyte via Docker Compose."
    }
}

# Main logic
if (Get-Command abctl -ErrorAction SilentlyContinue) {
    Start-Abctl
} else {
    if (Test-Path "docker-compose.yml") {
        Start-DockerCompose
    } else {
        Write-Host "abctl not found and Docker Compose file missing. Attempting to install abctl..." -ForegroundColor Yellow
        Install-Abctl
        Start-Abctl
    }
}
