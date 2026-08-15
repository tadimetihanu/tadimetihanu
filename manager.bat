@echo off
setlocal
cd /d "%~dp0"

:menu
cls
echo ========================================================
echo        Lumina BI - Service Manager
echo ========================================================
echo.
echo   [1] START Services (App and MinIO)
echo   [2] STOP Services
echo   [3] RESTART Services
echo   [4] CHECK Status (Running Ports)
echo   [5] VIEW Logs (Server Output)
echo   [6] EXIT
echo.
echo ========================================================
set /p choice="Select an option (1-6): "

if "%choice%"=="1" (
    echo.
    call start.bat
    echo.
    pause
    goto menu
)
if "%choice%"=="2" (
    echo.
    call stop.bat
    echo.
    pause
    goto menu
)
if "%choice%"=="3" (
    echo.
    call restart.bat
    echo.
    pause
    goto menu
)
if "%choice%"=="4" (
    echo.
    echo --- Port Status ---
    echo.
    echo Lumina BI (4005):
    netstat -aon | findstr :4005 || echo [OFFLINE]
    echo.
    echo MinIO (9010):
    netstat -aon | findstr :9010 || echo [OFFLINE]
    echo.
    echo --- Process Status ---
    tasklist /FI "IMAGENAME eq node.exe" /FI "STATUS eq running"
    tasklist /FI "IMAGENAME eq minio.exe" /FI "STATUS eq running"
    echo.
    pause
    goto menu
)
if "%choice%"=="5" (
    echo.
    echo --- Last 20 lines of server_output.log ---
    if exist server_output.log (
        powershell -Command "Get-Content server_output.log -Tail 20"
    ) else (
        echo [ERROR] server_output.log not found.
    )
    echo.
    pause
    goto menu
)
if "%choice%"=="6" exit
goto menu
