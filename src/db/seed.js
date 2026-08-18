const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

const db = new Database('./data/metadata.db');

async function seed() {
    console.log('🌱 Starting database seeding...');

    // 1. Create Admin User
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@cloudobjectiq.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminId = crypto.randomUUID();
    const hash = bcrypt.hashSync(adminPassword, 10);

    const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
    if (!existingUser) {
        db.prepare('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)')
          .run(adminId, adminEmail, hash, 'admin');
        console.log(`✅ Admin created: ${adminEmail}`);
    } else {
        console.log('ℹ️ Admin already exists, skipping.');
    }

    // 2. Add Initial Targets (from .env)
    const targets = [
        {
            id: crypto.randomUUID(),
            name: 'MinIO Local',
            type: 'minio',
            endpoint: process.env.MINIO_ENDPOINT,
            bucket: process.env.MINIO_BUCKET,
            access: process.env.MINIO_ACCESS_KEY,
            secret: process.env.MINIO_SECRET_KEY,
            region: (process.env.MINIO_ENDPOINT || '').includes('.r2.') ? 'auto' : 'us-east-1'
        },
        {
            id: crypto.randomUUID(),
            name: 'Azure Primary',
            type: 'azure',
            endpoint: process.env.AZURE_STORAGE_CONNECTION_STRING,
            bucket: process.env.AZURE_CONTAINER,
            access: null,
            secret: null,
            region: null
        },
        {
            id: crypto.randomUUID(),
            name: 'ADLS Primary Lake',
            type: 'adls',
            endpoint: process.env.ADLS_STORAGE_CONNECTION_STRING,
            bucket: process.env.ADLS_CONTAINER,
            access: null,
            secret: null,
            region: null
        }
    ];

    for (const t of targets) {
        const existingTarget = db.prepare('SELECT * FROM targets WHERE endpoint = ?').get(t.endpoint);
        if (!existingTarget) {
            db.prepare(`
                INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(t.id, t.name, t.type, t.endpoint, t.bucket, t.access, t.secret, t.region);
            console.log(`✅ Target added: ${t.name}`);

            // Grant admin permission to this target
            const userId = existingUser ? existingUser.user_id : adminId;
            db.prepare(`
                INSERT INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
                VALUES (?, ?, ?, 1, 1, 1)
            `).run(userId, 'user', t.id);
            console.log(`✅ Granted admin permissions to ${t.name}`);
        }
    }

    console.log('✨ Seeding complete.');
}

seed().catch(err => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
});
