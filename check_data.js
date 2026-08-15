const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const users = db.prepare('SELECT user_id, email, role FROM users').all();
console.log('USERS:', JSON.stringify(users, null, 2));
const targets = db.prepare('SELECT target_id, target_name, provider_type, bucket FROM targets').all();
console.log('TARGETS:', JSON.stringify(targets, null, 2));
