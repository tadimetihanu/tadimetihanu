const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
    const permissions = db.prepare('SELECT * FROM permissions').all();
    console.log(JSON.stringify(permissions, null, 2));
} catch (err) {
    console.error(err.message);
} finally {
    db.close();
}
