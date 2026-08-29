const duckdb = require('duckdb');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const gdrive = require('../drivers/gdrive');

// SSL CA Certificate Paths for libcurl / OpenSSL / DuckDB
if (!process.env.CURL_CA_BUNDLE) process.env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
if (!process.env.SSL_CERT_FILE) process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
if (!process.env.SSL_CERT_DIR) process.env.SSL_CERT_DIR = '/etc/ssl/certs';

// ── Global Connections ────────────────────────────────────────
const metaDb = new Database('./data/metadata.db');
try {
    metaDb.exec(`
        CREATE TABLE IF NOT EXISTS metadata_catalog (
            id TEXT PRIMARY KEY,
            target_id TEXT,
            file_path TEXT,
            file_name TEXT,
            file_size INTEGER,
            format TEXT,
            last_modified TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
} catch (e) {
    console.warn('[Engine DB] Warning initializing metadata_catalog:', e.message);
}
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
            'INSTALL iceberg', 'LOAD iceberg',
            `SET s3_url_style='path'`,
            `SET s3_region='us-east-1'`,
            `SET unsafe_enable_version_guessing = true`
        ];

        // Auto-configure SSL CA certificate bundle for Linux / Docker environments
        const possibleCaPaths = [
            '/etc/ssl/certs/ca-certificates.crt',
            '/etc/pki/tls/certs/ca-bundle.crt',
            '/etc/ssl/ca-bundle.pem',
            '/etc/ssl/cert.pem'
        ];
        for (const caPath of possibleCaPaths) {
            if (fs.existsSync(caPath)) {
                exts.push(`SET ca_cert_file='${caPath}'`);
                console.log(`🔒 [DuckDB] Configured CA Cert file: ${caPath}`);
                break;
            }
        }
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
    const pathMatch = sql.match(/(?:from\s+|read_[a-z_]+\s*\(\s*)['\"]([^'\"]+)['\"]/i);
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

    if (type === 'minio' || type === 's3' || type === 'r2' || type === 'cloudflare') {
        const rawEp = target.endpoint || '';
        const ep = rawEp.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const ssl = !rawEp.startsWith('http://');
        const region = target.region || (type === 'r2' || type === 'cloudflare' ? 'auto' : 'us-east-1');
        const secretName = `s3_${target.target_id || target.bucket}`.replace(/[^a-z0-9_]/gi, '_');

        const cmds = [
            `SET s3_url_style='path'`,
            `SET s3_use_ssl=${ssl}`,
            `CREATE OR REPLACE SECRET ${secretName} (
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
        let connStr = target.endpoint || '';
        
        // Auto-build connection string if only AccountName and keys were provided
        if (connStr && !connStr.includes('AccountKey=')) {
            let accountName = target.access_key || '';
            let accountKey = target.secret_key || '';
            if (!accountName && connStr.includes('.blob.core.windows.net')) {
                const m = connStr.match(/https?:\/\/([^.]+)\.blob\.core\.windows\.net/);
                if (m) accountName = m[1];
            } else if (!accountName && !connStr.includes('.')) {
                accountName = connStr;
            }
            if (accountName && accountKey) {
                connStr = `DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
            }
        }

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

            
        // [NEW] Metadata Catalog Verification
        // Block raw URIs
        if (sql.match(/s3:\/\//i) || sql.match(/az:\/\//i)) {
            throw new Error('Direct cloud storage URIs are disabled. Please use the filename registered in the Metadata Catalog.');
        }

        const pathMatch = sql.match(/(?:from\s+|read_[a-z_]+\s*\(\s*|iceberg_[a-z_]+\s*\(\s*)['"]([^'"]+)['"]/i);
        if (pathMatch) {
            let logicalName = pathMatch[1];
            
            // Look up in metadata catalog for this target
            let row = metaDb.prepare('SELECT file_path, format FROM metadata_catalog WHERE target_id = ? AND file_name = ?').get(targetId, logicalName);
            if (!row) {
                row = metaDb.prepare('SELECT file_path, format FROM metadata_catalog WHERE target_id = ? AND file_path = ?').get(targetId, logicalName);
            }
            if (!row) {
                const cleanName = logicalName.replace(/\.iceberg$/i, '');
                row = metaDb.prepare('SELECT file_path, format FROM metadata_catalog WHERE target_id = ? AND (file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?)').get(targetId, cleanName, `${cleanName}.iceberg`, cleanName, `${cleanName}.iceberg`);
            }
            // Cross-target catalog resolution
            if (!row) {
                const cleanName = logicalName.replace(/\.iceberg$/i, '');
                row = metaDb.prepare('SELECT file_path, format FROM metadata_catalog WHERE file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?').get(logicalName, `${cleanName}.iceberg`, cleanName, logicalName);
            }

            // Local sample & cache directory resolution
            let localSamplePath = null;
            const sampleCandidates = [
                path.join(__dirname, '..', '..', 'data', 'samples', logicalName),
                path.join(__dirname, '..', '..', 'minio_data', 'datalake', logicalName),
                path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', logicalName)
            ];
            for (const sp of sampleCandidates) {
                if (fs.existsSync(sp)) {
                    localSamplePath = sp.replace(/\\/g, '/');
                    break;
                }
            }

            if (!row && !localSamplePath) {
                try {
                    const { ensureAllSampleData } = require('../utils/sample_data');
                    ensureAllSampleData();
                    for (const sp of sampleCandidates) {
                        if (fs.existsSync(sp)) {
                            localSamplePath = sp.replace(/\\/g, '/');
                            break;
                        }
                    }
                    row = metaDb.prepare('SELECT file_path, format FROM metadata_catalog WHERE file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?').get(logicalName, `${logicalName}.iceberg`, logicalName.replace(/\.iceberg$/i, ''), logicalName);
                } catch (e) {}
            }

            if (row) {
                logicalName = row.file_path;
            }

            // Construct physical URI
            let physicalUri;
            if (localSamplePath) {
                physicalUri = localSamplePath;
            } else {
                const prefix = target.provider_type === 'azure' || target.provider_type === 'adls' ? 'az://' : 's3://';
                physicalUri = prefix + (target.bucket || 'datalake') + '/' + logicalName.replace(/^\/+/, '');
            }

            // If table format is iceberg and not already using iceberg_scan/iceberg_*, wrap in iceberg_scan
            const isIcebergTable = (row && row.format === 'iceberg') || logicalName.toLowerCase().endsWith('.iceberg') || logicalName.toLowerCase().includes('iceberg');
            const hasIcebergFunction = /iceberg_[a-z_]+\s*\(/i.test(sql);

            if (isIcebergTable && !hasIcebergFunction && !/read_[a-z_]+\s*\(/i.test(sql)) {
                // Rewrite `FROM 'logicalName'` -> `FROM iceberg_scan('physicalUri')`
                sql = sql.replace(new RegExp(`FROM\\s+['"]${pathMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'i'), `FROM iceberg_scan('${physicalUri}')`);
            } else {
                // Standard rewrite
                sql = sql.replace(pathMatch[1], physicalUri);
            }
        }
    

            await initSecret(target);

            let executableSql = sql;

            // Handle R2 path prefix (translate r2:// to s3:// for DuckDB)
            if (target.provider_type === 'r2' || target.provider_type === 'cloudflare') {
                executableSql = executableSql.replace(/r2:\/\//gi, 's3://');
            }

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

            // Handle Iceberg path mapping for local/demo sample tables
            if (executableSql.includes('iceberg_scan')) {
                const icebergMatches = executableSql.match(/iceberg_scan\s*\(\s*['"]([^'"]+)['"]\s*\)/gi) || [];
                for (const matchStr of icebergMatches) {
                    const m = matchStr.match(/iceberg_scan\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
                    if (m && m[1]) {
                        const rawPath = m[1];
                        const tableName = path.basename(rawPath);
                        const possibleLocalDirs = [
                            path.join(__dirname, '..', '..', 'data', 'samples', tableName),
                            path.join(__dirname, '..', '..', 'minio_data', 'datalake', tableName),
                            path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', tableName)
                        ];
                        if (target.endpoint && target.endpoint.includes('localhost')) {
                            for (const dir of possibleLocalDirs) {
                                const dataDir = path.join(dir, 'data');
                                if (fs.existsSync(dataDir)) {
                                    const normPath = path.join(dataDir, '*.parquet').replace(/\\/g, '/');
                                    executableSql = executableSql.replace(m[0], `read_parquet('${normPath}')`);
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            console.log(`🔍 [Query] Executing: ${executableSql.substring(0, 80)}...`);

            let rows;
            try {
                rows = await new Promise((res, rej) => {
                    conn.all(executableSql, (err, rows) => {
                        if (err) rej(err);
                        else res(rows);
                    });
                });
            } catch (queryErr) {
                // Reset transaction state on failure before attempting any fallback query
                await new Promise(r => conn.run('ROLLBACK', () => r()));

                // If Azure direct connection failed (e.g. SSL CA error or Azure C++ driver issue),
                // fall back to downloading via Node.js Azure SDK and running query locally!
                if ((target.provider_type === 'azure' || target.provider_type === 'adls') &&
                    (queryErr.message.includes('SSL CA cert') || queryErr.message.includes('Fail to get a new connection') || queryErr.message.includes('AzureStorageFileSystem'))) {
                    
                    console.log('🔄 [Engine Fallback] Direct Azure DuckDB query failed with SSL/connection error. Falling back to Azure Blob SDK...');
                    const { downloadFile } = require('../drivers/storage');
                    const fileRefMatches = sql.match(/['"](az:\/\/[^'"]+|[^'"]+\.(?:parquet|csv|json|orc|tsv|txt))['"]/gi) || [];
                    
                    let fallbackSql = sql;
                    for (const matchStr of fileRefMatches) {
                        const rawPath = matchStr.replace(/^['"]|['"]$/g, '');
                        const filename = path.basename(rawPath);
                        const localCached = path.join(os.tmpdir(), `az-cache-${filename}`);
                        
                        try {
                            if (!fs.existsSync(localCached)) {
                                await downloadFile(targetId, rawPath, localCached);
                            }
                            const normalizedPath = localCached.replace(/\\/g, '/');
                            fallbackSql = fallbackSql.split(rawPath).join(normalizedPath);
                        } catch (dlErr) {
                            console.error(`[Azure Fallback] Download failed for ${rawPath}:`, dlErr.message);
                        }
                    }

                    console.log(`🔍 [Engine Fallback] Executing fallback query: ${fallbackSql.substring(0, 80)}...`);
                    rows = await new Promise((res, rej) => {
                        conn.all(fallbackSql, (err, rows) => {
                            if (err) rej(err);
                            else res(rows);
                        });
                    });
                } else if (/iceberg_scan/i.test(executableSql) || /iceberg/i.test(queryErr.message) || /Failed to read iceberg table/i.test(queryErr.message)) {
                    // Iceberg direct parquet data fallback if MinIO/S3 version-hint is missing or offline
                    const m = executableSql.match(/iceberg_scan\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
                    if (m && m[1]) {
                        const rawPath = m[1];
                        const tableName = path.basename(rawPath);
                        const possibleLocalDirs = [
                            path.join(__dirname, '..', '..', 'minio_data', 'datalake', tableName),
                            path.join(__dirname, '..', '..', 'data', 'samples', tableName),
                            path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', tableName)
                        ];
                        let found = false;
                        for (const dir of possibleLocalDirs) {
                            const dataDir = path.join(dir, 'data');
                            if (fs.existsSync(dataDir)) {
                                const normPath = path.join(dataDir, '*.parquet').replace(/\\/g, '/');
                                const fallbackSql = executableSql.replace(m[0], `read_parquet('${normPath}')`);
                                console.log(`🔄 [Iceberg Fallback] Querying local table data: ${fallbackSql.substring(0, 80)}...`);
                                rows = await new Promise((res, rej) => {
                                    conn.all(fallbackSql, (err, rows) => {
                                        if (err) rej(err);
                                        else res(rows);
                                    });
                                });
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            // Try scanning S3 data parquet directly
                            const dataFallbackSql = executableSql.replace(m[0], `read_parquet('${rawPath}/data/*.parquet')`);
                            console.log(`🔄 [Iceberg Remote Fallback] Scanning remote data directory: ${dataFallbackSql.substring(0, 80)}...`);
                            rows = await new Promise((res, rej) => {
                                conn.all(dataFallbackSql, (err, rows) => {
                                    if (err) rej(err);
                                    else res(rows);
                                });
                            });
                        }
                    } else {
                        throw queryErr;
                    }
                } else {
                    throw queryErr;
                }
            }

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
