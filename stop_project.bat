@echo off
echo ========================================================
echo Stopping CloudObjectIQ Project Services...
echo ========================================================

echo.
echo [1/2] Stopping Node.js Application...
powershell -ExecutionPolicy Bypass -File .\stop_app.ps1

echo.
echo [2/2] Stopping Milvus via Docker Compose...
docker-compose -f milvus-docker-compose.yml down

echo.
echo ========================================================
echo CloudObjectIQ Project stopped successfully!
echo ========================================================
pause
