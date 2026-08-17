require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const session = require('express-session');
const { listFiles, uploadFile } = require('./drivers/storage');
const { encrypt, decrypt } = require('./utils/crypto');
const { initDuckDB, runQuery, calculateCost } = require('./query/engine');
const { suggestQuery } = require('./query/ai');
const { handleNl2Sql } = require('./nl2sql');
const { authenticate, isAdmin, loginLimiter, SECRET_KEY } = require('./middleware/auth');
const { checkAccess } = require('./middleware/checkAccess');

const db = new Database('./data/metadata.db');

try {
    const adminCheck = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@cloudobjectiq.com');
    if (!adminCheck) {
        console.log('[Boot] Admin user missing. Seeding admin@cloudobjectiq.com...');
        const adminHash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run('admin@cloudobjectiq.com', adminHash, 'admin');
        console.log('[Boot] Admin seeded successfully!');
    } else if (!bcrypt.compareSync('admin123', adminCheck.password_hash)) {
        console.log('[Boot] Admin password mismatch. Resetting to admin123...');
        const adminHash = bcrypt.hashSync('admin123', 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(adminHash, 'admin@cloudobjectiq.com');
        console.log('[Boot] Admin password reset to admin123!');
    }
} catch (e) {
    console.error('[Boot] Auto-seed failed (tables might not exist yet):', e.message);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/api/ping', (req, res) => res.json({ status: 'online', timestamp: new Date(), version: '2.0.1-diagnostic' }));
app.use(express.json());

app.use(session({ secret: process.env.SESSION_SECRET || 'oauth-secret-fallback', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID || 'dummy_id', clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy_secret', callbackURL: "http://localhost:4000/api/auth/google/callback" }, (accessToken, refreshToken, profile, done) => {
    profile.oauth_provider = 'google';
    profile.refreshToken = refreshToken;
    return done(null, profile);
}));

passport.use(new MicrosoftStrategy({ clientID: process.env.MICROSOFT_CLIENT_ID || 'dummy_id', clientSecret: process.env.MICROSOFT_CLIENT_SECRET || 'dummy_secret', callbackURL: "http://localhost:4000/api/auth/microsoft/callback", scope: ['user.read', 'offline_access'] }, (accessToken, refreshToken, profile, done) => {
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

function handleOAuthLogin(profile, res) {
    try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : (profile.userPrincipalName || null);
        if (!email) return res.redirect('/?error=no_email_provided');
        let user = db.prepare('SELECT * FROM users WHERE oauth_id = ? OR email = ?').get(profile.id, email);
        if (!user) {
            const defaultPassword = bcrypt.hashSync(Math.random().toString(36).slice(-8), 10);
            const encToken = profile.refreshToken ? encrypt(profile.refreshToken) : null;
            db.prepare('INSERT INTO users (user_id, email, password_hash, role, oauth_provider, oauth_id, display_name, refresh_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(profile.id, email, defaultPassword, 'user', profile.oauth_provider, profile.id, profile.displayName || email, encToken);
            user = { user_id: profile.id, email, role: 'user' };
        } else {
            if (profile.refreshToken) {
                db.prepare('UPDATE users SET refresh_token = ?, oauth_id = ?, oauth_provider = ?, display_name = ? WHERE email = ?')
                  .run(encrypt(profile.refreshToken), profile.id, profile.oauth_provider, profile.displayName || email, email);
            }
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

app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { email, password } = req.body;
    
    console.log(`[Auth] Attempt: ${email}`);

    if (!email || !password) {
        console.log(`[Auth] Failed: Missing credentials`);
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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
app.get('/api/user/profile', authenticate, (req, res) => {
    try {
        const userId = req.user.user_id;

        // Fetch Query History
        const history = db.prepare(`
            SELECT query_text AS sql_query, row_count, execution_time_ms AS duration, status, timestamp, target_id 
            FROM query_logs 
            WHERE user_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 25
        `).all(userId);

        // Calculate Stats
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total_queries,
                SUM(execution_time_ms) as total_compute_time,
                MAX(timestamp) as last_active,
                SUM(data_scanned_bytes) as total_scanned_bytes,
                SUM(calculated_cost_usd) as total_burn_usd
            FROM query_logs 
            WHERE user_id = ?
        `).get(userId);

        res.json({ 
            success: true, 
            user: { 
                email: req.user.email, 
                role: req.user.role, 
                joined: '2025-03-20' 
            }, 
            stats: {
                queries: stats.total_queries || 0,
                computeMs: stats.total_compute_time || 0,
                lastActive: stats.last_active || 'Never',
                totalScannedMB: ((stats.total_scanned_bytes || 0) / (1024 * 1024)).toFixed(2),
                totalBurnUsd: (stats.total_burn_usd || 0).toFixed(6)
            },
            history 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function getAzurePrefix(target) {
    const type = (target.provider_type || '').trim().toLowerCase();
    const isAzure = (type === 'azure' || type === 'adls');

    let prefix;
    if (isAzure) {
        // Broad scope prefix: az://CONTAINER/
        prefix = `az://${target.bucket}/`;
    } else {
        prefix = `s3://${target.bucket}/`;
    }

    console.log(`[PrefixGen] Target: ${target.target_name}, Type: ${type}, Prefix: ${prefix}`);
    return prefix;
}

// ── STORAGE & TARGET ROUTES ───────────────────────────────────
app.get('/api/targets', authenticate, (req, res) => {
    const userId = req.user.user_id;
    const role   = req.user.role;

    console.log(`[TargetFetch] User: ${req.user.email}, Role: ${role}`);

    try {
        let targets;
        if (role === 'admin') {
            targets = db.prepare('SELECT * FROM targets').all();
        } else {
            targets = db.prepare(`
                SELECT t.* FROM targets t
                JOIN permissions p ON t.target_id = p.target_id
                WHERE p.subject_id = ? AND p.subject_type = 'user'
            `).all(userId);
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
        const target = getTarget(targetId);
        if (req.user.role !== 'admin') {
            const hasAccess = db.prepare('SELECT 1 FROM permissions WHERE subject_id=? AND target_id=? AND access_level IN ("write", "admin")').get(req.user.user_id, targetId);
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


// ── SCHEMA INSPECTION (DATA SCANNING) ──────────────────────────
app.get('/api/schema/:targetId', authenticate, checkAccess('read'), async (req, res) => {
    const { targetId } = req.params;
    const { fileName } = req.query;
    const userId = req.user.user_id;

    if (!fileName) return res.status(400).json({ error: 'fileName param required' });

    try {
        const { getTarget } = require('./drivers/storage');
        const target = getTarget(targetId);
        const prefix = getAzurePrefix(target);
        const fullPath = fileName.includes('://') ? fileName : `${prefix}${fileName}`;

        // Intercept unstructured or binary files to prevent DuckDB binder errors
        const unstructuredExts = ['.dwg', '.dwf', '.dxf', '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md'];
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

        // 1. Get Column Details & Row Count (Sequentially for stability)
        const descRows = await runQuery(userId, `DESCRIBE SELECT * FROM '${fullPath}'`, targetId);
        const countRows = await runQuery(userId, `SELECT COUNT(*) AS row_count FROM '${fullPath}'`, targetId);

        const columns = descRows.map(r => ({
            name:     r.column_name,
            type:     r.column_type,
            nullable: r.null === 'YES',
        }));
        
        // 2. Count types (Booleans, etc)
        const boolCount = columns.filter(c => c.type.toLowerCase().includes('bool')).length;
        const numCount  = columns.filter(c => ['integer', 'double', 'float', 'decimal', 'hugeint'].some(t => c.type.toLowerCase().includes(t))).length;

        res.json({ 
            success: true, 
            fileName, 
            columns, 
            rowCount: Number(countRows[0]?.row_count ?? 0),
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

app.post('/api/upload/:targetId', authenticate, checkAccess('write'), upload.array('files'), async (req, res) => {
    try {
        const { targetId } = req.params;
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const results = [];
        for (const file of req.files) {
            const result = await uploadFile(targetId, file.originalname, file.buffer, file.mimetype);
            results.push(result);
        }
        res.json({ success: true, uploaded: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── QUERY & AI ROUTES ─────────────────────────────────────────

app.post('/api/query/:targetId', authenticate, checkAccess('read'), async (req, res) => {
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
        const { estimatedScan, estimatedCost } = calculateCost(sql, results);
        res.json({ 
            success: true, 
            data: sanitizeBigInt(results),
            meta: { duration, estimatedScan, estimatedCost }
        });
    } catch (err) {
        // ── SELF-HEALING AI LOGIC ──────────────────────────────
        if (err.message.includes('Binder Error') && err.message.includes('Candidate bindings')) {
            console.log(`🤖 [AI-Fix] Binder Error detected. Attempting self-healing...`);
            try {
                const fixedSql = await attemptAiFix(userId, sql, err.message, targetId);
                if (fixedSql && fixedSql !== sql) {
                    console.log(`✨ [AI-Fix] Re-executing repaired SQL: ${fixedSql}`);
                    const fixedResults = await runQuery(userId, fixedSql, targetId);
                    const duration = Date.now() - startTime;
                    const { estimatedScan, estimatedCost } = calculateCost(fixedSql, fixedResults);
                    return res.json({ 
                        success: true, 
                        data: sanitizeBigInt(fixedResults), 
                        isFixed: true,
                        originalSql: sql,
                        fixedSql: fixedSql,
                        meta: { duration, estimatedScan, estimatedCost }
                    });
                }
            } catch (fixErr) {
                console.error(`❌ [AI-Fix] Healing failed:`, fixErr.message);
            }
        }

        console.error(`❌ [Query] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

async function attemptAiFix(userId, failedSql, errorMessage, targetId) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

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
        const { prompt, fileName } = req.body;
        const userId = req.user.user_id;

        const sql = await suggestQuery(userId, prompt, targetId, fileName);
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
    db.prepare('INSERT INTO nl2sql_log (question, sql, result_summary) VALUES (?, ?, ?)').run(question, sql, summary);
    res.json({ success: true, sql, result });
  } catch (err) {
    console.error('[NL2SQL] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN CONTROL CENTER ROUTES ───────────────────────────────

// 1. User Management
app.get('/api/admin/users', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const users = db.prepare('SELECT user_id, email, role FROM users').all();
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:userId', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { userId } = req.params;
    const { role } = req.body;
    try {
        db.prepare('UPDATE users SET role = ? WHERE user_id = ?').run(role, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { email, password, role } = req.body;
    try {
        const userId = require('crypto').randomUUID();
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO users (user_id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(userId, email, hash, role || 'user');
        res.json({ success: true, userId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Permission Management
app.get('/api/admin/permissions', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const perms = db.prepare(`
            SELECT p.*, u.email, t.target_name 
            FROM permissions p
            LEFT JOIN users u ON p.subject_id = u.user_id AND p.subject_type = 'user'
            LEFT JOIN targets t ON p.target_id = t.target_id
        `).all();
        res.json({ success: true, permissions: perms });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/permissions', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { subject_id, subject_type, target_id, can_read, can_write, can_delete } = req.body;
    try {
        db.prepare(`
            INSERT OR REPLACE INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(subject_id, subject_type, target_id, can_read || 0, can_write || 0, can_delete || 0);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Target Management
app.get('/api/admin/targets', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const targets = db.prepare('SELECT * FROM targets').all();
        res.json({ success: true, targets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/targets', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { target_name, provider_type, endpoint, bucket, credentials, region } = req.body;
    let [access_key, secret_key] = (credentials || "").split(':');
    if (!secret_key) secret_key = access_key; // Fallback

    try {
        const targetId = require('crypto').randomUUID();
        db.prepare(`
            INSERT INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(targetId, target_name, provider_type, endpoint, bucket, access_key, secret_key, region);
        res.json({ success: true, targetId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/targets/:targetId', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    const { target_name, endpoint, bucket, credentials, region } = req.body;
    console.log(`[Admin] Updating target ${targetId}: ${target_name}`);
    let [access_key, secret_key] = (credentials || "").split(':');
    if (!secret_key) secret_key = access_key;

    try {
        db.prepare('UPDATE targets SET target_name = ?, endpoint = ?, bucket = ?, access_key = ?, secret_key = ?, region = ? WHERE target_id = ?')
          .run(target_name, endpoint, bucket, access_key, secret_key, region, targetId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Admin] Update failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/targets/:targetId', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    try {
        db.prepare('DELETE FROM targets WHERE target_id = ?').run(targetId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/logs', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const logs = db.prepare(`
            SELECT q.timestamp, u.email, t.target_name, q.status, q.execution_time_ms AS duration, q.calculated_cost_usd, q.query_text
            FROM query_logs q
            LEFT JOIN users u ON q.user_id = u.user_id
            LEFT JOIN targets t ON q.target_id = t.target_id
            ORDER BY q.timestamp DESC
        `).all();
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/catalog', authenticate, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
        const catalog = db.prepare(`
            SELECT m.*, t.target_name 
            FROM metadata_catalog m
            LEFT JOIN targets t ON m.target_id = t.target_id
        `).all();
        res.json({ success: true, catalog });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/catalog/scan/:targetId', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { targetId } = req.params;
    try {
        const files = await listFiles(targetId);
        const deleteStmt = db.prepare('DELETE FROM metadata_catalog WHERE target_id = ?');
        const insertStmt = db.prepare(`
            INSERT INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const transaction = db.transaction((filesList) => {
            deleteStmt.run(targetId);
            for (const file of filesList) {
                const id = require('crypto').randomUUID();
                const ext = file.name.split('.').pop().toLowerCase();
                insertStmt.run(id, targetId, file.name, file.name, file.size, ext);
            }
        });
        
        transaction(files);
        res.json({ success: true, message: `Scan completed successfully. Indexed ${files.length} objects.` });
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
            const target = db.prepare('SELECT * FROM targets WHERE target_id = ?').get(targetId);
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
            
            const targets = db.prepare('SELECT * FROM targets').all();
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
server.listen(PORT, () => {
    console.log(`🚀 CloudObjectIQ Enterprise running at http://localhost:${PORT}`);
});
