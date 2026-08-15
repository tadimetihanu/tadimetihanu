const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

console.log('--- RECONFIGURING SYSTEM ---');

// 1. Promote users to Admin
const users = ['admin@cloudobjectiq.com', 'test@cloudbonsai.com'];
for (const email of users) {
    db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
    console.log(`Promoted ${email} to admin`);
}

// 2. Grant universal permissions
const allUsers = db.prepare("SELECT user_id FROM users").all();
const allTargets = db.prepare("SELECT target_id FROM targets").all();

db.prepare("DELETE FROM permissions").run();

const insertPerm = db.prepare(`
    INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
    VALUES (?, 'user', ?, 1, 1, 1)
`);

for (const user of allUsers) {
    for (const target of allTargets) {
        insertPerm.run(user.user_id, target.target_id);
    }
}

console.log(`Granted full permissions for ${allUsers.length} users across ${allTargets.length} targets.`);
console.log('--- DONE ---');
