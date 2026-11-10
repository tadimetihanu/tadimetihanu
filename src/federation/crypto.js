const crypto = require('crypto');

const SENSITIVE_KEYS = new Set([
    'password',
    'secret_key',
    'secretKey',
    'secretAccessKey',
    'access_key',
    'accessKey',
    'accessKeyId',
    'connection_string',
    'connectionString',
    'sas_token',
    'sasToken',
    'account_key',
    'accountKey',
    'client_secret',
    'clientSecret',
    'token',
    'private_key',
    'privateKey',
    'credentials'
]);

function getDerivedKey() {
    const rawKey = (
        process.env.FEDERATION_ENCRYPTION_KEY ||
        process.env.TOKEN_ENCRYPTION_KEY ||
        process.env.JWT_SECRET ||
        'cloudobjectiq_enterprise_federation_kms_v2'
    ).trim();
    return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypts a JSON-serializable connection configuration object or string using AES-256-GCM.
 */
function encryptConnectionConfig(configObj) {
    const plaintext = typeof configObj === 'string' ? configObj : JSON.stringify(configObj || {});
    const iv = crypto.randomBytes(12);
    const key = getDerivedKey();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `v1:gcm:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted connection configuration string back to an object.
 */
function decryptConnectionConfig(cipherText) {
    if (!cipherText || typeof cipherText !== 'string') return {};
    if (cipherText.startsWith('{') && cipherText.endsWith('}')) {
        try { return JSON.parse(cipherText); } catch (_) { return {}; }
    }
    if (!cipherText.startsWith('v1:gcm:')) {
        throw new Error('Invalid or tampered encrypted connection payload');
    }
    const parts = cipherText.split(':');
    if (parts.length !== 5) {
        throw new Error('Malformed AES-256-GCM payload');
    }
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = Buffer.from(parts[4], 'hex');
    const key = getDerivedKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted);
}

/**
 * Redacts all sensitive credential fields from a connection configuration before returning to API or logs.
 */
function redactConnectionConfig(configObj) {
    if (!configObj || typeof configObj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(configObj)) {
        const lower = k.toLowerCase();
        if (
            SENSITIVE_KEYS.has(k) ||
            SENSITIVE_KEYS.has(lower) ||
            lower.includes('password') ||
            lower.includes('secret') ||
            lower.includes('token') ||
            lower.includes('key') ||
            lower.includes('connstr') ||
            lower.includes('connection_string')
        ) {
            if (v && typeof v === 'string' && v.length > 0) {
                out[k] = '••••••••REDACTED••••••••';
            } else {
                out[k] = null;
            }
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = redactConnectionConfig(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Scrubs any inline credentials from SQL strings or error messages before logging.
 */
function sanitizeErrorOrSql(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/(SECRET\s*['"]?)([^'"\s,;)]+)/gi, '$1***REDACTED***')
        .replace(/(PASSWORD\s*[=:]?\s*['"]?)([^'"\s,;)]+)/gi, '$1***REDACTED***')
        .replace(/(AccountKey=)([^;'"\s]+)/gi, '$1***REDACTED***')
        .replace(/(:\/\/[^/:@]+:)([^@]+)(@)/g, '$1***REDACTED***$3');
}

module.exports = {
    encryptConnectionConfig,
    decryptConnectionConfig,
    redactConnectionConfig,
    sanitizeErrorOrSql
};
