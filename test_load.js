const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();
const sql = 'INSTALL httpfs; LOAD httpfs; INSTALL azure; LOAD azure;';
conn.run(sql, (err) => {
    if (err) {
        console.error('❌ FAILED TO LOAD:', err.message);
    } else {
        console.log('✅ EXTENSIONS LOADED SUCCESSFULLY');
    }
    process.exit(0);
});
