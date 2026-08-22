'use strict';

var dbm;
var type;
var seed;

/**
  * We receive the dbmigrate dependency from dbmigrate initially.
  * This enables us to not have to rely on NODE_PATH.
  */
exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      oauth_provider TEXT,
      oauth_id TEXT,
      display_name TEXT,
      refresh_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE user_groups (
      user_id TEXT,
      group_id TEXT,
      PRIMARY KEY (user_id, group_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
    );

    CREATE TABLE targets (
      target_id TEXT PRIMARY KEY,
      target_name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      endpoint TEXT,
      bucket TEXT,
      access_key TEXT,
      secret_key TEXT,
      region TEXT DEFAULT 'us-east-1',
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE permissions (
      permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      can_read INTEGER DEFAULT 1,
      can_write INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE
    );

    CREATE TABLE file_config (
      target_id TEXT PRIMARY KEY,
      allowed_formats TEXT DEFAULT '.parquet,.csv,.json',
      max_file_size_mb INTEGER DEFAULT 500,
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE
    );

    CREATE TABLE query_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      target_id TEXT,
      query_text TEXT NOT NULL,
      row_count INTEGER,
      execution_time_ms INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'success'
    );
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS query_logs;
    DROP TABLE IF EXISTS file_config;
    DROP TABLE IF EXISTS permissions;
    DROP TABLE IF EXISTS targets;
    DROP TABLE IF EXISTS user_groups;
    DROP TABLE IF EXISTS groups;
    DROP TABLE IF EXISTS users;
  `);
};

exports._meta = {
  "version": 1
};
