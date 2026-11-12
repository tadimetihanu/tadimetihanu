# CloudObjectIQ ML Predictive Cost Intelligence – Phase 1 Architecture & Deployment Guide

## 1. Architectural Overview
CloudObjectIQ provides unified SQL analytics over multi-cloud object storage (AWS S3, Azure ADLS Gen2, MinIO, Google Drive) powered by DuckDB. 
Phase 1 introduces **ML-Powered Predictive Cost & Execution Intelligence**, giving users proactive pre-execution visibility into:
1. **Estimated Data Scanned** (bytes and human-readable format)
2. **Estimated Query Latency** (milliseconds / seconds)
3. **Estimated Financial Cost** (USD based on $5.00/TiB lakehouse standard)
4. **Statistical Confidence Intervals** (95% range for all 3 targets)
5. **Actionable Optimization Recommendations** (anti-pattern detection for missing filters, wildcard projections, uncompressed file formats, and unpruned joins)

The existing DuckDB execution engine and real-time **Live Burn** monitoring remain intact, while query telemetry and predictions are paired in a **closed feedback loop** for continuous self-learning model retraining.

```
┌────────────────────────────────────────────────────────┐
│               Frontend: SQL Workstation                │
│  [Query Editor]  [🔮 Predict Cost]  [Execute Query]    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 🤖 ML PREDICTIVE INTELLIGENCE PANEL (Forecast)   │  │
│  │ Est Scan: 24.5 MB | Est Latency: 280ms | $0.0001 │  │
│  │ 💡 Recommendations: Avoid SELECT *, Add Filter   │  │
│  │ 🎯 Feedback Loop: 97.1% Forecast Accuracy        │  │
│  └──────────────────────────────────────────────────┘  │
│  [🔴 Live Burn: $0.000000 USD (Actual Incurred Fee)]   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Node.js Gateway & Server                 │
│  • RBAC & Tenant Isolation Middleware                  │
│  • SQL Plan Feature Extractor (feature_extractor.js)   │
│  • Proxy & High-Availability Resilient Fallback        │
│  • Closed Feedback Recorder (ml_prediction.js)         │
└─────────────┬────────────────────────────┬─────────────┘
              │                            │
              ▼ (Async Internal API)       ▼ (SQL Engine)
┌───────────────────────────┐   ┌────────────────────────┐
│   Python FastAPI ML Core  │   │     DuckDB Engine      │
│ • XGBoost Scan Regressor  │   │ • Local SSD Material.  │
│ • XGBoost Latency Model   │   │ • Live Burn Calculation│
│ • XGBoost Cost Regressor  │   │ • Cloud Object Scans   │
│ • Recommendation Engine   │   └───────────┬────────────┘
│ • Tenant Model Registry   │               │
└─────────────┬─────────────┘               │
              │                             │
              ▼                             ▼
┌────────────────────────────────────────────────────────┐
│                 Metadata & Storage                     │
│  • query_telemetry: Granular execution features        │
│  • prediction_feedback: Prediction vs Actual variance  │
│  • ml_model_registry: Versioned tenant model artifacts │
│  • metadata_catalog: Multi-cloud file & schema cache   │
└────────────────────────────────────────────────────────┘
```

---

## 2. Telemetry Collection
Every executed SQL query records telemetry via `query_telemetry` and `query_logs`:
- **Execution & Tenant Context**: `execution_id`, `tenant_id`, `user_id`, `target_id`.
- **Query Plan & AST Features**: `query_type` (SELECT, AGGREGATE, JOIN, FILTER, DESCRIBE), `join_count`, `filter_count`, `projection_count`, `aggregation_count`, `has_wildcard`, `has_group_by`, `has_order_by`, `limit_value`, `cte_count`, `query_length`.
- **Storage & File Metadata**: `storage_provider` (`s3`, `adls`, `minio`, `gdrive`, `local`), `file_format` (`parquet`, `orc`, `csv`, `json`, `iceberg`), `file_count`, `total_file_size_bytes`.
- **Performance & Cost Actuals**: `actual_scan_bytes`, `duration_ms`, `actual_cost_usd`, `on_demand_cost_usd`, `cache_status` (MISS, HIT, LOCAL).

---

## 3. Machine Learning Microservice (`ml_service/`)
Built with Python 3.12, FastAPI, Pandas, Scikit-learn, and XGBoost:
- **`ScanVolumeRegressor`**: Predicts byte volume using `xgb.XGBRegressor` trained with `ColumnTransformer` (OneHotEncoder for categorical features + StandardScaler for numerical plan features).
- **`ExecutionTimeRegressor`**: Predicts latency in milliseconds.
- **`QueryCostRegressor`**: Predicts egress billing fee under lakehouse pricing rules.
- **Confidence Intervals**: 95% confidence intervals computed via residual standard error (`predicted ± 1.96 * SE`), with non-negative lower bounds for scan and cost.
- **Tenant Isolation**: Models are trained and partitioned strictly by `tenant_id` into `artifacts/{tenant_id}/{version}/`.

---

## 4. API Endpoints

### 4.1 Predict Query Cost
`POST /api/ml/predict-query-cost`
- **Request Body**:
```json
{
  "sql": "SELECT category, SUM(amount) FROM 's3://datalake/sales.parquet' WHERE region = 'US' GROUP BY 1",
  "targetId": "6c59252c-9112-46f4-a070-9fc548fb8253",
  "cacheStatus": "MISS"
}
```
- **Response**:
```json
{
  "success": true,
  "predicted_scan_volume_bytes": 18432000,
  "predicted_scan_volume_formatted": "17.6 MB",
  "predicted_execution_duration_ms": 285,
  "predicted_execution_duration_formatted": "285 ms",
  "predicted_cost_usd": 0.000084,
  "predicted_cost_formatted": "$0.000084 USD",
  "confidence_score": 92.5,
  "confidence_level": "High",
  "confidence_interval": {
    "scan_bytes": { "lower": 14500000, "upper": 22300000 },
    "duration_ms": { "lower": 220, "upper": 350 },
    "cost_usd": { "lower": 0.000066, "upper": 0.000101 }
  },
  "optimization_recommendations": [
    {
      "id": "rec_missing_partition_filter",
      "type": "partition_pruning",
      "severity": "warning",
      "message": "Full dataset scan detected without WHERE filters. Add partition filters to eliminate unneeded files.",
      "potential_savings": "50-95% scan and cost reduction"
    }
  ],
  "model_version": "v1.0.0",
  "algorithm": "XGBoost Regressor (Scikit-Learn)"
}
```

### 4.2 Retrain Tenant Models
`POST /api/ml/train` (Admin Only)
- **Request Body**: `{ "tenantId": "default" }`
- **Response**:
```json
{
  "success": true,
  "tenant_id": "default",
  "version": "v1.1.0",
  "sample_count": 210,
  "metrics": {
    "scan_r2": 0.88,
    "scan_mae_bytes": 4200000,
    "time_r2": 0.82,
    "time_mae_ms": 48.2,
    "cost_r2": 0.91,
    "cost_mae_usd": 0.000015
  }
}
```

### 4.3 Feedback Audit History
`GET /api/ml/feedback`
- Returns logged variance records comparing predicted scan, time, and cost against actual execution metrics.

---

## 5. Closed Feedback Loop
1. When a query is analyzed before execution, a pre-execution record is logged in `prediction_feedback`.
2. Upon user execution, `DuckDB` finishes query execution and calculates actual scan metrics.
3. `recordExecutionTelemetryAndFeedback` calculates variance and absolute percentage error:
   $$\text{Error}_{\text{scan}} = \text{Actual} - \text{Predicted}$$
   $$\text{Error \%} = \frac{|\text{Actual} - \text{Predicted}|}{\text{Actual}} \times 100\%$$
4. Validated historical data is fed back into model retraining cycles.

---

## 6. Enterprise Requirements & Compliance
- **Tenant Isolation**: Telemetry records and trained models are strictly partitioned by `tenant_id`. No cross-tenant data sharing.
- **RBAC Enforcement**: Model retraining (`/api/ml/train`) requires Admin privileges. Workstation predictions are accessible to analysts and data engineers.
- **Credential Management**: Communication between Node.js and Python ML microservice uses mutual `ML_SERVICE_API_KEY`.
- **Zero Third-Party AI Data Leakage**: SQL queries and schema metadata are processed exclusively on self-hosted XGBoost and Scikit-learn regressors without external AI API transmission.
- **High Availability**: If the Python service is offline, Node.js transparently invokes the built-in statistical fallback regressor.

---

## 7. Kubernetes Deployment Instructions

### 7.1 Build & Push Images
```bash
# 1. Build and push Node.js application image
docker build -t <ACR_OR_DOCKERHUB>/cloudobjectiq:v1 -f Dockerfile .
docker push <ACR_OR_DOCKERHUB>/cloudobjectiq:v1

# 2. Build and push Python ML Service image
docker build -t <ACR_OR_DOCKERHUB>/cloudobjectiq-ml:v1 -f ml_service/Dockerfile .
docker push <ACR_OR_DOCKERHUB>/cloudobjectiq-ml:v1
```

### 7.2 Apply Secrets & ConfigMaps
```bash
kubectl create secret generic cloudobjectiq-secrets \
  --from-literal=jwt-secret="enterprise_jwt_secret_2026" \
  --from-literal=ml-service-api-key="cloudobjectiq_ml_internal_key_2026" \
  --from-literal=database-url="postgresql://ciquser:ciqpass@postgres-service:5432/cloudobjectiq"
```

### 7.3 Deploy to Kubernetes Cluster
```bash
# Deploy Python ML service with ClusterIP and HorizontalPodAutoscaler
kubectl apply -f k8s/ml-service-deployment.yaml

# Deploy CloudObjectIQ backend and frontend with LoadBalancer
kubectl apply -f k8s/deployment.yaml

# Verify pod status
kubectl get pods -l 'app in (cloudobjectiq, cloudobjectiq-ml)'
kubectl get svc cloudobjectiq-ml-service
```

