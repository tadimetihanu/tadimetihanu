const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const connStr = 'DefaultEndpointsProtocol=https;AccountName=hcdp;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net';

const targets = [
    {
        id: '28e0979b-53ef-47ba-be22-9942fc54999e',
        name: 'Azuredatalakestorage1',
        type: 'adls',
        bucket: 'inseekdata'
    },
    {
        id: '4344bf75-da2b-4afe-bfd7-c5f624e2ef86',
        name: 'Azure CloudObject',
        type: 'azure',
        bucket: 'datainseektech'
    }
];

try {
    for (const t of targets) {
        db.prepare(`
            INSERT OR REPLACE INTO targets (target_id, target_name, provider_type, endpoint, bucket, access_key, secret_key, region, is_active)
            VALUES (?, ?, ?, ?, ?, '', '', '', 1)
        `).run(t.id, t.name, t.type, connStr, t.bucket);
        console.log(`✅ Added/replaced target ${t.name} (${t.id})`);
    }
} catch (e) {
    console.error('❌ Failed:', e.message);
} finally {
    db.close();
}
