import re
from typing import List, Dict, Any

def generate_recommendations(sql: str, features: Dict[str, Any], storage_provider: str, file_format: str, cache_status: str) -> List[Dict[str, Any]]:
    recommendations = []
    clean_sql = (sql or "").strip().upper()
    
    # 1. Check Wildcard SELECT *
    has_wildcard = features.get("has_wildcard", 0) or bool(re.search(r'\bSELECT\s+(?:DISTINCT\s+)?\*|\.\*', clean_sql))
    proj_count = features.get("projection_count", 1)
    file_size = features.get("total_file_size_bytes", 0)
    
    if has_wildcard:
        recommendations.append({
            "id": "rec_avoid_wildcard",
            "type": "projection_optimization",
            "severity": "warning",
            "message": "Avoid `SELECT *` projection. Specifying only required columns leverages columnar pruning (Parquet/ORC) and can reduce scanned bytes by 70-90%.",
            "potential_savings": "Up to 85% byte scan reduction"
        })
    elif proj_count > 15:
        recommendations.append({
            "id": "rec_high_column_count",
            "type": "projection_optimization",
            "severity": "tip",
            "message": f"Query projects {proj_count} columns. Verifying if all columns are needed in downstream processing will minimize memory and deserialization overhead.",
            "potential_savings": "15-30% latency reduction"
        })

    # 2. Check Missing Partition / Range Filter
    filter_count = features.get("filter_count", 0)
    query_type = features.get("query_type", "SELECT")
    if filter_count == 0 and query_type not in ["DESCRIBE", "SHOW"]:
        recommendations.append({
            "id": "rec_missing_partition_filter",
            "type": "partition_pruning",
            "severity": "critical" if file_size > 50000000 else "warning",
            "message": "Full dataset scan detected without WHERE filters. Add partition or range filters (e.g. date, region, tenant_id) to enable partition pruning and eliminate scanning unneeded files.",
            "potential_savings": "50-95% scan and cost reduction"
        })

    # 3. Check File Format Efficiency
    fmt = (file_format or "parquet").lower()
    if fmt == "csv":
        recommendations.append({
            "id": "rec_convert_to_parquet",
            "type": "storage_format",
            "severity": "warning",
            "message": "Query scans raw uncompressed CSV data. Converting this dataset to Parquet or ORC provides columnar compression, statistics-based row group skipping, and 5-10x execution speedups.",
            "potential_savings": "75% storage & scan savings"
        })
    elif fmt == "json":
        recommendations.append({
            "id": "rec_convert_json_to_parquet",
            "type": "storage_format",
            "severity": "tip",
            "message": "JSON requires row-oriented schema inference and string parsing. Converting to Parquet enables zero-copy deserialization.",
            "potential_savings": "60% latency improvement"
        })

    # 4. Check Multi-Join Complexity
    join_count = features.get("join_count", 0)
    if join_count >= 2 and filter_count == 0:
        recommendations.append({
            "id": "rec_unfiltered_joins",
            "type": "join_optimization",
            "severity": "warning",
            "message": f"Query contains {join_count} JOIN operations without early predicate filtering. Filtering dimension tables before joining prevents combinatorial row explosion.",
            "potential_savings": "3x - 5x query speedup"
        })

    # 5. Check Global Aggregations without Limit or Group By
    agg_count = features.get("aggregation_count", 0)
    has_group = features.get("has_group_by", 0)
    has_limit = features.get("has_limit", 0)
    if agg_count > 0 and not has_group and not has_limit and "COUNT(1)" not in clean_sql and "COUNT(*)" not in clean_sql:
        recommendations.append({
            "id": "rec_approximate_aggregates",
            "type": "aggregation_tuning",
            "severity": "tip",
            "message": "For large analytic datasets, evaluate using approximate aggregate functions (e.g., `approx_count_distinct`) to accelerate aggregation passes.",
            "potential_savings": "40% faster execution"
        })

    # 6. Check Caching Status
    if cache_status in ["MISS", "PURGED"]:
        recommendations.append({
            "id": "rec_cache_miss_priming",
            "type": "caching_strategy",
            "severity": "tip",
            "message": "Cache MISS: Remote storage I/O required. Once executed, subsequent identical queries on this target will read from hot SSD cache with 0.0s cloud transfer latency and $0 on-demand cost.",
            "potential_savings": "100% cost reduction on subsequent runs"
        })

    return recommendations

