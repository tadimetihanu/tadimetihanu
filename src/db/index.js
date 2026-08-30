const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { SQLITE_SCHEMA, POSTGRES_SCHEMA, DEFAULT_TARGETS } = require('./schema');

let _isPostgres = false;
let _pgPool = null;
let _sqliteDb = null;
let _initPromise = null;

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONNECTION_STRING;

if (dbUrl) {
    try {
        const { Pool } = require('pg');
        const isLocalPg = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
        _pgPool = new Pool({
            connectionString: dbUrl,
            ssl: isLocalPg ? false : { rejectUnauthorized: false }
        });
        _isPostgres = true;
        console.log('🐘 [Control Plane DB] Configured for PostgreSQL');
    } catch (err) {
        console.warn('⚠️ [Control Plane DB] PostgreSQL init failed, falling back to SQLite:', err.message);
        _isPostgres = false;
    }
}

if (!_isPostgres) {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'metadata.db');
    _sqliteDb = new Database(dbPath);
    console.log('🪶 [Control Plane DB] Configured for SQLite (data/metadata.db)');
}

// ── SQL Parameter Translator (Converts `?` to `$1, $2, ...` for PostgreSQL) ──
function translateSql(sql) {
    if (!_isPostgres) return sql;

    let index = 0;
    // Replace `?` not inside string literals
    let inString = false;
    let stringChar = '';
    let out = '';

    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];
        if (!inString && (char === "'" || char === '"')) {
            inString = true;
            stringChar = char;
            out += char;
        } else if (inString && char === stringChar) {
            if (sql[i + 1] === stringChar) {
                // Escaped quote
                out += char + sql[i + 1];
                i++;
            } else {
                inString = false;
                out += char;
            }
        } else if (!inString && char === '?') {
            index++;
            out += `$${index}`;
        } else {
            out += char;
        }
    }

    // Translate common SQLiteisms to PostgreSQL
    out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+metadata_catalog\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, cols, vals) => {
        return `INSERT INTO metadata_catalog (${cols}) VALUES (${vals}) ON CONFLICT (id) DO UPDATE SET file_path = EXCLUDED.file_path, file_name = EXCLUDED.file_name, file_size = EXCLUDED.file_size, format = EXCLUDED.format, last_modified = EXCLUDED.last_modified`;
    });

    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+metadata_catalog\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, cols, vals) => {
        return `INSERT INTO metadata_catalog (${cols}) VALUES (${vals}) ON CONFLICT (id) DO NOTHING`;
    });

    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+users\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, cols, vals) => {
        return `INSERT INTO users (${cols}) VALUES (${vals}) ON CONFLICT (email) DO NOTHING`;
    });

    out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+permissions\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, cols, vals) => {
        return `INSERT INTO permissions (${cols}) VALUES (${vals}) ON CONFLICT (subject_id, target_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write, can_delete = EXCLUDED.can_delete`;
    });

    return out;
}

// ── Database Methods ──

async function exec(sql) {
    if (_isPostgres) {
        return await _pgPool.query(sql);
    } else {
        return _sqliteDb.exec(sql);
    }
}

async function query(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return res.rows;
    } else {
        const stmt = _sqliteDb.prepare(sql);
        if (sql.trim().match(/^(SELECT|PRAGMA)/i)) {
            return stmt.all(...params);
        } else {
            const info = stmt.run(...params);
            return info;
        }
    }
}

async function get(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return res.rows[0] || null;
    } else {
        const stmt = _sqliteDb.prepare(sql);
        return stmt.get(...params) || null;
    }
}

async function all(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return res.rows;
    } else {
        const stmt = _sqliteDb.prepare(sql);
        return stmt.all(...params);
    }
}

async function run(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return { changes: res.rowCount, rowCount: res.rowCount };
    } else {
        const stmt = _sqliteDb.prepare(sql);
        return stmt.run(...params);
    }
}

// Synchronous SQLite helper for internal sync lookups when in SQLite mode
function getSync(sql, params = []) {
    if (!_isPostgres && _sqliteDb) {
        return _sqliteDb.prepare(sql).get(...params);
    }
    return null;
}

function allSync(sql, params = []) {
    if (!_isPostgres && _sqliteDb) {
        return _sqliteDb.prepare(sql).all(...params);
    }
    return [];
}

// ── Database Initialization & Seeding ──

async function initDatabase() {
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
            if (_isPostgres) {
                console.log('🔄 [Control Plane DB] Initializing PostgreSQL schemas...');
                await _pgPool.query(POSTGRES_SCHEMA);
            } else {
                console.log('🔄 [Control Plane DB] Initializing SQLite schemas...');
                _sqliteDb.exec(SQLITE_SCHEMA);

                // Auto-migrate last_modified column if missing
                try {
                    const cols = _sqliteDb.prepare("PRAGMA table_info(metadata_catalog)").all().map(c => c.name);
                    if (!cols.includes('last_modified')) {
                        _sqliteDb.prepare("ALTER TABLE metadata_catalog ADD COLUMN last_modified TEXT").run();
                    }
                } catch (e) {}
            }

            // 1. Seed Admin User if none exists
            const adminUser = await get('SELECT user_id FROM users WHERE email = ?', ['admin@cloudobjectiq.com']);
            if (!adminUser) {
                const adminId = crypto.randomUUID();
                const hash = await bcrypt.hash('Admin@123456', 10);
                await run('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)', [
                    adminId,
                    'admin@cloudobjectiq.com',
                    hash,
                    'admin'
                ]);
                console.log('👤 [Control Plane DB] Seeded default Admin user: admin@cloudobjectiq.com');
            }

            // 2. Seed Default Targets if targets table is empty
            const existingTargets = await all('SELECT target_id FROM targets');
            if (existingTargets.length === 0) {
                for (const t of DEFAULT_TARGETS) {
                    await run(`
                        INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, credentials, region, is_active)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [t.target_id, t.target_name, t.provider_type, t.endpoint, t.bucket, t.credentials, t.region, t.is_active]);
                }
                console.log(`🎯 [Control Plane DB] Seeded ${DEFAULT_TARGETS.length} default cloud targets`);
            }

            console.log('✅ [Control Plane DB] Control Plane Database initialized successfully');
        } catch (err) {
            console.error('❌ [Control Plane DB] Database initialization error:', err);
        }
    })();

    return _initPromise;
}

module.exports = {
    isPostgres: _isPostgres,
    pgPool: _pgPool,
    sqliteDb: _sqliteDb,
    initDatabase,
    exec,
    query,
    get,
    all,
    run,
    getSync,
    allSync
};
