const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const users = db.prepare('SELECT email, role FROM users').all();
console.log('--- USERS ---');
users.forEach(u => console.log(`${u.email} [${u.role}]`));
const targets = db.prepare('SELECT target_name, provider_type, is_active FROM targets').all();
console.log('\n--- TARGETS ---');
targets.forEach(t => console.log(`${t.target_name} (${t.provider_type}) - ${t.is_active ? 'ACTIVE' : 'INACTIVE'}`));
