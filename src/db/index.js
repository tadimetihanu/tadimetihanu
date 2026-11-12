const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { SQLITE_SCHEMA, POSTGRES_SCHEMA, POSTGRES_MIGRATIONS, DEFAULT_TARGETS } = require('./schema');
const { decryptSecret } = require('../utils/crypto');

const RENDER_DEFAULT_INSTANCE_ID = 'dpg-dbk8g0etlv9c73f5kitg-a';

let _isPostgres = false;
let _pgPool = null;
let _sqliteDb = null;
let _initPromise = null;
let _isReady = false;
let _sslEnabled = false;
let _dbMeta = {
    engine: 'sqlite',
    host: 'local',
    database: 'data/metadata.db',
    renderInstanceId: process.env.RENDER_POSTGRES_ID || RENDER_DEFAULT_INSTANCE_ID
};

function resolvePostgresUrl() {
    const directUrl = (
        process.env.DATABASE_URL ||
        process.env.INTERNAL_DATABASE_URL ||
        process.env.EXTERNAL_DATABASE_URL ||
        process.env.RENDER_POSTGRES_URL ||
        process.env.POSTGRES_URL ||
        process.env.PG_CONNECTION_STRING ||
        ''
    ).trim();

    if (directUrl) return directUrl;

    if (process.env.PGPASSWORD && process.env.PGUSER && process.env.PGDATABASE) {
        const host = (process.env.PGHOST || process.env.RENDER_POSTGRES_ID || RENDER_DEFAULT_INSTANCE_ID).trim();
        const port = (process.env.PGPORT || '5432').trim();
        const user = encodeURIComponent(process.env.PGUSER.trim());
        const pass = encodeURIComponent(process.env.PGPASSWORD.trim());
        const dbName = encodeURIComponent(process.env.PGDATABASE.trim());
        return `postgresql://${user}:${pass}@${host}:${port}/${dbName}`;
    }

    return '';
}

function parseDbUrlMetadata(dbUrl) {
    try {
        const parsed = new URL(dbUrl);
        const host = parsed.hostname || 'unknown';
        const database = (parsed.pathname || '').replace(/^\/+/, '') || 'postgres';
        const dpgMatch = host.match(/(dpg-[a-z0-9]+)/i);
        return {
            host,
            database,
            renderInstanceId: dpgMatch ? `${dpgMatch[1]}-a`.replace(/-a-a$/, '-a') : (host.startsWith('dpg-') ? host.split('.')[0] : RENDER_DEFAULT_INSTANCE_ID)
        };
    } catch (_) {
        return {
            host: 'postgres',
            database: 'postgres',
            renderInstanceId: RENDER_DEFAULT_INSTANCE_ID
        };
    }
}

function createPgPool(dbUrl, useSsl) {
    const { Pool, types } = require('pg');
    // Return BIGINT (OID 20) and NUMERIC (OID 1700) as JS Numbers to match SQLite behavior
    types.setTypeParser(20, (val) => (val === null ? null : Number(val)));
    types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

    // Strip sslmode query param if manually overriding ssl option to prevent pg-connection-string conflicts
    let cleanUrl = dbUrl;
    if (!useSsl) {
        cleanUrl = dbUrl.replace(/([?&])sslmode=[^&]+(&?)/i, (m, p1, p2) => (p2 ? p1 : '')).replace(/[?&]$/, '');
    }

    return new Pool({
        connectionString: cleanUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });
}

function initSqliteFallback() {
    if (_sqliteDb) return _sqliteDb;
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'metadata.db');
    _sqliteDb = new Database(dbPath);
    _dbMeta = {
        engine: 'sqlite',
        host: 'local',
        database: 'data/metadata.db',
        renderInstanceId: process.env.RENDER_POSTGRES_ID || RENDER_DEFAULT_INSTANCE_ID
    };
    console.log('🪶 [Control Plane DB] Configured for SQLite (data/metadata.db)');
    return _sqliteDb;
}

const _resolvedDbUrl = resolvePostgresUrl();

if (_resolvedDbUrl) {
    try {
        const meta = parseDbUrlMetadata(_resolvedDbUrl);
        const isLocalPg = meta.host === 'localhost' || meta.host === '127.0.0.1';
        const isInternalRenderHost = /^dpg-[a-z0-9-]+$/i.test(meta.host) && !meta.host.includes('.render.com');
        const forceSsl = /sslmode=(require|verify-ca|verify-full)/i.test(_resolvedDbUrl) || process.env.PGSSLMODE === 'require';

        // External Render Postgres (*.render.com) requires TLS; internal Render private hostnames often connect without TLS unless sslmode=require
        _sslEnabled = forceSsl || (!isLocalPg && !isInternalRenderHost);
        _pgPool = createPgPool(_resolvedDbUrl, _sslEnabled);
        _pgPool.on('error', (err) => {
            console.error('⚠️ [Control Plane DB] Idle PostgreSQL client error:', err.message);
        });
        _isPostgres = true;
        _dbMeta = {
            engine: 'postgresql',
            host: meta.host,
            database: meta.database,
            renderInstanceId: meta.host.startsWith('dpg-') ? meta.host.split('.')[0] : meta.renderInstanceId
        };
        console.log(`🐘 [Control Plane DB] Configured for Render PostgreSQL (${_dbMeta.host}/${_dbMeta.database}, ssl=${_sslEnabled})`);
    } catch (err) {
        console.warn('⚠️ [Control Plane DB] PostgreSQL pool setup failed, falling back to SQLite:', err.message);
        _isPostgres = false;
    }
}

if (!_isPostgres) {
    initSqliteFallback();
}

// ── Credential Helpers (keeps credentials, access_key, secret_key in sync) ──
function parseCredentials(credentials, accessKey, secretKey) {
    let creds = typeof credentials === 'string' ? decryptSecret(credentials).trim() : '';
    let ak = typeof accessKey === 'string' ? decryptSecret(accessKey).trim() : '';
    let sk = typeof secretKey === 'string' ? decryptSecret(secretKey).trim() : '';

    if (creds && (!ak && !sk)) {
        if (creds.startsWith('{') && creds.endsWith('}')) {
            ak = creds;
            sk = 'json-key';
        } else if (creds.includes('AccountName=') || creds.includes('AccountKey=')) {
            const nameMatch = creds.match(/AccountName=([^;]+)/i);
            const keyMatch = creds.match(/AccountKey=([^;]+)/i);
            ak = nameMatch ? nameMatch[1].trim() : creds;
            sk = keyMatch ? keyMatch[1].trim() : '';
        } else if (creds.includes(':')) {
            const idx = creds.indexOf(':');
            ak = creds.slice(0, idx);
            sk = creds.slice(idx + 1);
        } else {
            ak = creds;
            sk = creds;
        }
    } else if (!creds && (ak || sk)) {
        creds = `${ak}:${sk}`;
    }

    return { credentials: creds, access_key: ak, secret_key: sk };
}

function normalizeTargetRow(row) {
    if (!row || typeof row !== 'object') return row;
    if (!('provider_type' in row) && !('target_id' in row)) return row;
    const synced = parseCredentials(row.credentials, row.access_key, row.secret_key);
    return {
        ...row,
        credentials: synced.credentials,
        access_key: synced.access_key,
        secret_key: synced.secret_key,
        krb_keytab: row.krb_keytab ? decryptSecret(row.krb_keytab) : row.krb_keytab
    };
}

// ── SQL Parameter & Dialect Translator (SQLite -> PostgreSQL) ──
function translateSql(sql) {
    if (!_isPostgres) return sql;

    let index = 0;
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

    // Translate SQLite datetime('now') to PostgreSQL CURRENT_TIMESTAMP
    out = out.replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP');

    // Translate SQLite UPSERT / IGNORE idioms to PostgreSQL ON CONFLICT
    out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+metadata_catalog\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, cols, vals) => {
        const colNames = cols.split(',').map(c => c.trim().toLowerCase());
        const updates = ['file_path = EXCLUDED.file_path', 'file_name = EXCLUDED.file_name', 'file_size = EXCLUDED.file_size', 'format = EXCLUDED.format'];
        if (colNames.includes('schema_json')) updates.push('schema_json = EXCLUDED.schema_json');
        if (colNames.includes('last_modified')) updates.push('last_modified = EXCLUDED.last_modified');
        return `INSERT INTO metadata_catalog (${cols}) VALUES (${vals}) ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`;
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
        return res.rows.map(normalizeTargetRow);
    } else {
        const stmt = _sqliteDb.prepare(sql);
        if (sql.trim().match(/^(SELECT|PRAGMA)/i)) {
            return stmt.all(...params).map(normalizeTargetRow);
        } else {
            return stmt.run(...params);
        }
    }
}

async function get(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return normalizeTargetRow(res.rows[0]) || null;
    } else {
        const stmt = _sqliteDb.prepare(sql);
        return normalizeTargetRow(stmt.get(...params)) || null;
    }
}

async function all(sql, params = []) {
    if (_isPostgres) {
        const pgSql = translateSql(sql);
        const res = await _pgPool.query(pgSql, params);
        return res.rows.map(normalizeTargetRow);
    } else {
        const stmt = _sqliteDb.prepare(sql);
        return stmt.all(...params).map(normalizeTargetRow);
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
        return normalizeTargetRow(_sqliteDb.prepare(sql).get(...params));
    }
    return null;
}

function allSync(sql, params = []) {
    if (!_isPostgres && _sqliteDb) {
        return _sqliteDb.prepare(sql).all(...params).map(normalizeTargetRow);
    }
    return [];
}

function getStatus() {
    return {
        engine: _isPostgres ? 'postgresql' : 'sqlite',
        isPostgres: _isPostgres,
        ready: _isReady,
        ssl: _isPostgres ? _sslEnabled : false,
        host: _dbMeta.host,
        database: _dbMeta.database,
        renderInstanceId: _dbMeta.renderInstanceId
    };
}

// ── Database Initialization & Seeding ──

async function verifyOrNegotiatePostgres() {
    try {
        await _pgPool.query('SELECT 1');
        return true;
    } catch (firstErr) {
        const msg = (firstErr && firstErr.message) || '';
        const sslMismatch =
            msg.includes('does not support SSL') ||
            msg.includes('SSL/TLS required') ||
            msg.includes('SSL off') ||
            msg.includes('no pg_hba.conf entry') ||
            msg.includes('EPROTO');

        if (sslMismatch && _resolvedDbUrl) {
            const nextSsl = !_sslEnabled;
            console.log(`🔄 [Control Plane DB] Retrying PostgreSQL handshake with ssl=${nextSsl}...`);
            try {
                await _pgPool.end().catch(() => {});
                _sslEnabled = nextSsl;
                _pgPool = createPgPool(_resolvedDbUrl, _sslEnabled);
                _pgPool.on('error', (err) => {
                    console.error('⚠️ [Control Plane DB] Idle PostgreSQL client error:', err.message);
                });
                await _pgPool.query('SELECT 1');
                console.log(`✅ [Control Plane DB] PostgreSQL connected with ssl=${_sslEnabled}`);
                return true;
            } catch (retryErr) {
                console.error('❌ [Control Plane DB] PostgreSQL SSL retry failed:', retryErr.message);
            }
        } else {
            console.error('❌ [Control Plane DB] PostgreSQL connection check failed:', msg);
        }
        return false;
    }
}

async function ensureSqliteMigrations() {
    const migrations = [
        ['users', 'oauth_provider', 'TEXT'],
        ['users', 'oauth_id', 'TEXT'],
        ['users', 'display_name', 'TEXT'],
        ['users', 'refresh_token', 'TEXT'],
        ['targets', 'credentials', 'TEXT'],
        ['targets', 'access_key', 'TEXT'],
        ['targets', 'secret_key', 'TEXT'],
        ['targets', 'krb_principal', 'TEXT'],
        ['targets', 'krb_keytab', 'TEXT'],
        ['metadata_catalog', 'schema_json', 'TEXT'],
        ['metadata_catalog', 'last_modified', 'TEXT'],
        ['query_history', 'execution_id', 'TEXT'],
        ['query_history', 'on_demand_cost_usd', 'REAL DEFAULT 0'],
        ['query_history', 'storage_downloaded_bytes', 'INTEGER DEFAULT 0'],
        ['query_history', 'cache_status', "TEXT DEFAULT 'MISS'"],
        ['query_logs', 'execution_id', 'TEXT'],
        ['query_logs', 'storage_downloaded_bytes', 'INTEGER DEFAULT 0'],
        ['query_logs', 'cache_status', "TEXT DEFAULT 'MISS'"],
        ['query_logs', 'on_demand_cost_usd', 'REAL DEFAULT 0'],
        ['users', 'tenant_id', "TEXT DEFAULT 'default'"],
        ['query_history', 'tenant_id', "TEXT DEFAULT 'default'"],
        ['query_logs', 'tenant_id', "TEXT DEFAULT 'default'"]
    ];
    for (const [table, col, colType] of migrations) {
        try {
            const cols = _sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
            if (cols.length > 0 && !cols.includes(col)) {
                _sqliteDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${colType}`).run();
            }
        } catch (_) {}
    }
}

async function initDatabase() {
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
            if (_isPostgres) {
                const connected = await verifyOrNegotiatePostgres();
                if (!connected) {
                    console.warn('⚠️ [Control Plane DB] Falling back to local SQLite because PostgreSQL is unreachable.');
                    await _pgPool.end().catch(() => {});
                    _pgPool = null;
                    _isPostgres = false;
                    initSqliteFallback();
                }
            }

            if (_isPostgres) {
                console.log('🔄 [Control Plane DB] Initializing PostgreSQL metadata schemas...');
                await _pgPool.query(POSTGRES_SCHEMA);
                for (const alterSql of POSTGRES_MIGRATIONS) {
                    try {
                        await _pgPool.query(alterSql);
                    } catch (_) {}
                }
            } else {
                console.log('🔄 [Control Plane DB] Initializing SQLite metadata schemas...');
                _sqliteDb.exec(SQLITE_SCHEMA);
                await ensureSqliteMigrations();
            }

            // 1. Seed Admin User if none exists (matches login form default 'admin123' unless ADMIN_PASSWORD env var is set)
            const adminEmail = process.env.ADMIN_EMAIL || 'admin@cloudobjectiq.com';
            const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
            const adminUser = await get('SELECT user_id, password_hash FROM users WHERE email = ?', [adminEmail]);
            if (!adminUser) {
                const adminId = crypto.randomUUID();
                const hash = await bcrypt.hash(adminPass, 10);
                await run('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)', [
                    adminId,
                    adminEmail,
                    hash,
                    'admin'
                ]);
                console.log(`👤 [Control Plane DB] Seeded default Admin user: ${adminEmail}`);
            } else if (!process.env.ADMIN_PASSWORD && adminUser.password_hash && bcrypt.compareSync('Admin@123456', adminUser.password_hash)) {
                const hash = await bcrypt.hash('admin123', 10);
                await run('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, adminUser.user_id]);
                console.log(`🔑 [Control Plane DB] Synchronized default Admin password for ${adminEmail}`);
            }

            // 2. Seed Default Targets if targets table is empty
            const existingTargets = await all('SELECT target_id, credentials, access_key, secret_key FROM targets');
            if (existingTargets.length === 0) {
                for (const t of DEFAULT_TARGETS) {
                    await run(`
                        INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, credentials, access_key, secret_key, region, is_active)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [t.target_id, t.target_name, t.provider_type, t.endpoint, t.bucket, t.credentials, t.access_key, t.secret_key, t.region, t.is_active]);
                }
                console.log(`🎯 [Control Plane DB] Seeded ${DEFAULT_TARGETS.length} default cloud targets`);
            } else {
                // Backfill access_key / secret_key on any existing targets that only stored credentials
                for (const row of existingTargets) {
                    if (row.credentials && (!row.access_key && !row.secret_key)) {
                        const synced = parseCredentials(row.credentials, '', '');
                        if (synced.access_key || synced.secret_key) {
                            await run(
                                'UPDATE targets SET access_key = ?, secret_key = ? WHERE target_id = ?',
                                [synced.access_key, synced.secret_key, row.target_id]
                            );
                        }
                    }
                }
            }

            // 3. Seed sample datasets & metadata_catalog if catalog is empty
            const catalogCountRow = await get('SELECT COUNT(*) AS cnt FROM metadata_catalog');
            if (!catalogCountRow || Number(catalogCountRow.cnt) === 0) {
                try {
                    const { ensureAllSampleData } = require('../utils/sample_data');
                    await ensureAllSampleData();
                } catch (sampleErr) {
                    console.warn('⚠️ [Control Plane DB] Sample catalog seed notice:', sampleErr.message);
                }
            }

            _isReady = true;
            console.log(`✅ [Control Plane DB] Metadata store ready (${_isPostgres ? 'PostgreSQL' : 'SQLite'})`);
        } catch (err) {
            console.error('❌ [Control Plane DB] Database initialization error:', err);
        }
    })();

    return _initPromise;
}

module.exports = {
    get isPostgres() { return _isPostgres; },
    get pgPool() { return _pgPool; },
    get sqliteDb() { return _sqliteDb; },
    initDatabase,
    getStatus,
    parseCredentials,
    normalizeTargetRow,
    translateSql,
    exec,
    query,
    get,
    all,
    run,
    getSync,
    allSync
};
