const duckdb = require('duckdb');
const path = require('path');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const files = [
    'data/gcs_raw_events.parquet',
    'data/annual_finance_report_2025.csv'
];

async function check() {
    for (const f of files) {
        console.log(`\n--- Schema for: ${f} ---`);
        await new Promise((resolve) => {
            conn.all(`DESCRIBE SELECT * FROM "${f}"`, (err, res) => {
                if (err) console.error(err.message);
                else console.table(res.map(r => ({ column: r.column_name, type: r.column_type })));
                resolve();
            });
        });
    }
}

check();
