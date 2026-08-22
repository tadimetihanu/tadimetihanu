const { runQuery } = require('./src/query/engine');
const Database = require('better-sqlite3');

async function test() {
    const metaDb = new Database('./data/metadata.db');
    const target = metaDb.prepare("SELECT * FROM targets WHERE provider_type = 'minio'").get();
    const admin = metaDb.prepare("SELECT * FROM users WHERE email = 'admin@cloudobjectiq.com'").get();

    console.log('Using Target:', target.target_name, `(${target.target_id})`);

    console.log('\n--- 1. Querying Parquet Sales Data from S3/MinIO ---');
    const sql1 = "SELECT category, COUNT(*) as order_count, ROUND(AVG(amount), 2) as avg_order_val, ROUND(SUM(amount), 2) as total_rev FROM read_parquet('s3://datalake/sales_data.parquet') GROUP BY category ORDER BY total_rev DESC";
    const res1 = await runQuery(admin.user_id, sql1, target.target_id);
    console.table(res1);

    console.log('\n--- 2. Querying CSV Customers Data from S3/MinIO ---');
    const sql2 = "SELECT customer_id, name, email, region, credit_limit FROM read_csv_auto('s3://datalake/customers.csv') LIMIT 5";
    const res2 = await runQuery(admin.user_id, sql2, target.target_id);
    console.table(res2);

    console.log('\n--- 3. JOIN Query between Parquet & CSV ---');
    const sql3 = `
        SELECT 
            c.region,
            COUNT(s.order_id) as total_orders,
            ROUND(SUM(s.amount), 2) as regional_revenue
        FROM read_parquet('s3://datalake/sales_data.parquet') s
        JOIN read_csv_auto('s3://datalake/customers.csv') c ON s.customer_id = c.customer_id
        GROUP BY c.region
        ORDER BY regional_revenue DESC
    `;
    const res3 = await runQuery(admin.user_id, sql3, target.target_id);
    console.table(res3);

    console.log('\n🎉 ALL LOCAL DUCKDB + MINIO QUERIES EXECUTED SUCCESSFULLY!');
}

test().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
