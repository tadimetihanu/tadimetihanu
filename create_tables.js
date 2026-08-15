const { runQuery } = require('./src/query/engine');

async function createTables() {
    const minioTargetId = '81d80fa7-4520-4157-91d7-05a47ce5b2c1';
    const azureTargetId = '9d3a96e1-3622-4e87-b938-fb2b9737ca26';

    const sampleSql = `
        SELECT * FROM (VALUES
            (1, 'Product A', 100.50, '2026-04-09'),
            (2, 'Product B', 250.00, '2026-04-09'),
            (3, 'Product C', 75.25, '2026-04-08'),
            (4, 'Product D', 400.00, '2026-04-07')
        ) t(id, name, amount, sale_date)
    `;

    try {
        console.log('🚀 Creating Iceberg-compatible base tables...');

        // 1. Create on MinIO
        console.log('📡 Writing to MinIO (s3://datalake/iceberg_minio.parquet)...');
        await runQuery('admin', `COPY (${sampleSql}) TO 's3://datalake/iceberg_minio.parquet' (FORMAT PARQUET)`, minioTargetId);
        
        // 2. Create on Azure
        console.log('📡 Writing to Azure (az://datainseektech/iceberg_azure.parquet)...');
        await runQuery('admin', `COPY (${sampleSql}) TO 'az://datainseektech/iceberg_azure.parquet' (FORMAT PARQUET)`, azureTargetId);

        console.log('✅ Tables created as high-performance Parquet files.');
        console.log('\nNOTE: Native Iceberg Metadata requires an active REST Catalog (e.g., Nessie or Glue).');
        console.log('The files above are ready to be registered as Iceberg tables in your preferred catalog.');

    } catch (err) {
        console.error('❌ Error creating tables:', err.message);
    }
}

createTables();
