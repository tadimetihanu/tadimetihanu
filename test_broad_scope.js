const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');
const metaDb = new Database('./data/metadata.db');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a';
    const account = 'inseeksadls';
    
    // We'll manually test different scopes and URIs
    const trials = [
        { scope: 'az://inseekdata/', uri: 'az://inseekdata/csvdata/supermarket_sales.csv' },
        { scope: 'az://', uri: 'az://inseeksadls/inseekdata/csvdata/supermarket_sales.csv' },
        { scope: 'az://', uri: 'az://inseekdata/csvdata/supermarket_sales.csv' },
    ];

    for (const t of trials) {
        console.log(`\n--- Trial: Scope=${t.scope}, URI=${t.uri} ---`);
        try {
            // I need the engine to use THIS specific scope.
            // For now, I'll just change the URI to match what the engine currently does.
            // Currently engine does: scope = az://ACCOUNT/ (where ACCOUNT is extracted from connStr)
            // So if AccountName=inseeksadls, scope=az://inseeksadls/
            // Thus only az://inseeksadls/... will work.
            
            const results = await runQuery('admin_id', `SELECT * FROM read_csv_auto('${t.uri}') LIMIT 1`, targetId);
            console.log(`✅ SUCCESS!`);
            return;
        } catch (e) {
            console.log(`❌ Failed: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    process.exit();
}

test();
