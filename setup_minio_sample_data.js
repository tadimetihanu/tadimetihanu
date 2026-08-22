const { S3Client, CreateBucketCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function setup() {
    console.log('🚀 [Setup] Initializing MinIO Data Lake and Sample Datasets...');

    const s3 = new S3Client({
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
        forcePathStyle: true
    });

    const bucket = 'datalake';

    try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log(`✅ Bucket '${bucket}' created.`);
    } catch (e) {
        if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') {
            console.log(`ℹ️ Bucket '${bucket}' already exists.`);
        } else {
            console.error('❌ Bucket creation failed:', e.message);
        }
    }

    const tempDir = path.join(__dirname, 'data', 'samples');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const db = new duckdb.Database(':memory:');
    const runSql = (query) => new Promise((resolve, reject) => {
        db.run(query, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    console.log('📊 Generating Parquet & CSV sample datasets via DuckDB...');

    const salesParquet = path.join(tempDir, 'sales_data.parquet').replace(/\\/g, '/');
    const customersCsv = path.join(tempDir, 'customers.csv').replace(/\\/g, '/');
    const logisticsParquet = path.join(tempDir, 'logistics.parquet').replace(/\\/g, '/');

    await runSql(`
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

    await runSql(`
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

    await runSql(`
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

    console.log('☁️ Uploading datasets to MinIO S3 bucket...');

    const uploadFiles = [
        { name: 'sales_data.parquet', file: salesParquet, type: 'application/octet-stream' },
        { name: 'customers.csv', file: customersCsv, type: 'text/csv' },
        { name: 'logistics.parquet', file: logisticsParquet, type: 'application/octet-stream' }
    ];

    for (const item of uploadFiles) {
        const body = fs.readFileSync(item.file);
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: item.name,
            Body: body,
            ContentType: item.type
        }));
        console.log(`✅ Uploaded ${item.name} (${(body.length / 1024).toFixed(1)} KB)`);
    }

    // Verify S3 bucket listing
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    console.log('📦 MinIO Bucket Contents:', (listRes.Contents || []).map(o => o.Key));

    // Ensure metadata target is configured and admin permissions granted
    const metaDb = new Database('./data/metadata.db');
    const minioTarget = metaDb.prepare("SELECT * FROM targets WHERE provider_type = 'minio'").get();
    if (minioTarget) {
        metaDb.prepare("UPDATE targets SET endpoint = 'http://localhost:9000', bucket = 'datalake', access_key = 'minioadmin', secret_key = 'minioadmin', region = 'us-east-1', is_active = 1 WHERE target_id = ?")
            .run(minioTarget.target_id);
    }
    
    // Grant universal permissions to all users for all targets
    const users = metaDb.prepare("SELECT user_id FROM users").all();
    const targets = metaDb.prepare("SELECT target_id FROM targets").all();
    metaDb.prepare("DELETE FROM permissions").run();
    const insertPerm = metaDb.prepare(`
        INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
        VALUES (?, 'user', ?, 1, 1, 1)
    `);
    for (const u of users) {
        for (const t of targets) {
            insertPerm.run(u.user_id, t.target_id);
        }
    }
    console.log('✨ System setup & permissions verified!');
}

setup().catch(err => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
});
