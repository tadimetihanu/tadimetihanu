const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
    const res = db.prepare("DELETE FROM targets WHERE target_name = 'azureblob1'").run();
    console.log('✅ DELETE SUCCESS:', res);
} catch (e) {
    console.error('❌ DELETE FAILED:', e.message);
}
