from pyspark.sql import SparkSession
import os

# Initialize Spark Session
spark = SparkSession.builder \
    .appName("ORC Generator") \
    .config("spark.jars.packages", "org.apache.hadoop:hadoop-aws:3.3.4") \
    .getOrCreate()

print("🚀 Generating Synthetic Logistics Data (ORC)...")

# Create synthetic data
data = [
    (1, "Truck_A", "Express", 450.50, "Delivered", "2026-04-20 10:00:00"),
    (2, "Truck_B", "Standard", 210.00, "In Transit", "2026-04-21 12:30:00"),
    (3, "Truck_C", "Express", 890.25, "Pending", "2026-04-22 08:15:00"),
    (4, "Plane_1", "Overnight", 2500.00, "Delivered", "2026-04-22 14:00:00"),
    (5, "Truck_A", "Express", 320.00, "Delivered", "2026-04-23 09:45:00"),
    (6, "Truck_B", "Standard", 150.00, "In Transit", "2026-04-24 11:00:00"),
    (7, "Ship_1", "Ocean", 12000.00, "Arrived", "2026-04-25T07:41:40Z")
]

columns = ["id", "vehicle", "service_type", "cost", "status", "timestamp"]

df = spark.createDataFrame(data, columns)

# Target path inside the container (mapped to host)
target_path = "/app/minio_data/datalake/logistics_performance.orc"

print(f"💾 Saving to {target_path}...")
df.write.mode("overwrite").orc(target_path)

print("✅ ORC File Generation Complete.")
spark.stop()
