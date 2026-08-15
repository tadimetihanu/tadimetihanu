const db = require('./node_modules/better-sqlite3')('./data/metadata.db');

db.prepare(`
    UPDATE targets 
    SET bucket = 'parquetdata'
    WHERE target_name = 'Azuredatalakestorage1'
`).run();

console.log("✅ Azuredatalakestorage1 default bucket set to 'parquetdata'.");
