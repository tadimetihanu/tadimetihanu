'use strict';

exports.up = function(db) {
  return db.runSql(`
    ALTER TABLE users ADD COLUMN oauth_id TEXT;
    ALTER TABLE users ADD COLUMN oauth_provider TEXT;
    ALTER TABLE users ADD COLUMN display_name TEXT;
    ALTER TABLE users ADD COLUMN refresh_token TEXT;
  `);
};

exports.down = function(db) {
  // SQLite doesn't easily support dropping columns in older versions,
  // but better-sqlite3 handles it in newer sqlite versions.
  // We'll leave it as a no-op for simplicity.
  return Promise.resolve();
};

exports._meta = {
  "version": 1
};
