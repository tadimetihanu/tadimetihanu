const { runQuery } = require('./src/query/engine');

async function test() {
    const userId = 'e434041d-95a0-4811-9a7a-c77d4dd68d07'; // Admin
    
    // Test Target 1: Azuredatalakestorage1 (inseeksadls)
    const t1 = '28e0979b-53ef-47ba-be22-9942fc54999e';
    const q1 = "SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') LIMIT 1";
    
    // Test Target 2: Azure CloudObject (datainseek)
    const t2 = '4344bf75-da2b-4afe-bfd7-c5f624e2ef86';
    const q2 = "SELECT * FROM read_csv_auto('az://datainseektech/ingestion_1772342036579.csv') LIMIT 1";

    try {
        console.log('--- Testing Target 1 (inseeksadls) ---');
        const r1 = await runQuery(userId, q1, t1);
        console.log('✅ Target 1 Success:', r1.length > 0);

        console.log('--- Testing Target 2 (datainseek) ---');
        const r2 = await runQuery(userId, q2, t2);
        console.log('✅ Target 2 Success:', r2.length > 0);
        
    } catch (err) {
        console.error('❌ Test Failed:', err.message);
    }
}

test();
