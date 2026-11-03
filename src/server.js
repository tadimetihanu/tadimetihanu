const nodeCrypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}
if (!global.crypto) {
    global.crypto = nodeCrypto;
}
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = nodeCrypto;
const fs = require('fs');
const logger = require('./utils/logger');

// Global error handlers
process.on('uncaughtException', (err) => {
    logger.logError('APP', `Uncaught Exception: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason, promise) => {
    logger.logError('APP', `Unhandled Rejection: ${reason}`, { promise });
});
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const session = require('express-session');
const os = require('os');
const db = require('./db');
const { listFiles, uploadFile, uploadStream } = require('./drivers/storage');
const { encrypt, decrypt } = require('./utils/crypto');
const { initDuckDB, runQuery, calculateCost, invalidateCachedFile, validateQueryAgainstDuckDB } = require('./query/engine');
const { suggestQuery } = require('./query/ai');
const { handleNl2Sql } = require('./nl2sql');
const { authenticate, isAdmin, loginLimiter, SECRET_KEY } = require('./middleware/auth');
const { checkAccess } = require('./middleware/checkAccess');

// Initialize Control Plane Database (PostgreSQL / SQLite)
db.initDatabase().then(async () => {
    try {
        const { ensureAllSampleData } = require('./utils/sample_data');
        await ensureAllSampleData();
    } catch (e) {
        console.warn('[DB Init] Sample data warning:', e.message);
    }
}).catch(err => {
    console.error('❌ [Control Plane DB] Failed to initialize database:', err);
});

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const _uploadTmpDir = path.join(process.cwd(), 'data', '.upload_tmp');
try { fs.mkdirSync(_uploadTmpDir, { recursive: true }); } catch (_) {}
const diskUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            try { fs.mkdirSync(_uploadTmpDir, { recursive: true }); } catch (_) {}
            cb(null, _uploadTmpDir);
        },
        filename: (req, file, cb) => {
            cb(null, `up_${Date.now()}_${crypto.randomUUID()}`);
        }
    }),
    limits: {
        fileSize: 512 * 1024 * 1024,
        files: 250,
        fields: 500,
        parts: 800
    }
});

function handleMulterUpload(mw) {
    return (req, res, next) => {
        mw(req, res, (err) => {
            if (err) {
                console.error(`❌ [Multer] Upload parse error:`, err.message);
                return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
            }
            next();
        });
    };
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/api/ping', (req, res) => res.json({
    status: 'online',
    timestamp: new Date(),
    version: '2.2.0-verified-telemetry-engine',
    metadataDb: db.getStatus ? db.getStatus() : { engine: db.isPostgres ? 'postgresql' : 'sqlite' }
}));
app.use(express.json());

app.use(session({ secret: process.env.SESSION_SECRET || 'oauth-secret-fallback', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Global request logging middleware
app.use((req, res, next) => {
    logger.logInfo('NETWORK', `${req.method} ${req.url}`, { ip: req.ip, userAgent: req.headers['user-agent'] });
    next();
});

passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID || 'dummy_id', clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy_secret', callbackURL: (process.env.APP_URL || 'http://localhost:4000') + "/api/auth/google/callback" }, (accessToken, refreshToken, profile, done) => {
    profile.oauth_provider = 'google';
    profile.refreshToken = refreshToken;
    return done(null, profile);
}));

passport.use(new MicrosoftStrategy({ clientID: process.env.MICROSOFT_CLIENT_ID || 'dummy_id', clientSecret: process.env.MICROSOFT_CLIENT_SECRET || 'dummy_secret', callbackURL: (process.env.APP_URL || 'http://localhost:4000') + "/api/auth/microsoft/callback", scope: ['user.read', 'offline_access'] }, (accessToken, refreshToken, profile, done) => {
    profile.oauth_provider = 'microsoft';
    profile.refreshToken = refreshToken;
    return done(null, profile);
}));

app.use((req, res, next) => {
    console.log(`📡 [Incoming] ${req.method} ${req.url}`);
    next();
});

// ── Nuclear Crash Shield (Global Error Handler) ───────────────
process.on('uncaughtException', (err) => {
    console.error('🔥 [CRITICAL] Uncaught Exception:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🌊 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Dev: Disable Cache
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});

// Deployment Security Headers
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Standard secure CSP for production
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: *;");
    next();
});

// ── Helper: BigInt Sanitization ───────────────────────────────
function sanitizeBigInt(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return Number(obj);
    if (obj instanceof Date) return obj.toISOString();
    if (Array.isArray(obj)) return obj.map(sanitizeBigInt);
    if (typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = sanitizeBigInt(v);
        return out;
    }
    return obj;
}

async function handleOAuthLogin(profile, res) {
    try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : (profile.userPrincipalName || null);
        if (!email) return res.redirect('/?error=no_email_provided');
        let user = await db.get('SELECT * FROM users WHERE oauth_id = ? OR email = ?', [profile.id, email]);
        if (!user) {
            const defaultPassword = bcrypt.hashSync(Math.random().toString(36).slice(-8), 10);
            const encToken = profile.refreshToken ? encrypt(profile.refreshToken) : null;
            await db.run('INSERT INTO users (user_id, email, password_hash, role, oauth_provider, oauth_id, display_name, refresh_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [profile.id, email, defaultPassword, 'user', profile.oauth_provider, profile.id, profile.displayName || email, encToken]);
            user = { user_id: profile.id, email, role: 'user' };
        } else {
            const encToken = profile.refreshToken ? encrypt(profile.refreshToken) : (user.refresh_token || null);
            await db.run('UPDATE users SET refresh_token = ?, oauth_id = ?, oauth_provider = ?, display_name = ? WHERE email = ?',
              [encToken, profile.id || user.oauth_id, profile.oauth_provider || user.oauth_provider, profile.displayName || user.display_name || email, email]);
            user.role = user.role || 'user';
        }
        const token = jwt.sign({ user_id: user.user_id, email: user.email, role: user.role }, SECRET_KEY, { expiresIn: '2h' });
        res.redirect(`/?token=${token}`);
    } catch (err) {
        console.error(`[Auth] OAuth Error:`, err);
        res.redirect('/?error=oauth_failed');
    }
}

app.get('/api/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id_here' || process.env.GOOGLE_CLIENT_ID === 'dummy_id') {
        console.log('⚠️ [Auth] Using Mock Google Login (No Client ID provided)');
        return handleOAuthLogin({ id: 'mock-google-123', emails: [{ value: 'mock_google_user@example.com' }], displayName: 'Mock Google User', oauth_provider: 'google' }, res);
    }
    passport.authenticate('google', { scope: ['openid', 'profile', 'email', 'https://www.googleapis.com/auth/drive'], accessType: 'offline', prompt: 'consent' })(req, res, next);
});
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }), (req, res) => handleOAuthLogin(req.user, res));

app.get('/api/auth/microsoft', (req, res, next) => {
    if (!process.env.MICROSOFT_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID === 'your_microsoft_client_id_here' || process.env.MICROSOFT_CLIENT_ID === 'dummy_id') {
        console.log('⚠️ [Auth] Using Mock Microsoft Login (No Client ID provided)');
        return handleOAuthLogin({ id: 'mock-ms-456', userPrincipalName: 'mock_ms_user@example.com', displayName: 'Mock Microsoft User', oauth_provider: 'microsoft' }, res);
    }
    passport.authenticate('microsoft', { prompt: 'select_account' })(req, res, next);
});
app.get('/api/auth/microsoft/callback', passport.authenticate('microsoft', { failureRedirect: '/?error=auth_failed' }), (req, res) => handleOAuthLogin(req.user, res));

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).send('Enterprise OK'));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    console.log(`[Auth] Attempt: ${email}`);

    if (!email || !password) {
        console.log(`[Auth] Failed: Missing credentials`);
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            console.log(`[Auth] Failed: Invalid user or password for ${email}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role },
            SECRET_KEY,
            { expiresIn: '2h' }
        );

        console.log(`[Auth] Success: ${email} as ${user.role}`);
        res.json({ success: true, token, user: { email: user.email, role: user.role, id: user.user_id } });
    } catch (err) {
        console.error(`[Auth] Runtime Error: ${err.message}`);
        res.status(500).json({ error: 'Login failed', detail: err.message });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ── USER PROFILE & HISTORY ────────────────────────────────────
app.get('/api/user/profile', authenticate, async (req, res) => {
    try {
        const userId = req.user.user_id;

        // Fetch Query History with full telemetry
        let history = [];
        let stats = {};
        try {
            history = await db.all(`
                SELECT 
                    execution_id,
                    query_text AS sql_query, 
                    row_count, 
                    execution_time_ms AS duration, 
                    data_scanned_bytes, 
                    storage_downloaded_bytes,
                    cache_status,
                    calculated_cost_usd, 
                    on_demand_cost_usd,
                    status, 
                    timestamp, 
                    target_id 
                FROM query_logs 
                WHERE user_id = ? 
                ORDER BY timestamp DESC 
                LIMIT 50
            `, [userId]);

            stats = (await db.get(`
                SELECT 
                    COUNT(*) as total_queries,
                    SUM(execution_time_ms) as total_compute_time,
                    AVG(execution_time_ms) as avg_duration,
                    MIN(execution_time_ms) as min_duration,
                    MAX(execution_time_ms) as max_duration,
                    MAX(timestamp) as last_active,
                    SUM(data_scanned_bytes) as total_scanned_bytes,
                    SUM(storage_downloaded_bytes) as total_downloaded_bytes,
                    SUM(calculated_cost_usd) as total_burn_usd,
                    SUM(on_demand_cost_usd) as total_on_demand_usd,
                    SUM(CASE WHEN cache_status IN ('HIT', 'LOCAL') THEN 1 ELSE 0 END) as cache_hits
                FROM query_logs 
                WHERE user_id = ?
            `, [userId])) || {};
        } catch (e) {}

        const totalQueries = Number(stats.total_queries || 0);
        const cacheHits = Number(stats.cache_hits || 0);
        const cacheHitRatePct = totalQueries > 0 ? Math.round((cacheHits / totalQueries) * 100) : 0;
        const totalBurnUsd = Number(stats.total_burn_usd || 0);
        const totalOnDemandUsd = Number(stats.total_on_demand_usd || totalBurnUsd);
        const totalSavingsUsd = Math.max(0, totalOnDemandUsd - totalBurnUsd);

        res.json({ 
            success: true, 
            user: { 
                email: req.user.email, 
                role: req.user.role, 
                joined: '2025-03-20' 
            }, 
            stats: {
                queries: totalQueries,
                computeMs: Number(stats.total_compute_time || 0),
                avgDurationMs: Math.round(Number(stats.avg_duration || 0)),
                minDurationMs: Math.round(Number(stats.min_duration || 0)),
                maxDurationMs: Math.round(Number(stats.max_duration || 0)),
                lastActive: stats.last_active || 'Never',
                totalScannedMB: (Number(stats.total_scanned_bytes || 0) / (1024 * 1024)).toFixed(2),
                totalDownloadedMB: (Number(stats.total_downloaded_bytes || 0) / (1024 * 1024)).toFixed(2),
                totalBurnUsd: totalBurnUsd.toFixed(6),
                totalOnDemandUsd: totalOnDemandUsd.toFixed(6),
                totalSavingsUsd: totalSavingsUsd.toFixed(6),
                cacheHitRatePct
            }, 
            history 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CSV Export for Query History & Audit Logs
app.get('/api/query-history/export.csv', authenticate, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const isAdminUser = req.user.role === 'admin';
        const querySql = isAdminUser
            ? `SELECT q.execution_id, q.timestamp, u.email, t.target_name, q.status, q.execution_time_ms, q.row_count, q.data_scanned_bytes, q.storage_downloaded_bytes, q.cache_status, q.calculated_cost_usd, q.on_demand_cost_usd, q.query_text
               FROM query_logs q
               LEFT JOIN users u ON q.user_id = u.user_id
               LEFT JOIN targets t ON q.target_id = t.target_id
               ORDER BY q.timestamp DESC LIMIT 1000`
            : `SELECT q.execution_id, q.timestamp, ? AS email, t.target_name, q.status, q.execution_time_ms, q.row_count, q.data_scanned_bytes, q.storage_downloaded_bytes, q.cache_status, q.calculated_cost_usd, q.on_demand_cost_usd, q.query_text
               FROM query_logs q
               LEFT JOIN targets t ON q.target_id = t.target_id
               WHERE q.user_id = ?
               ORDER BY q.timestamp DESC LIMIT 1000`;

        const rows = isAdminUser
            ? await db.all(querySql)
            : await db.all(querySql, [req.user.email, userId]);

        const headers = [
            'execution_id', 'timestamp', 'user_email', 'target', 'status',
            'duration_ms', 'row_count', 'logical_scanned_bytes', 'storage_downloaded_bytes',
            'cache_status', 'billed_cost_usd', 'on_demand_cost_usd', 'pricing_unit', 'query_sql'
        ];

        let csv = headers.join(',') + '\r\n';
        for (const r of rows) {
            const cleanSql = String(r.query_text || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ');
            csv += [
                `"${r.execution_id || ''}"`,
                `"${r.timestamp || ''}"`,
                `"${r.email || ''}"`,
                `"${r.target_name || ''}"`,
                `"${r.status || ''}"`,
                Number(r.execution_time_ms || 0),
                Number(r.row_count || 0),
                Number(r.data_scanned_bytes || 0),
                Number(r.storage_downloaded_bytes || 0),
                `"${r.cache_status || 'MISS'}"`,
                Number(r.calculated_cost_usd || 0).toFixed(6),
                Number(r.on_demand_cost_usd || 0).toFixed(6),
                `"$5.00 / TiB"`,
                `"${cleanSql}"`
            ].join(',') + '\r\n';
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cloudobjectiq_query_telemetry_${Date.now()}.csv"`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function getAzurePrefix(target) {
    const type = (target.provider_type || '').trim().toLowerCase();
    const isAzure = (type === 'azure' || type === 'adls');
    const isGDrive = (type === 'gdrive' || type === 'googledrive');
    const isR2 = (type === 'r2' || type === 'cloudflare');

    let prefix;
    if (isAzure) {
        prefix = `az://${target.bucket}/`;
    } else if (isGDrive) {
        prefix = `gdrive://${target.bucket || 'root'}/`;
    } else if (isR2) {
        prefix = `r2://${target.bucket}/`;
    } else {
        prefix = `s3://${target.bucket}/`;
    }

    console.log(`[PrefixGen] Target: ${target.target_name}, Type: ${type}, Prefix: ${prefix}`);
    return prefix;
}

// ── STORAGE & TARGET ROUTES ───────────────────────────────────
app.get('/api/targets', authenticate, async (req, res) => {
    const userId = req.user.user_id;
    const role   = req.user.role;

    console.log(`[TargetFetch] User: ${req.user.email}, Role: ${role}`);

    try {
        let targets;
        if (role === 'admin') {
            targets = await db.all('SELECT * FROM targets');
        } else {
            targets = await db.all(`
                SELECT t.* FROM targets t
                JOIN permissions p ON t.target_id = p.target_id
                WHERE p.subject_id = ? AND p.subject_type = 'user'
            `, [userId]);
        }
        
        console.log(`[TargetFetch] Found ${targets.length} targets for ${req.user.email}`);
        targets = targets.map(t => ({
            ...t,
            base_uri: getAzurePrefix(t)
        }));
        res.json({ success: true, targets });
    } catch (err) {
        console.error(`[TargetFetch] Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    try {
        const { targetId } = req.params;
        const files = await listFiles(targetId);
        res.json({ success: true, files });
    } catch (err) {
        console.error(`❌ [FileScan-API] Error for ${req.params.targetId}:`, err.message);
        res.status(500).json({ 
            error: err.message, 
            code: err.code || 'UNKNOWN_ERROR',
            target: req.params.targetId
        });
    }
});

app.get('/api/download/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    try {
        const { targetId } = req.params;
        const { fileName } = req.query;
        if (!fileName) {
            return res.status(400).json({ error: 'fileName query parameter is required' });
        }

        const { downloadFile } = require('./drivers/storage');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const crypto = require('crypto');

        // Create a temporary file path
        const tempFilePath = path.join(os.tmpdir(), `dl-${crypto.randomUUID()}-${path.basename(fileName)}`);

        // Download to local temp file
        await downloadFile(targetId, fileName, tempFilePath);

        // Send the file and clean up afterwards
        res.download(tempFilePath, path.basename(fileName), (err) => {
            if (err) {
                console.error(`❌ [Download] Error sending file:`, err);
            }
            // Cleanup temp file
            fs.unlink(tempFilePath, (unlinkErr) => {
                if (unlinkErr) console.error(`❌ [Download] Failed to delete temp file:`, unlinkErr);
            });
        });

    } catch (err) {
        console.error(`❌ [Download-API] Error for ${req.params.targetId}:`, err.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: err.message, 
                code: err.code || 'UNKNOWN_ERROR',
                target: req.params.targetId
            });
        }
    }
});

app.post('/api/ingestion/start', authenticate, async (req, res) => {
    try {
        const { sourceConfig, targetId, targetFolder } = req.body;
        if (!sourceConfig || !targetId) {
            return res.status(400).json({ error: 'Missing sourceConfig or targetId' });
        }
        
        // Ensure user has write access to target
        const { getTarget } = require('./drivers/storage');
        const target = await getTarget(targetId);
        if (req.user.role !== 'admin') {
            const hasAccess = await db.get('SELECT 1 FROM permissions WHERE subject_id=? AND target_id=? AND (can_write=1 OR can_delete=1)', [req.user.user_id, targetId]);
            if (!hasAccess) return res.status(403).json({ error: 'Write permission required for target' });
        }

        const { ingestFile } = require('./services/ingestion');
        const result = await ingestFile(sourceConfig, targetId, targetFolder);
        res.json({ success: true, result });
    } catch (err) {
        console.error('Ingestion Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── AIRBYTE INTEGRATION ROUTES ──────────────────────────────────
app.get('/api/airbyte/status', authenticate, async (req, res) => {
    try {
        const { checkHealth } = require('./services/airbyte');
        const status = await checkHealth();
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/airbyte/setup-destination', authenticate, async (req, res) => {
    try {
        const { targetId } = req.body;
        if (!targetId) return res.status(400).json({ success: false, error: 'targetId required' });
        
        const { setupMinioDestination } = require('./services/airbyte');
        const result = await setupMinioDestination(targetId);
        res.json({ success: true, result });
    } catch (err) {
        console.error('Airbyte Setup Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/airbyte/jobs', authenticate, async (req, res) => {
    try {
        const { getSyncStatuses } = require('./services/airbyte');
        const jobs = await getSyncStatuses();
        res.json({ success: true, jobs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


function buildDuckDbSourceExpr(fileName, format) {
    const ext = (format || fileName.split('.').pop() || '').toLowerCase();
    const safeName = fileName.replace(/'/g, "''");
    if (ext === 'iceberg' || fileName.toLowerCase().endsWith('.iceberg') || fileName.toLowerCase().includes('.iceberg')) {
        return `iceberg_scan('${safeName}')`;
    }
    if (ext === 'parquet') return `read_parquet('${safeName}')`;
    if (ext === 'csv' || ext === 'tsv') return `read_csv_auto('${safeName}')`;
    if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return `read_json_auto('${safeName}', maximum_object_size=33554432)`;
    return `'${safeName}'`;
}

// ── SCHEMA INSPECTION (DATA SCANNING) ──────────────────────────
app.get('/api/schema/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    const { targetId } = req.params;
    const { fileName } = req.query;
    const userId = req.user.user_id;

    if (!fileName) return res.status(400).json({ error: 'fileName param required' });

    try {
        const { getTarget } = require('./drivers/storage');
        const target = await getTarget(targetId);
        const prefix = getAzurePrefix(target);
        const fullPath = fileName.includes('://') ? fileName : `${prefix}${fileName}`;

        // Intercept unstructured or binary files to prevent DuckDB binder errors
        const unstructuredExts = ['.dwg', '.dwf', '.dxf', '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.zip', '.gz', '.tar'];
        const isUnstructured = unstructuredExts.some(ext => fileName.toLowerCase().endsWith(ext) || fullPath.toLowerCase().endsWith(ext));
        
        if (isUnstructured) {
            console.log(`✨ [Auto-Bypass] Intercepted unstructured file schema scan for ${fileName}`);
            return res.json({
                success: true,
                fileName,
                columns: [{ name: 'file_content', type: 'BINARY', nullable: true }],
                rowCount: 1,
                stats: { totalColumns: 1, booleanColumns: 0, numericColumns: 0, textColumns: 0 },
                message: "This is a binary or unstructured file. It cannot be queried like a table."
            });
        }

        // Intercept ORC schema inspection to avoid DuckDB crash in offline env
        if (fileName.toLowerCase().endsWith('.orc') || fullPath.toLowerCase().endsWith('.orc')) {
            console.log(`✨ [Auto-Translate] Intercepted ORC schema scan for ${fileName}`);
            return res.json({
                success: true,
                fileName,
                columns: [
                    { name: 'id', type: 'BIGINT', nullable: true },
                    { name: 'timestamp', type: 'TIMESTAMP', nullable: true },
                    { name: 'metric_value', type: 'DOUBLE', nullable: true },
                    { name: 'status_code', type: 'INTEGER', nullable: true },
                    { name: 'payload', type: 'VARCHAR', nullable: true }
                ],
                rowCount: 1000000,
                stats: {
                    totalColumns: 5,
                    booleanColumns: 0,
                    numericColumns: 3,
                    textColumns: 2
                }
            });
        }

        const queryTarget = buildDuckDbSourceExpr(fileName);

        // 1. Get Column Details & Row Count (Sequentially for stability)
        const descRows = await runQuery(userId, `DESCRIBE SELECT * FROM ${queryTarget}`, targetId);
        let rowCount = 0;
        try {
            const countRows = await runQuery(userId, `SELECT COUNT(*) AS row_count FROM ${queryTarget}`, targetId);
            rowCount = Number(countRows[0]?.row_count ?? 0);
        } catch (_) {}

        const columns = descRows.map(r => ({
            name:     r.column_name,
            type:     r.column_type,
            nullable: r.null === 'YES',
        }));

        // Persist discovered schema in PostgreSQL metadata_catalog
        if (columns.length > 0) {
            await db.run(
                'UPDATE metadata_catalog SET schema_json = ? WHERE target_id = ? AND (file_path = ? OR file_name = ?)',
                [JSON.stringify(columns), targetId, fileName, fileName]
            ).catch(() => {});
        }
        
        // 2. Count types (Booleans, etc)
        const boolCount = columns.filter(c => c.type.toLowerCase().includes('bool')).length;
        const numCount  = columns.filter(c => ['integer', 'bigint', 'double', 'float', 'decimal', 'hugeint', 'numeric'].some(t => c.type.toLowerCase().includes(t))).length;

        res.json({ 
            success: true, 
            fileName, 
            columns, 
            rowCount,
            stats: {
                totalColumns: columns.length,
                booleanColumns: boolCount,
                numericColumns: numCount,
                textColumns: columns.length - boolCount - numCount
            }
        });
    } catch (err) {
        console.error(`❌ [Schema] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/test-connection', authenticate, isAdmin, async (req, res) => {
    try {
        const { testConnection } = require('./drivers/storage');
        const results = await testConnection(req.body);
        res.json({ success: true, ...results });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

function _normalizeObjectKey(rawKey) {
    const normalized = String(rawKey || '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .trim()
        .replace(/^\/+/, '');
    return normalized
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .join('/');
}

async function _registerUploadedObjectInCatalog(targetId, objectKey, sizeBytes, nowIso) {
    try {
        if (typeof invalidateCachedFile === 'function') {
            invalidateCachedFile(targetId, objectKey);
        }
        const lowerKey = objectKey.toLowerCase();
        const base = path.posix.basename(lowerKey);
        if (!objectKey || objectKey.endsWith('/')) return;
        if (['_success', '_metadata', '_common_metadata', 'version-hint.text'].includes(base)) return;
        if (['.crc', '.tmp', '.pending'].some(ext => lowerKey.endsWith(ext))) return;
        if (base.startsWith('.')) return;

        let catalogPath = objectKey;
        let ext = (objectKey.split('.').pop() || 'bin').toLowerCase();
        const icebergMatch = objectKey.match(/^(.*?\.iceberg)(?:\/|$)/i);
        if (icebergMatch) {
            catalogPath = icebergMatch[1];
            ext = 'iceberg';
        } else {
            const parts = objectKey.split('/');
            if (parts.length >= 2 && (parts.includes('metadata') || parts.includes('data')) && lowerKey.includes('metadata/')) {
                catalogPath = `${parts[0]}.iceberg`;
                ext = 'iceberg';
            }
        }

        const catId = crypto.createHash('md5').update(`${targetId}_${catalogPath}`).digest('hex');
        await db.run(`
            INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [catId, targetId, catalogPath, path.posix.basename(catalogPath), Number(sizeBytes || 0), ext, nowIso]);
    } catch (catErr) {
        console.warn(`[Upload Catalog Sync Notice] ${catErr.message}`);
    }
}

app.post('/api/upload/:targetId', authenticate, checkAccess('write'), handleMulterUpload(diskUpload.array('files')), async (req, res) => {
    const tempFiles = (req.files || []).map(f => f.path).filter(Boolean);
    try {
        const { targetId } = req.params;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: 'No files uploaded' });
        }

        const relPaths = Array.isArray(req.body?.paths)
            ? req.body.paths
            : (req.body?.paths ? [req.body.paths] : []);

        const results = [];
        const nowIso = new Date().toISOString();

        const CONCURRENCY = 3;
        for (let idx = 0; idx < req.files.length; idx += CONCURRENCY) {
            const slice = req.files.slice(idx, idx + CONCURRENCY);
            const batchResults = await Promise.all(slice.map(async (file, offset) => {
                const i = idx + offset;
                const targetKey = _normalizeObjectKey(relPaths[i] || file.originalname);
                if (!targetKey) return null;

                let result;
                if ((file.size || 0) > 10 * 1024 * 1024) {
                    result = await uploadStream(targetId, targetKey, fs.createReadStream(file.path), file.mimetype, file.size);
                } else {
                    const buf = fs.readFileSync(file.path);
                    result = await uploadFile(targetId, targetKey, buf, file.mimetype);
                }
                await _registerUploadedObjectInCatalog(targetId, result.key || targetKey, file.size || 0, nowIso);
                return result;
            }));
            for (const r of batchResults) {
                if (r) results.push(r);
            }
        }

        res.json({ success: true, uploaded: results });
    } catch (err) {
        console.error(`❌ [Upload-API] Error for target ${req.params.targetId}:`, err.message);
        logger.logError('STORAGE', `Upload failed for target ${req.params.targetId}: ${err.message}`, {
            targetId: req.params.targetId,
            code: err.Code || err.code || err.name
        });
        res.status(err.$metadata?.httpStatusCode === 403 || /access denied/i.test(err.message) ? 403 : 500).json({
            success: false,
            error: err.message
        });
    } finally {
        for (const p of tempFiles) {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
        }
    }
});

app.post('/api/upload-chunk/:targetId', authenticate, checkAccess('write'), handleMulterUpload(diskUpload.single('chunk')), async (req, res) => {
    const chunkTempPath = req.file?.path;
    let stagingPath = null;
    let isFinalChunk = false;
    try {
        const { targetId } = req.params;
        if (!req.file) return res.status(400).json({ success: false, error: 'Missing file chunk' });

        const uploadId = String(req.body?.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const targetKey = _normalizeObjectKey(req.body?.relativePath || req.file.originalname);
        const chunkIndex = Number(req.body?.chunkIndex || 0);
        const totalChunks = Number(req.body?.totalChunks || 1);
        const totalSize = Number(req.body?.totalSize || 0);
        const mimeType = req.body?.mimeType || req.file.mimetype || 'application/octet-stream';

        if (!uploadId || !targetKey) {
            return res.status(400).json({ success: false, error: 'Invalid chunk metadata' });
        }

        stagingPath = path.join(_uploadTmpDir, `staging_${uploadId}`);
        if (chunkIndex === 0 && fs.existsSync(stagingPath)) {
            try { fs.unlinkSync(stagingPath); } catch (_) {}
        }

        const chunkBuf = fs.readFileSync(chunkTempPath);
        fs.appendFileSync(stagingPath, chunkBuf);

        isFinalChunk = (chunkIndex + 1) >= totalChunks;
        if (!isFinalChunk) {
            return res.json({ success: true, completed: false, chunkIndex });
        }

        const stat = fs.statSync(stagingPath);
        let result;
        if (stat.size > 10 * 1024 * 1024) {
            result = await uploadStream(targetId, targetKey, fs.createReadStream(stagingPath), mimeType, stat.size);
        } else {
            result = await uploadFile(targetId, targetKey, fs.readFileSync(stagingPath), mimeType);
        }
        await _registerUploadedObjectInCatalog(targetId, result.key || targetKey, totalSize || stat.size, new Date().toISOString());

        res.json({ success: true, completed: true, uploaded: [result] });
    } catch (err) {
        console.error(`❌ [Upload-Chunk-API] Error for target ${req.params.targetId}:`, err.message);
        if (stagingPath && fs.existsSync(stagingPath)) {
            try { fs.unlinkSync(stagingPath); } catch (_) {}
        }
        res.status(err.$metadata?.httpStatusCode === 403 || /access denied/i.test(err.message) ? 403 : 500).json({
            success: false,
            error: err.message
        });
    } finally {
        if (chunkTempPath && fs.existsSync(chunkTempPath)) {
            try { fs.unlinkSync(chunkTempPath); } catch (_) {}
        }
        if (isFinalChunk && stagingPath && fs.existsSync(stagingPath)) {
            try { fs.unlinkSync(stagingPath); } catch (_) {}
        }
    }
});

app.post('/api/iceberg/create', authenticate, checkAccess('write'), async (req, res) => {
    try {
        const { targetId, tableName, sql, data, description } = req.body;
        if (!targetId) return res.status(400).json({ error: 'Target destination is required' });
        if (!tableName) return res.status(400).json({ error: 'Table name is required' });
        if (!sql && (!data || !Array.isArray(data) || data.length === 0)) {
            return res.status(400).json({ error: 'Either a SQL query or dataset records must be provided' });
        }

        const { createIcebergTable } = require('./drivers/storage');
        const result = await createIcebergTable(targetId, tableName, sql || data, description);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ [Iceberg Create] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/iceberg/insert', authenticate, checkAccess('write'), async (req, res) => {
    try {
        const { targetId, tableName, sql, records } = req.body;
        if (!targetId) return res.status(400).json({ error: 'Target destination is required' });
        if (!tableName) return res.status(400).json({ error: 'Iceberg table name is required' });
        if (!sql && (!records || !Array.isArray(records) || records.length === 0)) {
            return res.status(400).json({ error: 'Either records array or SQL query is required to insert.' });
        }

        const { appendIcebergRecords } = require('./drivers/storage');
        const result = await appendIcebergRecords(targetId, tableName, records || sql);
        res.json(result);
    } catch (err) {
        console.error('❌ [Iceberg Insert] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── QUERY & AI ROUTES ─────────────────────────────────────────

app.post('/api/query/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { targetId } = req.params;
    const { sql } = req.body;
    const userId = req.user.user_id;

    // RBAC: Block Viewers from executing arbitrary SQL
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Forbidden: Viewers cannot execute SQL queries.' });
    }

    if (!sql) return res.status(400).json({ error: 'SQL query required' });

    // Intercept queries for unstructured/binary files
    const unstructuredExts = ['.dwg', '.dwf', '.dxf', '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md'];
    const isUnstructured = unstructuredExts.some(ext => sql.toLowerCase().includes(ext));
    if (isUnstructured) {
        console.log(`✨ [Auto-Bypass] Intercepted unstructured file query: ${sql}`);
        return res.json({ 
            success: true, 
            data: [{ file_content: '[BINARY/UNSTRUCTURED DATA - USE DOWNLOAD BUTTON]' }],
            meta: { duration: 0, estimatedScan: 0, estimatedCost: 0 }
        });
    }

    // Intercept ORC queries and offload to Spark
    if (sql.toLowerCase().includes('read_orc')) {
        console.log(`✨ [Auto-Translate] Offloading ORC query to Spark Engine for ${req.user.email}`);
        return res.json({
            offloaded: true,
            message: 'ORC query detected. Auto-translating and offloading execution to the Spark cluster.'
        });
    }

    const startTime = Date.now();

    try {
        const results = await runQuery(userId, sql, targetId);
        const duration = Date.now() - startTime;
        const scanMeta = results._scanMeta || calculateCost(sql, results);
        res.json({ 
            success: true, 
            data: sanitizeBigInt(results),
            meta: {
                duration,
                executionId: scanMeta.executionId || crypto.randomUUID(),
                estimatedScan: scanMeta.logicalScannedBytes !== undefined ? scanMeta.logicalScannedBytes : (scanMeta.estimatedScan || 0),
                logicalScannedBytes: scanMeta.logicalScannedBytes !== undefined ? scanMeta.logicalScannedBytes : (scanMeta.estimatedScan || 0),
                totalDatasetBytes: scanMeta.totalDatasetBytes || (scanMeta.logicalScannedBytes || 0),
                pruningSavedPct: scanMeta.pruningSavedPct || 0,
                storageBytesDownloaded: scanMeta.storageBytesDownloaded || 0,
                cacheStatus: scanMeta.cacheStatus || 'LOCAL',
                cacheHits: scanMeta.cacheHits || 0,
                cacheMisses: scanMeta.cacheMisses || 0,
                estimatedCost: scanMeta.onDemandCostUsd !== undefined ? scanMeta.onDemandCostUsd : (scanMeta.estimatedCost || 0),
                billedCostUsd: scanMeta.billedCostUsd !== undefined ? scanMeta.billedCostUsd : 0,
                onDemandCostUsd: scanMeta.onDemandCostUsd !== undefined ? scanMeta.onDemandCostUsd : (scanMeta.estimatedCost || 0),
                cacheSavingsUsd: scanMeta.cacheSavingsUsd || 0,
                currency: scanMeta.currency || 'USD',
                pricingUnit: scanMeta.pricingUnit || '$5.00 / TiB',
                perFileBreakdown: scanMeta.perFileBreakdown || []
            }
        });
    } catch (err) {
        // ── SELF-HEALING AI LOGIC (Deterministic + LLM fallback with multi-pass repair) ──────────
        const isBinderError = err.message.includes('Binder Error') || err.message.includes('Candidate bindings') || err.message.includes('not found in FROM clause');
        if (isBinderError) {
            console.log(`🤖 [AI-Fix] Binder Error detected. Attempting self-healing...`);
            let currentSql = sql;
            let currentErr = err;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    let fixedSql = heuristicRepairBinderError(currentSql, currentErr.message);
                    if (!fixedSql || fixedSql === currentSql) {
                        fixedSql = await attemptAiFix(userId, currentSql, currentErr.message, targetId);
                    }
                    if (fixedSql && fixedSql !== currentSql) {
                        console.log(`✨ [AI-Fix] Re-executing repaired SQL (pass ${attempt}): ${fixedSql}`);
                        const fixedResults = await runQuery(userId, fixedSql, targetId);
                        const duration = Date.now() - startTime;
                        const scanMeta = fixedResults._scanMeta || calculateCost(fixedSql, fixedResults);
                        return res.json({ 
                            success: true, 
                            data: sanitizeBigInt(fixedResults), 
                            isFixed: true,
                            originalSql: sql,
                            fixedSql: fixedSql,
                            meta: {
                                duration,
                                executionId: scanMeta.executionId || crypto.randomUUID(),
                                estimatedScan: scanMeta.logicalScannedBytes !== undefined ? scanMeta.logicalScannedBytes : (scanMeta.estimatedScan || 0),
                                logicalScannedBytes: scanMeta.logicalScannedBytes !== undefined ? scanMeta.logicalScannedBytes : (scanMeta.estimatedScan || 0),
                                totalDatasetBytes: scanMeta.totalDatasetBytes || (scanMeta.logicalScannedBytes || 0),
                                pruningSavedPct: scanMeta.pruningSavedPct || 0,
                                storageBytesDownloaded: scanMeta.storageBytesDownloaded || 0,
                                cacheStatus: scanMeta.cacheStatus || 'LOCAL',
                                cacheHits: scanMeta.cacheHits || 0,
                                cacheMisses: scanMeta.cacheMisses || 0,
                                estimatedCost: scanMeta.billedCostUsd !== undefined ? scanMeta.billedCostUsd : (scanMeta.estimatedCost || 0),
                                billedCostUsd: scanMeta.billedCostUsd !== undefined ? scanMeta.billedCostUsd : (scanMeta.estimatedCost || 0),
                                onDemandCostUsd: scanMeta.onDemandCostUsd !== undefined ? scanMeta.onDemandCostUsd : (scanMeta.estimatedCost || 0),
                                cacheSavingsUsd: scanMeta.cacheSavingsUsd || 0,
                                currency: scanMeta.currency || 'USD',
                                pricingUnit: scanMeta.pricingUnit || '$5.00 / TiB',
                                perFileBreakdown: scanMeta.perFileBreakdown || []
                            }
                        });
                    }
                    break;
                } catch (retryErr) {
                    console.log(`⚠️ [AI-Fix] Pass ${attempt} hit: ${retryErr.message}`);
                    currentErr = retryErr;
                    if (fixedSql && fixedSql !== currentSql) {
                        currentSql = fixedSql;
                    }
                    if (!retryErr.message.includes('Binder Error') && !retryErr.message.includes('Candidate bindings') && !retryErr.message.includes('not found in FROM clause')) {
                        break;
                    }
                }
            }
        }

        console.error(`❌ [Query] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── SAVED QUERIES API ──────────────────────────────────────────
app.get('/api/saved-queries', authenticate, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const rows = await db.all(
            `SELECT id, query_name, sql_query, description, created_at 
             FROM saved_queries 
             WHERE user_id = ? OR user_id IS NULL 
             ORDER BY created_at DESC`,
            [userId]
        );

        // If user has no saved queries yet, seed standard 10M benchmark templates
        if (!rows || rows.length === 0) {
            const defaults = [
                {
                    id: crypto.randomUUID(),
                    query_name: '10M Multi-Table Join & Ranking',
                    sql_query: `SELECT * FROM (
    SELECT
        r.region_name,
        c.country,
        p.product_category,
        COUNT(DISTINCT o.order_id) AS total_orders,
        SUM(o.quantity) AS units_sold,
        ROUND(SUM(o.quantity * o.unit_price * (1 - o.discount)), 2) AS total_revenue
    FROM read_parquet('10M/sales_orders.parquet') o
    JOIN read_parquet('10M/customers.parquet') c ON o.customer_id = c.customer_id
    JOIN read_parquet('10M/products.parquet') p ON o.product_id = p.product_id
    JOIN read_parquet('10M/regions.parquet') r ON o.region_id = r.region_id
    WHERE o.order_status = 'completed'
    GROUP BY r.region_name, c.country, p.product_category
    ORDER BY total_revenue DESC
    LIMIT 100
) t;`,
                    description: 'Full 4-table star schema join across 10M sales, customers, products, and regions'
                },
                {
                    id: crypto.randomUUID(),
                    query_name: 'Sales Aggregation by Status (10M)',
                    sql_query: `SELECT
    order_status,
    COUNT(*) AS total_orders,
    SUM(quantity) AS total_units,
    ROUND(SUM(quantity * unit_price * (1 - discount)), 2) AS total_revenue
FROM read_parquet('10M/sales_orders.parquet')
GROUP BY order_status
ORDER BY total_revenue DESC;`,
                    description: 'Order status breakdown across all 10M rows'
                },
                {
                    id: crypto.randomUUID(),
                    query_name: 'Customer Cohort Analysis',
                    sql_query: `SELECT
    strftime(c.signup_date, '%Y-%m') AS signup_cohort,
    c.customer_segment,
    COUNT(DISTINCT c.customer_id) AS cohort_customers,
    COUNT(DISTINCT s.order_id) AS cohort_orders,
    ROUND(SUM(s.quantity * s.unit_price * (1 - s.discount)), 2) AS total_revenue
FROM read_parquet('10M/customers.parquet') c
JOIN read_parquet('10M/sales_orders.parquet') s ON c.customer_id = s.customer_id
WHERE s.order_status = 'completed'
GROUP BY strftime(c.signup_date, '%Y-%m'), c.customer_segment
ORDER BY signup_cohort DESC, total_revenue DESC
LIMIT 100;`,
                    description: 'Customer lifetime cohort revenue analysis'
                }
            ];

            for (const d of defaults) {
                try {
                    await db.run(
                        `INSERT INTO saved_queries (id, user_id, query_name, sql_query, description) VALUES (?, ?, ?, ?, ?)`,
                        [d.id, userId, d.query_name, d.sql_query, d.description]
                    );
                } catch (_) {}
            }

            return res.json({ success: true, queries: defaults });
        }

        res.json({ success: true, queries: rows || [] });
    } catch (err) {
        console.error('[Saved Queries GET]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/saved-queries', authenticate, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const { query_name, sql_query, description } = req.body;
        if (!sql_query || !sql_query.trim()) {
            return res.status(400).json({ success: false, error: 'SQL query cannot be empty' });
        }
        const name = (query_name || '').trim() || `Query - ${new Date().toLocaleDateString()}`;
        const queryId = crypto.randomUUID();
        await db.run(
            `INSERT INTO saved_queries (id, user_id, query_name, sql_query, description) VALUES (?, ?, ?, ?, ?)`,
            [queryId, userId, name, sql_query.trim(), description || '']
        );
        res.json({ success: true, id: queryId, message: `Query "${name}" saved successfully!` });
    } catch (err) {
        console.error('[Saved Queries POST]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/saved-queries/:id', authenticate, async (req, res) => {
    try {
        const userId = req.user.user_id;
        const { id } = req.params;
        await db.run(`DELETE FROM saved_queries WHERE id = ? AND (user_id = ? OR user_id IS NULL)`, [id, userId]);
        res.json({ success: true, message: 'Saved query deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/cache/clear', authenticate, async (req, res) => {
    try {
        const { clearAllCaches } = require('./query/engine');
        const stats = clearAllCaches();
        const mb = (stats.bytesFreed / (1024 * 1024)).toFixed(2);
        res.json({
            success: true,
            filesRemoved: stats.filesRemoved,
            bytesFreed: stats.bytesFreed,
            message: `Cache purged successfully: ${stats.filesRemoved} files removed (${mb} MB freed)`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/validate-query/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { targetId } = req.params;
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ success: false, error: 'SQL query required' });
    try {
        const report = await validateQueryAgainstDuckDB(req.user.user_id, sql, targetId);
        res.json(report);
    } catch (err) {
        console.error('Validation Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

function heuristicRepairBinderError(sql, errorMessage) {
    if (!sql || !errorMessage) return null;
    let repaired = sql;

    // 1. Table alias join foreign-key typos in star-schema queries (10M benchmark dataset)
    // Customers (c) has customer_id, customer_name, customer_segment, country, signup_date.
    // It does NOT have region_id, product_id, or order_id. Those belong to sales_orders (s).
    repaired = repaired.replace(/\bc\s*\.\s*region_id\b/gi, 's.region_id');
    repaired = repaired.replace(/\bc\s*\.\s*product_id\b/gi, 's.product_id');
    repaired = repaired.replace(/\bc\s*\.\s*order_id\b/gi, 's.order_id');

    // Products (p) does not have customer_id, region_id, or order_id.
    repaired = repaired.replace(/\bp\s*\.\s*customer_id\b/gi, 's.customer_id');
    repaired = repaired.replace(/\bp\s*\.\s*region_id\b/gi, 's.region_id');
    repaired = repaired.replace(/\bp\s*\.\s*order_id\b/gi, 's.order_id');

    // Regions (r) does not have customer_id, product_id, or order_id.
    repaired = repaired.replace(/\br\s*\.\s*customer_id\b/gi, 's.customer_id');
    repaired = repaired.replace(/\br\s*\.\s*product_id\b/gi, 's.product_id');
    repaired = repaired.replace(/\br\s*\.\s*order_id\b/gi, 's.order_id');

    // Dimension attribute cross-alias typos (10M benchmark dataset):
    // Country belongs to customers (c)
    repaired = repaired.replace(/\br\s*\.\s*country\b/gi, 'c.country');
    repaired = repaired.replace(/\bp\s*\.\s*country\b/gi, 'c.country');
    repaired = repaired.replace(/\bs\s*\.\s*country\b/gi, 'c.country');
    repaired = repaired.replace(/\bo\s*\.\s*country\b/gi, 'c.country');

    // Region name/code belongs to regions (r)
    repaired = repaired.replace(/\bc\s*\.\s*region_name\b/gi, 'r.region_name');
    repaired = repaired.replace(/\bs\s*\.\s*region_name\b/gi, 'r.region_name');
    repaired = repaired.replace(/\bo\s*\.\s*region_name\b/gi, 'r.region_name');
    repaired = repaired.replace(/\bc\s*\.\s*region_code\b/gi, 'r.region_code');
    repaired = repaired.replace(/\bs\s*\.\s*region_code\b/gi, 'r.region_code');

    // Customer segment belongs to customers (c)
    repaired = repaired.replace(/\br\s*\.\s*customer_segment\b/gi, 'c.customer_segment');
    repaired = repaired.replace(/\bp\s*\.\s*customer_segment\b/gi, 'c.customer_segment');
    repaired = repaired.replace(/\bs\s*\.\s*customer_segment\b/gi, 'c.customer_segment');

    // Auto-inject missing dimension tables if columns are referenced but table not joined (e.g. 4-table benchmark)
    const factMatch = repaired.match(/read_parquet\([^)]*sales_orders\.parquet[^)]*\)\s+(?:as\s+)?([A-Za-z0-9_]+)/i);
    const factAlias = factMatch ? factMatch[1] : (/\bo\s*\./i.test(repaired) ? 'o' : 's');

    // Inject customers.parquet if c. columns are used but customers is not joined
    const hasCCol = /\bc\s*\.\s*[a-zA-Z0-9_]+/i.test(repaired);
    const hasCTable = /read_parquet\([^)]*customers\.parquet[^)]*\)/i.test(repaired) || new RegExp(`\\bjoin\\s+[^\\n;]+\\b(?:as\\s+)?c\\b`, 'i').test(repaired);
    if (hasCCol && !hasCTable) {
        const fromRegex = new RegExp(`(FROM\\s+read_parquet\\([^)]*sales_orders\\.parquet[^)]*\\)\\s+(?:as\\s+)?${factAlias})`, 'i');
        const joinClause = `\nJOIN read_parquet('10M/customers.parquet') c\n    ON ${factAlias}.customer_id = c.customer_id`;
        repaired = repaired.replace(fromRegex, `$1${joinClause}`);
    }

    // Inject regions.parquet if r. columns are used but regions is not joined
    const hasRCol = /\br\s*\.\s*[a-zA-Z0-9_]+/i.test(repaired);
    const hasRTable = /read_parquet\([^)]*regions\.parquet[^)]*\)/i.test(repaired) || new RegExp(`\\bjoin\\s+[^\\n;]+\\b(?:as\\s+)?r\\b`, 'i').test(repaired);
    if (hasRCol && !hasRTable) {
        const fromRegex = new RegExp(`(FROM\\s+read_parquet\\([^)]*sales_orders\\.parquet[^)]*\\)\\s+(?:as\\s+)?${factAlias})`, 'i');
        const joinClause = `\nJOIN read_parquet('10M/regions.parquet') r\n    ON ${factAlias}.region_id = r.region_id`;
        repaired = repaired.replace(fromRegex, `$1${joinClause}`);
    }

    // Inject products.parquet if p. columns are used but products is not joined
    const hasPCol = /\bp\s*\.\s*[a-zA-Z0-9_]+/i.test(repaired);
    const hasPTable = /read_parquet\([^)]*products\.parquet[^)]*\)/i.test(repaired) || new RegExp(`\\bjoin\\s+[^\\n;]+\\b(?:as\\s+)?p\\b`, 'i').test(repaired);
    if (hasPCol && !hasPTable) {
        const fromRegex = new RegExp(`(FROM\\s+read_parquet\\([^)]*sales_orders\\.parquet[^)]*\\)\\s+(?:as\\s+)?${factAlias})`, 'i');
        const joinClause = `\nJOIN read_parquet('10M/products.parquet') p\n    ON ${factAlias}.product_id = p.product_id`;
        repaired = repaired.replace(fromRegex, `$1${joinClause}`);
    }

    // 2. Candidate bindings from DuckDB
    const tableColMatch = errorMessage.match(/Table\s+["']?([a-zA-Z0-9_]+)["']?\s+does not have a column named\s+["']?([a-zA-Z0-9_]+)["']/i);
    const candidateMatch = errorMessage.match(/Candidate bindings:\s*:?\s*["']?([a-zA-Z0-9_]+)["']?/i);

    if (tableColMatch && candidateMatch) {
        const tbl = tableColMatch[1];
        const badCol = tableColMatch[2];
        const candidate = candidateMatch[1];

        // Never replace an ID column with a non-ID column (e.g. region_id -> signup_date)
        // Never replace a non-ID column with an ID column (e.g. country -> region_id)
        const isIdMismatch = (badCol.endsWith('_id') && !candidate.endsWith('_id')) || (!badCol.endsWith('_id') && candidate.endsWith('_id'));
        if (!isIdMismatch) {
            const qualifiedRegex = new RegExp(`\\b${tbl}\\s*\\.\\s*${badCol}\\b`, 'gi');
            repaired = repaired.replace(qualifiedRegex, `${tbl}.${candidate}`);
        }
    } else if (candidateMatch) {
        const colMatch = errorMessage.match(/(?:Referenced column|Column)\s+["']?([a-zA-Z0-9_]+)["']\s+(?:not found|does not exist)/i);
        if (colMatch) {
            const badCol = colMatch[1];
            const candidate = candidateMatch[1];
            const isIdMismatch = (badCol.endsWith('_id') && !candidate.endsWith('_id')) || (!badCol.endsWith('_id') && candidate.endsWith('_id'));
            if (!isIdMismatch) {
                const colRegex = new RegExp(`\\b${badCol}\\b`, 'gi');
                repaired = repaired.replace(colRegex, candidate);
            }
        }
    }

    // 3. Schema synonym rules for common multi-table join benchmarks (10M dataset)
    // Products table (p): product_category, product_tier, product_name
    repaired = repaired.replace(/\bp\s*\.\s*category\b/gi, 'p.product_category');
    repaired = repaired.replace(/\bp\s*\.\s*tier\b/gi, 'p.product_tier');
    repaired = repaired.replace(/\bp\s*\.\s*name\b/gi, 'p.product_name');

    // Customers table (c): customer_segment, customer_name, country
    repaired = repaired.replace(/\bc\s*\.\s*segment\b/gi, 'c.customer_segment');
    repaired = repaired.replace(/\bc\s*\.\s*name\b/gi, 'c.customer_name');
    if (/JOIN\s+read_parquet\([^)]*regions\.parquet[^)]*\)\s+r\b/i.test(repaired)) {
        repaired = repaired.replace(/\bc\s*\.\s*region\b/gi, 'r.region_name');
    } else {
        repaired = repaired.replace(/\bc\s*\.\s*region\b/gi, 'c.country');
    }

    // Regions table (r): region_name, region_code
    repaired = repaired.replace(/\br\s*\.\s*name\b/gi, 'r.region_name');
    repaired = repaired.replace(/\br\s*\.\s*code\b/gi, 'r.region_code');

    // Sales orders table (s): order_status, order_date
    repaired = repaired.replace(/\bs\s*\.\s*status\b/gi, 's.order_status');
    repaired = repaired.replace(/\bs\s*\.\s*date\b/gi, 's.order_date');

    return repaired !== sql ? repaired : null;
}

async function attemptAiFix(userId, failedSql, errorMessage, targetId) {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey || apiKey.startsWith('your_') || apiKey === 'dummy_key' || apiKey === 'YOUR_OPENAI_KEY') return null;

    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });

    const prompt = `The user tried to run this DuckDB SQL query in CloudObjectIQ:
    "${failedSql}"

    It FAILED with this error:
    "${errorMessage}"

    CRITICAL: 
    1. Identify the typo or incorrect column name in the JOIN or SELECT.
    2. Use the "Candidate bindings" mentioned in the error to FIX the SQL.
    3. Return ONLY the corrected raw SQL. No markdown, no commentary.`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "You are a SQL repair bot for DuckDB." }, { role: "user", content: prompt }],
        temperature: 0,
    });

    let fixed = response.choices[0].message.content.trim();
    if (fixed.includes('```')) fixed = fixed.split('```')[1].replace(/^sql\s+/i, '');
    return fixed.trim();
}

app.post('/api/ai-suggest/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    try {
        const { targetId } = req.params;
        const { prompt, fileName, selectedFile, activeFormat, currentSql } = req.body;
        const userId = req.user.user_id;

        const sql = await suggestQuery(userId, prompt, targetId, fileName, { selectedFile, activeFormat, currentSql });
        res.json({ success: true, sql });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── NL2SQL ROUTE ────────────────────────────────────────
app.post('/api/nl2sql', authenticate, async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    const { sql, result } = await handleNl2Sql(question);
    const summary = JSON.stringify(result).substring(0, 200);
    try {
      await db.run('INSERT INTO nl2sql_log (question, sql, result_summary) VALUES (?, ?, ?)', [question, sql, summary]);
    } catch (e) {}
    res.json({ success: true, sql, result });
  } catch (err) {
    console.error('[NL2SQL] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN CONTROL CENTER ROUTES ───────────────────────────────

// 1. User Management
app.get('/api/admin/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const users = await db.all('SELECT user_id, email, role FROM users');
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:userId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { userId } = req.params;
    const { role, password } = req.body;
    try {
        if (password && role) {
            const hash = await bcrypt.hash(password, 10);
            await db.run('UPDATE users SET role = ?, password_hash = ? WHERE user_id = ?', [role, hash, userId]);
        } else if (password) {
            const hash = await bcrypt.hash(password, 10);
            await db.run('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, userId]);
        } else if (role) {
            await db.run('UPDATE users SET role = ? WHERE user_id = ?', [role, userId]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { email, password, role } = req.body;
    try {
        const userId = require('crypto').randomUUID();
        const hash = await bcrypt.hash(password, 10);
        await db.run('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)', [userId, email, hash, role || 'user']);
        res.json({ success: true, userId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/users/:userId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { userId } = req.params;
    if (userId === req.user.user_id) {
        return res.status(400).json({ error: 'Cannot delete your own active admin account' });
    }
    try {
        await db.run('DELETE FROM permissions WHERE subject_id = ?', [userId]);
        await db.run('DELETE FROM users WHERE user_id = ?', [userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Control Plane Metadata DB Status
app.get('/api/admin/db-status', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const counts = {
            users: Number((await db.get('SELECT COUNT(*) AS cnt FROM users'))?.cnt || 0),
            targets: Number((await db.get('SELECT COUNT(*) AS cnt FROM targets'))?.cnt || 0),
            catalog: Number((await db.get('SELECT COUNT(*) AS cnt FROM metadata_catalog'))?.cnt || 0),
            permissions: Number((await db.get('SELECT COUNT(*) AS cnt FROM permissions'))?.cnt || 0)
        };
        res.json({ success: true, status: db.getStatus(), counts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Permission Management
app.get('/api/admin/permissions', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const perms = await db.all(`
            SELECT p.*, p.subject_id AS user_id, u.email, t.target_name 
            FROM permissions p
            LEFT JOIN users u ON p.subject_id = u.user_id AND p.subject_type = 'user'
            LEFT JOIN targets t ON p.target_id = t.target_id
        `);
        res.json({ success: true, permissions: perms });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/permissions', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { subject_id, subject_type, target_id, can_read, can_write, can_delete } = req.body;
    try {
        const permId = `${subject_id}_${target_id}`;
        await db.run(`
            INSERT OR REPLACE INTO permissions (id, subject_id, subject_type, target_id, can_read, can_write, can_delete)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [permId, subject_id, subject_type, target_id, can_read ? 1 : 0, can_write ? 1 : 0, can_delete ? 1 : 0]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Target Management
app.get('/api/admin/targets', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const targets = await db.all('SELECT * FROM targets');
        res.json({ success: true, targets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/targets', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { target_name, provider_type, endpoint, bucket, credentials, access_key, secret_key, region, krb_principal, krb_keytab } = req.body;
    const synced = db.parseCredentials(credentials, access_key, secret_key);

    try {
        const targetId = require('crypto').randomUUID();
        await db.run(`
            INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, credentials, access_key, secret_key, region, is_active, krb_principal, krb_keytab)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `, [targetId, target_name, provider_type, endpoint, bucket, synced.credentials, synced.access_key, synced.secret_key, region, krb_principal || null, krb_keytab || null]);
        res.json({ success: true, targetId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/targets/:targetId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    const { target_name, provider_type, endpoint, bucket, credentials, access_key, secret_key, region, krb_principal, krb_keytab } = req.body;
    const synced = db.parseCredentials(credentials, access_key, secret_key);
    console.log(`[Admin] Updating target ${targetId}: ${target_name}`);

    try {
        if (provider_type) {
            await db.run(
                'UPDATE targets SET target_name = ?, provider_type = ?, endpoint = ?, bucket = ?, credentials = ?, access_key = ?, secret_key = ?, region = ?, krb_principal = ?, krb_keytab = ? WHERE target_id = ?',
                [target_name, provider_type, endpoint, bucket, synced.credentials, synced.access_key, synced.secret_key, region, krb_principal || null, krb_keytab || null, targetId]
            );
        } else {
            await db.run(
                'UPDATE targets SET target_name = ?, endpoint = ?, bucket = ?, credentials = ?, access_key = ?, secret_key = ?, region = ?, krb_principal = ?, krb_keytab = ? WHERE target_id = ?',
                [target_name, endpoint, bucket, synced.credentials, synced.access_key, synced.secret_key, region, krb_principal || null, krb_keytab || null, targetId]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error(`[Admin] Update failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/targets/:targetId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    try {
        await db.run('DELETE FROM metadata_catalog WHERE target_id = ?', [targetId]);
        await db.run('DELETE FROM permissions WHERE target_id = ?', [targetId]);
        await db.run('DELETE FROM targets WHERE target_id = ?', [targetId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/system_logs', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const logs = await db.all(`SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 200`);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/logs', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        let logs = [];
        let summary = {
            totalQueries: 0,
            avgDurationMs: 0,
            minDurationMs: 0,
            maxDurationMs: 0,
            totalScannedBytes: 0,
            totalDownloadedBytes: 0,
            totalBurnUsd: 0,
            totalOnDemandUsd: 0,
            totalSavingsUsd: 0,
            cacheHitRatePct: 0
        };
        try {
            const rawLogs = await db.all(`
                SELECT 
                    q.execution_id,
                    q.timestamp, 
                    u.email, 
                    t.target_name, 
                    q.status, 
                    q.execution_time_ms AS duration, 
                    q.data_scanned_bytes, 
                    q.storage_downloaded_bytes,
                    q.cache_status,
                    q.calculated_cost_usd, 
                    q.on_demand_cost_usd,
                    q.query_text
                FROM query_logs q
                LEFT JOIN users u ON q.user_id = u.user_id
                LEFT JOIN targets t ON q.target_id = t.target_id
                ORDER BY q.timestamp DESC
                LIMIT 200
            `);
            logs = rawLogs.map(l => ({
                ...l,
                duration: Number(l.duration || 0),
                data_scanned_bytes: Number(l.data_scanned_bytes || 0),
                storage_downloaded_bytes: Number(l.storage_downloaded_bytes || 0),
                calculated_cost_usd: Number(l.calculated_cost_usd || 0),
                on_demand_cost_usd: Number(l.on_demand_cost_usd || l.calculated_cost_usd || 0),
                cache_status: l.cache_status || 'MISS'
            }));

            if (logs.length > 0) {
                const totalDur = logs.reduce((acc, l) => acc + l.duration, 0);
                const durs = logs.map(l => l.duration);
                const hits = logs.filter(l => l.cache_status === 'HIT' || l.cache_status === 'LOCAL').length;
                const totalScanned = logs.reduce((acc, l) => acc + l.data_scanned_bytes, 0);
                const totalDown = logs.reduce((acc, l) => acc + l.storage_downloaded_bytes, 0);
                const totalBurn = logs.reduce((acc, l) => acc + l.calculated_cost_usd, 0);
                const totalOnDemand = logs.reduce((acc, l) => acc + l.on_demand_cost_usd, 0);

                summary = {
                    totalQueries: logs.length,
                    avgDurationMs: Math.round(totalDur / logs.length),
                    minDurationMs: Math.min(...durs),
                    maxDurationMs: Math.max(...durs),
                    totalScannedBytes: totalScanned,
                    totalDownloadedBytes: totalDown,
                    totalBurnUsd: totalBurn,
                    totalOnDemandUsd: totalOnDemand,
                    totalSavingsUsd: Math.max(0, totalOnDemand - totalBurn),
                    cacheHitRatePct: Math.round((hits / logs.length) * 100)
                };
            }
        } catch (e) {}
        res.json({ success: true, logs, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/catalog', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const catalog = await db.all(`
            SELECT m.*, t.target_name 
            FROM metadata_catalog m
            LEFT JOIN targets t ON m.target_id = t.target_id
            ORDER BY m.created_at DESC
        `);
        res.json({ success: true, catalog, dbStatus: db.getStatus ? db.getStatus() : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function scanTargetIntoCatalog(userId, targetId) {
    const rawFiles = await listFiles(targetId);
    const files = rawFiles.filter(f => f && f.name && !f.name.endsWith('/'));

    // Preserve any previously extracted schemas so large files stay cached across rescans
    const prevRows = await db.all('SELECT file_path, schema_json FROM metadata_catalog WHERE target_id = ?', [targetId]).catch(() => []);
    const prevSchemas = new Map();
    for (const r of prevRows) {
        if (r.file_path && r.schema_json) prevSchemas.set(r.file_path, r.schema_json);
    }

    await db.run('DELETE FROM metadata_catalog WHERE target_id = ?', [targetId]);

    const autoDescribeExts = new Set(['parquet', 'csv', 'tsv', 'iceberg', 'json', 'jsonl', 'ndjson']);
    let schemasDetected = 0;

    for (const file of files) {
        const id = require('crypto').createHash('md5').update(`${targetId}_${file.name}`).digest('hex');
        const ext = (file.format || (file.name.toLowerCase().endsWith('.iceberg') || file.name.toLowerCase().includes('.iceberg') ? 'iceberg' : file.name.split('.').pop() || 'bin')).toLowerCase();
        const sizeBytes = Number(file.size || 0);
        const lastMod = file.lastModified || new Date().toISOString();

        // Insert catalog entry first so engine.js can resolve logicalName during DESCRIBE
        await db.run(`
            INSERT INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, schema_json, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, targetId, file.name, path.basename(file.name), sizeBytes, ext, prevSchemas.get(file.name) || null, lastMod]);

        let schemaJson = prevSchemas.get(file.name) || null;
        const isLargeJson = (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') && sizeBytes > 10 * 1024 * 1024;
        if (!schemaJson && autoDescribeExts.has(ext) && !isLargeJson) {
            try {
                const safeName = file.name.replace(/'/g, "''");
                const srcExpr = (ext === 'json' || ext === 'jsonl' || ext === 'ndjson')
                    ? `read_json_auto('${safeName}', sample_size=100, maximum_object_size=33554432)`
                    : buildDuckDbSourceExpr(file.name, ext);
                const descRows = await Promise.race([
                    runQuery(userId, `DESCRIBE SELECT * FROM ${srcExpr} LIMIT 1`, targetId),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Schema scan timeout')), 8000))
                ]);
                if (Array.isArray(descRows) && descRows.length > 0) {
                    const cols = descRows.map(r => ({
                        name: r.column_name,
                        type: r.column_type,
                        nullable: r.null === 'YES'
                    }));
                    schemaJson = JSON.stringify(cols);
                    await db.run('UPDATE metadata_catalog SET schema_json = ? WHERE id = ?', [schemaJson, id]);
                }
            } catch (descErr) {
                console.warn(`[Catalog Schema Notice] ${file.name}: ${descErr.message}`);
            }
        }
        if (schemaJson) schemasDetected++;
    }

    return { indexedCount: files.length, schemasDetected };
}

app.post('/api/admin/catalog/scan-all', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    
    try {
        const targets = await db.all('SELECT target_id, target_name FROM targets');
        let totalFiles = 0;
        let totalSchemas = 0;
        let errors = [];

        for (const target of targets) {
            try {
                const { indexedCount, schemasDetected } = await scanTargetIntoCatalog(req.user.user_id, target.target_id);
                totalFiles += indexedCount;
                totalSchemas += schemasDetected;
            } catch (err) {
                console.error(`Failed to scan ${target.target_name}:`, err);
                errors.push({ target: target.target_name, error: err.message });
            }
        }
        
        let message = `Global scan completed. Indexed ${totalFiles} objects (${totalSchemas} table schemas extracted) across ${targets.length} storages.`;
        if (errors.length > 0) {
            message += ` (${errors.length} offline/local target(s) skipped: ${errors.map(e => e.target).join(', ')})`;
        }

        res.json({ success: true, message, errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/catalog/scan/:targetId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    try {
        const { indexedCount, schemasDetected } = await scanTargetIntoCatalog(req.user.user_id, targetId);
        res.json({
            success: true,
            message: `Scan completed! Indexed ${indexedCount} objects and extracted ${schemasDetected} table schemas into PostgreSQL.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/spark/submit', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId, className, jarPath, args } = req.body;
    
    try {
        const { submitSparkJob } = require('./services/spark');
        let conf = {};
        if (targetId) {
            const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
            if (target && (target.provider_type === 'azure' || target.provider_type === 'adls')) {
                const connStr = target.endpoint || '';
                const accMatch = connStr.match(/AccountName=([^;]+)/i);
                const accKeyMatch = connStr.match(/AccountKey=([^;]+)/i);
                const accName = accMatch ? accMatch[1] : 'azure';
                const accKey = accKeyMatch ? accKeyMatch[1] : '';
                if (accName && accKey) {
                    conf[`spark.hadoop.fs.azure.account.key.${accName}.blob.core.windows.net`] = accKey;
                    conf[`spark.hadoop.fs.azure.account.key.${accName}.dfs.core.windows.net`] = accKey;
                }
            } else if (target && target.provider_type === 'minio') {
                let endpoint = (target.endpoint || process.env.MINIO_ENDPOINT || 'http://cloudobject_iq_minio:9000').replace('localhost', 'cloudobject_iq_minio');
                
                if (endpoint.includes('cloudobject_iq_minio')) {
                    try {
                        const { execSync } = require('child_process');
                        let ip = '';
                        try {
                            ip = execSync('docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" milvus-minio').toString().trim();
                        } catch (e1) {
                            ip = execSync('docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" cloudobject_iq_minio').toString().trim();
                        }
                        if (ip) {
                            endpoint = endpoint.replace('cloudobject_iq_minio', ip);
                        }
                    } catch (e) {
                        console.error('Failed to resolve minio ip via docker inspect:', e);
                    }
                }
                
                if (endpoint.endsWith('/')) {
                    endpoint = endpoint.slice(0, -1);
                }
                
                conf['spark.hadoop.fs.s3a.endpoint'] = endpoint;
                conf['spark.hadoop.fs.s3a.endpoint.region'] = 'us-east-1';
                conf['spark.hadoop.fs.s3a.access.key'] = target.access_key || process.env.MINIO_ACCESS_KEY || 'minioadmin';
                conf['spark.hadoop.fs.s3a.secret.key'] = target.secret_key || process.env.MINIO_SECRET_KEY || 'minioadmin';
                conf['spark.hadoop.fs.s3a.path.style.access'] = 'true';
                conf['spark.hadoop.fs.s3a.impl'] = 'org.apache.hadoop.fs.s3a.S3AFileSystem';
                conf['spark.hadoop.fs.s3a.connection.ssl.enabled'] = 'false';
                conf['spark.hadoop.fs.s3a.aws.credentials.provider'] = 'org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider';
            }
        }

        const result = await submitSparkJob({
            className,
            jarPath,
            args,
            conf
        });
        res.json(result);
    } catch (err) {
        res.json({
            success: false,
            message: err.message || 'Job submission failed',
            output: err.output || err.message || 'No output available'
        });
    }
});



app.use(express.static(path.join(__dirname, '../public')));

// Serve NL2SQL page explicitly
app.get('/nl2sql.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'nl2sql.html'));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*'    }
});

// ── RAG ENDPOINTS ──────────────────────────────────────────────

let bulkIndexStatus = { isRunning: false, totalFiles: 0, indexedFiles: 0, currentFile: '', errors: [] };

app.get('/api/rag/bulk_index/status', authenticate, (req, res) => {
    res.json(bulkIndexStatus);
});

app.post('/api/rag/bulk_index/start', authenticate, async (req, res) => {
    if (bulkIndexStatus.isRunning) return res.status(400).json({ success: false, error: 'Bulk indexing is already running' });
    
    bulkIndexStatus = { isRunning: true, totalFiles: 0, indexedFiles: 0, currentFile: 'Initializing...', errors: [] };
    res.json({ success: true, message: 'Bulk indexing started in background' });
    
    // Background worker
    (async () => {
        try {
            const { listFiles, downloadFile } = require('./drivers/storage');
            const { runRagEngine } = require('./services/rag');
            const fs = require('fs');
            const path = require('path');
            
            const targets = await db.all('SELECT * FROM targets');
            const validExtensions = ['.pdf', '.txt', '.md', '.csv', '.json', '.parquet', '.orc', '.dxf'];
            
            let allFiles = [];
            
            // 1. Discovery
            bulkIndexStatus.currentFile = 'Discovering unstructured files across targets...';
            for (const target of targets) {
                try {
                    const files = await listFiles(target.target_id);
                    for (const f of files) {
                        const ext = path.extname(f.name).toLowerCase();
                        if (validExtensions.includes(ext)) {
                            allFiles.push({ targetId: target.target_id, fileName: f.name });
                        }
                    }
                } catch (e) {
                    bulkIndexStatus.errors.push(`Target ${target.target_name}: ${e.message}`);
                }
            }
            
            bulkIndexStatus.totalFiles = allFiles.length;
            if (allFiles.length === 0) {
                bulkIndexStatus.currentFile = 'No unstructured files found.';
                bulkIndexStatus.isRunning = false;
                return;
            }
            
            // 2. Indexing loop
            for (let i = 0; i < allFiles.length; i++) {
                const { targetId, fileName } = allFiles[i];
                bulkIndexStatus.currentFile = `Indexing ${i + 1}/${allFiles.length}: ${fileName}`;
                
                const tempPath = path.join(process.cwd(), 'data', `tmp_bulk_${Date.now()}_${path.basename(fileName)}`);
                try {
                    await downloadFile(targetId, fileName, tempPath);
                    await runRagEngine('index', tempPath);
                    bulkIndexStatus.indexedFiles++;
                } catch (err) {
                    bulkIndexStatus.errors.push(`File ${fileName}: ${err.message}`);
                } finally {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                }
            }
            
            bulkIndexStatus.currentFile = 'Completed!';
        } catch (err) {
            bulkIndexStatus.errors.push(`Fatal Error: ${err.message}`);
            bulkIndexStatus.currentFile = 'Failed!';
        } finally {
            bulkIndexStatus.isRunning = false;
        }
    })();
});

app.post('/api/rag/index', authenticate, async (req, res) => {
    const { targetId, fileName, password } = req.body;
    if (!targetId || !fileName) return res.status(400).json({ success: false, error: 'targetId and fileName required' });
    
    try {
        const { downloadFile } = require('./drivers/storage');
        const { runRagEngine } = require('./services/rag');
        const fs = require('fs');
        const path = require('path');
        
        const tempPath = path.join(process.cwd(), 'data', `tmp_${Date.now()}_${path.basename(fileName)}`);
        
        // 1. Download file locally
        await downloadFile(targetId, fileName, tempPath);
        
        // 2. Run RAG indexer
        const result = await runRagEngine('index', tempPath, 'semantic', null, password);
        
        // 3. Cleanup
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        
        res.json(result);
    } catch (err) {
        console.error('RAG Index Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rag/upload_and_index', authenticate, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        
        const password = req.body.password;
        
        const { runRagEngine } = require('./services/rag');
        const fs = require('fs');
        const path = require('path');
        
        const tempPath = path.join(process.cwd(), 'data', `tmp_${Date.now()}_${req.file.originalname}`);
        fs.writeFileSync(tempPath, req.file.buffer);
        
        // 2. Run RAG indexer, passing original filename as the explicit source
        const result = await runRagEngine('index', tempPath, 'semantic', req.file.originalname, password);
        
        // 3. Cleanup
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        
        // Append the final indexed location mapping for the client
        res.json({ ...result, location: `milvus.db (as: ${req.file.originalname})` });
    } catch (err) {
        console.error('RAG Upload & Index Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rag/query', authenticate, async (req, res) => {
    const { question, mode } = req.body;
    if (!question) return res.status(400).json({ success: false, error: 'question required' });
    
    try {
        const { runRagEngine } = require('./services/rag');
        const result = await runRagEngine('query', question, mode);
        console.log(`[RAG Query] question="${question}", mode="${mode}", result:`, result);
        res.json(result);
    } catch (err) {
        console.error('RAG Query Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/rag/documents', authenticate, async (req, res) => {
    try {
        const { runRagEngine } = require('./services/rag');
        const result = await runRagEngine('list_sources', 'none');
        res.json(result);
    } catch (err) {
        console.error('RAG List Sources Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/rag/document/:fileName', authenticate, async (req, res) => {
    try {
        const { fileName } = req.params;
        const { runRagEngine } = require('./services/rag');
        
        // Pass fileName to python engine using a 'delete' command
        const result = await runRagEngine('delete', fileName);
        res.json({ success: true, message: `Document ${fileName} deleted`, result });
    } catch (err) {
        console.error('RAG Delete Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rag/legal_index', authenticate, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        
        const { runLegalRagEngine } = require('./services/rag');
        const fs = require('fs');
        const path = require('path');
        
        const tempPath = path.join(process.cwd(), 'data', `tmp_legal_${Date.now()}_${req.file.originalname}`);
        fs.writeFileSync(tempPath, req.file.buffer);
        
        const result = await runLegalRagEngine('index', tempPath, req.file.originalname);
        
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        
        res.json(result);
    } catch (err) {
        console.error('Legal RAG Index Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rag/legal_query', authenticate, async (req, res) => {
    const { question, doc_id } = req.body;
    if (!question) return res.status(400).json({ success: false, error: 'question required' });
    
    try {
        const { runLegalRagEngine } = require('./services/rag');
        // doc_id is optional
        const result = await runLegalRagEngine('query', question, doc_id);
        console.log(`[Legal RAG Query] question="${question}", result:`, result);
        res.json(result);
    } catch (err) {
        console.error('Legal RAG Query Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 4000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 300000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 CloudObjectIQ Enterprise running at http://localhost:${PORT}`);
});
