const { listFiles } = require('./src/drivers/storage');

async function test() {
    const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
    try {
        console.log(`📡 Listing files for: Azuredatalakestorage1 (${targetId})`);
        const files = await listFiles(targetId);
        console.log('✅ Found files:', files.length);
    } catch (err) {
        console.error('❌ Error listing files:', err.message);
    }
}

test();
