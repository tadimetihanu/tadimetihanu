const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    // Attempt multiple account/container pairs
    const trials = [
        { account: 'inseeksadls', container: 'inseekdata' },
        { account: 'inseeksadls', container: 'datainseektech' },
        { account: 'inseekdata',   container: 'datainseektech' },
        { account: 'inseekdata',   container: 'csvdata' },
    ];
    
    // Test for ADLS Primary Lake (84ba9535-7cf0-42f7-b28e-8a2bf753381e)
    const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
    
    for (const { account, container } of trials) {
        try {
            // Update the DB temporarily for the test to ensure engine picks it up
            const newEndpoint = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net`;
            metaDb.prepare('UPDATE targets SET endpoint = ?, bucket = ? WHERE target_id = ?').run(newEndpoint, container, targetId);
            
            const sql = `SELECT * FROM read_csv_auto('az://${account}/${container}/csvdata/supermarket_sales.csv') LIMIT 1`;
            console.log(`\nTesting Pair: Account=${account}, Container=${container}`);
            console.log(`URI: az://${account}/${container}/csvdata/supermarket_sales.csv`);
            
            const results = await runQuery('admin_id', sql, targetId);
            console.log(`✅ SUCCESS! Found valid path.`);
            console.table(results);
            return;
        } catch (err) {
            console.error(`❌ Failed: ${err.message}`);
            // Wait a bit to let transactions settle
            await new Promise(r => setTimeout(r, 500));
        }
    }
    process.exit();
}

test();
