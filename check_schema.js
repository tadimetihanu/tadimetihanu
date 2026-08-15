const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');
const schema = db.prepare("PRAGMA table_info(targets)").all();
console.log(JSON.stringify(schema, null, 2));
db.close();
