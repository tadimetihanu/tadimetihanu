const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare('SELECT target_id, target_name, endpoint FROM targets').all();
console.log(JSON.stringify(target, null, 2));
db.close();
