const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// ── Rate Limiter: Login (Brute-force protection) ──────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Fail after 10 attempts
    message: { error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Auth Middleware: JWT Verification ────────────────────────
const SECRET_KEY = process.env.JWT_SECRET || 'changeme_plz_enterprise_grade';

function authenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Token expired or invalid' });
        
        req.user = decoded;
        next();
    });
}

function isAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') next();
    else res.status(403).json({ error: 'Permission denied: Admins only' });
}

module.exports = { 
    authenticate,
    loginLimiter,
    SECRET_KEY,
    isAdmin
};
