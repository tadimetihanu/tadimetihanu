@echo off
setlocal
echo 🚀 Launching CloudObjectIQ Enterprise...

REM 1. Migration check
echo 🗃️ Ensuring database schema is up-to-date...
call npx --yes db-migrate up --config database.json -e sqlite

REM 2. Seeding check (safe to run multiple times due to existingUser check)
echo 🌱 Checking seeds...
node src/db/seed.js

REM 3. Startup
echo 🌐 Starting Server. Please navigate to http://localhost:3000
node src/server.js
pause
