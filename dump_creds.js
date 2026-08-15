const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare("SELECT access_key, secret_key FROM targets WHERE target_name = 'MinIO Local'").get();
console.log('AccessKey: [' + target.access_key + ']');
console.log('SecretKey: [' + target.secret_key + ']');
