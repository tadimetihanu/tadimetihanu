@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================================
echo   Lumina BI - STOP SERVICES
echo ========================================================
echo.

:: 1. Stop MinIO
echo [Stopping] MinIO server...
taskkill /F /IM minio.exe /T >nul 2>&1

:: 2. Stop Node Server 
echo [Stopping] Node.js Server on port 4005...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4005') do (
    taskkill /F /PID %%a /T >nul 2>&1
)

echo.
echo ========================================================
echo   ALL SERVICES STOPPED
echo ========================================================
echo.
timeout /t 3
