const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS targets (
    target_id TEXT PRIMARY KEY,
    target_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    endpoint TEXT,
    bucket TEXT,
    credentials TEXT,
    region TEXT,
    is_active INTEGER DEFAULT 1,
    krb_principal TEXT,
    krb_keytab TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    can_read INTEGER DEFAULT 0,
    can_write INTEGER DEFAULT 0,
    can_delete INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subject_id, target_id)
);

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

CREATE TABLE IF NOT EXISTS query_history (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    target_id TEXT,
    sql_query TEXT,
    duration_ms INTEGER,
    row_count INTEGER,
    cost_usd REAL,
    scan_bytes INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT,
    target_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    query_name TEXT,
    sql_query TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    file_name TEXT,
    target_id TEXT,
    chunk_count INTEGER,
    indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) DEFAULT 'viewer',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS targets (
    target_id VARCHAR(64) PRIMARY KEY,
    target_name VARCHAR(255) NOT NULL,
    provider_type VARCHAR(64) NOT NULL,
    endpoint TEXT,
    bucket VARCHAR(255),
    credentials TEXT,
    region VARCHAR(64),
    is_active INTEGER DEFAULT 1,
    krb_principal TEXT,
    krb_keytab TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id VARCHAR(64) PRIMARY KEY,
    subject_id VARCHAR(64) NOT NULL,
    subject_type VARCHAR(32) NOT NULL,
    target_id VARCHAR(64) NOT NULL,
    can_read INTEGER DEFAULT 0,
    can_write INTEGER DEFAULT 0,
    can_delete INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unq_subj_target UNIQUE (subject_id, target_id)
);

CREATE TABLE IF NOT EXISTS metadata_catalog (
    id VARCHAR(64) PRIMARY KEY,
    target_id VARCHAR(64),
    file_path TEXT,
    file_name TEXT,
    file_size BIGINT,
    format VARCHAR(64),
    last_modified TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_history (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64),
    target_id VARCHAR(64),
    sql_query TEXT,
    duration_ms INTEGER,
    row_count BIGINT,
    cost_usd NUMERIC(10, 6),
    scan_bytes BIGINT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64),
    action VARCHAR(128),
    target_id VARCHAR(64),
    details TEXT,
    ip_address VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_queries (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64),
    query_name VARCHAR(255),
    sql_query TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_documents (
    id VARCHAR(64) PRIMARY KEY,
    file_name TEXT,
    target_id VARCHAR(64),
    chunk_count INTEGER,
    indexed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
`;

const DEFAULT_TARGETS = [
    {
        target_id: '6c59252c-9112-46f4-a070-9fc548fb8253',
        target_name: 'MinIO Local',
        provider_type: 'minio',
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'datalake',
        credentials: 'minioadmin:minioadmin',
        region: 'us-east-1',
        is_active: 1
    },
    {
        target_id: 'd535000d-4a9b-4a0b-994a-4b8ef44f6124',
        target_name: 'Azure Primary',
        provider_type: 'azure',
        endpoint: '',
        bucket: null,
        credentials: ':',
        region: '',
        is_active: 1
    },
    {
        target_id: '8c60e100-5c87-4786-ac51-bb453796bac9',
        target_name: 'ADLS Primary Lake',
        provider_type: 'adls',
        endpoint: '',
        bucket: null,
        credentials: ':',
        region: '',
        is_active: 1
    },
    {
        target_id: '24ed18a4-4498-4769-b513-0ef7087c8084',
        target_name: 'Enterprise Google Drive Lake',
        provider_type: 'gdrive',
        endpoint: 'https://www.googleapis.com/drive/v3',
        bucket: 'root',
        credentials: 'demo-service-account:demo-private-key',
        region: 'global',
        is_active: 1
    }
];

module.exports = {
    SQLITE_SCHEMA,
    POSTGRES_SCHEMA,
    DEFAULT_TARGETS
};
