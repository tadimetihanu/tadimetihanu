@echo off
title Stop CloudObjectIQ Services
echo Stopping CloudObjectIQ Server and MinIO...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000') do (
    taskkill /f /pid %%a 2>nul
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9000') do (
    taskkill /f /pid %%a 2>nul
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9001') do (
    taskkill /f /pid %%a 2>nul
)

echo Services stopped.
timeout /t 2 /nobreak >nul
