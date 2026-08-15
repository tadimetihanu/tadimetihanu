const { uploadFile, getTarget } = require('./src/drivers/storage');
const fs = require('fs');
const path = require('path');

async function upload() {
    const filePath = path.join(__dirname, 'data/real_estate_market_trends.csv');
    const fileContent = fs.readFileSync(filePath);
    
    // Find MinIO target ID
    const Database = require('better-sqlite3');
    const db = new Database('./data/metadata.db');
    const target = db.prepare("SELECT target_id FROM targets WHERE provider_type = 'minio' AND endpoint LIKE '%:9010%'").get();
    
    if (!target) {
        console.error('MinIO Target not found');
        return;
    }
    
    console.log(`🚀 Uploading real_estate_market_trends.csv to MinIO target ${target.target_id}...`);
    
    try {
        await uploadFile(target.target_id, 'real_estate_market_trends.csv', fileContent, 'text/csv');
        console.log('✅ Upload successful!');
    } catch (err) {
        console.error('❌ Upload failed:', err);
    }
}

upload();
