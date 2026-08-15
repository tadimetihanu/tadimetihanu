const db = require('better-sqlite3')('data/metadata.db');
const targets = db.prepare('SELECT target_name, provider_type, endpoint, access_key, secret_key FROM targets').all();
console.log(JSON.stringify(targets, null, 2));
