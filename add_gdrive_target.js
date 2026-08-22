const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database('./data/metadata.db');

console.log('🚀 Adding Enterprise Google Drive target to metadata DB...');

const existing = db.prepare("SELECT * FROM targets WHERE provider_type = 'gdrive' OR provider_type = 'googledrive'").get();

let gdriveTargetId;
if (existing) {
    gdriveTargetId = existing.target_id;
    console.log(`ℹ️ Google Drive target already exists with ID: ${gdriveTargetId}`);
} else {
    gdriveTargetId = crypto.randomUUID();
    db.prepare(`
        INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        gdriveTargetId,
        'Enterprise Google Drive Lake',
        'gdrive',
        'https://www.googleapis.com/drive/v3',
        'root',
        'enterprise-gdrive-service-account@google-drive-lake.iam.gserviceaccount.com',
        'demo-gdrive-key',
        'global'
    );
    console.log(`✅ Created Enterprise Google Drive target with ID: ${gdriveTargetId}`);
}

// Grant permissions to all users
const users = db.prepare('SELECT user_id, email FROM users').all();
for (const u of users) {
    const perm = db.prepare('SELECT * FROM permissions WHERE subject_id = ? AND target_id = ?').get(u.user_id, gdriveTargetId);
    if (!perm) {
        db.prepare(`
            INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
            VALUES (?, 'user', ?, 1, 1, 1)
        `).run(u.user_id, gdriveTargetId);
        console.log(`✅ Granted permissions on Google Drive to ${u.email}`);
    }
}

console.log('🏁 Google Drive Target Setup Complete!');
