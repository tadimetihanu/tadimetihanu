const Database = require('better-sqlite3');
const fs = require('fs');

if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
}

// We open a dedicated connection for logging
const logDb = new Database('./data/metadata.db');

// Ensure table exists
try {
    logDb.prepare(`
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            level TEXT,
            category TEXT,
            message TEXT,
            metadata TEXT
        )
    `).run();
    
    // Create an index for faster querying
    logDb.prepare(`CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp)`).run();
} catch (e) {
    console.warn('[Logger] Failed to initialize system_logs table:', e.message);
}

const MAX_LOGS = 5000;

function pruneLogs() {
    try {
        logDb.prepare(`
            DELETE FROM system_logs 
            WHERE id NOT IN (
                SELECT id FROM system_logs ORDER BY timestamp DESC LIMIT ?
            )
        `).run(MAX_LOGS);
    } catch (e) {
        // Ignore prune errors
    }
}

// Intermittent pruning (roughly 1 in every 100 log writes)
let pruneCounter = 0;

function systemLog(level, category, message, meta = {}) {
    try {
        logDb.prepare(
            'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)'
        ).run(level, category, message, JSON.stringify(meta));
        
        pruneCounter++;
        if (pruneCounter >= 100) {
            pruneLogs();
            pruneCounter = 0;
        }
    } catch (e) {
        // Fallback to console if DB fails
        console.error("[Logger Failed]", e.message);
    }
}

module.exports = {
    logInfo: (category, message, meta) => systemLog('INFO', category, message, meta),
    logWarn: (category, message, meta) => systemLog('WARN', category, message, meta),
    logError: (category, message, meta) => systemLog('ERROR', category, message, meta)
};
