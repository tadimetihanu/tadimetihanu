from pyspark.sql import SparkSession
import os

# Initialize Spark Session
spark = SparkSession.builder \
    .appName("LogisticsDataGenerator") \
    .getOrCreate()

print("🚛 [Spark] Generating Synthetic Global Logistics Data...")

# Create 100,000 rows of rich logistics data
df = spark.range(100000).selectExpr(
    "(100000 + id) AS shipment_id",
    "CASE WHEN rand() > 0.8 THEN 'Air' WHEN rand() > 0.5 THEN 'Sea' ELSE 'Ground' END AS transport_mode",
    "CASE WHEN rand() > 0.9 THEN 'Critical' WHEN rand() > 0.6 THEN 'High' ELSE 'Standard' END AS priority",
    "CAST(rand() * 500 + 50 AS DOUBLE) AS weight_kg",
    "CAST(rand() * 2000 + 100 AS DOUBLE) AS shipping_cost_usd",
    "CASE WHEN rand() > 0.7 THEN 'Delivered' WHEN rand() > 0.3 THEN 'In Transit' ELSE 'Pending' END AS status",
    "date_sub(current_date(), cast(rand() * 30 as int)) AS shipment_date",
    "concat('Hub_', cast(rand() * 10 + 1 as int)) AS origin_hub"
)

# Output Path (mapped to host ./spark_data)
output_path = "/opt/spark/data/logistics_performance_2026.orc"

print(f"💾 [Spark] Saving ORC to {output_path}...")
df.write.mode("overwrite").orc(output_path)

print("✅ [Spark] Data Generation Complete.")
spark.stop()
