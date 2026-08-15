const db = require('better-sqlite3')('data/metadata.db');

try {
    console.log("Adding columns to users table...");
    db.prepare('ALTER TABLE users ADD COLUMN oauth_provider TEXT').run();
    db.prepare('ALTER TABLE users ADD COLUMN oauth_id TEXT').run();
    db.prepare('ALTER TABLE users ADD COLUMN display_name TEXT').run();
    db.prepare('ALTER TABLE users ADD COLUMN refresh_token TEXT').run();
    console.log("Migration successful!");
} catch (err) {
    console.error("Migration failed or columns already exist:", err.message);
}
