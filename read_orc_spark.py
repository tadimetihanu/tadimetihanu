from pyspark.sql import SparkSession

def main():
    print("Initializing Spark Session with AWS S3 packages for MinIO...")
    spark = SparkSession.builder \
        .appName("Read ORC from MinIO") \
        .config("spark.jars.packages", "org.apache.hadoop:hadoop-aws:3.3.4,com.amazonaws:aws-java-sdk-bundle:1.12.262") \
        .config("spark.hadoop.fs.s3a.endpoint", "http://localhost:9000") \
        .config("spark.hadoop.fs.s3a.access.key", "minioadmin") \
        .config("spark.hadoop.fs.s3a.secret.key", "minioadmin") \
        .config("spark.hadoop.fs.s3a.path.style.access", "true") \
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem") \
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false") \
        .getOrCreate()
        
    print("Spark Session created successfully.")
    
    # Path to the ORC file in the 'datalake' bucket
    # Note: Use s3a:// prefix for Spark's S3AFileSystem
    orc_path = "s3a://datalake/TestOrcFile.test1.orc"
    print(f"Reading ORC file from: {orc_path}")
    
    try:
        # Read the ORC file directly
        df = spark.read.orc(orc_path)
        
        # Show schema and some rows
        print("\n--- ORC Schema ---")
        df.printSchema()
        
        print("\n--- ORC Data ---")
        df.show(5, truncate=False)
        
    except Exception as e:
        print(f"Error reading ORC file: {e}")
    finally:
        spark.stop()

if __name__ == "__main__":
    main()
