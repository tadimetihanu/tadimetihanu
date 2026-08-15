const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare("SELECT * FROM targets WHERE target_name = 'MinIO Local'").get();
console.log(JSON.stringify(target, null, 2));
