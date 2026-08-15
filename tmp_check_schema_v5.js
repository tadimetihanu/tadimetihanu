const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function check() {
    console.log('--- START ---');
    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/inventory.parquet'", (err, res) => {
        if (err) console.log('ERR1:' + err.message);
        else res.forEach(col => console.log('INV_COL:' + col.column_name));
        r();
    }));

    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/ingestion_1772344536419.csv'", (err, res) => {
        if (err) console.log('ERR2:' + err.message);
        else res.forEach(col => console.log('ING_COL:' + col.column_name));
        r();
    }));
    console.log('--- END ---');
}
check();
