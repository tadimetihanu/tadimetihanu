@echo off
title CloudObjectIQ Enterprise Launcher
cd /d "%~dp0"

echo ===================================================
echo     Launching CloudObjectIQ Enterprise Platform
echo ===================================================

:: Ensure Node.js is in PATH
set PATH=C:\Users\tadim\.tools\node-v20.18.0-win-x64;%PATH%

:: 1. Start MinIO S3 Object Storage if not already running
echo [1/3] Checking MinIO Object Storage (Port 9000)...
netstat -ano | findstr :9000 >nul
if %errorlevel% neq 0 (
    echo Starting MinIO Server in background...
    set MINIO_ROOT_USER=minioadmin
    set MINIO_ROOT_PASSWORD=minioadmin
    if not exist "%~dp0minio_data" mkdir "%~dp0minio_data"
    start "MinIO Storage Engine" /min "%~dp0minio.exe" server "%~dp0minio_data" --address ":9000" --console-address ":9001"
    timeout /t 2 /nobreak >nul
) else (
    echo MinIO Server is already running.
)

:: 2. Start CloudObjectIQ Backend Application
echo [2/3] Starting CloudObjectIQ Server (Port 4000)...
netstat -ano | findstr :4000 >nul
if %errorlevel% neq 0 (
    start "CloudObjectIQ Backend" cmd /k "set PATH=C:\Users\tadim\.tools\node-v20.18.0-win-x64;%%PATH%% && set PORT=4000 && node src\server.js"
    timeout /t 3 /nobreak >nul
) else (
    echo Server is already running on port 4000.
)

:: 3. Open Browser
echo [3/3] Opening CloudObjectIQ Portal in Default Browser...
start http://localhost:4000

echo.
echo ===================================================
echo  CloudObjectIQ is ready!
echo  Web Portal:     http://localhost:4000
echo  MinIO Console:  http://localhost:9001 (minioadmin / minioadmin)
echo  Default Login:  admin@cloudobjectiq.com / admin123
echo ===================================================
pause
