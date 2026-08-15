const { runQuery } = require('./src/query/engine');

async function test() {
    const targetId = 'fa6c1cf6-ab5c-4d0b-92ff-20b2a3350d6a';
    const containers = ['data', 'files', 'datasets', 'inseek', 'blob', 'public', 'private'];
    
    for (const c of containers) {
        try {
            const sql = `SELECT * FROM glob('az://inseeksadls/${c}/*')`;
            console.log(`Testing container: ${c}`);
            const results = await runQuery('admin_id', sql, targetId);
            if (results.length > 0) {
                console.log(`✅ Success with ${c}!`);
                console.table(results);
                return;
            }
        } catch (e) {
            console.log(`❌ ${c} failed: ${e.message.substring(0, 100)}`);
        }
    }
    process.exit();
}

test();
