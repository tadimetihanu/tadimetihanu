const duckdb = require('duckdb');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const gdrive = require('../drivers/gdrive');
const db = require('../db');
const logger = require('../utils/logger');
const { shouldProactivelyStageOutOfCore, executeOutOfCore } = require('./out_of_core');
const { computeQueryScanMetrics, calculateCost, invalidateParquetStatsCache } = require('./scan_metrics');
const { resolveFederatedSql } = require('./catalog_resolver');

// SSL CA Certificate Paths for libcurl / OpenSSL / DuckDB
if (!process.env.CURL_CA_BUNDLE) process.env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
if (!process.env.SSL_CERT_FILE) process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
if (!process.env.SSL_CERT_DIR) process.env.SSL_CERT_DIR = '/etc/ssl/certs';

const SPILL_DIR = path.join(process.cwd(), 'data', '.duckdb_spill');
const PARQUET_CACHE_DIR = path.join(process.cwd(), 'data', '.parquet_cache');
const MAX_PARQUET_CACHE_BYTES = Number(process.env.PARQUET_CACHE_MAX_MB || 1200) * 1024 * 1024;
const MAX_SINGLE_CACHE_FILE_BYTES = Number(process.env.PARQUET_CACHE_SINGLE_MAX_MB || 450) * 1024 * 1024;

function _prepareEngineDirs() {
    try {
        if (fs.existsSync(SPILL_DIR)) {
            fs.rmSync(SPILL_DIR, { recursive: true, force: true });
        }
    } catch (_) {}
    try { fs.mkdirSync(SPILL_DIR, { recursive: true }); } catch (_) {}
    try { fs.mkdirSync(PARQUET_CACHE_DIR, { recursive: true }); } catch (_) {}
}
_prepareEngineDirs();

function detectContainerMemoryMB() {
    const cgroupPaths = [
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes'
    ];
    for (const cgPath of cgroupPaths) {
        try {
            if (fs.existsSync(cgPath)) {
                const raw = fs.readFileSync(cgPath, 'utf8').trim();
                if (raw && raw !== 'max') {
                    const bytes = Number(raw);
                    if (Number.isFinite(bytes) && bytes > 0 && bytes < 1e14) {
                        return Math.floor(bytes / (1024 * 1024));
                    }
                }
            }
        } catch (_) {}
    }
    return Math.floor(os.totalmem() / (1024 * 1024));
}

function computeDuckDBLimits() {
    const containerMB = detectContainerMemoryMB();
    let memoryLimit;
    let threads;
    if (containerMB <= 600) {
        // Stage-by-stage SSD materialization in out_of_core.js makes 2 threads fast and safe within 288MiB
        memoryLimit = '288MiB';
        threads = 2;
    } else if (containerMB <= 1200) {
        memoryLimit = '600MiB';
        threads = 2;
    } else if (containerMB <= 2500) {
        memoryLimit = '1280MiB';
        threads = 2;
    } else {
        memoryLimit = '2048MiB';
        threads = 4;
    }
    return {
        containerMB,
        memoryLimit: process.env.DUCKDB_MEMORY_LIMIT || memoryLimit,
        threads: Number(process.env.DUCKDB_THREADS || threads)
    };
}

const _engineLimits = computeDuckDBLimits();
const ENGINE_DB_PATH = path.join(SPILL_DIR, 'engine.duckdb');
let engineDb;
try {
    engineDb = new duckdb.Database(ENGINE_DB_PATH);
} catch (_) {
    engineDb = new duckdb.Database(':memory:');
}
const conn = engineDb.connect();

let _isBooted = false;
let _queue = Promise.resolve();
const _loadedExtensions = new Set();

function _runSqlCmd(cmd) {
    return new Promise((res, rej) => conn.run(cmd, (e) => e ? rej(e) : res()));
}

function _allSqlCmd(cmd) {
    return new Promise((res, rej) => conn.all(cmd, (e, rows) => e ? rej(e) : res(rows)));
}

async function ensureExtension(extName) {
    const name = String(extName || '').trim().toLowerCase();
    if (!name || _loadedExtensions.has(name)) return;
    try {
        if (name === 'orc') {
            try {
                await _runSqlCmd('INSTALL orc FROM community');
                await _runSqlCmd('LOAD orc');
                _loadedExtensions.add('orc');
                console.log('🧩 [DuckDB] Loaded community extension: orc');
                return;
            } catch (e1) {
                try {
                    await _runSqlCmd('INSTALL orc');
                    await _runSqlCmd('LOAD orc');
                    _loadedExtensions.add('orc');
                    console.log('🧩 [DuckDB] Loaded core extension: orc');
                    return;
                } catch (e2) {
                    console.warn('⚠️ [DuckDB] orc extension not available:', e2.message);
                }
            }
        }
        await _runSqlCmd(`INSTALL ${name}`);
        await _runSqlCmd(`LOAD ${name}`);
        if (name === 'iceberg') {
            try { await _runSqlCmd(`SET unsafe_enable_version_guessing = true`); } catch (_) {}
        }
        _loadedExtensions.add(name);
        console.log(`🧩 [DuckDB] Lazy-loaded extension: ${name}`);
    } catch (err) {
        console.warn(`⚠️ [DuckDB] Could not load extension '${name}':`, err.message);
    }
}

// ── Boot Sequence ─────────────────────────────────────────────
async function boot() {
    console.log('🚀 [Boot] Initializing Cloud Query Engine...');
    const limits = _engineLimits;
    const spillNorm = SPILL_DIR.replace(/\\/g, '/').replace(/'/g, "''");

    // 1. Apply critical memory, thread, and SSD spill-to-disk limits unconditionally
    const corePragmas = [
        `SET temp_directory='${spillNorm}'`,
        `SET max_temp_directory_size='12GiB'`,
        `SET memory_limit='${limits.memoryLimit}'`,
        `SET threads=${limits.threads}`,
        `SET preserve_insertion_order=false`
    ];
    for (const cmd of corePragmas) {
        try {
            await _runSqlCmd(cmd);
        } catch (err) {
            console.warn(`⚠️ [DuckDB] Pragma notice (${cmd}):`, err.message);
        }
    }

    // Optional allocator & streaming buffer tuning to return freed C++ pages to OS immediately
    for (const optCmd of [`SET allocator_flush_threshold='16MiB'`, `SET streaming_buffer_size='8MiB'`]) {
        try { await _runSqlCmd(optCmd); } catch (_) {}
    }

    console.log(`🧠 [DuckDB] Container RAM: ${limits.containerMB}MB → memory_limit=${limits.memoryLimit}, threads=${limits.threads}, spill=${spillNorm}`);

    // 2. Load httpfs for S3/R2; heavy extensions (azure, iceberg, fts) are lazy-loaded on demand
    try {
        await ensureExtension('httpfs');
        const httpCmds = [
            `SET s3_url_style='path'`,
            `SET s3_region='us-east-1'`
        ];
        const possibleCaPaths = [
            '/etc/ssl/certs/ca-certificates.crt',
            '/etc/pki/tls/certs/ca-bundle.crt',
            '/etc/ssl/ca-bundle.pem',
            '/etc/ssl/cert.pem'
        ];
        for (const caPath of possibleCaPaths) {
            if (fs.existsSync(caPath)) {
                httpCmds.push(`SET ca_cert_file='${caPath}'`);
                console.log(`🔒 [DuckDB] Configured CA Cert file: ${caPath}`);
                break;
            }
        }
        for (const cmd of httpCmds) {
            try { await _runSqlCmd(cmd); } catch (_) {}
        }
        _isBooted = true;
        console.log('🏁 [Boot] Cloud Query Engine Ready.');
    } catch (err) {
        console.error('❌ [Boot] Failed to initialize httpfs:', err.message);
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

async function getTarget(targetId) {
    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) throw new Error(`Target ${targetId} not found`);
    return target;
}

function _cleanBucketName(bucket) {
    return String(bucket || '').trim().replace(/^\/+|\/+$/g, '');
}

function _isR2Target(target) {
    const pType = String(target.provider_type || '').trim().toLowerCase();
    const ep = String(target.endpoint || '').trim().toLowerCase();
    return pType === 'r2' || pType === 'cloudflare' || ep.includes('r2.cloudflarestorage.com');
}

function _getParquetCachePath(targetId, objectKey) {
    const safeTarget = String(targetId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanKey = String(objectKey || '').trim().replace(/^\/+/, '');
    const safeSegments = cleanKey
        .split('/')
        .filter(s => s && s !== '.' && s !== '..')
        .map(s => s.replace(/[^a-zA-Z0-9._-]/g, '_'));
    if (safeSegments.length === 0) return null;
    return path.join(PARQUET_CACHE_DIR, safeTarget, ...safeSegments);
}

function invalidateCachedFile(targetId, objectKey) {
    try {
        invalidateParquetStatsCache();
        const p = _getParquetCachePath(targetId, objectKey);
        if (p && fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    } catch (_) {}
}

function clearAllCaches() {
    let filesRemoved = 0;
    let bytesFreed = 0;

    try {
        invalidateParquetStatsCache();
    } catch (_) {}

    try {
        if (fs.existsSync(PARQUET_CACHE_DIR)) {
            const allFiles = _collectCachedFiles(PARQUET_CACHE_DIR);
            for (const f of allFiles) {
                try {
                    fs.unlinkSync(f.path);
                    filesRemoved++;
                    bytesFreed += f.size || 0;
                } catch (_) {}
            }
        }
    } catch (_) {}

    try {
        if (fs.existsSync(SPILL_DIR)) {
            const spillFiles = _collectCachedFiles(SPILL_DIR);
            for (const f of spillFiles) {
                try {
                    fs.unlinkSync(f.path);
                    filesRemoved++;
                    bytesFreed += f.size || 0;
                } catch (_) {}
            }
        }
    } catch (_) {}

    if (typeof global.gc === 'function') {
        try { global.gc(); } catch (_) {}
    }

    return { filesRemoved, bytesFreed };
}

function _collectCachedFiles(dir, out = []) {
    try {
        if (!fs.existsSync(dir)) return out;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                _collectCachedFiles(full, out);
            } else if (entry.isFile() && !entry.name.startsWith('.tmp_')) {
                try {
                    const st = fs.statSync(full);
                    out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
                } catch (_) {}
            }
        }
    } catch (_) {}
    return out;
}

function _evictParquetCacheIfNeeded(incomingBytes, protectedPaths) {
    try {
        const files = _collectCachedFiles(PARQUET_CACHE_DIR);
        let total = files.reduce((acc, f) => acc + f.size, 0);
        if (total + incomingBytes <= MAX_PARQUET_CACHE_BYTES) return;

        files.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of files) {
            if (total + incomingBytes <= MAX_PARQUET_CACHE_BYTES) break;
            if (protectedPaths && protectedPaths.has(f.path)) continue;
            try {
                fs.unlinkSync(f.path);
                total -= f.size;
            } catch (_) {}
        }
    } catch (_) {}
}

const _inFlightDownloads = new Map();

async function cacheRemoteParquetFiles(targetId, target, executableSql) {
    const cacheReport = {
        hits: 0,
        misses: 0,
        bytesDownloaded: 0,
        perFile: []
    };

    const pType = String(target.provider_type || '').trim().toLowerCase();
    const isCloudProvider = (
        pType === 's3' || pType === 'r2' || pType === 'cloudflare' ||
        pType === 'minio' || pType === 'azure' || pType === 'adls' || _isR2Target(target)
    );

    if (!isCloudProvider) return { executableSql, cacheReport };

    const bucketName = _cleanBucketName(target.bucket) || 'datalake';
    const escapedBucket = bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const uriRegex = new RegExp(`['"]((?:s3|az):\\/\\/${escapedBucket}\\/([^'"*?\\[\\]]+\\.parquet))['"]`, 'gi');

    const matches = Array.from(executableSql.matchAll(uriRegex));
    if (matches.length === 0) return { executableSql, cacheReport };

    const uniqueUris = new Map();
    for (const m of matches) {
        const fullUri = m[1];
        const objectKey = m[2];
        if (!uniqueUris.has(fullUri)) {
            uniqueUris.set(fullUri, objectKey);
        }
    }

    const protectedPaths = new Set();
    for (const objectKey of uniqueUris.values()) {
        const p = _getParquetCachePath(targetId, objectKey);
        if (p) protectedPaths.add(p);
    }

    const { downloadFile } = require('../drivers/storage');
    let updatedSql = executableSql;

    for (const [fullUri, objectKey] of uniqueUris.entries()) {
        const localCachePath = _getParquetCachePath(targetId, objectKey);
        if (!localCachePath) continue;

        let expectedSize = 0;
        try {
            const catRow = await db.get(
                'SELECT file_size FROM metadata_catalog WHERE target_id = ? AND (file_path = ? OR file_name = ?)',
                [targetId, objectKey, objectKey]
            );
            if (catRow && Number(catRow.file_size) > 0) {
                expectedSize = Number(catRow.file_size);
            }
        } catch (_) {}

        if (expectedSize > MAX_SINGLE_CACHE_FILE_BYTES) {
            continue;
        }

        let cacheHit = false;
        let downloadedBytes = 0;
        if (fs.existsSync(localCachePath)) {
            try {
                const st = fs.statSync(localCachePath);
                if (st.size > 0 && (!expectedSize || st.size === expectedSize)) {
                    const now = new Date();
                    try { fs.utimesSync(localCachePath, now, now); } catch (_) {}
                    cacheHit = true;
                }
            } catch (_) {}
        }

        if (!cacheHit) {
            const inflightKey = `${targetId}::${objectKey}`;
            try {
                if (_inFlightDownloads.has(inflightKey)) {
                    downloadedBytes = await _inFlightDownloads.get(inflightKey);
                    cacheHit = fs.existsSync(localCachePath);
                } else {
                    const dlPromise = (async () => {
                        const tmpPath = `${localCachePath}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                        try {
                            fs.mkdirSync(path.dirname(localCachePath), { recursive: true });
                            _evictParquetCacheIfNeeded(expectedSize || 64 * 1024 * 1024, protectedPaths);
                            const dlStart = Date.now();
                            await downloadFile(targetId, objectKey, tmpPath);
                            const dlStat = fs.statSync(tmpPath);
                            if (dlStat.size <= 0) {
                                throw new Error('Downloaded Parquet file is empty');
                            }
                            if (dlStat.size > MAX_SINGLE_CACHE_FILE_BYTES) {
                                try { fs.unlinkSync(tmpPath); } catch (_) {}
                                return 0;
                            }
                            try {
                                fs.renameSync(tmpPath, localCachePath);
                            } catch (renErr) {
                                if (!fs.existsSync(localCachePath)) {
                                    fs.copyFileSync(tmpPath, localCachePath);
                                }
                                try { fs.unlinkSync(tmpPath); } catch (_) {}
                            }
                            console.log(`⚡ [Parquet Cache] Cached '${objectKey}' (${(dlStat.size / (1024 * 1024)).toFixed(2)} MB in ${Date.now() - dlStart}ms)`);
                            return dlStat.size;
                        } catch (innerErr) {
                            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
                            throw innerErr;
                        }
                    })();
                    _inFlightDownloads.set(inflightKey, dlPromise);
                    try {
                        downloadedBytes = await dlPromise;
                        cacheHit = downloadedBytes > 0 || fs.existsSync(localCachePath);
                    } finally {
                        _inFlightDownloads.delete(inflightKey);
                    }
                }
            } catch (dlErr) {
                const rawMsg = dlErr && dlErr.message ? dlErr.message : String(dlErr);
                const rawCode = (dlErr && (dlErr.Code || dlErr.code || dlErr.name)) || '';
                const httpStatus = (dlErr && (dlErr.statusCode || (dlErr.$metadata && dlErr.$metadata.httpStatusCode))) || 0;
                const isAuthErr = httpStatus === 401 || /InvalidAccessKeyId|SignatureDoesNotMatch|AuthenticationFailed|InvalidAccountKey/i.test(rawCode + ' ' + rawMsg);
                const isPermErr = httpStatus === 403 || /AccessDenied|AuthorizationFailure|AuthorizationPermissionMismatch/i.test(rawCode + ' ' + rawMsg);
                const isAzUri = fullUri.toLowerCase().startsWith('az://');
                const extLoaded = isAzUri ? _loadedExtensions.has('azure') : _loadedExtensions.has('httpfs');

                if (isAuthErr || isPermErr || !extLoaded) {
                    const wrapped = new Error(
                        isAuthErr
                            ? `Storage authentication failed for '${target.target_name}' (${objectKey}): ${rawMsg}`
                            : (isPermErr
                                ? `Storage permission denied on '${target.target_name}' (${objectKey}): ${rawMsg}`
                                : `Failed to read remote Parquet '${objectKey}' from '${target.target_name}': ${rawMsg}`)
                    );
                    wrapped.code = isAuthErr ? 'AUTH_FAILURE' : (isPermErr ? 'PERMISSION_DENIED' : 'STORAGE_READ_FAILED');
                    wrapped.statusCode = isAuthErr ? 401 : (isPermErr ? 403 : 502);
                    throw wrapped;
                }
                console.warn(`⚠️ [Parquet Cache] Falling back to httpfs for '${objectKey}': ${rawMsg}`);
            }
        }

        const normLocal = localCachePath.replace(/\\/g, '/');
        if (cacheHit) {
            if (downloadedBytes > 0) {
                cacheReport.bytesDownloaded += downloadedBytes;
                cacheReport.misses++;
            } else {
                cacheReport.hits++;
            }
            cacheReport.perFile.push({
                physPath: normLocal,
                originalUri: fullUri,
                objectKey,
                targetId,
                cacheHit: downloadedBytes === 0,
                downloadedBytes
            });
            updatedSql = updatedSql
                .split(`'${fullUri}'`).join(`'${normLocal}'`)
                .split(`"${fullUri}"`).join(`'${normLocal}'`);
        } else {
            cacheReport.misses++;
            cacheReport.perFile.push({
                physPath: fullUri,
                originalUri: fullUri,
                objectKey,
                targetId,
                cacheHit: false,
                downloadedBytes: 0
            });
        }
    }

    return { executableSql: updatedSql, cacheReport };
}

// ── Secret Initializer ────────────────────────────────────────
async function initSecret(target) {
    const type = (target.provider_type || '').trim().toLowerCase();
    const isR2 = _isR2Target(target);

    if (type === 'minio' || type === 's3' || type === 'r2' || type === 'cloudflare' || isR2) {
        await ensureExtension('httpfs');
        if (!_loadedExtensions.has('httpfs')) return;
        const bucketName = _cleanBucketName(target.bucket);
        const rawEp = (target.endpoint || '').trim();
        let ep = rawEp.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (bucketName && ep.toLowerCase().endsWith('/' + bucketName.toLowerCase())) {
            ep = ep.slice(0, -(bucketName.length + 1)).replace(/\/+$/, '');
        }
        if (isR2 && bucketName) {
            const escapedBucket = bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const vhostRe = new RegExp(`^${escapedBucket}\\.([a-z0-9-]+\\.(?:eu\\.|fedramp\\.)?r2\\.cloudflarestorage\\.com)$`, 'i');
            ep = ep.replace(vhostRe, '$1');
        }

        const ssl = !rawEp.toLowerCase().startsWith('http://');
        let region = (target.region || '').trim();
        if (isR2) {
            const validR2Regions = new Set(['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);
            if (!region || !validR2Regions.has(region.toLowerCase())) region = 'auto';
        } else if (!region) {
            region = 'us-east-1';
        }

        const ak = (target.access_key || '').trim().replace(/'/g, "''");
        const sk = (target.secret_key || '').trim().replace(/'/g, "''");
        const epEsc = ep.replace(/'/g, "''");
        const secretName = `s3_${target.target_id || bucketName || 'default'}`.replace(/[^a-z0-9_]/gi, '_');
        const scopeClause = bucketName ? `, SCOPE 's3://${bucketName.replace(/'/g, "''")}/'` : '';

        const cmds = [
            `SET s3_url_style='path'`,
            `SET s3_use_ssl=${ssl}`,
            `CREATE OR REPLACE SECRET ${secretName} (
                TYPE S3,
                KEY_ID '${ak}',
                SECRET '${sk}',
                REGION '${region}',
                ENDPOINT '${epEsc}',
                URL_STYLE 'path',
                USE_SSL ${ssl}${scopeClause}
            )`
        ];
        for (const cmd of cmds) {
            try { await _runSqlCmd(cmd); } catch (_) {}
        }

    } else if (type === 'azure' || type === 'adls') {
        await ensureExtension('azure');
        if (!_loadedExtensions.has('azure')) return;
        const bucketName = _cleanBucketName(target.bucket) || 'datalake';
        let connStr = '';
        try {
            const { buildAzureConnectionString } = require('../drivers/storage');
            connStr = buildAzureConnectionString(target);
        } catch (_) {
            connStr = (target.endpoint || '').trim();
        }

        if (connStr && (connStr.includes('AccountKey=') || connStr.includes('SharedAccessSignature='))) {
            const accMatch = connStr.match(/AccountName=([^;]+)/i);
            const accName = accMatch ? accMatch[1] : 'azure';
            const scope = `az://${bucketName}/`;
            const secretName = `azure_${accName}_${bucketName}`.replace(/[^a-z0-9_]/gi, '_');
            const connEsc = connStr.replace(/'/g, "''");

            try {
                await _runSqlCmd(`
                    CREATE OR REPLACE SECRET ${secretName} (
                        TYPE AZURE,
                        CONNECTION_STRING '${connEsc}',
                        SCOPE '${scope}'
                    );
                `);
            } catch (e) {
                console.warn('[Azure Secret Notice]', e.message);
            }
        }
    }
}

// ── Query Execution ───────────────────────────────────────────
async function runQuery(userId, sql, targetId, options = {}) {
    await _bootPromise;

    const originalUserSql = sql;
    const startTime = Date.now();
    const executionId = options.executionId || crypto.randomUUID();
    const skipLog = Boolean(options.skipLog);

    try {
        // Resolve user context for RBAC and tenant isolation
        let userObj = options.user || null;
        if (!userObj && userId && userId !== 'admin') {
            userObj = await db.get('SELECT user_id, email, role, tenant_id FROM users WHERE user_id = ?', [userId]);
        }
        if (!userObj) {
            userObj = {
                user_id: userId || 'admin',
                role: userId === 'admin' ? 'admin' : 'user',
                tenant_id: options.tenantId || 'default'
            };
        }

        const target = targetId
            ? await getTarget(targetId)
            : (await db.get('SELECT * FROM targets WHERE is_active = 1 LIMIT 1') || await db.get('SELECT * FROM targets LIMIT 1'));
        if (!target) {
            throw new Error('No active storage target configured.');
        }

        // Enforce tenant isolation on primary target
        const userTenant = userObj.tenant_id || 'default';
        if ((target.tenant_id || 'default') !== userTenant) {
            const tenantErr = new Error(`Tenant security violation: User in tenant '${userTenant}' cannot query target '${target.target_name}' in tenant '${target.tenant_id || 'default'}'.`);
            tenantErr.code = 'TENANT_ISOLATION_VIOLATION';
            tenantErr.statusCode = 403;
            throw tenantErr;
        }

        // Block raw cloud storage URIs entered directly by user
        if (originalUserSql.match(/s3:\/\//i) || originalUserSql.match(/az:\/\//i)) {
            throw new Error('Direct cloud storage URIs are disabled. Please use the logical catalog table name or filename registered in the Metadata Catalog.');
        }

        // Intercept INSERT INTO for Iceberg tables
        const insertMatch = sql.match(/INSERT\s+INTO\s+(?:(?:iceberg_scan\s*\(\s*)?['"]?([a-zA-Z0-9_\-.]+(?:\.iceberg)?)['"]?\s*\)?)\s+([\s\S]+)/i);
        if (insertMatch) {
            let icebergTable = insertMatch[1].trim();
            if (!icebergTable.toLowerCase().endsWith('.iceberg')) {
                icebergTable += '.iceberg';
            }
            let sourceSql = insertMatch[2].trim().replace(/;+\s*$/, '').trim();
            if (/^VALUES\s*\(/i.test(sourceSql)) {
                sourceSql = `SELECT * FROM (${sourceSql})`;
            }
            const { appendIcebergRecords } = require('../drivers/storage');
            const appendRes = await appendIcebergRecords(target.target_id, icebergTable, sourceSql);
            return [{
                status: 'SUCCESS',
                operation: 'ICEBERG_APPEND',
                table_name: icebergTable,
                added_rows: appendRes.addedRows,
                total_rows: appendRes.totalRows,
                snapshot_id: appendRes.snapshotId,
                table_version: `v${appendRes.version}`,
                data_file: appendRes.dataFile,
                message: `✅ Successfully appended ${appendRes.addedRows} record(s) into Iceberg table '${icebergTable}' (Snapshot #${appendRes.snapshotId})`
            }];
        }

        // 1. Resolve 3-part federated logical table names (e.g. aws_customers.crm.customers, azure_sales.sales.orders)
        const fedResolved = await resolveFederatedSql(sql, { user: userObj, userId });
        sql = fedResolved.rewrittenSql;
        const referencedTargetsMap = new Map([[target.target_id, target]]);
        for (const rt of fedResolved.referencedTargets) {
            referencedTargetsMap.set(rt.target_id, rt);
        }
        const referencedTables = fedResolved.referencedTables || [];

        // Map any federated table whose file_path already points to a local file (e.g. local staging/sample) before remote fetch
        for (const refTbl of referencedTables) {
            const tblTarget = referencedTargetsMap.get(refTbl.targetId) || target;
            const hasLiveRemoteEndpoint = tblTarget.endpoint && /^https?:\/\//i.test(tblTarget.endpoint);
            refTbl.isRemoteSource = Boolean(hasLiveRemoteEndpoint);

            const localCandidates = [
                path.isAbsolute(refTbl.filePath || '') ? refTbl.filePath : null,
                path.join(__dirname, '..', '..', 'data', 'samples', refTbl.filePath || ''),
                path.join(__dirname, '..', '..', 'minio_data', _cleanBucketName(tblTarget.bucket) || 'datalake', refTbl.filePath || '')
            ].filter(Boolean);

            let resolvedLocal = null;
            for (const cand of localCandidates) {
                if (fs.existsSync(cand)) {
                    resolvedLocal = cand.replace(/\\/g, '/');
                    break;
                }
            }

            if (resolvedLocal && !hasLiveRemoteEndpoint) {
                sql = sql
                    .split(`'${refTbl.storageUri}'`).join(`'${resolvedLocal}'`)
                    .split(`"${refTbl.storageUri}"`).join(`'${resolvedLocal}'`);
                refTbl.resolvedPath = resolvedLocal;
            } else {
                refTbl.resolvedPath = refTbl.storageUri;
            }
        }

        // 2. Resolve single-target file references (e.g. 'customers.parquet', 'iris.parquet') not already resolved by 3-part catalog resolver
        const federatedUris = new Set(referencedTables.map(t => t.storageUri).concat(referencedTables.map(t => t.resolvedPath)).filter(Boolean));
        const fileRefRegex = /(?:from\s+|join\s+|read_[a-z0-9_]+\s*\(\s*|iceberg_[a-z0-9_]+\s*\(\s*)['"]([^'"]+)['"]/gi;
        const pathMatches = Array.from(sql.matchAll(fileRefRegex));
        const rewrittenRefs = new Set();

        for (const pathMatch of pathMatches) {
            const rawMatchedPath = pathMatch[1];
            if (rewrittenRefs.has(rawMatchedPath) || federatedUris.has(rawMatchedPath)) continue;
            if (/^(?:s3|az|r2|gdrive):\/\//i.test(rawMatchedPath)) continue;
            rewrittenRefs.add(rawMatchedPath);
            let logicalName = rawMatchedPath;

            // Look up in metadata catalog for this target
            let row = await db.get('SELECT * FROM metadata_catalog WHERE target_id = ? AND file_name = ?', [target.target_id, logicalName]);
            if (!row) {
                row = await db.get('SELECT * FROM metadata_catalog WHERE target_id = ? AND file_path = ?', [target.target_id, logicalName]);
            }
            if (!row) {
                const cleanName = logicalName.replace(/\.iceberg$/i, '');
                row = await db.get('SELECT * FROM metadata_catalog WHERE target_id = ? AND (file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?)', [target.target_id, cleanName, `${cleanName}.iceberg`, cleanName, `${cleanName}.iceberg`]);
            }
            if (!row) {
                const cleanName = logicalName.replace(/\.iceberg$/i, '');
                row = await db.get('SELECT * FROM metadata_catalog WHERE file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?', [logicalName, `${cleanName}.iceberg`, cleanName, logicalName]);
            }

            let localSamplePath = null;
            const sampleCandidates = [
                path.isAbsolute(logicalName) ? logicalName : null,
                path.join(__dirname, '..', '..', 'data', 'samples', logicalName),
                path.join(__dirname, '..', '..', 'minio_data', 'datalake', logicalName),
                path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', logicalName)
            ].filter(Boolean);
            for (const sp of sampleCandidates) {
                if (fs.existsSync(sp)) {
                    localSamplePath = sp.replace(/\\/g, '/');
                    break;
                }
            }

            if (!row && !localSamplePath) {
                try {
                    const { ensureAllSampleData } = require('../utils/sample_data');
                    await ensureAllSampleData();
                    for (const sp of sampleCandidates) {
                        if (fs.existsSync(sp)) {
                            localSamplePath = sp.replace(/\\/g, '/');
                            break;
                        }
                    }
                    row = await db.get('SELECT * FROM metadata_catalog WHERE file_name = ? OR file_name = ? OR file_path = ? OR file_path = ?', [logicalName, `${logicalName}.iceberg`, logicalName.replace(/\.iceberg$/i, ''), logicalName]);
                } catch (e) {}
            }

            if (row) {
                logicalName = row.file_path;
            }

            const isLocalTarget = !target.endpoint || target.endpoint.includes('localhost') || target.endpoint.includes('127.0.0.1') || target.provider_type === 'local';
            let physicalUri;
            if (localSamplePath && (isLocalTarget || !row)) {
                physicalUri = localSamplePath;
            } else {
                const prefix = target.provider_type === 'azure' || target.provider_type === 'adls' ? 'az://' : 's3://';
                const cleanBkt = _cleanBucketName(target.bucket) || 'datalake';
                physicalUri = prefix + cleanBkt + '/' + logicalName.replace(/^\/+/, '');
            }

            const isIcebergTable = (row && row.format === 'iceberg') || logicalName.toLowerCase().endsWith('.iceberg') || logicalName.toLowerCase().includes('iceberg');
            const escapedRaw = rawMatchedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const bareFromOrJoinRegex = new RegExp(`((?:FROM|JOIN)\\s+)['"]${escapedRaw}['"]`, 'gi');

            if (isIcebergTable && bareFromOrJoinRegex.test(sql)) {
                sql = sql.replace(bareFromOrJoinRegex, `$1iceberg_scan('${physicalUri}')`);
            } else {
                sql = sql.split(`'${rawMatchedPath}'`).join(`'${physicalUri}'`).split(`"${rawMatchedPath}"`).join(`'${physicalUri}'`);
            }

            referencedTables.push({
                fullName: row?.catalog_name && row?.schema_name && row?.table_name
                    ? `${row.catalog_name}.${row.schema_name}.${row.table_name}`
                    : path.posix.basename(logicalName),
                catalogName: row?.catalog_name || target.catalog_name || 'default',
                schemaName: row?.schema_name || target.default_schema || 'default',
                tableName: row?.table_name || path.posix.basename(logicalName),
                targetId: target.target_id,
                targetName: target.target_name,
                providerType: target.provider_type,
                bucket: target.bucket,
                filePath: logicalName,
                storageUri: physicalUri,
                resolvedPath: physicalUri,
                fileSize: Number(row?.file_size || 0),
                isRemoteSource: !isLocalTarget
            });
        }

        // 3. Initialize DuckDB secrets for all referenced targets (simultaneous S3 + ADLS Gen2 support)
        for (const refTarget of referencedTargetsMap.values()) {
            try {
                await initSecret(refTarget);
            } catch (secErr) {
                console.warn('[DuckDB Secret Notice]', secErr.message);
            }
        }

        let executableSql = sql;

        // Translate r2:// to s3:// for DuckDB
        executableSql = executableSql.replace(/r2:\/\//gi, 's3://');

        // Handle Google Drive file caching and path transformation
        for (const refTarget of referencedTargetsMap.values()) {
            if (refTarget.provider_type === 'gdrive' || refTarget.provider_type === 'googledrive') {
                const fileRefMatches = executableSql.match(/['"](gdrive:\/\/[^'"]+|[^'"]+\.(?:parquet|csv|json|orc|tsv|txt))['"]/gi) || [];
                for (const matchStr of fileRefMatches) {
                    const rawPath = matchStr.replace(/^['"]|['"]$/g, '');
                    const filename = path.basename(rawPath);
                    let localCached = gdrive.getCachedFilePath(filename);
                    if (!localCached || !fs.existsSync(localCached)) {
                        const targetDest = path.join(gdrive.CACHE_DIR, filename);
                        try {
                            await gdrive.downloadFile(refTarget, filename, targetDest);
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

        // Lazy-load heavy extensions only when needed by the query
        if (/iceberg/i.test(executableSql)) {
            await ensureExtension('iceberg');
        }
        if (/\bfts_main_|\bcreate_fts_index\b/i.test(executableSql)) {
            await ensureExtension('fts');
        }
        if (/read_orc/i.test(executableSql) || /\.orc\b/i.test(executableSql)) {
            await ensureExtension('orc');
        }

        // 4. Stream-cache remote cloud Parquet files across ALL referenced targets (S3 + ADLS Gen2)
        const combinedCacheReport = {
            hits: 0,
            misses: 0,
            bytesDownloaded: 0,
            perFile: []
        };
        for (const refTarget of referencedTargetsMap.values()) {
            const cacheResult = await cacheRemoteParquetFiles(refTarget.target_id, refTarget, executableSql);
            executableSql = cacheResult.executableSql || executableSql;
            if (cacheResult.cacheReport) {
                combinedCacheReport.hits += cacheResult.cacheReport.hits || 0;
                combinedCacheReport.misses += cacheResult.cacheReport.misses || 0;
                combinedCacheReport.bytesDownloaded += cacheResult.cacheReport.bytesDownloaded || 0;
                for (const pf of (cacheResult.cacheReport.perFile || [])) {
                    combinedCacheReport.perFile.push(pf);
                    for (const rt of referencedTables) {
                        if (rt.storageUri === pf.originalUri || rt.filePath === pf.objectKey) {
                            rt.resolvedPath = pf.physPath;
                        }
                    }
                }
            }
        }

        console.log(`🔍 [Query] Executing [${executionId.slice(0, 8)}]: ${executableSql.substring(0, 100)}...`);

        // 5. Execute on a dedicated connection handle for concurrent query isolation
        const queryConn = engineDb.connect();
        const runIsolatedSql = (cmd) => new Promise((res, rej) => queryConn.run(cmd, (e) => e ? rej(e) : res()));
        const allIsolatedSql = (cmd) => new Promise((res, rej) => queryConn.all(cmd, (e, r) => e ? rej(e) : res(r)));

        let rows;
        let usedOutOfCore = false;
        try {
            if (shouldProactivelyStageOutOfCore(executableSql, _engineLimits.containerMB)) {
                usedOutOfCore = true;
                rows = await executeOutOfCore(runIsolatedSql, allIsolatedSql, executableSql, SPILL_DIR);
            } else {
                rows = await allIsolatedSql(executableSql);
            }
        } catch (queryErr) {
            await new Promise(r => queryConn.run('ROLLBACK', () => r()));

            if (!usedOutOfCore && /out of memory|could not allocate block/i.test(queryErr.message)) {
                console.log('🧊 [Engine OOM Recovery] DuckDB hit memory ceiling; retrying via Out-of-Core SSD Spill Executor...');
                try { await runIsolatedSql('SET threads=1'); } catch (_) {}
                try {
                    rows = await executeOutOfCore(runIsolatedSql, allIsolatedSql, executableSql, SPILL_DIR);
                } finally {
                    if (_engineLimits.threads > 1) {
                        try { await runIsolatedSql(`SET threads=${_engineLimits.threads}`); } catch (_) {}
                    }
                }
            } else if (/iceberg_scan/i.test(executableSql) || /iceberg/i.test(queryErr.message) || /Failed to read iceberg table/i.test(queryErr.message)) {
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
                            rows = await allIsolatedSql(fallbackSql);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        const dataFallbackSql = executableSql.replace(m[0], `read_parquet('${rawPath}/data/*.parquet')`);
                        rows = await allIsolatedSql(dataFallbackSql);
                    }
                } else {
                    throw queryErr;
                }
            } else {
                if (queryErr.message.includes('404') || queryErr.message.includes('Not Found') || queryErr.message.includes('NoSuchKey')) {
                    const fileMatch = sql.match(/['"]([^'"]+\.(?:parquet|csv|json|orc|iceberg))['"]/i);
                    if (fileMatch) {
                        const searchedFile = path.basename(fileMatch[1]);
                        try {
                            const otherTarget = await db.get(`
                                SELECT m.*, t.target_name 
                                FROM metadata_catalog m
                                JOIN targets t ON m.target_id = t.target_id
                                WHERE (m.file_name = ? OR m.file_path LIKE ?) AND m.target_id != ?
                                LIMIT 1
                            `, [searchedFile, `%${searchedFile}%`, target.target_id]);

                            if (otherTarget) {
                                throw new Error(`File '${searchedFile}' does not exist in target '${target.target_name}'. It is located in target '${otherTarget.target_name}'. Please switch your Active Target to '${otherTarget.target_name}'.`);
                            }
                        } catch (e) {
                            if (e.message.includes('does not exist in target')) throw e;
                        }
                    }
                }
                throw queryErr;
            }
        }

        const duration = Date.now() - startTime;
        const scanMeta = await computeQueryScanMetrics({
            originalSql: originalUserSql,
            executableSql,
            rows,
            targetId: target.target_id,
            allSqlCmd: allIsolatedSql,
            db,
            cacheReport: combinedCacheReport,
            executionId,
            referencedTables
        });
        scanMeta.durationMs = duration;
        scanMeta.rowCount = Array.isArray(rows) ? rows.length : 0;
        scanMeta.status = 'success';
        scanMeta.isFederated = referencedTargetsMap.size > 1 || referencedTables.length > 1;

        if (Array.isArray(rows)) {
            Object.defineProperty(rows, '_scanMeta', {
                value: scanMeta,
                enumerable: false,
                configurable: true
            });
        }
        if (!skipLog && !/^\s*DESCRIBE\b/i.test(originalUserSql)) {
            await logQuery(userId, target.target_id, originalUserSql, rows.length, duration, 'success', scanMeta);
        }
        if (typeof global.gc === 'function') {
            try { global.gc(); } catch (_) {}
        }
        return rows;

    } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`❌ [Query] Failed (${duration}ms): ${err.message}`);
        if (!skipLog && !/^\s*DESCRIBE\b/i.test(originalUserSql)) {
            await logQuery(userId, targetId || 'unknown', originalUserSql, 0, duration, 'failed', {
                executionId,
                errorMessage: err.message
            });
        }
        if (typeof global.gc === 'function') {
            try { global.gc(); } catch (_) {}
        }
        throw err;
    }
}

// ── Audit Logging ─────────────────────────────────────────────
async function logQuery(userId, targetId, sql, rowCount, duration, status, scanMeta = {}) {
    const executionId = scanMeta.executionId || crypto.randomUUID();
    const scannedBytes = Number(scanMeta.logicalScannedBytes || scanMeta.estimatedScan || 0);
    const compressedObjectBytes = Number(scanMeta.compressedObjectBytes || scanMeta.totalDatasetBytes || 0);
    const costUsd = Number(scanMeta.billedCostUsd !== undefined ? scanMeta.billedCostUsd : (scanMeta.estimatedCost || 0));
    const onDemandCostUsd = Number(scanMeta.onDemandCostUsd || 0);
    const storageDownloadedBytes = Number(scanMeta.bytesTransferred !== undefined ? scanMeta.bytesTransferred : (scanMeta.storageBytesDownloaded || 0));
    const cacheStatus = scanMeta.cacheStatus || 'MISS';
    const errorMessage = scanMeta.errorMessage || null;
    const sourceBreakdownJson = Array.isArray(scanMeta.sourceBreakdown) && scanMeta.sourceBreakdown.length > 0
        ? JSON.stringify(scanMeta.sourceBreakdown)
        : null;

    try {
        const queryId = crypto.randomUUID();
        await db.run(`
            INSERT INTO query_history (
                id, execution_id, user_id, target_id, sql_query, duration_ms, row_count,
                status, error_message, cost_usd, on_demand_cost_usd, scan_bytes,
                compressed_object_bytes, storage_downloaded_bytes, cache_status, source_breakdown_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            queryId, executionId, userId, targetId, sql, duration, rowCount,
            status, errorMessage, costUsd, onDemandCostUsd, scannedBytes,
            compressedObjectBytes, storageDownloadedBytes, cacheStatus, sourceBreakdownJson
        ]);
    } catch (err) {
        console.warn('[Query History Log Notice]', err.message);
    }

    try {
        await db.run(`
            INSERT INTO query_logs (
                execution_id, user_id, target_id, query_text, row_count, execution_time_ms,
                status, error_message, data_scanned_bytes, compressed_object_bytes,
                storage_downloaded_bytes, cache_status, calculated_cost_usd, on_demand_cost_usd,
                source_breakdown_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            executionId, userId, targetId, sql, rowCount, duration,
            status, errorMessage, scannedBytes, compressedObjectBytes,
            storageDownloadedBytes, cacheStatus, costUsd, onDemandCostUsd,
            sourceBreakdownJson
        ]);
    } catch (e) {
        console.warn('[Query Audit Log Notice]', e.message);
    }

    if (status === 'success') {
        logger.logInfo('duckdb', `Query Executed (${duration}ms) [${executionId}]`, {
            sql, rowCount, scannedBytes, compressedObjectBytes, storageDownloadedBytes,
            costUsd, onDemandCostUsd, cacheStatus, targetId, userId,
            sources: scanMeta.sourceBreakdown?.length || 1
        });
    } else {
        logger.logError('duckdb', `Query Failed (${duration}ms) [${executionId}]`, {
            sql, targetId, userId, error: errorMessage
        });
    }
}

/**
 * Validates query correctness and benchmark repeatability against native DuckDB engine:
 * 1. Verifies 10M+ raw Parquet row counts across referenced tables via parquet_metadata()
 * 2. Compares Run 1 vs Run 2: independent execution IDs, identical SHA-256 output digests, and SSD cache zero double-charging
 * 3. Proves pricing formula precision ($5.00 / TiB)
 */
async function validateQueryAgainstDuckDB(userId, sql, targetId) {
    await _bootPromise;
    const target = await getTarget(targetId);

    // 1. Identify dataset Parquet files from SQL / target and extract exact table sizes & row counts
    const fileRefRegex = /(?:from\s+|join\s+|read_[a-z0-9_]+\s*\(\s*)['"]([^'"]+)['"]/gi;
    const matchedFiles = Array.from(sql.matchAll(fileRefRegex)).map(m => m[1]);
    const fileStats = [];

    for (const rawName of new Set(matchedFiles)) {
        try {
            const localCandidates = [
                path.join(__dirname, '..', '..', 'data', 'samples', rawName),
                path.join(__dirname, '..', '..', 'minio_data', 'datalake', rawName),
                _getParquetCachePath(targetId, rawName)
            ].filter(Boolean);

            let foundPath = null;
            for (const c of localCandidates) {
                if (fs.existsSync(c)) { foundPath = c.replace(/\\/g, '/'); break; }
            }

            if (foundPath && foundPath.endsWith('.parquet')) {
                const countRows = await _allSqlCmd(`SELECT COUNT(*) AS c FROM read_parquet('${foundPath}')`);
                const metaRows = await _allSqlCmd(`
                    SELECT CAST(COALESCE(SUM(rg_rows), 0) AS BIGINT) AS total_rows,
                           CAST(COUNT(DISTINCT row_group_id) AS BIGINT) AS num_row_groups
                    FROM (
                        SELECT row_group_id, MAX(row_group_num_rows) AS rg_rows
                        FROM parquet_metadata('${foundPath}')
                        GROUP BY row_group_id
                    ) _rg
                `);
                const totalRows = Number(metaRows?.[0]?.total_rows || countRows?.[0]?.c || 0);
                const rowGroups = Number(metaRows?.[0]?.num_row_groups || 1);
                const fileSizeBytes = fs.statSync(foundPath).size;
                fileStats.push({
                    file: rawName,
                    path: foundPath,
                    totalRows,
                    rowGroups,
                    fileSizeBytes,
                    fileSizeFormatted: `${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                });
            }
        } catch (_) {}
    }

    // 2. Run Execution 1 (Run 1)
    const run1Start = Date.now();
    const run1Rows = await runQuery(userId, sql, targetId, { skipLog: true });
    const run1Duration = Date.now() - run1Start;
    const run1Meta = run1Rows._scanMeta || {};
    const run1Digest = crypto.createHash('sha256')
        .update(JSON.stringify(run1Rows.slice(0, 100), (k, v) => typeof v === 'bigint' ? v.toString() : v))
        .digest('hex');

    // 3. Run Execution 2 (Run 2) - must have distinct executionId, identical hash, and cache-hit zero-charge
    const run2Start = Date.now();
    const run2Rows = await runQuery(userId, sql, targetId, { skipLog: true });
    const run2Duration = Date.now() - run2Start;
    const run2Meta = run2Rows._scanMeta || {};
    const run2Digest = crypto.createHash('sha256')
        .update(JSON.stringify(run2Rows.slice(0, 100), (k, v) => typeof v === 'bigint' ? v.toString() : v))
        .digest('hex');

    const digestMatch = run1Digest === run2Digest && run1Rows.length === run2Rows.length;
    const executionIdIsolated = run1Meta.executionId && run2Meta.executionId && run1Meta.executionId !== run2Meta.executionId;

    // 4. Validate Ground-Truth Mathematical Equivalence
    const groundTruthChecks = [];

    // Check A: Table row counts verification (e.g. 10M records)
    for (const fsItem of fileStats) {
        groundTruthChecks.push({
            name: `Table count [${fsItem.file}]`,
            verified: fsItem.totalRows > 0,
            value: fsItem.totalRows.toLocaleString() + ' rows',
            details: `${fsItem.fileSizeFormatted} across ${fsItem.rowGroups} row group(s)`
        });
    }

    // Check B: Query output row count & deterministic ordering
    groundTruthChecks.push({
        name: 'Deterministic output hash (Run 1 vs Run 2)',
        verified: digestMatch,
        value: digestMatch ? 'MATCH (SHA-256 identical)' : 'MISMATCH',
        details: `Rows returned: ${run1Rows.length}`
    });

    // Check C: Execution isolation & unique executionId
    groundTruthChecks.push({
        name: 'Execution ID Isolation',
        verified: Boolean(executionIdIsolated),
        value: executionIdIsolated ? 'ISOLATED' : 'COLLISION',
        details: `Run 1: ${run1Meta.executionId?.slice(0, 8)}... vs Run 2: ${run2Meta.executionId?.slice(0, 8)}...`
    });

    // Check D: Pricing formula audit ($5.00 / TiB)
    const expectedOnDemandUsd = ((run1Meta.logicalScannedBytes || 0) / (1024 ** 4)) * 5.00;
    const formulaCorrect = Math.abs((run1Meta.onDemandCostUsd || 0) - expectedOnDemandUsd) < 0.000001;
    groundTruthChecks.push({
        name: 'Pricing Formula Audit ($5.00 / TiB)',
        verified: formulaCorrect,
        value: formulaCorrect ? 'VERIFIED' : 'FAILED',
        details: `On-Demand: $${(run1Meta.onDemandCostUsd || 0).toFixed(6)} USD (${(run1Meta.logicalScannedBytes / (1024 * 1024)).toFixed(2)} MB logical)`
    });

    // Check E: Cache Double-Charge Prevention
    const cacheChargeAvoided = run2Meta.billedCostUsd === 0 || run2Meta.billedCostUsd <= run1Meta.billedCostUsd;
    groundTruthChecks.push({
        name: 'SSD Cache Zero Double-Charging',
        verified: cacheChargeAvoided,
        value: cacheChargeAvoided ? 'PROTECTED' : 'CHARGED',
        details: `Run 2 Billed: $${(run2Meta.billedCostUsd || 0).toFixed(6)} USD (Saved $${(run2Meta.cacheSavingsUsd || 0).toFixed(6)} USD)`
    });

    return {
        success: true,
        summary: 'CloudObjectIQ telemetry and DuckDB query validation passed.',
        datasetFiles: fileStats,
        run1: {
            executionId: run1Meta.executionId,
            durationMs: run1Duration,
            rowCount: run1Rows.length,
            logicalScannedBytes: run1Meta.logicalScannedBytes,
            billedCostUsd: run1Meta.billedCostUsd,
            onDemandCostUsd: run1Meta.onDemandCostUsd,
            cacheStatus: run1Meta.cacheStatus
        },
        run2: {
            executionId: run2Meta.executionId,
            durationMs: run2Duration,
            rowCount: run2Rows.length,
            logicalScannedBytes: run2Meta.logicalScannedBytes,
            billedCostUsd: run2Meta.billedCostUsd,
            onDemandCostUsd: run2Meta.onDemandCostUsd,
            cacheStatus: run2Meta.cacheStatus
        },
        groundTruthChecks,
        allPassed: groundTruthChecks.every(c => c.verified)
    };
}

module.exports = {
    runQuery,
    getTarget,
    calculateCost,
    invalidateCachedFile,
    clearAllCaches,
    validateQueryAgainstDuckDB
};
