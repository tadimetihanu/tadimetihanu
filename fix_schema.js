const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

console.log('🔧 [Schema Fix] Checking database tables and columns...');

// 1. Users table
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
const requiredUserCols = [
    { name: 'oauth_id', type: 'TEXT' },
    { name: 'oauth_provider', type: 'TEXT' },
    { name: 'display_name', type: 'TEXT' },
    { name: 'refresh_token', type: 'TEXT' }
];
for (const col of requiredUserCols) {
    if (!userCols.includes(col.name)) {
        db.prepare(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`).run();
        console.log(`✅ Added column ${col.name} to users table.`);
    }
}

// 2. Query logs table
const queryCols = db.prepare('PRAGMA table_info(query_logs)').all().map(c => c.name);
const requiredQueryCols = [
    { name: 'data_scanned_bytes', type: 'INTEGER DEFAULT 0' },
    { name: 'calculated_cost_usd', type: 'REAL DEFAULT 0.0' }
];
for (const col of requiredQueryCols) {
    if (!queryCols.includes(col.name)) {
        db.prepare(`ALTER TABLE query_logs ADD COLUMN ${col.name} ${col.type}`).run();
        console.log(`✅ Added column ${col.name} to query_logs table.`);
    }
}

// 3. NL2SQL table
db.prepare(`
    CREATE TABLE IF NOT EXISTS nl2sql_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT,
        sql TEXT,
        result_summary TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

console.log('✨ All schema tables & columns verified!');
