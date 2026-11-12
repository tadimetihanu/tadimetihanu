import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

from ml_service.trainer import get_tenant_model
from ml_service.db_loader import load_historical_telemetry
from ml_service.recommender import generate_recommendations

print("Testing ML Service Trainer and Recommender...")

# 1. Load telemetry
df = load_historical_telemetry("default")
print(f"Loaded {len(df)} telemetry samples for tenant 'default'.")

# 2. Train tenant model
model = get_tenant_model("default")
metrics = model.train(df)
print("Training Metrics:", metrics)
assert model.is_trained, "Model should be trained"
assert "scan_r2" in metrics, "Metrics should contain scan_r2"

# 3. Test prediction
sample_features = {
    "query_type": "AGGREGATE",
    "storage_provider": "s3",
    "file_format": "parquet",
    "cache_status": "MISS",
    "file_count": 2,
    "total_file_size_bytes": 50 * 1024 * 1024,
    "join_count": 1,
    "filter_count": 1,
    "projection_count": 4,
    "selected_column_count": 4,
    "column_count": 12,
    "has_partition_filter": 1,
    "aggregation_count": 2,
    "has_wildcard": 0,
    "has_group_by": 1,
    "has_order_by": 1,
    "has_limit": 1,
    "limit_value": 100,
    "cte_count": 0,
    "query_length": 120,
    "token_count": 20
}

pred = model.predict(sample_features)
print("Prediction Result:", pred)
assert pred["predicted_scan_volume_bytes"] > 0
assert pred["predicted_execution_duration_ms"] > 0
assert pred["predicted_cost_usd"] >= 0
assert "confidence_interval" in pred

# 4. Test recommender
sql = "SELECT * FROM read_parquet('s3://datalake/orders.parquet')"
recs = generate_recommendations(sql, {"has_wildcard": 1, "filter_count": 0, "total_file_size_bytes": 60000000}, "s3", "parquet", "MISS")
print(f"Generated {len(recs)} recommendations:")
for r in recs:
    print(f" - [{r['severity']}] {r['message']}")

assert len(recs) >= 2, "Should trigger wildcard and missing partition filter recommendations"

print("✅ ML Service Tests Passed Successfully!")

