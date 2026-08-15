const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const azureTargets = db.prepare("SELECT * FROM targets WHERE provider_type = 'azure' OR provider_type = 'adls'").all();
console.log('AZURE TARGETS:', JSON.stringify(azureTargets, null, 2));
const allTargets = db.prepare("SELECT target_name, provider_type, is_active FROM targets").all();
console.log('ALL TARGETS:', JSON.stringify(allTargets, null, 2));
const users = db.prepare("SELECT email, role FROM users").all();
console.log('USERS:', JSON.stringify(users, null, 2));
