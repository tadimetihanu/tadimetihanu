const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');
const targets = db.prepare("SELECT name, type, connection_string FROM targets").all();
console.log(JSON.stringify(targets, null, 2));
db.close();
