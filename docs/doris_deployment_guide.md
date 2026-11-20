# CloudObjectIQ – Apache Doris Deployment & Operations Guide

## Overview

CloudObjectIQ introduces **Apache Doris** as an optional, high-throughput Distributed Query Execution (DQE) engine. Doris executes massively parallel queries against cloud object storage (S3, Cloudflare R2, Azure Blob Storage, MinIO) without loading data into internal storage, leveraging **Doris Multi-Catalog**.

---

## 1. Local Development Stack (Docker Compose)

For local development and testing, run the containerized Doris FE and BE stack:

```bash
docker compose -f docker-compose.doris.yml up -d
```

### Endpoints (Localhost Bound)
- **FE MySQL Client Port**: `127.0.0.1:9030`
- **FE Web Console / REST**: `http://127.0.0.1:8030`
- **BE Health Endpoint**: `http://127.0.0.1:8040/api/health`

### Verification
```bash
# Verify FE bootstrap
curl -s http://localhost:8030/api/bootstrap

# Connect via MySQL client (default user 'root', blank password)
mysql -h 127.0.0.1 -P 9030 -u root

# Within MySQL prompt:
SHOW FRONTENDS\G
SHOW BACKENDS\G
```

---

## 2. Kubernetes Dev/Test Deployment

The Kubernetes manifests are located in `k8s/doris-dev-deployment.yaml`. They deploy an isolated cluster in the `cloudobjectiq-dqe` namespace:
- **StatefulSet `doris-fe`**: 1 replica with persistent metadata volume (`doris-meta`).
- **StatefulSet `doris-be`**: 2 replicas with persistent execution/storage volume (`doris-storage`).
- **Headless & ClusterIP Services**: Internal cluster routing, no external public LoadBalancer.

### Applying to Cluster
```bash
kubectl apply -f k8s/doris-dev-deployment.yaml
```

### Checking Status
```bash
kubectl get pods -n cloudobjectiq-dqe -o wide
kubectl logs -n cloudobjectiq-dqe -l app=doris-fe --tail=50
kubectl logs -n cloudobjectiq-dqe -l app=doris-be --tail=50
```

### Backend Registration
In Kubernetes, when BE pods start up, register them with FE if not automatically discovered:
```sql
ALTER SYSTEM ADD BACKEND "doris-be-0.doris-be-service.cloudobjectiq-dqe.svc.cluster.local:9050";
ALTER SYSTEM ADD BACKEND "doris-be-1.doris-be-service.cloudobjectiq-dqe.svc.cluster.local:9050";
```

---

## 3. Multi-Catalog Object Storage Configuration

CloudObjectIQ queries cloud storage directly by mounting targets as Doris External Catalogs.

### S3 / Cloudflare R2 / MinIO Example
```sql
CREATE CATALOG IF NOT EXISTS cloudobjectiq_s3 PROPERTIES (
    "type" = "s3",
    "s3.endpoint" = "https://<account_id>.r2.cloudflarestorage.com",
    "s3.access_key" = "<access_key>",
    "s3.secret_key" = "<secret_key>",
    "s3.region" = "auto",
    "use_path_style" = "true"
);

-- Query directly via S3 table-valued functions or external catalog
SELECT count(*) 
FROM s3(
  "uri" = "s3://my-bucket/orders/*.parquet",
  "s3.access_key" = "...",
  "s3.secret_key" = "...",
  "s3.endpoint" = "https://...",
  "format" = "parquet"
);
```

---

## 4. Operational Runbook & Safe Scale-Down

When scaling down BE instances, **never forcefully delete or abruptly terminate BE pods**.
Always decommission through Doris first:

```sql
-- 1. Notify FE to migrate any cache or tablet metadata safely
ALTER SYSTEM DECOMMISSION BACKEND "doris-be-1.doris-be-service.cloudobjectiq-dqe.svc.cluster.local:9050";

-- 2. Verify decommission status
SHOW BACKENDS\G

-- 3. Once Decommissioned is TRUE, scale down the StatefulSet
kubectl scale statefulset doris-be -n cloudobjectiq-dqe --replicas=1
```
