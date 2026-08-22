const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');

async function test() {
    const metaDb = new Database('./data/metadata.db');
    const target = metaDb.prepare("SELECT * FROM targets WHERE provider_type = 'minio'").get();
    const admin = metaDb.prepare("SELECT * FROM users WHERE email = 'admin@cloudobjectiq.com'").get();

    console.log('Testing DESCRIBE query...');
    try {
        const descRows = await runQuery(admin.user_id, "DESCRIBE SELECT * FROM 's3://datalake/sales_data.parquet'", target.target_id);
        console.log('DESCRIBE succeeded:', descRows);
    } catch (e) {
        console.error('DESCRIBE failed with error:', e);
    }

    console.log('Testing COUNT query...');
    try {
        const countRows = await runQuery(admin.user_id, "SELECT COUNT(*) AS row_count FROM 's3://datalake/sales_data.parquet'", target.target_id);
        console.log('COUNT succeeded:', countRows);
    } catch (e) {
        console.error('COUNT failed with error:', e);
    }
}

test();
