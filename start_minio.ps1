$env:MINIO_ROOT_USER="minioadmin"
$env:MINIO_ROOT_PASSWORD="minioadmin"
Write-Host ">>> Starting Native MinIO on Windows (Port 9000)..." -ForegroundColor Green
Write-Host ">>> Access the console at: http://localhost:9001" -ForegroundColor Cyan
.\minio.exe server .\minio_data --console-address ":9001"
