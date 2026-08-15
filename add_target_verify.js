const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
    db.prepare(`
        INSERT OR REPLACE INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region, is_active)
        VALUES ('fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a', 'Azure Cloud Target', 'azure', 'DefaultEndpointsProtocol=https;AccountName=hcdp;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net', 'test', '', '', '', 1)
    `).run();
    console.log('✅ Successfully added/replaced target fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a');
} catch (e) {
    console.error('❌ Failed:', e.message);
} finally {
    db.close();
}
