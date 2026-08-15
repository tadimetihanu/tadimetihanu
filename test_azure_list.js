const { listFiles } = require('./src/drivers/storage');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

async function test() {
    try {
        const target = db.prepare('SELECT target_id FROM targets WHERE target_name = ?').get('Azure CloudObject');
        if (!target) throw new Error('Target not found');
        
        console.log(`📡 Listing files for: Azure CloudObject (${target.target_id})`);
        const files = await listFiles(target.target_id);
        console.log('✅ Found files:', files.length);
        console.log(JSON.stringify(files.slice(0, 5), null, 2));
    } catch (err) {
        console.error('❌ Error listing files:', err.message);
    } finally {
        db.close();
    }
}

test();
