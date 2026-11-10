'use strict';

var dbm;
var type;
var seed;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm ? dbm.dataType : null;
  seed = seedLink;
};

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS federation_connections (
      connection_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      connection_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      connection_config_enc TEXT NOT NULL,
      auth_method TEXT NOT NULL DEFAULT 'key_secret',
      owner_id TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      last_error TEXT,
      last_tested_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS federation_catalogs (
      catalog_id TEXT PRIMARY KEY,
      catalog_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      auth_method TEXT NOT NULL DEFAULT 'key_secret',
      status TEXT NOT NULL DEFAULT 'connected',
      capabilities_json TEXT,
      schema_metadata_json TEXT,
      created_by TEXT,
      last_successful_connection TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, catalog_name)
    );

    CREATE TABLE IF NOT EXISTS federation_schemas (
      schema_id TEXT PRIMARY KEY,
      catalog_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      schema_name TEXT NOT NULL,
      metadata_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(catalog_id, schema_name)
    );

    CREATE TABLE IF NOT EXISTS federation_tables (
      table_id TEXT PRIMARY KEY,
      schema_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      schema_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      physical_location TEXT,
      format TEXT NOT NULL DEFAULT 'parquet',
      row_count_estimate INTEGER DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      metadata_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(catalog_id, schema_name, table_name)
    );

    CREATE TABLE IF NOT EXISTS federation_column_metadata (
      column_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      column_name TEXT NOT NULL,
      data_type TEXT NOT NULL,
      ordinal_position INTEGER DEFAULT 0,
      is_nullable INTEGER DEFAULT 1,
      stats_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS federation_query_history (
      query_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      user_id TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      rewritten_sql TEXT,
      engine_used TEXT NOT NULL DEFAULT 'DuckDBExecutor',
      execution_mode TEXT NOT NULL DEFAULT 'SINGLE_NODE_DUCKDB',
      join_strategy TEXT,
      catalogs_referenced TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      row_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      object_bytes_scanned INTEGER DEFAULT 0,
      relational_bytes_retrieved INTEGER DEFAULT 0,
      network_bytes_transferred INTEGER DEFAULT 0,
      peak_memory_bytes INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      on_demand_cost_usd REAL DEFAULT 0,
      cache_status TEXT DEFAULT 'MISS',
      is_cost_estimate INTEGER DEFAULT 0,
      explain_plan_json TEXT,
      error_message TEXT,
      failed_source TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS federation_execution_metrics (
      metric_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      catalog_id TEXT,
      catalog_name TEXT NOT NULL,
      schema_name TEXT,
      table_name TEXT,
      source_type TEXT NOT NULL,
      metric_category TEXT NOT NULL,
      bytes_scanned INTEGER DEFAULT 0,
      bytes_retrieved INTEGER DEFAULT 0,
      network_bytes INTEGER DEFAULT 0,
      rows_processed INTEGER DEFAULT 0,
      scan_duration_ms INTEGER DEFAULT 0,
      peak_memory_bytes INTEGER DEFAULT 0,
      pushed_predicates TEXT,
      pushed_projections TEXT,
      cache_status TEXT DEFAULT 'MISS',
      is_estimate INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS federation_audit_logs (
      audit_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      catalog_name TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      details_json TEXT,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS federation_access_policies (
      policy_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default_tenant',
      subject_id TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT 'user',
      catalog_name TEXT NOT NULL,
      schema_name TEXT DEFAULT '*',
      table_name TEXT DEFAULT '*',
      can_select INTEGER DEFAULT 1,
      can_explain INTEGER DEFAULT 1,
      can_manage INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, subject_id, catalog_name, schema_name, table_name)
    );
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS federation_access_policies;
    DROP TABLE IF EXISTS federation_audit_logs;
    DROP TABLE IF EXISTS federation_execution_metrics;
    DROP TABLE IF EXISTS federation_query_history;
    DROP TABLE IF EXISTS federation_column_metadata;
    DROP TABLE IF EXISTS federation_tables;
    DROP TABLE IF EXISTS federation_schemas;
    DROP TABLE IF EXISTS federation_catalogs;
    DROP TABLE IF EXISTS federation_connections;
  `);
};

exports._meta = {
  "version": 2
};

