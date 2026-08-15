const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');
const rows = db.prepare("SELECT * FROM targets").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
