@echo off
title CloudObjectIQ Ngrok Tunnel
cd /d "%~dp0"

echo ===================================================
echo   Starting Official Ngrok Tunnel for CloudObjectIQ
echo ===================================================

:: Ensure Node.js is in PATH
set PATH=C:\Users\tadim\.tools\node-v20.18.0-win-x64;%PATH%

echo [1/2] Checking if local server is running on port 4000...
netstat -ano | findstr :4000 >nul
if %errorlevel% neq 0 (
    echo Local server not detected on port 4000.
    echo Starting server now...
    start "" "%~dp0start_all.bat"
    timeout /t 5 /nobreak >nul
)

echo [2/2] Connecting to Ngrok with your configured token...
echo.
node "%~dp0start_ngrok.js"
pause
