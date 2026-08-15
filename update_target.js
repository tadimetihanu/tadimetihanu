const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const connStr = 'DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net';

try {
    const stmt = db.prepare(`
        UPDATE targets 
        SET endpoint = ? 
        WHERE target_name = 'Azure CloudObject'
    `);
    stmt.run(connStr);
    console.log('✅ Updated Azure CloudObject with full connection string.');
} catch (err) {
    console.error('❌ Error updating target:', err.message);
} finally {
    db.close();
}
