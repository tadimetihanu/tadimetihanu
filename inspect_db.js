const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const targets = db.prepare('SELECT target_id, target_name FROM targets').all();
const users = db.prepare('SELECT user_id, email FROM users').all();
console.log('Targets:', targets);
console.log('Users:', users);
