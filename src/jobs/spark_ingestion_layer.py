import sys
import os
import time
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, current_timestamp
from dotenv import load_dotenv

# Load env variables for credentials
load_dotenv()

# Ensure required env variables are present (or fall back to defaults)
MINIO_ACCESS_KEY = os.getenv('MINIO_ACCESS_KEY', 'minioadmin')
MINIO_SECRET_KEY = os.getenv('MINIO_SECRET_KEY', 'minioadmin')
MINIO_ENDPOINT = os.getenv('MINIO_ENDPOINT', 'http://localhost:9000')

POSTGRES_USER = os.getenv('POSTGRES_USER', 'postgres')
POSTGRES_PASSWORD = os.getenv('POSTGRES_PASSWORD', 'postgres')
POSTGRES_URL = os.getenv('POSTGRES_URL', 'jdbc:postgresql://localhost:5432/cloudobjectiq_db')

MILVUS_URI = os.getenv('MILVUS_URI', './data/milvus.db')
MILVUS_COLLECTION = 'unstructured_rag'

def init_spark():
    """Initialize SparkSession with AWS S3A and MySQL JDBC configurations."""
    print("Initializing Spark Session...")
    spark = SparkSession.builder \
        .appName("CloudObjectIQ_Spark_Ingestion_Layer") \
        .config("spark.jars.packages", "org.apache.hadoop:hadoop-aws:3.3.4,org.postgresql:postgresql:42.6.0") \
        .config("spark.hadoop.fs.s3a.access.key", MINIO_ACCESS_KEY) \
        .config("spark.hadoop.fs.s3a.secret.key", MINIO_SECRET_KEY) \
        .config("spark.hadoop.fs.s3a.endpoint", MINIO_ENDPOINT) \
        .config("spark.hadoop.fs.s3a.path.style.access", "true") \
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false") \
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem") \
        .getOrCreate()
    return spark

def process_file(file_path, file_type):
    """Read the file based on the file_type."""
    spark = init_spark()
    print(f"Reading {file_type.upper()} file from: {file_path}")
    
    try:
        if file_type.lower() == 'csv':
            df = spark.read.option("header", "true").option("inferSchema", "true").csv(file_path)
        elif file_type.lower() == 'json':
            df = spark.read.json(file_path)
        elif file_type.lower() == 'parquet':
            df = spark.read.parquet(file_path)
        elif file_type.lower() == 'orc':
            df = spark.read.orc(file_path)
        else:
            raise ValueError(f"Unsupported file type: {file_type}")
    except Exception as e:
        print(f"Failed to read data: {e}")
        sys.exit(1)
        
    print(f"Loaded {df.count()} records successfully.")
    
    # 1. Write to MinIO (Raw / Processed Storage)
    print("\n--- 1. Writing to MinIO (Object Storage) ---")
    minio_path = f"s3a://unstructured-files/processed/{int(time.time())}/"
    try:
        # Write as parquet for optimized storage in MinIO
        df.write.mode("overwrite").parquet(minio_path)
        print(f"Successfully wrote data to MinIO at: {minio_path}")
    except Exception as e:
        print(f"Failed to write to MinIO: {e}")

    # 2. Write to PostgreSQL (Metadata Storage)
    print("\n--- 2. Writing to PostgreSQL (Metadata) ---")
    try:
        # Create a metadata dataframe
        metadata_df = spark.createDataFrame([{
            "source_path": file_path,
            "file_type": file_type,
            "minio_path": minio_path,
            "record_count": df.count(),
            "status": "PROCESSED"
        }])
        metadata_df = metadata_df.withColumn("ingestion_time", current_timestamp())
        
        metadata_df.write \
            .format("jdbc") \
            .option("url", POSTGRES_URL) \
            .option("dbtable", "ingestion_metadata") \
            .option("user", POSTGRES_USER) \
            .option("password", POSTGRES_PASSWORD) \
            .option("driver", "org.postgresql.Driver") \
            .mode("append") \
            .save()
        print("Successfully wrote metadata to PostgreSQL.")
    except Exception as e:
        print(f"Failed to write to PostgreSQL: {e}")

    # 3. Write to Milvus (Vector Index)
    print("\n--- 3. Writing to Milvus (Vector Database) ---")
    # To write to Milvus, we typically extract the text content, generate embeddings, and insert.
    # Since Spark distributed processing with local Milvus/OpenAI can be complex due to API rate limits, 
    # we collect a sample or use a mapPartition for the vector generation.
    try:
        from pymilvus import MilvusClient
        from langchain_openai import OpenAIEmbeddings
        import json
        
        # We assume the dataframe has a 'text' or 'content' column to embed. 
        # For dynamic datasets, we can just dump the row as a JSON string to index it.
        print("Extracting text representation of rows for vectorization...")
        
        # Take a subset of records to prevent massive OpenAI API costs during ingestion of large files
        sample_records = df.limit(100).toJSON().collect()
        
        if sample_records:
            print(f"Generating embeddings for {len(sample_records)} records...")
            embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
            
            client = MilvusClient(MILVUS_URI)
            if not client.has_collection(collection_name=MILVUS_COLLECTION):
                client.create_collection(
                    collection_name=MILVUS_COLLECTION,
                    dimension=1536
                )
                
            vectors = embeddings.embed_documents(sample_records)
            
            data = []
            for i, (text, vector) in enumerate(zip(sample_records, vectors)):
                data.append({
                    "id": hash(text) & ((1<<63)-1),
                    "vector": vector,
                    "text": text,
                    "source": f"spark_ingest_{os.path.basename(file_path)}",
                    "page": 0
                })
            
            res = client.insert(collection_name=MILVUS_COLLECTION, data=data)
            print(f"Successfully inserted {res.get('insert_count', len(data))} vectors into Milvus.")
        else:
            print("No records found to vectorize.")
            
    except Exception as e:
        print(f"Failed to write to Milvus: {e}")

    print("\n--- Ingestion Pipeline Completed ---")
    spark.stop()

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python spark_ingestion_layer.py <file_path> <file_type>")
        print("Supported file_types: csv, json, parquet, orc")
        sys.exit(1)
        
    file_path = sys.argv[1]
    file_type = sys.argv[2]
    
    process_file(file_path, file_type)
