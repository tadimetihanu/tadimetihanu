const { runQuery } = require('./src/query/engine');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a';
    try {
        const r = await runQuery('admin', "SELECT * FROM read_csv_auto('az://csvdata/supermarket_sales.csv') LIMIT 1", targetId);
        console.table(r);
    } catch (e) {
        console.error(`❌ csvdata failed: ${e.message}`);
    }
}

test();
