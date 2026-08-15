const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
    const account = 'inseeksadls';
    const container = 'csvdata'; // Based on the user's original URI
    
    // Set the endpoint and bucket in the DB
    const newEndpoint = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net`;
    metaDb.prepare('UPDATE targets SET endpoint = ?, bucket = ? WHERE target_id = ?').run(newEndpoint, container, targetId);
    
    const sql = `SELECT * FROM read_csv_auto('az://${account}/${container}/supermarket_sales.csv') LIMIT 5`;
    console.log(`Testing path: az://${account}/${container}/supermarket_sales.csv`);
    
    try {
        const results = await runQuery('admin_id', sql, targetId);
        console.log(`✅ SUCCESS!`);
        console.table(results);
    } catch (err) {
        console.error(`❌ Failed: ${err.message}`);
    }
    process.exit();
}

test();
