const { runQuery } = require('./src/query/engine');
const path = require('path');
const fs = require('fs');

async function generateData() {
    const targetPath = path.join(__dirname, 'hadoop-deploy', 'data', 'logistics_shipments.parquet');
    console.log(`🚀 Generating Logistics Parquet dataset at ${targetPath}...`);

    const sql = `
        COPY (
            SELECT 
                'SHP-' || range as shipment_id,
                CASE WHEN random() > 0.5 THEN 'Shanghai' ELSE 'Rotterdam' END as origin,
                CASE WHEN random() > 0.5 THEN 'New York' ELSE 'Mumbai' END as destination,
                (random() * 5000)::int as weight_kg,
                CASE 
                    WHEN random() > 0.8 THEN 'DELIVERED'
                    WHEN random() > 0.4 THEN 'IN-TRANSIT'
                    ELSE 'PENDING'
                END as status,
                now() - interval (random() * 30) day as shipment_date
            FROM range(25000)
        ) TO '${targetPath.replace(/\\/g, '/')}' (FORMAT PARQUET);
    `;

    try {
        await runQuery('system', sql, null);
        console.log('✅ Logistics dataset generated successfully.');
        console.log('📦 Now run this to ingest it into HDFS:');
        console.log('cd hadoop-deploy; docker-compose exec namenode /bin/bash /tmp/ingest/ingest.sh');
    } catch (err) {
        console.error('❌ Generation failed:', err);
    }
}

generateData();
