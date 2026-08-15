const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const user = db.prepare('SELECT user_id FROM users WHERE email = ?').get('test@example.com');
const targets = db.prepare('SELECT target_id FROM targets').all();

console.log('User:', user.user_id);
console.log('Targets Found:', targets.length);

db.prepare('DELETE FROM permissions WHERE subject_id = ?').run(user.user_id);

for (const t of targets) {
    db.prepare(`
        INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
        VALUES (?, 'user', ?, 1, 1, 1)
    `).run(user.user_id, t.target_id);
    console.log('✅ Granted ' + t.target_id + ' to ' + user.user_id);
}
console.log('Verification:');
const check = db.prepare('SELECT count(*) as c FROM permissions WHERE subject_id = ?').get(user.user_id);
console.log('Perms in DB:', check.c);
