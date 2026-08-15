const { uploadFile } = require('./src/drivers/storage');
const fs = require('fs');

async function run() {
    const filePath = 'D:\\c-downloads\\supermarket_sales.csv';
    if (!fs.existsSync(filePath)) {
        console.error('Source file not found at D:\\c-downloads\\supermarket_sales.csv');
        return;
    }
    const fileContent = fs.readFileSync(filePath);
    const targetId = '08074d76-ba29-47de-a88f-650a074ff7ba'; // azureblob1

    console.log('🚀 Uploading supermarket_sales.csv to azureblob1...');
    try {
        await uploadFile(targetId, 'csvdata/supermarket_sales.csv', fileContent, 'text/csv');
        console.log('✅ Upload successful!');
    } catch (e) {
        console.error('❌ Upload failed:', e.message);
    }
}

run();
