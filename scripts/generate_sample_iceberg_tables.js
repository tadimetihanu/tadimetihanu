const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

async function generateSampleIcebergTables() {
    console.log('🧊 [Iceberg Generator] Generating sample Apache Iceberg datasets...');

    const db = new duckdb.Database(':memory:');
    const runSql = (query) => new Promise((resolve, reject) => {
        db.run(query, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    const tables = [
        {
            name: 'ecommerce_orders.iceberg',
            logicalName: 'ecommerce_orders.iceberg',
            tableUuid: '9c5a1f2b-7e3d-4c8a-b1e0-3f5a7c9d1e2f',
            description: 'Global E-Commerce Customer Orders & Revenue Lakehouse Table',
            fields: [
                { id: 1, name: 'order_id', required: true, type: 'long', duckType: 'BIGINT' },
                { id: 2, name: 'customer_name', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 3, name: 'product_category', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 4, name: 'unit_price', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 5, name: 'quantity', required: false, type: 'int', duckType: 'INTEGER' },
                { id: 6, name: 'total_usd', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 7, name: 'order_status', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 8, name: 'order_date', required: false, type: 'date', duckType: 'DATE' }
            ],
            dataSql: `
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
            logicalName: 'financial_transactions.iceberg',
            tableUuid: '4d8a2c1e-9f3b-4a7c-8e0d-1c3f5a7b9e2d',
            description: 'Multi-Currency Financial Ledger & Transaction Auditing Table',
            fields: [
                { id: 1, name: 'tx_id', required: true, type: 'string', duckType: 'VARCHAR' },
                { id: 2, name: 'account_id', required: true, type: 'string', duckType: 'VARCHAR' },
                { id: 3, name: 'tx_type', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 4, name: 'amount_usd', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 5, name: 'currency', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 6, name: 'merchant', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 7, name: 'fee_usd', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 8, name: 'timestamp', required: false, type: 'timestamp', duckType: 'TIMESTAMP' }
            ],
            dataSql: `
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
            logicalName: 'cloud_telemetry.iceberg',
            tableUuid: '1f3a5c7e-8b0d-4e2a-9c4f-6a8d0e2b4c6e',
            description: 'Distributed Cluster Performance & Health Metrics Table',
            fields: [
                { id: 1, name: 'metric_id', required: true, type: 'long', duckType: 'BIGINT' },
                { id: 2, name: 'node_id', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 3, name: 'region', required: false, type: 'string', duckType: 'VARCHAR' },
                { id: 4, name: 'cpu_usage_pct', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 5, name: 'memory_mb', required: false, type: 'int', duckType: 'INTEGER' },
                { id: 6, name: 'active_connections', required: false, type: 'int', duckType: 'INTEGER' },
                { id: 7, name: 'p99_latency_ms', required: false, type: 'double', duckType: 'DOUBLE' },
                { id: 8, name: 'recorded_at', required: false, type: 'timestamp', duckType: 'TIMESTAMP' }
            ],
            dataSql: `
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

    // Base directories to populate
    const baseDirs = [
        path.join(__dirname, '..', 'data', 'samples'),
        path.join(__dirname, '..', 'minio_data', 'datalake'),
        path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache')
    ];

    for (const targetBase of baseDirs) {
        if (!fs.existsSync(targetBase)) {
            fs.mkdirSync(targetBase, { recursive: true });
        }
    }

    const generatedTableDetails = [];

    for (const tbl of tables) {
        console.log(`\n📦 Processing Table: ${tbl.name}...`);
        
        // Write to each storage directory
        for (const baseDir of baseDirs) {
            const tableDir = path.join(baseDir, tbl.name);
            const dataDir = path.join(tableDir, 'data');
            const metaDir = path.join(tableDir, 'metadata');

            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(metaDir, { recursive: true });

            const parquetFile = path.join(dataDir, '00000-0-data.parquet').replace(/\\/g, '/');

            // Generate Parquet Data File using DuckDB
            if (!fs.existsSync(parquetFile) || fs.statSync(parquetFile).size === 0) {
                await runSql(`COPY (${tbl.dataSql}) TO '${parquetFile}' (FORMAT PARQUET);`);
                console.log(`   ✅ Wrote Parquet data: ${parquetFile}`);
            }

            const parquetStat = fs.statSync(parquetFile);

            // Generate Iceberg v2 Metadata JSON
            const metadataJson = {
                "format-version": 2,
                "table-uuid": tbl.tableUuid,
                "location": `s3://datalake/${tbl.name}`,
                "last-sequence-number": 1,
                "last-updated-ms": Date.now(),
                "last-column-id": tbl.fields.length,
                "current-schema-id": 0,
                "schemas": [
                    {
                        "type": "struct",
                        "schema-id": 0,
                        "fields": tbl.fields
                    }
                ],
                "partition-specs": [
                    {
                        "spec-id": 0,
                        "fields": []
                    }
                ],
                "default-spec-id": 0,
                "last-partition-id": 0,
                "properties": {
                    "write.format.default": "parquet",
                    "comment": tbl.description
                },
                "current-snapshot-id": 10001,
                "snapshots": [
                    {
                        "snapshot-id": 10001,
                        "timestamp-ms": Date.now(),
                        "summary": {
                            "operation": "append",
                            "added-data-files": "1",
                            "added-records": "2500",
                            "total-data-files": "1",
                            "total-records": "2500"
                        },
                        "manifest-list": `s3://datalake/${tbl.name}/metadata/snap-10001-1.avro`
                    }
                ],
                "snapshot-log": [
                    {
                        "timestamp-ms": Date.now(),
                        "snapshot-id": 10001
                    }
                ]
            };

            const metadataPath = path.join(metaDir, 'v1.metadata.json');
            fs.writeFileSync(metadataPath, JSON.stringify(metadataJson, null, 2), 'utf8');

            const versionHintPath = path.join(metaDir, 'version-hint.text');
            fs.writeFileSync(versionHintPath, '1\n', 'utf8');

            console.log(`   🧊 Created Iceberg v2 metadata: ${metadataPath}`);
        }

        generatedTableDetails.push(tbl);
    }

    // Index into metadata_catalog in SQLite database
    const metaDbPath = path.join(__dirname, '..', 'data', 'metadata.db');
    if (fs.existsSync(metaDbPath)) {
        const metaDb = new Database(metaDbPath);
        
        metaDb.exec(`
            CREATE TABLE IF NOT EXISTS metadata_catalog (
                id TEXT PRIMARY KEY,
                target_id TEXT,
                file_path TEXT,
                file_name TEXT,
                file_size INTEGER,
                format TEXT,
                last_modified TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const targets = metaDb.prepare('SELECT target_id, target_name FROM targets').all();
        console.log(`\n📚 Indexing sample Iceberg tables across ${targets.length} targets in metadata.db...`);

        const insertStmt = metaDb.prepare(`
            INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const target of targets) {
            for (const tbl of tables) {
                const id = crypto.createHash('md5').update(`${target.target_id}_${tbl.name}`).digest('hex');
                insertStmt.run(
                    id,
                    target.target_id,
                    tbl.name,
                    tbl.name,
                    65536,
                    'iceberg',
                    new Date().toISOString()
                );
            }
        }
        console.log('✅ Metadata Catalog updated with all sample Iceberg tables!');
    }

    console.log('\n🎉 [Success] Sample Apache Iceberg tables generated successfully:');
    tables.forEach(t => console.log(`   🧊 ${t.name} -> ${t.description}`));
}

generateSampleIcebergTables().catch(e => {
    console.error('❌ Generation failed:', e);
    process.exit(1);
});
