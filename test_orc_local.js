const { runQuery } = require('./src/query/engine');

async function main() {
    try {
        console.log('Testing ORC Query with SET extension_directory...');
        const sql = `
            INSTALL orc;
            LOAD orc;
            SELECT * FROM read_orc('s3://datalake/performance_1m.orc') LIMIT 5;
        `;
        const results = await runQuery('admin', sql, '81d80fa7-4520-4157-91d7-05a47ce5b2c1');
        console.log('✅ Query succeeded!');
        console.table(results);
    } catch (e) {
        console.error('❌ Query failed:', e.message);
    }
}

main();
