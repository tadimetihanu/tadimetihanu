const fs = require('fs');
const dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data/metadata.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(dbPath);

// ── Auto-Create Tables on Boot ────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        oauth_provider TEXT,
        oauth_id TEXT,
        display_name TEXT,
        refresh_token TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_groups (
        user_id TEXT,
        group_id TEXT,
        PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS targets (
        target_id TEXT PRIMARY KEY,
        target_name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        endpoint TEXT,
        bucket TEXT NOT NULL,
        access_key TEXT,
        secret_key TEXT,
        region TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS permissions (
        permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        can_read INTEGER DEFAULT 1,
        can_write INTEGER DEFAULT 1,
        can_delete INTEGER DEFAULT 1,
        access_level TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(subject_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS query_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        query_text TEXT,
        execution_time_ms INTEGER,
        row_count INTEGER,
        status TEXT,
        target_id TEXT,
        data_scanned_bytes INTEGER DEFAULT 0,
        calculated_cost_usd REAL DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS metadata_catalog (
        id TEXT PRIMARY KEY,
        target_id TEXT,
        file_path TEXT,
        file_name TEXT,
        file_size INTEGER,
        format TEXT,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nl2sql_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT,
        sql TEXT,
        result_summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ── Auto-Seed Admin Account ───────────────────────────────────
try {
    const adminCheck = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@cloudobjectiq.com');
    if (!adminCheck) {
        console.log('[Boot] Seeding initial admin (admin@cloudobjectiq.com)...');
        const adminHash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (user_id, email, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)')
          .run('admin-root-001', 'admin@cloudobjectiq.com', adminHash, 'admin', 'Admin');
        console.log('[Boot] Admin seeded successfully!');
    }
} catch (e) {
    console.error('[Boot] Auto-seed error:', e.message);
}
