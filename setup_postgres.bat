@echo off
echo =========================================================
echo Setting up Portable PostgreSQL 16.3 (Docker Bypassed)
echo =========================================================

echo [1/4] Downloading PostgreSQL binaries...
curl.exe -L -o pg.zip https://get.enterprisedb.com/postgresql/postgresql-16.3-1-windows-x64-binaries.zip

echo [2/4] Extracting binaries...
tar -xf pg.zip
del pg.zip

echo [3/4] Initializing Database Cluster...
echo postgres>pw.txt
pgsql\bin\initdb.exe -D pgsql\data -U postgres --pwfile=pw.txt
del pw.txt

echo [4/4] Starting PostgreSQL Server on port 5432...
pgsql\bin\pg_ctl.exe -D pgsql\data -l pgsql\logfile start

echo.
echo ✅ PostgreSQL is now running!
echo Connection Details:
echo Host: localhost
echo Port: 5432
echo User: postgres
echo Pass: postgres
echo.
echo To stop the server later, run:
echo pgsql\bin\pg_ctl.exe -D pgsql\data stop
