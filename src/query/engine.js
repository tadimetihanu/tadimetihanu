const duckdb = require('duckdb');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const gdrive = require('../drivers/gdrive');

// ── Global Connections ────────────────────────────────────────
const metaDb = new Database('./data/metadata.db');
const engineDb = new duckdb.Database(':memory:');
const conn = engineDb.connect();

let _isBooted = false;
let _queue = Promise.resolve();

// ── Boot Sequence ─────────────────────────────────────────────
async function boot() {
    console.log('🚀 [Boot] Initializing Cloud Query Engine...');
    try {
        const exts = [
            'INSTALL httpfs', 'LOAD httpfs', 
            'INSTALL azure', 'LOAD azure', 
            'INSTALL fts', 'LOAD fts', 
            `SET s3_url_style='path'`,
            `SET s3_region='us-east-1'`
        ];
        for (const cmd of exts) {
            await new Promise((res, rej) => conn.run(cmd, (e) => e ? rej(e) : res()));
        }
        _isBooted = true;
        console.log('🏁 [Boot] All Cloud Extensions Loaded.');
    } catch (err) {
        console.error('❌ [Boot] Failed to load extensions:', err.message);
        // We continue anyway, some queries might work
        _isBooted = true;
    }
    return true;
}
const _bootPromise = boot();

function enqueue(fn) {
    const p = _queue.then(async () => {
        try { 
            return await fn(); 
        } catch (e) { 
            // Recover duckdb from dirty transaction state
            await new Promise(r => conn.run('ROLLBACK', r));
            throw e; 
        }
    });
    _queue = p.catch(() => {});
    return p;
}

function getTarget(targetId) {
    const target = metaDb.prepare('SELECT * FROM targets WHERE target_id = ?').get(targetId);
    if (!target) throw new Error(`Target ${targetId} not found`);
    return target;
}

/**
 * Calculates a slightly varying cost based on the filename to simulate realistic distinct object sizes.
 */
function calculateCost(sql, rows) {
    let fileFactor = 1.0;
    const pathMatch = sql.match(/(?:from|read_[a-z_]+)\s*\(['"]?([^'"]+)['"]?\)/i);
    if (pathMatch) {
        let hash = 0;
        for (let i = 0; i < pathMatch[1].length; i++) {
            hash = ((hash << 5) - hash) + pathMatch[1].charCodeAt(i);
            hash |= 0;
        }
        // Varies the floor from 1.0x to 8.9x
        fileFactor = 1.0 + (Math.abs(hash) % 800) / 100.0;
    }
    const estimatedScan = Math.max(
        JSON.stringify(rows, (k, v) => typeof v === 'bigint' ? v.toString() : v).length * 2 + 10485, 
        104857 * fileFactor
    );
    const estimatedCost = (estimatedScan / (1024 * 1024 * 1024)) * 5.50;
    return { estimatedScan, estimatedCost };
}

// ── Secret Initializer ────────────────────────────────────────
async function initSecret(target) {
    const type = target.provider_type;

    if (type === 'minio' || type === 's3') {
        const rawEp = target.endpoint || '';
        const ep = rawEp.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const ssl = rawEp.startsWith('https');
        const region = target.region || 'us-east-1';

        const cmds = [
            `SET s3_url_style='path'`,
            `SET s3_use_ssl=${ssl}`,
            `CREATE OR REPLACE SECRET minio_secret (
                TYPE S3,
                KEY_ID '${target.access_key}',
                SECRET '${target.secret_key}',
                REGION '${region}',
                ENDPOINT '${ep}',
                URL_STYLE 'path',
                USE_SSL ${ssl}
            )`
        ];
        for (const cmd of cmds) {
            await new Promise((res, rej) => conn.run(cmd, (e) => e ? rej(e) : res()));
        }

    } else if (type === 'azure' || type === 'adls') {
        const connStr = target.endpoint || '';
        const accMatch = connStr.match(/AccountName=([^;]+)/i);
        const accName = accMatch ? accMatch[1] : 'azure';
        const scope = `az://${target.bucket}/`;
        const secretName = `azure_${accName}_${target.bucket}`.replace(/[^a-z0-9_]/gi, '_');

        await new Promise((res, rej) => {
            conn.run(`
                CREATE OR REPLACE SECRET ${secretName} (
                    TYPE AZURE,
                    CONNECTION_STRING '${connStr}',
                    SCOPE '${scope}'
                );
            `, (e) => e ? rej(e) : res());
        });
    }
}

// ── Query Execution ───────────────────────────────────────────
async function runQuery(userId, sql, targetId) {
    await _bootPromise;

    const target = getTarget(targetId);
    const startTime = Date.now();

    return enqueue(async () => {
        try {
            await initSecret(target);

            let executableSql = sql;

            // Handle Google Drive file caching and path transformation
            if (target.provider_type === 'gdrive' || target.provider_type === 'googledrive') {
                const fileRefMatches = sql.match(/['"](gdrive:\/\/[^'"]+|[^'"]+\.(?:parquet|csv|json|orc|tsv|txt))['"]/gi) || [];
                for (const matchStr of fileRefMatches) {
                    const rawPath = matchStr.replace(/^['"]|['"]$/g, '');
                    const filename = path.basename(rawPath);
                    let localCached = gdrive.getCachedFilePath(filename);
                    if (!localCached || !fs.existsSync(localCached)) {
                        const targetDest = path.join(gdrive.CACHE_DIR, filename);
                        try {
                            await gdrive.downloadFile(target, filename, targetDest);
                            localCached = targetDest;
                        } catch (err) {
                            console.warn(`[GDrive Engine] Could not download ${filename} on demand:`, err.message);
                        }
                    }
                    if (localCached && fs.existsSync(localCached)) {
                        const normalizedPath = localCached.replace(/\\/g, '/');
                        executableSql = executableSql.split(rawPath).join(normalizedPath);
                    }
                }
            }

            console.log(`🔍 [Query] Executing: ${executableSql.substring(0, 80)}...`);

            const rows = await new Promise((res, rej) => {
                conn.all(executableSql, (err, rows) => {
                    if (err) rej(err);
                    else res(rows);
                });
            });

            const duration = Date.now() - startTime;
            const { estimatedScan, estimatedCost } = calculateCost(sql, rows);
            logQuery(userId, targetId, sql, rows.length, duration, 'success', estimatedScan, estimatedCost);
            return rows;

        } catch (err) {
            const duration = Date.now() - startTime;
            console.error(`❌ [Query] Failed (${duration}ms): ${err.message}`);
            logQuery(userId, targetId, sql, 0, duration, 'failed', 0, 0);
            throw err;
        }
    });
}

// ── Audit Logging ─────────────────────────────────────────────
function logQuery(userId, targetId, sql, rowCount, duration, status, scannedBytes = 0, costUsd = 0) {
    try {
        metaDb.prepare(`
            INSERT INTO query_logs (user_id, target_id, query_text, row_count, execution_time_ms, status, data_scanned_bytes, calculated_cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, targetId, sql, rowCount, duration, status, scannedBytes, costUsd);
    } catch (err) {
        console.error('Failed to log query:', err.message);
    }
}

module.exports = { runQuery, getTarget, calculateCost };
