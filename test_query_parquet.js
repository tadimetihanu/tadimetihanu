const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

async function testParquet() {
    const t = db.prepare("SELECT * FROM targets WHERE provider_type = 'gdrive'").get();
    console.log('Testing GDrive target:', t.target_name, t.target_id);

    try {
        const sql1 = "SELECT * FROM read_parquet('gdrive://root/quarterly_sales_2026.parquet') LIMIT 3";
        console.log('Running SQL 1:', sql1);
        const res1 = await runQuery('admin', sql1, t.target_id);
        console.log('✅ Result 1:', res1);

        const sql2 = "SELECT product, revenue, region FROM 'quarterly_sales_2026.parquet' ORDER BY revenue DESC";
        console.log('Running SQL 2:', sql2);
        const res2 = await runQuery('admin', sql2, t.target_id);
        console.log('✅ Result 2:', res2);
    } catch (e) {
        console.error('❌ Parquet query failed:', e);
    }
}

testParquet();
