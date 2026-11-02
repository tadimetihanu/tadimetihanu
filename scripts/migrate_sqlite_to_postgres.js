/**
 * Migrates existing local SQLite metadata (data/metadata.db) to Render PostgreSQL
 * and verifies schema initialization on dpg-dbk8g0etlv9c73f5kitg-a.
 *
 * Usage:
 *   DATABASE_URL="postgresql://user:pass@dpg-dbk8g0etlv9c73f5kitg-a.<region>-postgres.render.com/<db>" node scripts/migrate_sqlite_to_postgres.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('../src/db');

async function migrate() {
    await db.initDatabase();
    const status = db.getStatus();

    if (!status.isPostgres) {
        console.error('❌ PostgreSQL is not active. Set DATABASE_URL (External Database URL from Render dpg-dbk8g0etlv9c73f5kitg-a) and re-run.');
        process.exit(1);
    }

    console.log(`✅ Connected to Render PostgreSQL (${status.host}/${status.database})`);

    const sqlitePath = path.join(__dirname, '..', 'data', 'metadata.db');
    if (!fs.existsSync(sqlitePath) || fs.statSync(sqlitePath).size === 0) {
        console.log('ℹ️  No non-empty local data/metadata.db found; PostgreSQL schemas and seed records are ready.');
        process.exit(0);
    }

    const Database = require('better-sqlite3');
    const sqlite = new Database(sqlitePath, { readonly: true });
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);

    if (tables.includes('users')) {
        const rows = sqlite.prepare('SELECT * FROM users').all();
        for (const u of rows) {
            await db.run(
                `INSERT INTO users (user_id, email, password_hash, role, oauth_provider, oauth_id, display_name, refresh_token)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (email) DO UPDATE SET
                   role = EXCLUDED.role,
                   oauth_provider = COALESCE(EXCLUDED.oauth_provider, users.oauth_provider),
                   oauth_id = COALESCE(EXCLUDED.oauth_id, users.oauth_id),
                   display_name = COALESCE(EXCLUDED.display_name, users.display_name),
                   refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token)`,
                [u.user_id, u.email, u.password_hash, u.role || 'viewer', u.oauth_provider || null, u.oauth_id || null, u.display_name || null, u.refresh_token || null]
            );
        }
        console.log(`👤 Migrated ${rows.length} users`);
    }

    if (tables.includes('targets')) {
        const rows = sqlite.prepare('SELECT * FROM targets').all();
        for (const t of rows) {
            const synced = db.parseCredentials(t.credentials, t.access_key, t.secret_key);
            await db.run(
                `INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, credentials, access_key, secret_key, region, is_active, krb_principal, krb_keytab)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (target_id) DO UPDATE SET
                   target_name = EXCLUDED.target_name,
                   provider_type = EXCLUDED.provider_type,
                   endpoint = EXCLUDED.endpoint,
                   bucket = EXCLUDED.bucket,
                   credentials = EXCLUDED.credentials,
                   access_key = EXCLUDED.access_key,
                   secret_key = EXCLUDED.secret_key,
                   region = EXCLUDED.region,
                   is_active = EXCLUDED.is_active`,
                [t.target_id, t.target_name, t.provider_type, t.endpoint || '', t.bucket || null, synced.credentials, synced.access_key, synced.secret_key, t.region || '', t.is_active ?? 1, t.krb_principal || null, t.krb_keytab || null]
            );
        }
        console.log(`🎯 Migrated ${rows.length} targets`);
    }

    if (tables.includes('permissions')) {
        const rows = sqlite.prepare('SELECT * FROM permissions').all();
        for (const p of rows) {
            const id = p.id || `${p.subject_id}_${p.target_id}`;
            await db.run(
                `INSERT OR REPLACE INTO permissions (id, subject_id, subject_type, target_id, can_read, can_write, can_delete)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [String(id), p.subject_id, p.subject_type || 'user', p.target_id, p.can_read ? 1 : 0, p.can_write ? 1 : 0, p.can_delete ? 1 : 0]
            );
        }
        console.log(`🔐 Migrated ${rows.length} permissions`);
    }

    if (tables.includes('metadata_catalog')) {
        const rows = sqlite.prepare('SELECT * FROM metadata_catalog').all();
        for (const c of rows) {
            const id = String(c.id || `${c.target_id}_${c.file_path}`);
            await db.run(
                `INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, schema_json, last_modified)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, c.target_id, c.file_path, c.file_name || c.file_path, Number(c.file_size || 0), c.format || 'unknown', c.schema_json || null, c.last_modified || null]
            );
        }
        console.log(`📚 Migrated ${rows.length} metadata_catalog entries`);
    }

    sqlite.close();
    console.log('🎉 Render PostgreSQL metadata migration complete!');
    process.exit(0);
}

migrate().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
