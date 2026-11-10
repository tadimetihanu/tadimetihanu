# CloudObjectIQ Cross-Source Data Federation — Deployment & Operations Guide

## 1. Architecture Overview

The Cross-Source Data Federation subsystem (`src/federation/`) integrates directly into the existing **CloudObjectIQ** platform (`src/server.js`, `src/db/index.js`, `public/index.html`, `public/app.js`) without requiring a separate microservice or breaking existing `metadata.db` / PostgreSQL tables.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   CloudObjectIQ Enterprise Frontend                        │
│  [Catalog Explorer] [Visual Join Builder] [SQL Editor] [Execution Plan DAG]│
│  [Source-Level Scan Metrics] [Live Burn Cost Insights] [Query History]     │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ REST API (/api/federation/*)
┌───────────────────────────────────────▼────────────────────────────────────┐
│               Federation Control Plane & Security Guard                    │
│  - JWT Authentication (`src/middleware/auth.js`)                           │
│  - Tenant Isolation (`tenant_id`) & RBAC (`federation_access_policies`)    │
│  - AES-256-GCM Credential Encryption & Redaction (`src/federation/crypto`) │
│  - SQL Safety & DDL/DML Injection Blocker (`src/federation/planner.js`)    │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼────────────────────────────────────┐
│              Federation Query Planner & Pushdown Optimizer                 │
│  - 3-Part Name Resolver (`catalog.schema.table`)                           │
│  - Projection Pushdown (Column Pruning per table alias)                    │
│  - Predicate Pushdown (Conjunctive WHERE filters pushed to connectors)     │
│  - Cardinality-Aware Join Ordering & Dynamic Filtering                     │
│  - Broadcast Hash Join vs Partitioned Hash Join Selection                  │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼────────────────────────────────────┐
│                         ExecutionRouter (`src/federation/executors/`)      │
│   ┌───────────────────────────────────┴────────────────────────────────┐   │
│   ▼                                                                    ▼   │
│  [DuckDBExecutor (SINGLE_NODE_DUCKDB)]        [TrinoExecutor (Optional MPP)]│
│  - Vectorized In-Memory + SSD Spill           - Coordinator `/v1/statement`│
│  - Timeout & Active Query Cancellation        - Multi-Node 100GB+ Joins    │
└───────────────┬───────────────────┬──────────────────┬─────────────────┬───┘
                │                   │                  │                 │
      ┌─────────▼──────┐  ┌─────────▼──────┐  ┌────────▼───────┐ ┌───────▼───────┐
      │ S3Connector &  │  │ AdlsConnector  │  │PostgresConnector│ │MysqlConnector │
      │ MinioConnector │  │ (Azure ADLS)   │  │ (PostgreSQL)   │ │   (MySQL)     │
      │ (+ Iceberg v2) │  │ (+ Iceberg v2) │  │                │ │               │
      └────────────────┘  └────────────────┘  └────────────────┘ └───────────────┘
```

---

## 2. Environment Variables

Add or configure the following variables in `.env` or your Kubernetes `Secret` / `ConfigMap` on Azure AKS:

```ini
# Control Plane Database (SQLite fallback used automatically if DATABASE_URL is unset)
DATABASE_URL=postgresql://user:password@postgres-host:5432/cloudobjectiq

# AES-256-GCM Credential Encryption Key (32+ characters recommended)
FEDERATION_ENCRYPTION_KEY=your_32_byte_enterprise_encryption_key_here
TOKEN_ENCRYPTION_KEY=your_32_byte_enterprise_encryption_key_here

# DuckDB Single-Node Federation Engine Limits
DUCKDB_FEDERATION_MEMORY_LIMIT=2GB
DUCKDB_FEDERATION_THREADS=4

# Optional Trino Distributed Execution Backend
TRINO_COORDINATOR_URL=http://trino-coordinator.cloudobjectiq.svc.cluster.local:8080
TRINO_USER=cloudobjectiq_federation
FEDERATION_DISTRIBUTED_THRESHOLD_BYTES=10737418240
```

---

## 3. Database Migrations

The federation metadata tables are automatically initialized on startup by [`src/db/index.js`](file:///C:/Users/user/.gemini/antigravity/scratch/tadimetihanu/src/db/index.js) via [`src/db/schema.js`](file:///C:/Users/user/.gemini/antigravity/scratch/tadimetihanu/src/db/schema.js) for both SQLite (`data/metadata.db`) and PostgreSQL, and are also available as a standalone migration in [`src/db/migrations/20261110000000-cross-source-federation.js`](file:///C:/Users/user/.gemini/antigravity/scratch/tadimetihanu/src/db/migrations/20261110000000-cross-source-federation.js):

- `federation_connections`
- `federation_catalogs`
- `federation_schemas`
- `federation_tables`
- `federation_column_metadata`
- `federation_query_history`
- `federation_execution_metrics`
- `federation_audit_logs`
- `federation_access_policies`

---

## 4. Running & Verifying Locally or on Azure AKS

1. **Start the Server**:
   ```bash
   npm start
   ```
2. **Run the 30 Automated Federation Tests**:
   ```bash
   node tests/federation.test.js
   ```
3. **Run the Federation Pushdown & Multi-Source Benchmarks**:
   ```bash
   node scripts/run_federation_benchmarks.js
   ```
4. **Access the UI**:
   - Open `http://localhost:4000`
   - Sign in (`admin@cloudobjectiq.com` / `admin123`)
   - Click **🌐 Cross-Source Federation** in the top workspace navigation bar.

