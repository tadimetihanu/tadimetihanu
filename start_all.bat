@echo off
echo ========================================================
echo Starting ALL CloudObjectIQ Services (including D:\Minio)
echo ========================================================

echo.
echo [1/3] Starting Native MinIO Server (D:\Minio)...
start /b cmd /c "cd /d D:\Minio && start_minio.bat"

echo.
echo [2/3] Starting Milvus via Docker Compose...
cd /d D:\CloudObjectIQ_Ready
docker-compose -f milvus-docker-compose.yml up -d

echo.
echo [3/3] Starting Node.js Application...
start /b powershell -ExecutionPolicy Bypass -File .\start_app.ps1

echo.
echo ========================================================
echo All services started!
echo App: http://localhost:4000
echo MinIO Console: http://localhost:9003
echo ========================================================
pause
