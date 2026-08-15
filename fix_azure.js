const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target_name = 'azureblob1';
const row = db.prepare("SELECT endpoint FROM targets WHERE target_name = ?").get(target_name);
if (row) {
    let newEndpoint = row.endpoint;
    if (newEndpoint.includes('==EndpointSuffix')) {
        newEndpoint = newEndpoint.replace('==EndpointSuffix', '==;EndpointSuffix');
    }
    if (newEndpoint.includes('AccountName=test')) {
        newEndpoint = newEndpoint.replace('AccountName=test', 'AccountName=datainseek');
    }
    
    if (newEndpoint !== row.endpoint) {
        db.prepare("UPDATE targets SET endpoint = ? WHERE target_name = ?").run(newEndpoint, target_name);
        console.log('✅ FIXED: updated endpoint syntax and account name');
    } else {
        console.log('ℹ️ Already fixed or pattern not found');
    }
} else {
    console.log('❌ Target not found');
}
