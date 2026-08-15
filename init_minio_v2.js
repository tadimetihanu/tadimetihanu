const { uploadFile } = require('./src/drivers/storage');
const Database = require('better-sqlite3');
const fs = require('fs');

async function init() {
    const db = new Database('./data/metadata.db');
    const target = db.prepare("SELECT target_id FROM targets WHERE provider_type = 'minio'").get();
    if (!target) { console.error('No MinIO target'); return; }

    const files = [
        { name: 'iris.parquet', path: './data/iris.parquet' },
        { name: 'census_data.parquet', path: './data/census_data.parquet' }
    ];

    for (const f of files) {
        if (!fs.existsSync(f.path)) { console.warn(`Missing: ${f.path}`); continue; }
        console.log(`📡 Uploading ${f.name} to target ${target.target_id}...`);
        try {
            await uploadFile(target.target_id, f.name, fs.readFileSync(f.path), 'application/octet-stream');
            console.log(`✅ ${f.name} uploaded!`);
        } catch (e) {
            console.error(`❌ ${f.name} failed:`, e.message);
        }
    }
}
init();
