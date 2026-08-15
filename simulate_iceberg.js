const { runQuery } = require('./src/query/engine');
const fs = require('fs');
const path = require('path');

async function createIcebergStructure() {
    const minioTargetId = '81d80fa7-4520-4157-91d7-05a47ce5b2c1';
    
    // 1. Data SQL
    const dataSql = `
        SELECT * FROM (VALUES
            (101, 'Iceberg Transaction A', 500.00),
            (102, 'Iceberg Transaction B', 1200.50)
        ) t(tx_id, description, amount)
    `;

    try {
        console.log('🧊 Provisioning Iceberg Format Template...');

        // Create the data file
        console.log('📁 Writing Data: /my_iceberg_table/data/f1.parquet');
        await runQuery('admin', `COPY (${dataSql}) TO 's3://datalake/my_iceberg_table/data/f1.parquet' (FORMAT PARQUET)`, minioTargetId);

        // In a real Iceberg setup, the metadata/ manifest/ etc. are binary and complex.
        // We will create the metadata folder and a README to simulate the format structure.
        console.log('📁 Creating Metadata Placeholder: /my_iceberg_table/metadata/v1.metadata.json');
        
        // Note: Our runQuery only supports SQL. We don't have a direct "write text file to s3" tool in the engine 
        // through SQL unless we use a trick or another tool. 
        // However, I can create it in the local "data" directory which is mounted to MinIO in docker-compose!
        
        const localPath = path.join(__dirname, 'minio_data/datalake/my_iceberg_table/metadata');
        if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });
        
        const metadata = {
            "format-version": 2,
            "table-uuid": "7a3b1c4d-9e2f-4a6b-8c1d-0e2f3a4b5c6d",
            "location": "s3://datalake/my_iceberg_table",
            "last-sequence-number": 1,
            "last-updated-ms": Date.now(),
            "last-column-id": 3,
            "schemas": [
                {
                    "type": "struct",
                    "schema-id": 0,
                    "fields": [
                        { "id": 1, "name": "tx_id", "required": true, "type": "long" },
                        { "id": 2, "name": "description", "required": false, "type": "string" },
                        { "id": 3, "name": "amount", "required": false, "type": "double" }
                    ]
                }
            ],
            "current-schema-id": 0,
            "partition-specs": [{ "spec-id": 0, "fields": [] }],
            "default-spec-id": 0,
            "snapshots": []
        };

        fs.writeFileSync(path.join(localPath, 'v1.metadata.json'), JSON.stringify(metadata, null, 2));
        fs.writeFileSync(path.join(localPath, 'version-hint.text'), '1');

        console.log('✅ Iceberg Directory Structure ready on MinIO.');
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

createIcebergStructure();
