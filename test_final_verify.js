const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

async function test() {
    const target = db.prepare('SELECT * FROM targets WHERE target_id = ?').get('fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a');
    console.log(`Testing Target: ${target.target_name}, Bucket: ${target.bucket}`);

    // Prefix construction (mimics getAzurePrefix)
    const prefix = `az://${target.bucket}/`;
    const fullPath = `${prefix}csvdata/supermarket_sales.csv`;

    console.log(`Attempting to query: ${fullPath}`);

    try {
        const results = await runQuery('admin', `SELECT * FROM read_csv_auto('${fullPath}') LIMIT 5`, target.target_id);
        console.log(`✅ SUCCESS! Query results:`);
        console.table(results);
    } catch (e) {
        console.error(`❌ FAILED: ${e.message}`);
    }
}

test();
