const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = new Database('./data/metadata.db');

const [email, password, role] = process.argv.slice(2);

if (!email || !password) {
    console.log('Usage: node create_user.js <email> <password> [role]');
    process.exit(1);
}

const userId = crypto.randomUUID();
const hash = bcrypt.hashSync(password, 10);

try {
    db.prepare('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(userId, email, hash, role || 'user');
    console.log(`✅ User created successfully: ${email} (${role || 'user'})`);
} catch (err) {
    console.error(`❌ Error: ${err.message}`);
}
