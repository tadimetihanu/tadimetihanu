const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a'; // Azure Cloud Target
    const account = 'inseeksadls';
    const container = 'datainseektech';
    const path = 'csvdata/supermarket_sales.csv';
    
    const sql = `SELECT * FROM read_csv_auto('az://${account}/${container}/${path}') LIMIT 5`;
    console.log(`Testing path: az://${account}/${container}/${path}`);
    
    try {
        const results = await runQuery('admin_id', sql, targetId);
        console.log(`✅ SUCCESS! Found valid path.`);
        console.table(results);
    } catch (err) {
        console.error(`❌ Failed: ${err.message}`);
    }
    process.exit();
}

test();
