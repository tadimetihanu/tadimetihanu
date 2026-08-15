const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database('./data/metadata.db');

const targetId = crypto.randomUUID();
const localPath = path.resolve('./minio_data/datalake');

try {
    // 1. Insert Local Target
    db.prepare(`
        INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, is_active)
        VALUES (?, 'Local Data Lake (Emergency)', 'local', ?, 'datalake', 1)
    `).run(targetId, localPath);
    
    // 2. Grant Admin Permissions
    const admin = db.prepare('SELECT user_id FROM users WHERE email = ?').get('admin@cloudobjectiq.com');
    if (admin) {
        db.prepare(`
            INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
            VALUES (?, 'user', ?, 1, 1, 1)
        `).run(admin.user_id, targetId);
    }

    console.log('✅ Local Data Target Added Successfully');
    console.log('Target ID:', targetId);
    console.log('Path:', localPath);
} catch (e) {
    console.error('❌ Failed to add target:', e.message);
}
