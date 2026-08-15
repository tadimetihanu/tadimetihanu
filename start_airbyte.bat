@echo off
echo ====================================================
echo Starting Airbyte Data Integration Engine...
echo ====================================================
echo Note: This requires Docker Desktop to be running.
echo.

WHERE abctl >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    IF NOT EXIST "%cd%\abctl.exe" (
        echo [Airbyte Setup] abctl is missing. Downloading the latest Windows release...
        powershell -Command "Invoke-WebRequest -Uri 'https://github.com/airbytehq/abctl/releases/latest/download/abctl-windows-amd64.exe' -OutFile 'abctl.exe'"
        IF NOT EXIST "%cd%\abctl.exe" (
            echo ❌ ERROR: Failed to download abctl. Please download it manually from https://github.com/airbytehq/abctl/releases
            pause
            exit /b 1
        )
        echo ✅ Download complete.
    )
    set ABCTL_CMD="%cd%\abctl.exe"
) ELSE (
    set ABCTL_CMD=abctl
)

echo.
echo Launching Airbyte Engine...
%ABCTL_CMD% local install

IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ ERROR: Failed to start Airbyte. Please ensure Docker Desktop is running.
) ELSE (
    echo.
    echo ✅ Airbyte started successfully!
    echo Dashboard: http://localhost:8000
    echo Default credentials: airbyte / password
)
