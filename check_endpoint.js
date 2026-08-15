const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const row = db.prepare("SELECT endpoint FROM targets WHERE target_name = 'azureblob1'").get();
console.log('ENDPOINT:', row.endpoint);
