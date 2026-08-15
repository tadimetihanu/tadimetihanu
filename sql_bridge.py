import sys
import argparse
import re
import json
import os
from pyspark.sql import SparkSession

def translate_query(sql, spark):
    print("🔄 Translating query for Spark engine...")
    # Normalize prefixes for Spark compatibility
    sql = sql.replace('az://', 'wasbs://').replace('s3://', 's3a://')
    
    # Extract account for wasbs expansion if needed
    # We look for the first account key in the config to guess the target account
    conf = spark.sparkContext.getConf().getAll()
    account = None
    for k, v in conf:
        if 'fs.azure.account.key' in k:
            account = k.split('.')[-5] # Extract 'account' from 'fs.azure.account.key.account.blob...'
            break

    matches = re.findall(r"read_(orc|parquet)\s*\(\s*'([^']+)'\s*\)", sql, re.IGNORECASE)
    new_sql = sql
    for i, (fmt, path) in enumerate(matches):
        # Expand wasbs://container/path to wasbs://container@account.blob.core.windows.net/path
        if path.startswith('wasbs://') and account and '@' not in path:
            parts = path.replace('wasbs://', '').split('/', 1)
            container = parts[0]
            rest = parts[1] if len(parts) > 1 else ""
            old_path = path
            path = f"abfss://{container}@{account}.dfs.core.windows.net/{rest}"
            print(f"📍 Expanded ADLS {old_path} -> {path}")

        view_name = f"temp_view_{fmt}_{i}"
        print(f"📖 Reading {fmt} from: {path}")
        if fmt.lower() == 'orc':
            df = spark.read.orc(path)
        else:
            df = spark.read.parquet(path)
        df.createOrReplaceTempView(view_name)
        
        # Careful replacement to avoid partial matches
        pattern = rf"read_{fmt}\s*\(\s*'{re.escape(path if '@' not in path else matches[i][1])}'\s*\)"
        new_sql = re.sub(pattern, view_name, new_sql, flags=re.IGNORECASE)
    
    print(f"✅ Translation complete. Final SQL: {new_sql}")
    return new_sql

def main():
    print("🚀 SQL Bridge starting...")
    print(f"DEBUG: sys.argv = {sys.argv}")
    
    parser = argparse.ArgumentParser(description='CloudObjectIQ Spark SQL Bridge (with Table Support)')
    parser.add_argument('--sql', type=str)
    
    # Use parse_known_args to handle cases where values might start with hyphens
    args, unknown = parser.parse_known_args()
    
    # Fallback: if --sql wasn't caught correctly but we have arguments
    sql_query = args.sql
    if not sql_query and unknown:
        # If the first 'unknown' looks like it was meant for --sql
        if unknown[0].strip().startswith('--'):
            sql_query = " ".join(unknown)
        else:
            sql_query = unknown[0]
            
    if not sql_query:
        print("❌ Error: No SQL query provided. Use --sql \"query\"")
        sys.exit(1)

    print("🔧 Initializing SparkSession...")
    builder = SparkSession.builder.appName("CloudObjectIQ_SQL_Grid_Bridge")
    
    spark = builder.getOrCreate()
    print("✨ SparkSession ready.")
    
    # Configure S3A for MinIO only if not already provided via --conf
    hadoop_conf = spark._jsc.hadoopConfiguration()
    if not hadoop_conf.get("fs.s3a.endpoint"):
        import socket
        try:
            minio_ip = socket.gethostbyname('cloudobject_iq_minio')
            minio_endpoint = os.environ.get('MINIO_ENDPOINT', f'http://{minio_ip}:9000')
        except:
            minio_endpoint = os.environ.get('MINIO_ENDPOINT', 'http://cloudobject_iq_minio:9000')
        minio_access_key = os.environ.get('MINIO_ACCESS_KEY', 'minioadmin')
        minio_secret_key = os.environ.get('MINIO_SECRET_KEY', 'minioadmin')
        
        hadoop_conf.set("fs.s3a.endpoint", minio_endpoint)
        hadoop_conf.set("fs.s3a.endpoint.region", "us-east-1")
        hadoop_conf.set("fs.s3a.access.key", minio_access_key)
        hadoop_conf.set("fs.s3a.secret.key", minio_secret_key)
        hadoop_conf.set("fs.s3a.path.style.access", "true")
        hadoop_conf.set("fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        hadoop_conf.set("fs.s3a.connection.ssl.enabled", "false")
        hadoop_conf.set("fs.s3a.aws.credentials.provider", "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")

    try:
        translated_sql = translate_query(sql_query, spark)
        print(f"🖥️  Executing SQL: {translated_sql}")
        df = spark.sql(translated_sql)
        
        print("📥 Collecting results (limit 100)...")
        rows = df.limit(100).collect()
        data = [row.asDict(recursive=True) for row in rows]
        
        def default_serializer(obj):
            import datetime
            from decimal import Decimal
            if isinstance(obj, (datetime.date, datetime.datetime)):
                return obj.isoformat()
            if isinstance(obj, Decimal):
                return float(obj)
            return str(obj)

        result_path = '/app/data/spark_result.json'
        print(f"💾 Saving {len(data)} rows to {result_path}")
        with open(result_path, 'w') as f:
            json.dump(data, f, default=default_serializer)
            
        print("🏁 Query Successful")
        df.show(5, truncate=False)
    except Exception as e:
        print(f"❌ Query Failed: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        print("🔌 Stopping SparkSession...")
        spark.stop()

if __name__ == "__main__":
    main()
