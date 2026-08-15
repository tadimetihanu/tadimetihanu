@echo off
setlocal
cd /d "%~dp0"

echo.
echo ========================================================
echo   Lumina BI - START SERVICES
echo ========================================================
echo.

:: 1. Cleanup
echo [Status] Stopping any existing services...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9010') do (
    taskkill /F /PID %%a /T >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4005') do (
    taskkill /F /PID %%a /T >nul 2>&1
)

:: 2. Start MinIO
echo [Status] Starting MinIO server (APIs: 9010, Console: 9011)...
:: Using absolute paths to avoid issues with current working directory
start "Lumina MinIO" /B minio.exe server .\data --address :9010 --console-address :9011 > minio_output.log 2> minio_error.log

:: Wait for MinIO
timeout /t 3 /nobreak >nul

:: 3. Start Node Server
echo [Status] Starting Node.js Server (Port: 4005)...
start "Lumina Server" /B node src/server.js > server_output.log 2> server_error.txt

echo.
echo ========================================================
echo   SERVICES STARTED SUCCESSFULLY
echo ========================================================
echo   Lumina BI App:   http://localhost:4005
echo   MinIO Console:   http://localhost:9011
echo ========================================================
echo.
echo Use stop.bat to shut down all processes.
timeout /t 5
