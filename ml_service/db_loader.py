import os
import sqlite3
import pandas as pd
import numpy as np
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "metadata.db")

def get_db_connection():
    # If POSTGRES_URL / DATABASE_URL is defined, use psycopg2
    pg_url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if pg_url:
        import psycopg2
        return psycopg2.connect(pg_url)
    
    # Fallback to local SQLite
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def generate_synthetic_seed_telemetry(tenant_id: str = "default", sample_count: int = 120) -> pd.DataFrame:
    """
    Generates realistic historical query telemetry for training when the database is freshly initialized.
    Covers Parquet, ORC, CSV, ADLS, S3, MinIO, Joins, Aggregates, Wildcards, and Caches.
    """
    np.random.seed(42)
    records = []
    
    providers = ["s3", "adls", "minio", "local"]
    formats = ["parquet", "orc", "csv"]
    query_types = ["SELECT", "AGGREGATE", "JOIN", "FILTER"]
    cache_statuses = ["MISS", "HIT", "LOCAL"]
    
    for i in range(sample_count):
        provider = np.random.choice(providers, p=[0.4, 0.35, 0.2, 0.05])
        fmt = np.random.choice(formats, p=[0.7, 0.2, 0.1])
        q_type = np.random.choice(query_types, p=[0.3, 0.35, 0.25, 0.1])
        cache_status = np.random.choice(cache_statuses, p=[0.7, 0.25, 0.05])
        
        file_count = int(np.random.choice([1, 2, 4, 8, 16], p=[0.5, 0.25, 0.15, 0.07, 0.03]))
        base_file_size = int(np.random.uniform(5 * 1024 * 1024, 250 * 1024 * 1024))
        total_file_size_bytes = base_file_size * file_count
        
        join_count = int(np.random.choice([0, 1, 2, 3], p=[0.6, 0.25, 0.1, 0.05])) if q_type in ["JOIN", "AGGREGATE"] else 0
        filter_count = int(np.random.choice([0, 1, 2, 3, 4], p=[0.25, 0.4, 0.2, 0.1, 0.05]))
        projection_count = int(np.random.choice([1, 2, 5, 10, 25], p=[0.2, 0.35, 0.25, 0.15, 0.05]))
        aggregation_count = int(np.random.choice([0, 1, 2, 4], p=[0.5, 0.3, 0.15, 0.05])) if q_type == "AGGREGATE" else 0
        has_wildcard = 1 if projection_count > 15 or np.random.rand() < 0.2 else 0
        has_group_by = 1 if aggregation_count > 0 and np.random.rand() < 0.8 else 0
        has_order_by = 1 if np.random.rand() < 0.4 else 0
        has_limit = 1 if np.random.rand() < 0.5 else 0
        limit_value = int(np.random.choice([10, 50, 100, 1000])) if has_limit else -1
        cte_count = 1 if np.random.rand() < 0.15 else 0
        query_length = int(np.random.uniform(40, 350))
        token_count = int(query_length / 6)
        
        # Calculate realistic actual scanned bytes based on storage format and projection pruning:
        if fmt == "parquet":
            # Parquet prunes columns and row groups
            col_ratio = 1.0 if has_wildcard else min(1.0, max(0.08, projection_count * 0.05))
            filter_ratio = 1.0 if filter_count == 0 else max(0.15, 1.0 - (filter_count * 0.22))
            actual_scan_bytes = int(total_file_size_bytes * col_ratio * filter_ratio)
        elif fmt == "orc":
            col_ratio = 1.0 if has_wildcard else min(1.0, max(0.10, projection_count * 0.06))
            filter_ratio = 1.0 if filter_count == 0 else max(0.20, 1.0 - (filter_count * 0.20))
            actual_scan_bytes = int(total_file_size_bytes * col_ratio * filter_ratio)
        else: # CSV
            # CSV scans full text file
            actual_scan_bytes = total_file_size_bytes
            
        actual_scan_bytes = max(1024, actual_scan_bytes)
        
        # Calculate realistic execution duration (ms)
        # Latency factors: network provider + scan volume + join complexity + aggregation
        provider_base_ms = {"s3": 45, "adls": 55, "minio": 15, "local": 5}[provider]
        scan_time_ms = (actual_scan_bytes / (1024 * 1024)) * 3.5  # ~3.5 ms per MB
        join_overhead_ms = join_count * 120.0
        agg_overhead_ms = aggregation_count * 45.0
        
        if cache_status == "HIT":
            duration_ms = int(max(8, provider_base_ms * 0.2 + (scan_time_ms * 0.05) + join_overhead_ms * 0.5))
            actual_cost_usd = 0.0
        else:
            duration_ms = int(max(15, provider_base_ms + scan_time_ms + join_overhead_ms + agg_overhead_ms + np.random.normal(0, 15)))
            # Standard lakehouse $5.00 per TiB
            tib = 1024.0 ** 4
            actual_cost_usd = round((actual_scan_bytes / tib) * 5.0, 7)
            
        records.append({
            "tenant_id": tenant_id,
            "query_type": q_type,
            "storage_provider": provider,
            "file_format": fmt,
            "cache_status": cache_status,
            "file_count": file_count,
            "total_file_size_bytes": total_file_size_bytes,
            "join_count": join_count,
            "filter_count": filter_count,
            "projection_count": projection_count,
            "aggregation_count": aggregation_count,
            "has_wildcard": has_wildcard,
            "has_group_by": has_group_by,
            "has_order_by": has_order_by,
            "has_limit": has_limit,
            "limit_value": limit_value,
            "cte_count": cte_count,
            "query_length": query_length,
            "token_count": token_count,
            "actual_scan_bytes": actual_scan_bytes,
            "duration_ms": duration_ms,
            "actual_cost_usd": actual_cost_usd
        })
        
    return pd.DataFrame(records)

def load_historical_telemetry(tenant_id: str = "default") -> pd.DataFrame:
    """
    Loads telemetry records from the database partitioned by tenant_id.
    If database records are few, merges with realistic domain seed records.
    """
    db_df = pd.DataFrame()
    try:
        conn = get_db_connection()
        query = """
            SELECT 
                tenant_id, query_type, storage_provider, file_format, cache_status,
                file_count, total_file_size_bytes, join_count, filter_count,
                projection_count, aggregation_count, has_wildcard,
                actual_scan_bytes, duration_ms, actual_cost_usd
            FROM query_telemetry
            WHERE tenant_id = ? OR tenant_id IS NULL
        """
        # For Postgres parameter substitution
        if os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL"):
            query = query.replace("?", "%s")
            
        db_df = pd.read_sql_query(query, conn, params=[tenant_id])
        conn.close()
    except Exception as e:
        print(f"Notice: Failed to read from query_telemetry table ({e}). Using synthetic seeds.")

    # If telemetry table has fewer than 20 rows, complement with synthetic telemetry
    if len(db_df) < 20:
        seed_df = generate_synthetic_seed_telemetry(tenant_id=tenant_id, sample_count=150)
        if not db_df.empty:
            combined = pd.concat([seed_df, db_df], ignore_index=True)
            return combined
        return seed_df
        
    return db_df

