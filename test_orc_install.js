const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

conn.run('INSTALL orc;', (err) => {
    if (err) {
        console.error('❌ INSTALL FAILED:', err.message);
    } else {
        console.log('✅ INSTALL SUCCESS');
        conn.run('LOAD orc;', (err2) => {
            if (err2) console.error('❌ LOAD FAILED:', err2.message);
            else console.log('✅ LOAD SUCCESS');
        });
    }
});
