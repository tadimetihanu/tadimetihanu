const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const targets = db.prepare('SELECT target_name, provider_type FROM targets').all();
targets.forEach(t => console.log(`TARGET: ${t.target_name} | TYPE: ${t.provider_type}`));
const users = db.prepare('SELECT email, role FROM users').all();
users.forEach(u => console.log(`USER: ${u.email} | ROLE: ${u.role}`));
