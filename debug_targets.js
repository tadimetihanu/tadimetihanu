const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const targets = db.prepare('SELECT target_name, access_key, secret_key, provider_type, bucket FROM targets').all();
console.log(JSON.stringify(targets, null, 2));
