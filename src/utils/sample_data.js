const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function ensureAllSampleData() {
    try {
        const samplesDir = path.join(__dirname, '..', '..', 'data', 'samples');
        const minioDir = path.join(__dirname, '..', '..', 'minio_data', 'datalake');
        const gdriveDir = path.join(process.env.USERPROFILE || '/tmp', '.gdrive_cache');

        [samplesDir, minioDir, gdriveDir].forEach(d => {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        });

        const memDb = new duckdb.Database(':memory:');
        const runSql = (q) => new Promise((resolve, reject) => {
            memDb.run(q, (err) => err ? reject(err) : resolve());
        });

        const salesParquet = path.join(samplesDir, 'sales_data.parquet').replace(/\\/g, '/');
        const customersCsv = path.join(samplesDir, 'customers.csv').replace(/\\/g, '/');
        const logisticsParquet = path.join(samplesDir, 'logistics.parquet').replace(/\\/g, '/');
        const irisParquet = path.join(samplesDir, 'iris.parquet').replace(/\\/g, '/');

        // 1. Generate sales_data.parquet
        if (!fs.existsSync(salesParquet) || fs.statSync(salesParquet).size === 0) {
            memDb.run(`
                COPY (
                    SELECT 
                        1000 + range AS order_id,
                        CASE (range % 5)
                            WHEN 0 THEN 'Electronics'
                            WHEN 1 THEN 'Fashion'
                            WHEN 2 THEN 'Home & Living'
                            WHEN 3 THEN 'Health & Beauty'
                            ELSE 'Books'
                        END AS category,
                        ROUND(10 + (random() * 490), 2) AS amount,
                        (1 + (range % 100)) AS customer_id,
                        CASE (range % 3)
                            WHEN 0 THEN 'Credit Card'
                            WHEN 1 THEN 'PayPal'
                            ELSE 'Wire Transfer'
                        END AS payment_method,
                        DATE '2026-01-01' + INTERVAL (range % 90) DAY AS order_date
                    FROM range(5000)
                ) TO '${salesParquet}' (FORMAT PARQUET);
            `);
        }

        // 2. Generate customers.csv
        if (!fs.existsSync(customersCsv)) {
            memDb.run(`
                COPY (
                    SELECT 
                        range + 1 AS customer_id,
                        'Customer_' || (range + 1) AS name,
                        'user' || (range + 1) || '@example.com' AS email,
                        CASE (range % 4)
                            WHEN 0 THEN 'North America'
                            WHEN 1 THEN 'EMEA'
                            WHEN 2 THEN 'APAC'
                            ELSE 'LATAM'
                        END AS region,
                        ROUND(500 + (random() * 9500), 2) AS credit_limit
                    FROM range(100)
                ) TO '${customersCsv}' (FORMAT CSV, HEADER);
            `);
        }

        // 3. Generate logistics.parquet
        if (!fs.existsSync(logisticsParquet) || fs.statSync(logisticsParquet).size === 0) {
            memDb.run(`
                COPY (
                    SELECT 
                        'SHIP-' || (50000 + range) AS shipment_id,
                        CASE (range % 4)
                            WHEN 0 THEN 'Shanghai'
                            WHEN 1 THEN 'Rotterdam'
                            WHEN 2 THEN 'Los Angeles'
                            ELSE 'Singapore'
                        END AS origin,
                        CASE (range % 4)
                            WHEN 0 THEN 'New York'
                            WHEN 1 THEN 'Frankfurt'
                            WHEN 2 THEN 'Tokyo'
                            ELSE 'London'
                        END AS destination,
                        (100 + (random() * 4900))::int AS weight_kg,
                        CASE (range % 3)
                            WHEN 0 THEN 'DELIVERED'
                            WHEN 1 THEN 'IN_TRANSIT'
                            ELSE 'PROCESSING'
                        END AS status,
                        ROUND(50 + (random() * 950), 2) AS shipping_fee
                    FROM range(2500)
                ) TO '${logisticsParquet}' (FORMAT PARQUET);
            `);
        }

        // 4. Generate sample Iceberg Tables on disk
        const sampleTables = [
            {
                name: 'ecommerce_orders.iceberg',
                uuid: '9c5a1f2b-7e3d-4c8a-b1e0-3f5a7c9d1e2f',
                desc: 'Global E-Commerce Customer Orders & Revenue Lakehouse Table',
                sql: `
                    SELECT 
                        100000 + range AS order_id,
                        'Customer_' || (1 + (range % 150)) AS customer_name,
                        CASE (range % 6)
                            WHEN 0 THEN 'Electronics'
                            WHEN 1 THEN 'Cloud Compute'
                            WHEN 2 THEN 'AI Accelerators'
                            WHEN 3 THEN 'Networking Hardware'
                            WHEN 4 THEN 'Storage Arrays'
                            ELSE 'Developer Tools'
                        END AS product_category,
                        ROUND(25.0 + (random() * 475.0), 2) AS unit_price,
                        (1 + (range % 10))::int AS quantity,
                        ROUND((25.0 + (random() * 475.0)) * (1 + (range % 10)), 2) AS total_usd,
                        CASE (range % 4)
                            WHEN 0 THEN 'COMPLETED'
                            WHEN 1 THEN 'PROCESSING'
                            WHEN 2 THEN 'SHIPPED'
                            ELSE 'DELIVERED'
                        END AS order_status,
                        DATE '2026-01-01' + INTERVAL (range % 90) DAY AS order_date
                    FROM range(2500)
                `
            },
            {
                name: 'financial_transactions.iceberg',
                uuid: '4d8a2c1e-9f3b-4a7c-8e0d-1c3f5a7b9e2d',
                desc: 'Multi-Currency Financial Ledger Table',
                sql: `
                    SELECT 
                        'TX-' || (700000 + range) AS tx_id,
                        'ACC-' || (1000 + (range % 80)) AS account_id,
                        CASE (range % 4)
                            WHEN 0 THEN 'PAYMENT'
                            WHEN 1 THEN 'TRANSFER'
                            WHEN 2 THEN 'REFUND'
                            ELSE 'DEPOSIT'
                        END AS tx_type,
                        ROUND(10.0 + (random() * 4990.0), 2) AS amount_usd,
                        CASE (range % 3)
                            WHEN 0 THEN 'USD'
                            WHEN 1 THEN 'EUR'
                            ELSE 'GBP'
                        END AS currency,
                        CASE (range % 5)
                            WHEN 0 THEN 'Amazon AWS'
                            WHEN 1 THEN 'Microsoft Azure'
                            WHEN 2 THEN 'Cloudflare R2'
                            WHEN 3 THEN 'Google Cloud'
                            ELSE 'Databricks Lakehouse'
                        END AS merchant,
                        ROUND(0.50 + (random() * 9.50), 2) AS fee_usd,
                        TIMESTAMP '2026-03-01 00:00:00' + INTERVAL (range * 12) MINUTE AS timestamp
                    FROM range(3000)
                `
            },
            {
                name: 'cloud_telemetry.iceberg',
                uuid: '1f3a5c7e-8b0d-4e2a-9c4f-6a8d0e2b4c6e',
                desc: 'Distributed Cluster Performance & Health Metrics Table',
                sql: `
                    SELECT 
                        range + 1 AS metric_id,
                        'node-' || (1 + (range % 25)) AS node_id,
                        CASE (range % 4)
                            WHEN 0 THEN 'us-east-1'
                            WHEN 1 THEN 'us-west-2'
                            WHEN 2 THEN 'eu-west-1'
                            ELSE 'ap-southeast-1'
                        END AS region,
                        ROUND(15.0 + (random() * 80.0), 2) AS cpu_usage_pct,
                        (2048 + (random() * 14336))::int AS memory_mb,
                        (50 + (range % 450))::int AS active_connections,
                        ROUND(1.2 + (random() * 48.8), 2) AS p99_latency_ms,
                        TIMESTAMP '2026-03-25 00:00:00' + INTERVAL (range * 5) MINUTE AS recorded_at
                    FROM range(4000)
                `
            }
        ];

        for (const st of sampleTables) {
            const tablePath = path.join(samplesDir, st.name);
            const dataDir = path.join(tablePath, 'data');
            const metaDir = path.join(tablePath, 'metadata');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(metaDir, { recursive: true });

            const parquetDest = path.join(dataDir, '00000-0-data.parquet').replace(/\\/g, '/');
            if (!fs.existsSync(parquetDest) || fs.statSync(parquetDest).size === 0) {
                memDb.run(`COPY (${st.sql}) TO '${parquetDest}' (FORMAT PARQUET);`);
            }

            const metadataPath = path.join(metaDir, 'v1.metadata.json');
            if (!fs.existsSync(metadataPath)) {
                const metadataJson = {
                    "format-version": 2,
                    "table-uuid": st.uuid,
                    "location": `s3://datalake/${st.name}`,
                    "last-sequence-number": 1,
                    "last-updated-ms": Date.now(),
                    "last-column-id": 8,
                    "current-schema-id": 0,
                    "schemas": [{ "type": "struct", "schema-id": 0, "fields": [] }],
                    "partition-specs": [{ "spec-id": 0, "fields": [] }],
                    "default-spec-id": 0,
                    "last-partition-id": 0,
                    "properties": { "write.format.default": "parquet", "comment": st.desc },
                    "current-snapshot-id": 10001,
                    "snapshots": [{ "snapshot-id": 10001, "timestamp-ms": Date.now(), "summary": { "operation": "append" } }]
                };
                fs.writeFileSync(metadataPath, JSON.stringify(metadataJson, null, 2), 'utf8');
                fs.writeFileSync(path.join(metaDir, 'version-hint.text'), '1\n', 'utf8');
            }
        }

        // 5. Populate metadata_catalog in Control Plane Database
        const db = require('../db');
        const defaultFiles = [
            { name: 'sales_data.parquet', size: 125000, format: 'parquet' },
            { name: 'customers.csv', size: 45000, format: 'csv' },
            { name: 'logistics.parquet', size: 85000, format: 'parquet' },
            { name: 'iris.parquet', size: 17408, format: 'parquet' },
            { name: 'ecommerce_orders.iceberg', size: 65536, format: 'iceberg' },
            { name: 'financial_transactions.iceberg', size: 65536, format: 'iceberg' },
            { name: 'cloud_telemetry.iceberg', size: 65536, format: 'iceberg' }
        ];

        (async () => {
            try {
                const allTargets = await db.all('SELECT target_id FROM targets');
                for (const t of allTargets) {
                    for (const f of defaultFiles) {
                        const cid = crypto.createHash('md5').update(`${t.target_id}_${f.name}`).digest('hex');
                        try {
                            await db.run(`
                                INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, last_modified)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `, [cid, t.target_id, f.name, f.name, f.size, f.format, new Date().toISOString()]);
                        } catch (insErr) {
                            await db.run(`
                                INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format)
                                VALUES (?, ?, ?, ?, ?, ?)
                            `, [cid, t.target_id, f.name, f.name, f.size, f.format]);
                        }
                    }
                }
            } catch (e) {}
        })();
    } catch (err) {
        console.warn('[Sample Data] Initialization notice:', err.message);
    }
}

module.exports = { ensureAllSampleData };
