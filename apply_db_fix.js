const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');

const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
const newEndpoint = 'DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net';

db.prepare('UPDATE targets SET endpoint = ? WHERE target_id = ?').run(newEndpoint, targetId);

console.log('✅ Updated Azuredatalakestorage1 endpoint.');

db.prepare("UPDATE targets SET endpoint = ? WHERE target_name = 'ADLS Primary Lake' OR target_name = 'Azure Cloud Target'").run(newEndpoint);
console.log('✅ Updated other Azure targets to use inseeksadls account.');
