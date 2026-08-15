const { runQuery } = require('./src/query/engine');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a';
    const sql = `SELECT * FROM glob('az://inseeksadls/*')`;
    console.log(`Listing containers for inseeksadls...`);
    
    try {
        const results = await runQuery('admin_id', sql, targetId);
        console.log(`✅ Found:`);
        console.table(results);
    } catch (err) {
        console.error(`❌ Failed: ${err.message}`);
    }
    process.exit();
}

test();
