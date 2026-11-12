const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    oauth_provider TEXT,
    oauth_id TEXT,
    display_name TEXT,
    refresh_token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS targets (
    target_id TEXT PRIMARY KEY,
    target_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    endpoint TEXT,
    bucket TEXT,
    credentials TEXT,
    access_key TEXT,
    secret_key TEXT,
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
    schema_json TEXT,
    last_modified TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS objects (
    object_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER,
    checksum_md5 TEXT,
    content_type TEXT,
    schema_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_history (
    id TEXT PRIMARY KEY,
    execution_id TEXT,
    user_id TEXT,
    target_id TEXT,
    sql_query TEXT,
    duration_ms INTEGER,
    row_count INTEGER,
    cost_usd REAL,
    on_demand_cost_usd REAL DEFAULT 0,
    scan_bytes INTEGER,
    storage_downloaded_bytes INTEGER DEFAULT 0,
    cache_status TEXT DEFAULT 'MISS',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT,
    user_id TEXT,
    target_id TEXT,
    query_text TEXT,
    row_count INTEGER DEFAULT 0,
    execution_time_ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    data_scanned_bytes INTEGER DEFAULT 0,
    storage_downloaded_bytes INTEGER DEFAULT 0,
    cache_status TEXT DEFAULT 'MISS',
    calculated_cost_usd REAL DEFAULT 0,
    on_demand_cost_usd REAL DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    level TEXT,
    category TEXT,
    message TEXT,
    metadata TEXT
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

CREATE TABLE IF NOT EXISTS nl2sql_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    sql TEXT,
    result_summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    source_conn TEXT,
    target_path TEXT,
    parallelism INTEGER DEFAULT 4,
    status TEXT DEFAULT 'idle',
    dlq_count INTEGER DEFAULT 0,
    created_by TEXT,
    file_format TEXT DEFAULT 'parquet',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_telemetry (
    id TEXT PRIMARY KEY,
    execution_id TEXT UNIQUE NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT,
    target_id TEXT,
    query_text TEXT NOT NULL,
    query_type TEXT,
    storage_provider TEXT,
    file_format TEXT,
    file_count INTEGER DEFAULT 1,
    total_file_size_bytes INTEGER DEFAULT 0,
    join_count INTEGER DEFAULT 0,
    filter_count INTEGER DEFAULT 0,
    projection_count INTEGER DEFAULT 0,
    aggregation_count INTEGER DEFAULT 0,
    has_wildcard INTEGER DEFAULT 0,
    query_plan_features TEXT,
    cache_status TEXT DEFAULT 'MISS',
    estimated_scan_bytes INTEGER DEFAULT 0,
    actual_scan_bytes INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    actual_cost_usd REAL DEFAULT 0,
    on_demand_cost_usd REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prediction_feedback (
    id TEXT PRIMARY KEY,
    execution_id TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT,
    query_text TEXT,
    predicted_scan_bytes INTEGER,
    predicted_duration_ms INTEGER,
    predicted_cost_usd REAL,
    confidence_score REAL,
    confidence_interval TEXT,
    recommendations TEXT,
    actual_scan_bytes INTEGER,
    actual_duration_ms INTEGER,
    actual_cost_usd REAL,
    scan_error INTEGER,
    duration_error_ms INTEGER,
    cost_error_usd REAL,
    scan_error_pct REAL,
    duration_error_pct REAL,
    cost_error_pct REAL,
    model_version TEXT DEFAULT 'v1.0.0',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    validated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ml_model_registry (
    model_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    model_type TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    version TEXT NOT NULL,
    metrics TEXT,
    hyperparameters TEXT,
    model_path TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) DEFAULT 'viewer',
    oauth_provider VARCHAR(64),
    oauth_id VARCHAR(255),
    display_name VARCHAR(255),
    refresh_token TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS targets (
    target_id VARCHAR(64) PRIMARY KEY,
    target_name VARCHAR(255) NOT NULL,
    provider_type VARCHAR(64) NOT NULL,
    endpoint TEXT,
    bucket VARCHAR(255),
    credentials TEXT,
    access_key TEXT,
    secret_key TEXT,
    region VARCHAR(64),
    is_active INTEGER DEFAULT 1,
    krb_principal TEXT,
    krb_keytab TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id VARCHAR(128) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
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
    id VARCHAR(128) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    target_id VARCHAR(64),
    file_path TEXT,
    file_name TEXT,
    file_size BIGINT DEFAULT 0,
    format VARCHAR(64),
    schema_json TEXT,
    last_modified TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS objects (
    object_id VARCHAR(64) PRIMARY KEY,
    target_id VARCHAR(64) NOT NULL,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes BIGINT DEFAULT 0,
    checksum_md5 VARCHAR(64),
    content_type VARCHAR(128),
    schema_json TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_history (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    execution_id VARCHAR(64),
    user_id VARCHAR(64),
    target_id VARCHAR(64),
    sql_query TEXT,
    duration_ms INTEGER,
    row_count BIGINT,
    cost_usd NUMERIC(12, 6),
    on_demand_cost_usd NUMERIC(12, 6) DEFAULT 0,
    scan_bytes BIGINT,
    storage_downloaded_bytes BIGINT DEFAULT 0,
    cache_status VARCHAR(32) DEFAULT 'MISS',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_logs (
    log_id SERIAL PRIMARY KEY,
    execution_id VARCHAR(64),
    user_id VARCHAR(64),
    target_id VARCHAR(64),
    query_text TEXT,
    row_count BIGINT DEFAULT 0,
    execution_time_ms INTEGER DEFAULT 0,
    status VARCHAR(32) DEFAULT 'success',
    data_scanned_bytes BIGINT DEFAULT 0,
    storage_downloaded_bytes BIGINT DEFAULT 0,
    cache_status VARCHAR(32) DEFAULT 'MISS',
    calculated_cost_usd NUMERIC(12, 6) DEFAULT 0,
    on_demand_cost_usd NUMERIC(12, 6) DEFAULT 0,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(16),
    category VARCHAR(64),
    message TEXT,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    user_id VARCHAR(64),
    action VARCHAR(128),
    target_id VARCHAR(64),
    details TEXT,
    ip_address VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_queries (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    user_id VARCHAR(64),
    query_name VARCHAR(255),
    sql_query TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_documents (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    file_name TEXT,
    target_id VARCHAR(64),
    chunk_count INTEGER,
    indexed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nl2sql_log (
    id SERIAL PRIMARY KEY,
    question TEXT,
    sql TEXT,
    result_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipelines (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    source_type VARCHAR(64) NOT NULL,
    target_type VARCHAR(64) NOT NULL,
    source_conn TEXT,
    target_path TEXT,
    parallelism INTEGER DEFAULT 4,
    status VARCHAR(32) DEFAULT 'idle',
    dlq_count INTEGER DEFAULT 0,
    created_by VARCHAR(255),
    file_format VARCHAR(32) DEFAULT 'parquet',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_telemetry (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    execution_id VARCHAR(64) UNIQUE NOT NULL,
    tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
    user_id VARCHAR(64),
    target_id VARCHAR(64),
    query_text TEXT NOT NULL,
    query_type VARCHAR(64),
    storage_provider VARCHAR(64),
    file_format VARCHAR(64),
    file_count INTEGER DEFAULT 1,
    total_file_size_bytes BIGINT DEFAULT 0,
    join_count INTEGER DEFAULT 0,
    filter_count INTEGER DEFAULT 0,
    projection_count INTEGER DEFAULT 0,
    aggregation_count INTEGER DEFAULT 0,
    has_wildcard INTEGER DEFAULT 0,
    query_plan_features TEXT,
    cache_status VARCHAR(32) DEFAULT 'MISS',
    estimated_scan_bytes BIGINT DEFAULT 0,
    actual_scan_bytes BIGINT DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    actual_cost_usd NUMERIC(12, 6) DEFAULT 0,
    on_demand_cost_usd NUMERIC(12, 6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prediction_feedback (
    id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    execution_id VARCHAR(64),
    tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
    user_id VARCHAR(64),
    query_text TEXT,
    predicted_scan_bytes BIGINT,
    predicted_duration_ms INTEGER,
    predicted_cost_usd NUMERIC(12, 6),
    confidence_score NUMERIC(5, 2),
    confidence_interval TEXT,
    recommendations TEXT,
    actual_scan_bytes BIGINT,
    actual_duration_ms INTEGER,
    actual_cost_usd NUMERIC(12, 6),
    scan_error BIGINT,
    duration_error_ms INTEGER,
    cost_error_usd NUMERIC(12, 6),
    scan_error_pct NUMERIC(8, 2),
    duration_error_pct NUMERIC(8, 2),
    cost_error_pct NUMERIC(8, 2),
    model_version VARCHAR(64) DEFAULT 'v1.0.0',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    validated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ml_model_registry (
    model_id VARCHAR(64) PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
    tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
    model_type VARCHAR(64) NOT NULL,
    algorithm VARCHAR(64) NOT NULL,
    version VARCHAR(64) NOT NULL,
    metrics TEXT,
    hyperparameters TEXT,
    model_path TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_query_telemetry_tenant ON query_telemetry(tenant_id);
CREATE INDEX IF NOT EXISTS idx_query_telemetry_execution ON query_telemetry(execution_id);
CREATE INDEX IF NOT EXISTS idx_prediction_feedback_tenant ON prediction_feedback(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ml_model_registry_tenant ON ml_model_registry(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_metadata_catalog_target ON metadata_catalog(target_id);
CREATE INDEX IF NOT EXISTS idx_metadata_catalog_filename ON metadata_catalog(file_name);
CREATE INDEX IF NOT EXISTS idx_query_logs_timestamp ON query_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_query_logs_user ON query_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp DESC);
`;

const POSTGRES_MIGRATIONS = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token TEXT`,
    `ALTER TABLE targets ADD COLUMN IF NOT EXISTS credentials TEXT`,
    `ALTER TABLE targets ADD COLUMN IF NOT EXISTS access_key TEXT`,
    `ALTER TABLE targets ADD COLUMN IF NOT EXISTS secret_key TEXT`,
    `ALTER TABLE targets ADD COLUMN IF NOT EXISTS krb_principal TEXT`,
    `ALTER TABLE targets ADD COLUMN IF NOT EXISTS krb_keytab TEXT`,
    `ALTER TABLE permissions ALTER COLUMN id SET DEFAULT md5(random()::text || clock_timestamp()::text)`,
    `ALTER TABLE metadata_catalog ADD COLUMN IF NOT EXISTS schema_json TEXT`,
    `ALTER TABLE metadata_catalog ADD COLUMN IF NOT EXISTS last_modified TEXT`,
    `ALTER TABLE metadata_catalog ALTER COLUMN id SET DEFAULT md5(random()::text || clock_timestamp()::text)`,
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS execution_id VARCHAR(64)`,
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS on_demand_cost_usd NUMERIC(12, 6) DEFAULT 0`,
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS storage_downloaded_bytes BIGINT DEFAULT 0`,
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS cache_status VARCHAR(32) DEFAULT 'MISS'`,
    `ALTER TABLE query_logs ADD COLUMN IF NOT EXISTS execution_id VARCHAR(64)`,
    `ALTER TABLE query_logs ADD COLUMN IF NOT EXISTS storage_downloaded_bytes BIGINT DEFAULT 0`,
    `ALTER TABLE query_logs ADD COLUMN IF NOT EXISTS cache_status VARCHAR(32) DEFAULT 'MISS'`,
    `ALTER TABLE query_logs ADD COLUMN IF NOT EXISTS on_demand_cost_usd NUMERIC(12, 6) DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) DEFAULT 'default'`,
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) DEFAULT 'default'`,
    `ALTER TABLE query_logs ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) DEFAULT 'default'`
];

const DEFAULT_TARGETS = [
    {
        target_id: '6c59252c-9112-46f4-a070-9fc548fb8253',
        target_name: 'MinIO Local',
        provider_type: 'minio',
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'datalake',
        credentials: 'minioadmin:minioadmin',
        access_key: 'minioadmin',
        secret_key: 'minioadmin',
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
        access_key: '',
        secret_key: '',
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
        access_key: '',
        secret_key: '',
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
        access_key: 'demo-service-account',
        secret_key: 'demo-private-key',
        region: 'global',
        is_active: 1
    }
];

module.exports = {
    SQLITE_SCHEMA,
    POSTGRES_SCHEMA,
    POSTGRES_MIGRATIONS,
    DEFAULT_TARGETS
};
