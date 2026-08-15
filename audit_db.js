const Database = require('better-sqlite3');
const db = new Database('D:/CloudObjectIQ_Ready/data/metadata.db');

try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('--- TABLES ---');
    console.log(tables.map(t => t.name).join(', '));
    
    console.log('\n--- TARGETS DATA ---');
    const targets = db.prepare("SELECT * FROM targets").all();
    console.log(JSON.stringify(targets, null, 2));

    console.log('\n--- QUERY LOGS (Last 5) ---');
    const logs = db.prepare("SELECT * FROM query_logs ORDER BY timestamp DESC LIMIT 5").all();
    console.log(JSON.stringify(logs, null, 2));

} catch (err) {
    console.error('Error:', err.message);
} finally {
    db.close();
}
