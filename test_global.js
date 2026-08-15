const { runQuery } = require('./src/query/engine.js');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

async function testAll() {
    console.log('🧪 Starting Global Storage Audit (v120)...');
    
    const targets = db.prepare('SELECT target_id, target_name, provider_type, bucket FROM targets').all();
    
    for (const target of targets) {
        console.log(`\n🔍 Testing Target: ${target.target_name} (${target.provider_type})`);
        
        try {
            // Try to list first few files or just do a generic check
            // Actually, I'll just try to query a known file if possible, or just a dummy query to see if the secret is accepted.
            const dummySql = `SELECT 1 as status;`;
            
            // To really test storage, we need a file. 
            // I'll try to find one file in the database for this target.
            const dataset = db.prepare('SELECT file_path FROM datasets WHERE target_id = ? LIMIT 1').get(target.target_id);
            
            if (dataset) {
                const path = dataset.file_path;
                const sql = `SELECT * FROM read_csv_auto('${path}') LIMIT 1;`;
                console.log(`📡 Querying: ${path}`);
                const rows = await runQuery('system-test', sql, target.target_id);
                console.log(`✅ Success! Found ${rows.length} rows.`);
            } else {
                console.log('⚠️ No datasets found for this target to test.');
            }
        } catch (e) {
            console.error(`❌ Failed: ${e.message}`);
        }
    }
}

testAll();
