const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const users = db.prepare('SELECT user_id FROM users').all();
const targets = db.prepare('SELECT target_id FROM targets').all();

const queries = [
    "SELECT * FROM 'az://inseekdata/orcdata/part-1.orc' LIMIT 1000",
    "SELECT category, SUM(price) FROM 'az://inseekdata/parquetdata/orders.parquet' GROUP BY 1",
    "SELECT COUNT(*) FROM 's3://datalake/events.parquet' WHERE status = 'error'",
    "SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') WHERE Total > 100",
    "SELECT date_trunc('day', timestamp), AVG(latency) FROM 'az://inseekdata/parquetdata/telemetry.parquet' GROUP BY 1"
];

db.transaction(() => {
    for (let i = 0; i < 50; i++) {
        const u = users[Math.floor(Math.random() * users.length)].user_id;
        const t = targets[Math.floor(Math.random() * targets.length)].target_id;
        const q = queries[Math.floor(Math.random() * queries.length)];
        const dur = Math.floor(Math.random() * 5000) + 100;
        const rows = Math.floor(Math.random() * 100000);
        const scan = Math.floor((rows * 1200) + (dur * 5000)) + (Math.random() * 50000000);
        const cost = (scan / (1024 * 1024 * 1024)) * 0.005;

        db.prepare(`
            INSERT INTO query_logs (user_id, target_id, query_text, row_count, execution_time_ms, status, data_scanned_bytes, calculated_cost_usd, timestamp)
            VALUES (?, ?, ?, ?, ?, 'success', ?, ?, datetime('now', '-${Math.floor(Math.random() * 10)} days'))
        `).run(u, t, q, rows, dur, scan, cost);
    }
})();

console.log('🌱 Seeded 50 burn records.');
