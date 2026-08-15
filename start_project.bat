@echo off
echo ========================================================
echo Starting CloudObjectIQ Project Services...
echo ========================================================

echo.
echo [1/2] Starting Milvus via Docker Compose...
docker-compose -f milvus-docker-compose.yml up -d

echo.
echo [2/2] Starting Node.js Application...
start /b powershell -ExecutionPolicy Bypass -File .\start_app.ps1

echo.
echo ========================================================
echo CloudObjectIQ Project start sequence initiated!
echo You can access the app at http://localhost:4000 once it boots.
echo ========================================================
pause
