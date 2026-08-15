const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
    const targets = db.prepare('SELECT * FROM targets').all();
    console.log(JSON.stringify(targets, null, 2));
} catch (err) {
    console.error(err.message);
} finally {
    db.close();
}
