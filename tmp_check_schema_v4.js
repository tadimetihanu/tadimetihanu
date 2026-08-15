const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function check() {
    console.log('--- START ---');
    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/gcs_raw_events.parquet'", (err, res) => {
        if (err) console.log('ERR1:' + err.message);
        else res.forEach(col => console.log('GCS_COL:' + col.column_name));
        r();
    }));

    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/annual_finance_report_2025.csv'", (err, res) => {
        if (err) console.log('ERR2:' + err.message);
        else res.forEach(col => console.log('CSV_COL:' + col.column_name));
        r();
    }));
    console.log('--- END ---');
}
check();
