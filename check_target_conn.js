const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare('SELECT endpoint FROM targets WHERE target_name = "Azuredatalakestorage1"').get();
console.log('ADLS ConnString:', target.endpoint);
db.close();
