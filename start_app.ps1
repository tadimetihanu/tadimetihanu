# Start the CloudObjectIQ (CloudObjectIQ) on port 4000

$port = 4000
Write-Host ">>> Starting CloudObjectIQ App on port $port..." -ForegroundColor Green

# Ensure node is installed
if (!(Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Please install it to continue."
    exit 1
}

# Set PORT environment variable for server.js
$env:PORT = $port

# Start the process in the background
node src/server.js
Write-Host ">>> App started in the background." -ForegroundColor Cyan
Write-Host ">>> Access it at: http://localhost:$port" -ForegroundColor White
