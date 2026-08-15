const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    try {
        const target = metaDb.prepare("SELECT * FROM targets WHERE target_name = 'Azuredatalakestorage1'").get();
        if (!target) {
            console.error('Target not found');
            return;
        }

        // Using the corrected URI format: az://ACCOUNT/CONTAINER/path
        const sql = "SELECT * FROM read_csv_auto('az://inseeksadls/inseekdata/csvdata/supermarket_sales.csv') LIMIT 5";
        console.log(`Running test query on ${target.target_name}...`);
        
        const results = await runQuery('admin_id', sql, target.target_id);
        console.log('✅ Query Success!');
        console.table(results);
    } catch (err) {
        console.error('❌ Query Failed:', err.message);
        if (err.message.includes('12007')) {
            console.error('DNS Resolution Error (12007) still persists.');
        }
    } finally {
        process.exit();
    }
}

test();
