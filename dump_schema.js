const db = require('better-sqlite3')('data/metadata.db');
const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
console.log(table.sql);
