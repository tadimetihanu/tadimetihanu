const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const files = [
    'data/gcs_raw_events.parquet',
    'data/annual_finance_report_2025.csv'
];

async function check() {
    for (const f of files) {
        process.stdout.write(`\n--- ${f} --- \n`);
        await new Promise((resolve) => {
            conn.all(`DESCRIBE SELECT * FROM "${f}"`, (err, res) => {
                if (err) process.stdout.write(err.message + '\n');
                else res.forEach(r => process.stdout.write(r.column_name + ' (' + r.column_type + ')\n'));
                resolve();
            });
        });
    }
}

check();
