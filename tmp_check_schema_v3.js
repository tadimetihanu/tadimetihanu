const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function check() {
    console.log('--- gcs_raw_events.parquet ---');
    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/gcs_raw_events.parquet'", (err, res) => {
        if (err) console.log(err.message);
        else res.forEach(col => console.log(col.column_name));
        r();
    }));

    console.log('\n--- annual_finance_report_2025.csv ---');
    await new Promise(r => conn.all("DESCRIBE SELECT * FROM 'data/annual_finance_report_2025.csv'", (err, res) => {
        if (err) console.log(err.message);
        else res.forEach(col => console.log(col.column_name));
        r();
    }));
}
check();
