const db = require('../db');

const MAX_LOGS = 5000;
let pruneCounter = 0;

async function pruneLogs() {
    try {
        await db.run(`
            DELETE FROM system_logs
            WHERE id NOT IN (
                SELECT id FROM system_logs ORDER BY timestamp DESC LIMIT ?
            )
        `, [MAX_LOGS]);
    } catch (_) {
        // Ignore prune errors
    }
}

function systemLog(level, category, message, meta = {}) {
    // Wait until DB is initialized before writing logs so schema creation finishes first
    const status = db.getStatus ? db.getStatus() : { ready: true };
    if (!status.ready) return;

    db.run(
        'INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)',
        [level, category, message, JSON.stringify(meta)]
    ).then(() => {
        pruneCounter++;
        if (pruneCounter >= 100) {
            pruneCounter = 0;
            pruneLogs();
        }
    }).catch((e) => {
        console.error('[Logger Failed]', e.message);
    });
}

module.exports = {
    logInfo: (category, message, meta) => systemLog('INFO', category, message, meta),
    logWarn: (category, message, meta) => systemLog('WARN', category, message, meta),
    logError: (category, message, meta) => systemLog('ERROR', category, message, meta)
};
