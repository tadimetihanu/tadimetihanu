const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
    const res = db.prepare('UPDATE targets SET endpoint = ? WHERE provider_type = ?').run('http://localhost:9000', 'minio');
    console.log(`✅ Updated ${res.changes} MinIO targets to point to port 9000`);
} catch (err) {
    console.error('❌ Update failed:', err.message);
} finally {
    db.close();
}
