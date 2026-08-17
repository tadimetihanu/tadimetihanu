const bcrypt = require('bcryptjs');
const db = require('better-sqlite3')('./data/metadata.db');
const hash = bcrypt.hashSync('admin', 10);
db.exec(`INSERT INTO users (user_id, email, password_hash, role) VALUES ('admin-1', 'admin@cloudobjectiq.com', '${hash}', 'admin')`);
console.log('Admin user created successfully.');
