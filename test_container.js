const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    const containers = ['inseekdata', 'datainseektech', 'csvdata'];
    const account = 'inseeksadls';
    
    for (const container of containers) {
        try {
            const sql = `SELECT * FROM read_csv_auto('az://${account}/${container}/csvdata/supermarket_sales.csv') LIMIT 1`;
            console.log(`Testing: az://${account}/${container}/csvdata/supermarket_sales.csv`);
            
            const results = await runQuery('admin_id', sql, '28e0979b-53ef-47ba-be22-9942fc54999e');
            console.log(`✅ Success with container: ${container}`);
            console.table(results);
            return;
        } catch (err) {
            console.error(`❌ Failed with container: ${container} - ${err.message}`);
        }
    }
    process.exit();
}

test();
