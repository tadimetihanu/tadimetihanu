from pyspark.sql import SparkSession
from pyspark.sql.functions import col, rand, when
import sys

def main():
    # Retrieve output path from arguments
    output_path = sys.argv[1] if len(sys.argv) > 1 else "s3a://datalake/spark_ingested_data"

    print(f"🚀 Starting Ingestion to: {output_path}")

    # Initialize Spark Session
    # Note: Configuration for S3A is handled automatically by CloudObjectIQ backend
    spark = SparkSession.builder \
        .appName("CloudObjectIQ-Ingestion") \
        .getOrCreate()

    # 1. Generate Sample Data (Synthetic Sales Data)
    print("📈 Generating sample sales data...")
    data = spark.range(0, 1000) \
        .withColumn("sale_id", col("id")) \
        .withColumn("amount", (rand() * 1000).round(2)) \
        .withColumn("category", 
            when(col("id") % 5 == 0, "Electronics")
            .when(col("id") % 3 == 0, "Maintenance")
            .otherwise("Cleaning")) \
        .drop("id")

    # 2. Write to MinIO as Parquet
    print(f"💾 Saving data to {output_path}...")
    data.write.mode("overwrite").parquet(output_path)

    print("✅ Ingestion Completed Successfully!")
    
    # Show summary
    data.groupBy("category").count().show()

    spark.stop()

if __name__ == "__main__":
    main()
