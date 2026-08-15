const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));
for (const table of tables) {
    console.log(`\nSchema for ${table.name}:`);
    const info = db.prepare(`PRAGMA table_info(${table.name})`).all();
    console.log(JSON.stringify(info, null, 2));
}
db.close();
