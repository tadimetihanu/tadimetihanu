@echo off
echo ========================================================
echo Stopping ALL CloudObjectIQ Services
echo ========================================================

echo.
echo [1/3] Stopping Native MinIO Server...
taskkill /IM minio.exe /F 2>nul

echo.
echo [2/3] Stopping Node.js Application...
cd /d D:\CloudObjectIQ_Ready
powershell -ExecutionPolicy Bypass -File .\stop_app.ps1

echo.
echo [3/3] Stopping Milvus via Docker Compose...
docker-compose -f milvus-docker-compose.yml down

echo.
echo ========================================================
echo All services stopped successfully!
echo ========================================================
pause
