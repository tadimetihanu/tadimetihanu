const { runQuery } = require('./src/query/engine');

async function test() {
    const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
    const userId = 'e434041d-95a0-4811-9a7a-c77d4dd68d07'; // Admin
    // Path matched az://inseekdata/ (the bucket in the DB)
    const sql = "SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') LIMIT 5";
    
    try {
        console.log(`📡 Running query for: Azuredatalakestorage1 (${targetId})`);
        const rows = await runQuery(userId, sql, targetId);
        console.log('✅ Found rows:', rows.length);
    } catch (err) {
        console.error('❌ Query Failed:', err.message);
    }
}

test();
