const { runQuery } = require('./src/query/engine');
require('dotenv').config();

async function test() {
    // This target ID and user ID should exist in the local enterprise.db
    const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
    const userId = 'e434041d-95a0-4811-9a7a-c77d4dd68d07'; 
    
    // ORC trigger
    const sql = "SELECT * FROM read_orc('az://inseekdata/orcdata/part-00000-43c63acf-d5c6-4101-b40b-7a0536d295a2-c000.snappy.orc') LIMIT 1;";
    
    try {
        console.log(`📡 Triggering Spark via ORC query...`);
        const rows = await runQuery(userId, sql, targetId);
        console.log('✅ Result:', rows);
    } catch (err) {
        console.error('❌ Interaction Failed:', err.message);
    }
}

test();
