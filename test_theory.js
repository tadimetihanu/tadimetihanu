const { runQuery } = require('./src/query/engine');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a';
    
    // Test 1: az://inseekdata/...
    const sql1 = `SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') LIMIT 5`;
    console.log(`Testing path: az://inseekdata/csvdata/supermarket_sales.csv`);
    
    try {
        const results1 = await runQuery('admin_id', sql1, targetId);
        console.log(`✅ SUCCESS with inseekdata container!`);
        console.table(results1);
    } catch (err) {
        console.error(`❌ inseekdata failed: ${err.message}`);
    }

    // Test 2: az://datainseektech/...
    const sql2 = `SELECT * FROM read_csv_auto('az://datainseektech/csvdata/supermarket_sales.csv') LIMIT 5`;
    console.log(`\nTesting path: az://datainseektech/csvdata/supermarket_sales.csv`);
    try {
        const results2 = await runQuery('admin_id', sql2, targetId);
        console.log(`✅ SUCCESS with datainseektech container!`);
        console.table(results2);
    } catch (err) {
        console.error(`❌ datainseektech failed: ${err.message}`);
    }

    process.exit();
}

test();
