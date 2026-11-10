const db = require('../src/db');
const {
    initFederationCatalogs,
    executeFederatedQuery,
    explainFederatedQuery,
    defaultRouter
} = require('../src/federation');

const benchUser = {
    user_id: 'bench-admin',
    email: 'admin@cloudobjectiq.com',
    role: 'admin',
    tenant_id: 'default_tenant'
};

async function runBenchmarks() {
    await db.initDatabase();
    await initFederationCatalogs();

    console.log('================================================================================');
    console.log('📊 CloudObjectIQ Cross-Source Federation — Benchmark & Scale Profiling');
    console.log('================================================================================\n');

    const scenarios = [
        {
            name: '1. Single-Source Query (Azure ADLS Gen2)',
            sql: `SELECT order_status, COUNT(*) AS cnt, SUM(quantity * unit_price) AS rev FROM azure_sales.sales.orders WHERE order_date >= '2025-01-01' GROUP BY order_status`
        },
        {
            name: '2. Two-Source Federated Join (ADLS Gen2 + AWS S3)',
            sql: `SELECT c.country, COUNT(o.order_id) AS orders, SUM(o.quantity * o.unit_price) AS rev FROM azure_sales.sales.orders o JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id WHERE o.order_date >= '2025-01-01' GROUP BY c.country`
        },
        {
            name: '3. Three-Source Federated Join (ADLS Gen2 + AWS S3 + MinIO)',
            sql: `SELECT c.country, p.category, COUNT(DISTINCT o.order_id) AS total_orders, SUM(o.quantity * o.unit_price) AS total_revenue FROM azure_sales.sales.orders o JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id JOIN minio_products.catalog.products p ON o.product_id = p.product_id WHERE o.order_date >= '2025-01-01' GROUP BY c.country, p.category ORDER BY total_revenue DESC`
        },
        {
            name: '4. Five-Source Enterprise Join (ADLS + S3 + MinIO + PostgreSQL + MySQL + Iceberg)',
            sql: `SELECT pg.country, mgr.territory, p.category, COUNT(DISTINCT o.order_id) AS orders, SUM(ms.stock_on_hand) AS stock, COUNT(DISTINCT ev.event_id) AS events FROM azure_sales.sales.orders o JOIN aws_customers.crm.customers s3c ON o.customer_id = s3c.customer_id JOIN pg_crm.public.customers pg ON s3c.customer_id = pg.customer_id JOIN pg_crm.public.account_managers mgr ON pg.manager_id = mgr.manager_id JOIN minio_products.catalog.products p ON o.product_id = p.product_id JOIN mysql_erp.inventory.stock ms ON o.product_id = ms.product_id AND o.warehouse_id = ms.warehouse_id LEFT JOIN aws_customers.iceberg.customer_events ev ON o.customer_id = ev.customer_id WHERE o.order_status = 'completed' GROUP BY pg.country, mgr.territory, p.category`
        }
    ];

    for (const sc of scenarios) {
        const withPush = await executeFederatedQuery({
            sql: sc.sql,
            user: benchUser,
            enablePushdown: true
        });
        const withoutPush = await executeFederatedQuery({
            sql: sc.sql,
            user: benchUser,
            enablePushdown: false
        });

        console.log(`▶ ${sc.name}`);
        console.log(`  - With Pushdown:    ${withPush.durationMs}ms | Object Scanned: ${withPush.telemetry.objectBytesScanned} B | Relational: ${withPush.telemetry.relationalBytesRetrieved} B | Cost: $${withPush.telemetry.onDemandCostUsd.toFixed(8)}`);
        console.log(`  - Without Pushdown: ${withoutPush.durationMs}ms | Object Scanned: ${withoutPush.telemetry.objectBytesScanned} B | Relational: ${withoutPush.telemetry.relationalBytesRetrieved} B | Cost: $${withoutPush.telemetry.onDemandCostUsd.toFixed(8)}`);
        const savedPct = withoutPush.telemetry.networkBytesTransferred > 0
            ? Math.round((1 - withPush.telemetry.networkBytesTransferred / withoutPush.telemetry.networkBytesTransferred) * 100)
            : 0;
        console.log(`  - Pushdown Bytes Reduction: ${savedPct}% | Join Strategy: ${withPush.telemetry.joinStrategy}\n`);
    }

    console.log('================================================================================');
    console.log('✅ Benchmark suite completed.');
    console.log('================================================================================');
}

if (require.main === module) {
    runBenchmarks().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runBenchmarks };

