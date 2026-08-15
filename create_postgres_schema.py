import subprocess
import os
import sys

def run_psql_command(command, db="postgres"):
    psql_path = os.path.join("pgsql", "bin", "psql.exe")
    if not os.path.exists(psql_path):
        print(f"Error: Could not find {psql_path}. Ensure PostgreSQL is installed.")
        sys.exit(1)
        
    env = os.environ.copy()
    env["PGPASSWORD"] = "postgres"
    
    cmd = [psql_path, "-U", "postgres", "-h", "localhost", "-p", "5432", "-d", db, "-c", command]
    try:
        result = subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
        print(result.stdout)
    except subprocess.CalledProcessError as e:
        # Ignore "database already exists" errors
        if "already exists" not in e.stderr:
            print(f"Error executing command: {e.stderr}")

if __name__ == "__main__":
    print("Creating database 'cloudobjectiq_db'...")
    # Cannot create database if connected to it, so connect to default 'postgres'
    run_psql_command("CREATE DATABASE cloudobjectiq_db;")
    
    print("Creating 'ingestion_metadata' table...")
    table_schema = """
    CREATE TABLE IF NOT EXISTS ingestion_metadata (
        id SERIAL PRIMARY KEY,
        source_path VARCHAR(500),
        file_type VARCHAR(50),
        minio_path VARCHAR(500),
        record_count INT,
        status VARCHAR(50),
        ingestion_time TIMESTAMP
    );
    """
    run_psql_command(table_schema, db="cloudobjectiq_db")
    print("Database schema successfully initialized.")
