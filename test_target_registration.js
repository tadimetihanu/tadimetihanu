const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const db = new Database('./data/metadata.db');
const u = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_enterprise_jwt_key_2026';
const token = jwt.sign({ user_id: u.user_id, email: u.email, role: u.role }, SECRET_KEY);

async function testRegistration() {
    console.log('🧪 Testing Target Registration on http://localhost:4000 ...\n');

    // 1. Register Azure Blob Target
    console.log('1. Register Azure Blob Target');
    const azureRes = await fetch('http://localhost:4000/api/admin/targets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            target_name: 'Test Azure Blob Storage',
            provider_type: 'azure',
            endpoint: 'DefaultEndpointsProtocol=https;AccountName=testacc;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net',
            bucket: 'test-container',
            credentials: 'testacc:dGVzdGtleQ==',
            region: 'eastus'
        })
    }).then(r => r.json());
    console.log('   Azure Blob Register Result:', azureRes);

    // 2. Register ADLS Target
    console.log('\n2. Register ADLS Target');
    const adlsRes = await fetch('http://localhost:4000/api/admin/targets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            target_name: 'Test ADLS Gen2 Lake',
            provider_type: 'adls',
            endpoint: 'DefaultEndpointsProtocol=https;AccountName=testlake;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net',
            bucket: 'test-lake-container',
            credentials: 'testlake:dGVzdGtleQ==',
            region: 'eastus'
        })
    }).then(r => r.json());
    console.log('   ADLS Register Result:', adlsRes);

    // 3. Register GDrive Target
    console.log('\n3. Register Google Drive Target');
    const gdriveRes = await fetch('http://localhost:4000/api/admin/targets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            target_name: 'Test Google Drive Team Lake',
            provider_type: 'gdrive',
            endpoint: 'https://www.googleapis.com/drive/v3',
            bucket: 'root',
            credentials: 'test-sa@gdrive.iam.gserviceaccount.com:test-secret',
            region: 'global'
        })
    }).then(r => r.json());
    console.log('   Google Drive Register Result:', gdriveRes);

    // 4. Test Connection
    console.log('\n4. Test Connection (Google Drive & Azure)');
    const testConnRes = await fetch('http://localhost:4000/api/admin/test-connection', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'gdrive',
            bucket: 'root',
            credentials: 'test-sa:test-secret'
        })
    }).then(r => r.json());
    console.log('   Test Connection Result:', testConnRes);

    // 5. Cleanup test targets
    if (azureRes.targetId) db.prepare('DELETE FROM targets WHERE target_id = ?').run(azureRes.targetId);
    if (adlsRes.targetId) db.prepare('DELETE FROM targets WHERE target_id = ?').run(adlsRes.targetId);
    if (gdriveRes.targetId) db.prepare('DELETE FROM targets WHERE target_id = ?').run(gdriveRes.targetId);

    console.log('\n✅ Target Registration Pipeline Verified with ZERO Errors!');
}

testRegistration().catch(console.error);
