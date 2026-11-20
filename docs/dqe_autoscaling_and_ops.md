# CloudObjectIQ – Distributed Query Execution (DQE) & Autoscaling Operations Guide

## 1. System Architecture

CloudObjectIQ evolves into an intelligent multi-engine federated lakehouse platform:

```
                            SQL Workstation / UI
                                     │
                                     ▼
                        CloudObjectIQ Query Router
                       (Feature Flags & Heuristics)
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        DuckDB Engine           Doris Engine           Spark Engine
     (Single-Node Vector)     (Distributed MPP)      (Distributed Batch)
              │                      │                      │
     Queries < 5GB Parquet    Joins, Aggregations,      Hadoop / ORC
       Interactive / CSV       Enterprise Big Data       ETL Pipelines
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     ▼
                    Cloud Object Storage & Catalogs
                (AWS S3, Azure ADLS Gen2, Cloudflare R2,
                     MinIO, Apache Iceberg Tables)
```

---

## 2. Engine Matrix & Selection Heuristics

| Engine | Ideal Workload | Size Profile | Formats | Distributed |
|---|---|---|---|---|
| **DuckDB** | Fast interactive analytics, single-table aggregations, exploratory queries | 0 MB – 5 GB | Parquet, CSV, JSON, Iceberg | No (In-Process) |
| **Apache Doris** | High concurrency, large multi-table distributed joins, heavy group-by | 5 GB – 100+ TB | Parquet, ORC, CSV, Multi-Catalog | Yes (MPP) |
| **Apache Spark** | Long-running batch ETL, Hadoop workloads, legacy ORC clusters | 100 GB – PBs | ORC, Parquet, HDFS | Yes (Batch/MapReduce) |

---

## 3. Intelligent AUTO Routing Heuristics

When a query is submitted under `AUTO` mode:
1. **Format Check**: Queries referencing `.orc`, `read_orc`, or `hdfs://` automatically route to **Spark**.
2. **Feature Gate**: If `ENABLE_DORIS_ENGINE` is `false` (default), all queries route to **DuckDB**.
3. **Scan Volume & Join Heuristics**: If Doris is enabled:
   - Queries with estimated scan size > 5,000 MB (5 GB) route to **Doris**.
   - Queries with 2+ multi-table joins and scan size > 1,000 MB route to **Doris**.
   - Queries with high-cardinality `COUNT(DISTINCT ...)` aggregations and scan size > 2,000 MB route to **Doris**.
4. **Conservative Default**: All other queries execute on **DuckDB** for minimum latency.

---

## 4. Autoscaling & Capacity Management Policy

### Guiding Principles
- **No CPU-only Autoscaling**: CPU spikes occur during normal vectorized query execution. Autoscaling Doris Backend (BE) nodes purely on CPU causes thrashing and query interruption.
- **Queue-Aware Scaling**: Scale-up triggers when active query queue depth > 5 sustained for 60 seconds.
- **Graceful Decommissioning**: **Never abruptly delete BE pods**. A BE pod must be decommissioned via `ALTER SYSTEM DECOMMISSION BACKEND` before scaling down.

### Kubernetes Horizontal Pod Autoscaler (HPA) Specification
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: doris-be-hpa
  namespace: cloudobjectiq-dqe
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: doris-be
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 75
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 20
          periodSeconds: 120
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
```

---

## 5. Rollback Plan & Operational Flags

DQE and Doris capabilities are protected by feature flags (`src/utils/feature_flags.js`).

### Emergency Immediate Rollback
If Doris becomes unreachable or experiences cluster degradation, disable it instantly without rebuilding or restarting the application:

```bash
# In .env or Kubernetes Deployment Environment:
ENABLE_DORIS_ENGINE=false
ENABLE_DQE=false
ENABLE_AUTO_ROUTING=false
```

Once disabled, 100% of query traffic immediately falls back to DuckDB and Spark with zero interruption to active users.
