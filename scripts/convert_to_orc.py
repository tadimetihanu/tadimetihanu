from pyspark.sql import SparkSession
import sys
import os

# Initialize Spark Session
spark = SparkSession.builder \
    .appName("ParquetToOrcConverter") \
    .getOrCreate()

input_path = "/app/minio_data/datalake/logistics_performance_2026.parquet"
output_path = "/app/minio_data/datalake/logistics_performance_2026.orc"

print(f"🔄 Converting {input_path} to ORC...")

if not os.path.exists(input_path):
    # Try alternate path if /app mapping is different
    alt_path = "/opt/spark/data/logistics_performance_2026.parquet"
    if os.path.exists(alt_path):
        input_path = alt_path
    else:
        print(f"❌ Error: Input file not found at {input_path}")
        sys.exit(1)

try:
    df = spark.read.parquet(input_path)
    print(f"📥 Loaded {df.count()} rows.")
    
    print(f"💾 Saving ORC to {output_path}...")
    df.write.mode("overwrite").orc(output_path)
    print(f"✅ Conversion successful: {output_path}")
except Exception as e:
    print(f"❌ Conversion failed: {str(e)}")
    sys.exit(1)
finally:
    spark.stop()
