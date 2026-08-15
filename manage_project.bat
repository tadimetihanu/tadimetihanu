@echo off
title CloudObjectIQ Enterprise Control Panel
color 0b

:MENU
cls
echo ==========================================================
echo       CloudObjectIQ Enterprise Control Panel
echo ==========================================================
echo.
echo    [1] Start All Services
echo    [2] Stop All Services
echo    [3] Exit
echo.
set /p choice="Enter your choice (1-3): "

if "%choice%"=="1" goto START_ALL
if "%choice%"=="2" goto STOP_ALL
if "%choice%"=="3" goto EOF

echo Invalid choice. Please try again.
pause
goto MENU

:START_ALL
cls
echo ==========================================================
echo Starting CloudObjectIQ Infrastructure...
echo ==========================================================

echo.
echo [1/4] Starting core databases and Spark...
docker-compose up -d

echo.
echo [2/4] Starting vector database (Milvus)...
docker-compose -f milvus-docker-compose.yml up -d

echo.
echo [3/4] Starting standalone MinIO Server (Port 9002/9003)...
start /b D:\minio\start_minio.bat

echo.
echo [4/4] Starting Node.js Backend Application...
start /b powershell -ExecutionPolicy Bypass -File .\start_app.ps1

echo.
echo ==========================================================
echo All services have been successfully launched!
echo Access the UI at: http://localhost:4000
echo ==========================================================
pause
goto MENU

:STOP_ALL
cls
echo ==========================================================
echo Stopping CloudObjectIQ Infrastructure...
echo ==========================================================

echo.
echo [1/4] Stopping Node.js Backend Application...
powershell -ExecutionPolicy Bypass -File .\stop_app.ps1

echo.
echo [2/4] Stopping standalone MinIO Server...
taskkill /IM minio.exe /F >nul 2>&1

echo.
echo [3/4] Stopping vector database (Milvus)...
docker-compose -f milvus-docker-compose.yml down

echo.
echo [4/4] Stopping core databases and Spark...
docker-compose down

echo.
echo ==========================================================
echo All services have been completely shut down!
echo ==========================================================
pause
goto MENU
