const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const target_id = require('crypto').randomUUID();
const target_name = 'azureblob1';
const account_name = 'hcdp';
const account_key = 'beJ2L9vyu4TobcnuXwrJ5nGkhs/AdJiVHYzZdsUI8ZduMfOLfV2ry2JmmkvFgm08J2iVJD5scwFy+Juo5MLFJQ==';
const container = 'test';

const connectionString = `DefaultEndpointsProtocol=https;AccountName=${account_name};AccountKey=${account_key};EndpointSuffix=core.windows.net`;

db.prepare(`
    INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region, is_active)
    VALUES (?, ?, 'azure', ?, ?, '', '', '', 1)
`).run(target_id, target_name, connectionString, container);

// Also add admin permission for it
const admin = db.prepare("SELECT user_id FROM users WHERE role = 'admin'").get();
if (admin) {
    db.prepare(`
        INSERT OR IGNORE INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
        VALUES (?, 'user', ?, 1, 1, 1)
    `).run(admin.user_id, target_id);
}

console.log('✅ RESTORED azureblob1 successfully');
