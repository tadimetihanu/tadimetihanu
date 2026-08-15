import duckdb
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "localhost:9000").replace("http://", "").replace("https://", "")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")

print("Initializing DuckDB...")
con = duckdb.connect()

print("Loading extensions...")
con.execute("INSTALL postgres;")
con.execute("LOAD postgres;")
con.execute("INSTALL httpfs;")
con.execute("LOAD httpfs;")

# Configure S3 credentials for MinIO
print("Configuring S3 credentials for MinIO...")
con.execute(f"""
    SET s3_endpoint='{MINIO_ENDPOINT.strip('/')}';
    SET s3_access_key_id='{MINIO_ACCESS_KEY}';
    SET s3_secret_access_key='{MINIO_SECRET_KEY}';
    SET s3_use_ssl=false;
    SET s3_url_style='path';
""")

# Attach PostgreSQL metadata database
print("Attaching PostgreSQL Metadata Database...")
# Assuming postgres is running locally on port 5432 with user 'postgres' and pass 'postgres'
try:
    con.execute("ATTACH 'dbname=cloudobjectiq_db user=postgres password=postgres host=localhost port=5432' AS metadata_db (TYPE postgres);")
    print("Successfully attached PostgreSQL database!")
except Exception as e:
    print(f"Failed to attach PostgreSQL database. Ensure the database 'cloudobjectiq_db' exists. Error: {e}")
    exit(1)

# Query metadata
print("\n--- Available Files from Metadata ---")
try:
    metadata_df = con.execute("SELECT * FROM metadata_db.ingestion_metadata").df()
    print(metadata_df)
    
    if len(metadata_df) > 0:
        # Example of hybrid querying: read the first file from MinIO directly
        first_minio_path = metadata_df.iloc[0]['minio_path']
        print(f"\n--- Reading first dataset directly from MinIO using DuckDB: {first_minio_path} ---")
        
        # S3 paths in MinIO usually start with s3a:// in Spark, DuckDB can use s3://
        duckdb_s3_path = first_minio_path.replace("s3a://", "s3://")
        
        if duckdb_s3_path.endswith('/'):
            duckdb_s3_path += "*.parquet"
            
        data_df = con.execute(f"SELECT * FROM read_parquet('{duckdb_s3_path}') LIMIT 5").df()
        print(data_df)
    else:
        print("\nNo records found in metadata database. Run an ingestion job first!")
except Exception as e:
    print(f"Error querying data: {e}")

print("\n--- RAG Integration Example Complete ---")
