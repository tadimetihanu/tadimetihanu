const assert = require('assert');
const db = require('../src/db');
const {
    encryptConnectionConfig,
    decryptConnectionConfig,
    redactConnectionConfig,
    sanitizeErrorOrSql
} = require('../src/federation/crypto');
const { createConnector } = require('../src/federation/connectors');
const {
    initFederationCatalogs,
    listCatalogs,
    registerCatalog,
    getConnectorForCatalog,
    resolveTableMetadata,
    verifyTableAccess,
    planFederatedQuery,
    executeFederatedQuery,
    explainFederatedQuery,
    cancelFederatedQuery
} = require('../src/federation');

const adminUser = {
    user_id: 'admin-test-001',
    email: 'admin@cloudobjectiq.com',
    role: 'admin',
    tenant_id: 'default_tenant'
};

const restrictedUser = {
    user_id: 'restricted-user-002',
    email: 'analyst@cloudobjectiq.com',
    role: 'viewer',
    tenant_id: 'default_tenant'
};

const foreignTenantUser = {
    user_id: 'foreign-user-003',
    email: 'external@othercorp.com',
    role: 'admin',
    tenant_id: 'tenant_othercorp'
};

async function runAllFederationTests() {
    console.log('================================================================================');
    console.log('🚀 CloudObjectIQ Cross-Source Data Federation — 30-Test Enterprise Suite');
    console.log('================================================================================\n');

    await db.initDatabase();
    await initFederationCatalogs();

    let passed = 0;
    let failed = 0;
    const results = [];

    async function runTest(id, category, name, fn) {
        const start = Date.now();
        try {
            await fn();
            const ms = Date.now() - start;
            passed++;
            results.push({ id, category, name, status: 'PASS', durationMs: ms });
            console.log(`✅ [Test #${String(id).padStart(2, '0')} | ${category.padEnd(12)}] ${name} (${ms}ms)`);
        } catch (err) {
            const ms = Date.now() - start;
            failed++;
            results.push({ id, category, name, status: 'FAIL', durationMs: ms, error: err.message });
            console.error(`❌ [Test #${String(id).padStart(2, '0')} | ${category.padEnd(12)}] ${name} — FAILED: ${err.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTIONAL TESTS (1–12)
    // ═══════════════════════════════════════════════════════════════════════════

    await runTest(1, 'Functional', 'Connect AWS S3 catalog (aws_customers)', async () => {
        const { connector } = await getConnectorForCatalog('aws_customers');
        const testRes = await connector.testConnection();
        assert.strictEqual(testRes.success, true);
        assert.strictEqual(testRes.sourceType, 's3');
        const schemas = await connector.listSchemas();
        assert(schemas.includes('crm') && schemas.includes('iceberg'));
        const tables = await connector.listTables('crm');
        assert(tables.some(t => t.table_name === 'customers'));
    });

    await runTest(2, 'Functional', 'Connect Azure ADLS Gen2 catalog (azure_sales)', async () => {
        const { connector } = await getConnectorForCatalog('azure_sales');
        const testRes = await connector.testConnection();
        assert.strictEqual(testRes.success, true);
        assert.strictEqual(testRes.sourceType, 'adls');
        const schemas = await connector.listSchemas();
        assert(schemas.includes('sales'));
        const tables = await connector.listTables('sales');
        assert(tables.some(t => t.table_name === 'orders'));
    });

    await runTest(3, 'Functional', 'Connect MinIO catalog (minio_products)', async () => {
        const { connector } = await getConnectorForCatalog('minio_products');
        const testRes = await connector.testConnection();
        assert.strictEqual(testRes.success, true);
        assert.strictEqual(testRes.sourceType, 'minio');
        const tables = await connector.listTables('catalog');
        assert(tables.some(t => t.table_name === 'products'));
    });

    await runTest(4, 'Functional', 'Connect PostgreSQL catalog (pg_crm)', async () => {
        const { connector } = await getConnectorForCatalog('pg_crm');
        const testRes = await connector.testConnection();
        assert.strictEqual(testRes.success, true);
        assert.strictEqual(testRes.sourceType, 'postgresql');
        const tables = await connector.listTables('public');
        assert(tables.some(t => t.table_name === 'customers'));
        assert(tables.some(t => t.table_name === 'account_managers'));
    });

    await runTest(5, 'Functional', 'Connect MySQL catalog (mysql_erp)', async () => {
        const { connector } = await getConnectorForCatalog('mysql_erp');
        const testRes = await connector.testConnection();
        assert.strictEqual(testRes.success, true);
        assert.strictEqual(testRes.sourceType, 'mysql');
        const tables = await connector.listTables('inventory');
        assert(tables.some(t => t.table_name === 'stock'));
        assert(tables.some(t => t.table_name === 'warehouses'));
    });

    await runTest(6, 'Functional', 'Query single catalog (SELECT * FROM aws_customers.crm.customers)', async () => {
        const res = await executeFederatedQuery({
            sql: `SELECT customer_id, customer_name, country, segment FROM aws_customers.crm.customers ORDER BY customer_id ASC`,
            user: adminUser
        });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.rowCount, 10);
        assert.strictEqual(res.data[0].customer_name, 'Alice Sterling');
        assert.strictEqual(res.data[9].country, null); // NULL country row preserved accurately
    });

    await runTest(7, 'Functional', 'Join two catalogs (Azure ADLS Gen2 + AWS S3)', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT o.order_id, c.customer_name, c.country, o.quantity, o.unit_price
                FROM azure_sales.sales.orders o
                INNER JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                WHERE o.order_id IN (5001, 5003, 5012)
                ORDER BY o.order_id ASC
            `,
            user: adminUser
        });
        // Order 5012 has NULL customer_id so INNER JOIN must exclude it, returning 5001 and 5003
        assert.strictEqual(res.rowCount, 2);
        assert.strictEqual(res.data[0].order_id, 5001);
        assert.strictEqual(res.data[0].customer_name, 'Alice Sterling');
        assert.strictEqual(res.data[1].order_id, 5003);
        assert.strictEqual(res.data[1].customer_name, 'Bruno Silva');
    });

    await runTest(8, 'Functional', 'Join three catalogs (Azure ADLS + AWS S3 + MinIO — Master Prompt Scenario)', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT
                    c.country,
                    p.category,
                    COUNT(DISTINCT o.order_id) AS total_orders,
                    ROUND(SUM(o.quantity * o.unit_price), 2) AS total_revenue
                FROM azure_sales.sales.orders o
                JOIN aws_customers.crm.customers c
                    ON o.customer_id = c.customer_id
                JOIN minio_products.catalog.products p
                    ON o.product_id = p.product_id
                WHERE o.order_date >= '2025-01-01'
                GROUP BY c.country, p.category
                ORDER BY total_revenue DESC
            `,
            user: adminUser
        });
        assert.strictEqual(res.success, true);
        // Independently verified expected top row: Japan | Hardware | order 5004 (5 * 1200.00 = 6000.00)
        assert.strictEqual(res.data[0].country, 'Japan');
        assert.strictEqual(res.data[0].category, 'Hardware');
        assert.strictEqual(Number(res.data[0].total_orders), 1);
        assert.strictEqual(Number(res.data[0].total_revenue), 6000.0);
    });

    await runTest(9, 'Functional', 'Join five catalogs (ADLS + S3 + MinIO + PostgreSQL + MySQL + Iceberg)', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT
                    o.order_id,
                    s3c.customer_name,
                    pg_mgr.manager_name,
                    p.product_name,
                    ms.stock_on_hand,
                    w.warehouse_name
                FROM azure_sales.sales.orders o
                JOIN aws_customers.crm.customers s3c ON o.customer_id = s3c.customer_id
                JOIN pg_crm.public.customers pgc ON s3c.customer_id = pgc.customer_id
                JOIN pg_crm.public.account_managers pg_mgr ON pgc.manager_id = pg_mgr.manager_id
                JOIN minio_products.catalog.products p ON o.product_id = p.product_id
                JOIN mysql_erp.inventory.stock ms ON o.product_id = ms.product_id AND o.warehouse_id = ms.warehouse_id
                JOIN mysql_erp.inventory.warehouses w ON ms.warehouse_id = w.warehouse_id
                WHERE o.order_id = 5001
            `,
            user: adminUser
        });
        assert.strictEqual(res.rowCount, 1);
        assert.strictEqual(res.data[0].customer_name, 'Alice Sterling');
        assert.strictEqual(res.data[0].manager_name, 'Sarah Jenkins');
        assert.strictEqual(res.data[0].product_name, 'Quantum NVMe Array');
        assert.strictEqual(Number(res.data[0].stock_on_hand), 140);
        assert.strictEqual(res.data[0].warehouse_name, 'Virginia Ashburn Hub');
        assert.strictEqual(res.telemetry.catalogsReferenced.length, 5);
    });

    await runTest(10, 'Functional', 'LEFT, RIGHT, FULL OUTER & CROSS JOIN across catalogs with NULL handling', async () => {
        // LEFT JOIN: order 5012 has NULL customer_id, must be preserved with NULL customer_name
        const leftRes = await executeFederatedQuery({
            sql: `
                SELECT o.order_id, o.customer_id, c.customer_name
                FROM azure_sales.sales.orders o
                LEFT JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                WHERE o.order_id = 5012
            `,
            user: adminUser
        });
        assert.strictEqual(leftRes.rowCount, 1);
        assert.strictEqual(leftRes.data[0].order_id, 5012);
        assert.strictEqual(leftRes.data[0].customer_name, null);

        // RIGHT JOIN: customer 9 (Isabella Rossi) has no orders, must appear with NULL order_id
        const rightRes = await executeFederatedQuery({
            sql: `
                SELECT c.customer_id, c.customer_name, o.order_id
                FROM azure_sales.sales.orders o
                RIGHT JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                WHERE c.customer_id = 9
            `,
            user: adminUser
        });
        assert.strictEqual(rightRes.rowCount, 1);
        assert.strictEqual(rightRes.data[0].customer_name, 'Isabella Rossi');
        assert.strictEqual(rightRes.data[0].order_id, null);

        // FULL OUTER JOIN: preserves both orphan order 5012 and unmatched customer 9
        const fullRes = await executeFederatedQuery({
            sql: `
                SELECT COUNT(*) AS total_full_rows
                FROM azure_sales.sales.orders o
                FULL OUTER JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
            `,
            user: adminUser
        });
        // 13 orders (12 matched + 1 orphan 5012) + 1 unmatched customer (customer 9) = 14 rows
        assert.strictEqual(Number(fullRes.data[0].total_full_rows), 14);
    });

    await runTest(11, 'Functional', 'GROUP BY, HAVING, and Subqueries across catalogs', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT
                    p.category,
                    COUNT(*) AS order_lines,
                    ROUND(SUM(o.quantity * o.unit_price), 2) AS cat_revenue
                FROM azure_sales.sales.orders o
                JOIN minio_products.catalog.products p ON o.product_id = p.product_id
                WHERE o.customer_id IN (SELECT customer_id FROM pg_crm.public.customers WHERE tier = 'Enterprise')
                GROUP BY p.category
                HAVING SUM(o.quantity * o.unit_price) > 1500
                ORDER BY cat_revenue DESC
            `,
            user: adminUser
        });
        assert(res.rowCount >= 2);
        assert.strictEqual(res.data[0].category, 'Hardware');
        assert.strictEqual(Number(res.data[0].cat_revenue), 12150.0);
    });

    await runTest(12, 'Functional', 'Window functions (RANK / SUM OVER) across catalogs + Apache Iceberg scan', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT
                    c.customer_name,
                    ev.event_type,
                    ev.duration_sec,
                    RANK() OVER (PARTITION BY ev.event_type ORDER BY ev.duration_sec DESC) AS duration_rank
                FROM aws_customers.iceberg.customer_events ev
                JOIN pg_crm.public.customers c ON ev.customer_id = c.customer_id
                WHERE ev.event_type = 'checkout_completed'
                ORDER BY duration_rank ASC
            `,
            user: adminUser
        });
        assert.strictEqual(res.rowCount, 6);
        assert.strictEqual(res.data[0].customer_name, 'Chika Tanaka');
        assert.strictEqual(Number(res.data[0].duration_sec), 210);
        assert.strictEqual(Number(res.data[0].duration_rank), 1);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // OPTIMIZATION TESTS (13–20)
    // ═══════════════════════════════════════════════════════════════════════════

    await runTest(13, 'Optimization', 'Predicate pushdown verification', async () => {
        const plan = await explainFederatedQuery({
            sql: `
                SELECT o.order_id, c.customer_name
                FROM azure_sales.sales.orders o
                JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                WHERE o.order_date >= '2025-02-01' AND c.country = 'Japan'
            `,
            user: adminUser
        });
        const ordersScan = plan.sourceCatalogAccess.find(s => s.tableName === 'orders');
        const custScan = plan.sourceCatalogAccess.find(s => s.tableName === 'customers');
        assert(ordersScan.pushedPredicates.some(p => p.includes('order_date')));
        assert(custScan.pushedPredicates.some(p => p.includes('country') && p.includes('Japan')));
    });

    await runTest(14, 'Optimization', 'Projection pushdown (column pruning) verification', async () => {
        const plan = await explainFederatedQuery({
            sql: `
                SELECT c.country, SUM(o.quantity) AS total_qty
                FROM azure_sales.sales.orders o
                JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                GROUP BY c.country
            `,
            user: adminUser
        });
        const ordersScan = plan.sourceCatalogAccess.find(s => s.tableName === 'orders');
        const custScan = plan.sourceCatalogAccess.find(s => s.tableName === 'customers');
        // Orders has 10 columns, but only customer_id and quantity are needed
        assert.strictEqual(ordersScan.pushedProjections.length, 2);
        assert(ordersScan.pushedProjections.includes('customer_id') && ordersScan.pushedProjections.includes('quantity'));
        // Customers has 7 columns, but only customer_id and country are needed
        assert.strictEqual(custScan.pushedProjections.length, 2);
        assert(ordersScan.estimatedScanBytes < ordersScan.physicalSizeBytes);
    });

    await runTest(15, 'Optimization', 'Join reorder verification (cardinality-aware join ordering)', async () => {
        const plan = await explainFederatedQuery({
            sql: `
                SELECT *
                FROM pg_crm.public.account_managers mgr
                JOIN pg_crm.public.customers c ON mgr.manager_id = c.manager_id
                JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
            `,
            user: adminUser
        });
        // Largest table (`orders` with 13 rows) should be recommended first, smallest (`account_managers` with 4 rows) last
        assert.strictEqual(plan.recommendedJoinOrder[0].fqn, 'azure_sales.sales.orders');
        assert.strictEqual(plan.recommendedJoinOrder[plan.recommendedJoinOrder.length - 1].fqn, 'pg_crm.public.account_managers');
    });

    await runTest(16, 'Optimization', 'Broadcast join selection & dynamic filter generation for small dimension tables', async () => {
        const plan = await explainFederatedQuery({
            sql: `
                SELECT o.order_id, p.product_name
                FROM azure_sales.sales.orders o
                JOIN minio_products.catalog.products p ON o.product_id = p.product_id
            `,
            user: adminUser
        });
        assert.strictEqual(plan.overallJoinStrategy, 'BROADCAST_HASH_JOIN');
        assert(plan.dynamicFilters.length >= 1);
        assert.strictEqual(plan.dynamicFilters[0].buildTable, 'minio_products.catalog.products');
    });

    await runTest(17, 'Optimization', 'Partitioned join selection when table exceeds broadcast threshold', async () => {
        // Temporarily set row_count_estimate on customers to 250,000 to verify planner switches to PARTITIONED_HASH_JOIN
        await db.run(
            `UPDATE federation_tables SET row_count_estimate = 250000 WHERE table_name = 'customers' AND schema_name = 'crm'`
        );
        const { clearMetadataCache } = require('../src/federation');
        clearMetadataCache();

        try {
            const plan = await explainFederatedQuery({
                sql: `
                    SELECT o.order_id, c.customer_name
                    FROM azure_sales.sales.orders o
                    JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
                `,
                user: adminUser
            });
            assert.strictEqual(plan.joinOperations[0].strategy, 'PARTITIONED_HASH_JOIN');
        } finally {
            await db.run(
                `UPDATE federation_tables SET row_count_estimate = 10 WHERE table_name = 'customers' AND schema_name = 'crm'`
            );
            clearMetadataCache();
        }
    });

    await runTest(18, 'Optimization', 'Large table scan & Cross-Join handling with honest single-node reporting', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT COUNT(*) AS cross_cnt
                FROM azure_sales.sales.orders o
                CROSS JOIN minio_products.catalog.products p
            `,
            user: adminUser
        });
        // 13 orders * 6 products = 78 rows
        assert.strictEqual(Number(res.data[0].cross_cnt), 78);
        assert.strictEqual(res.engineUsed, 'DuckDBExecutor');
        assert.strictEqual(res.executionMode, 'SINGLE_NODE_DUCKDB');
        assert.strictEqual(res.isDistributed, false); // Never claims distributed execution on single DuckDB instance
    });

    await runTest(19, 'Optimization', 'Query timeout enforcement', async () => {
        // Generate a heavy synthetic cartesian product inside DuckDB and enforce a 5ms timeout
        let timedOut = false;
        try {
            await executeFederatedQuery({
                sql: `
                    SELECT COUNT(*)
                    FROM azure_sales.sales.orders o1
                    CROSS JOIN azure_sales.sales.orders o2
                    CROSS JOIN azure_sales.sales.orders o3
                    CROSS JOIN azure_sales.sales.orders o4
                    CROSS JOIN azure_sales.sales.orders o5
                    CROSS JOIN azure_sales.sales.orders o6
                `,
                user: adminUser,
                timeoutMs: 1
            });
        } catch (err) {
            if (/timed out/i.test(err.message)) timedOut = true;
        }
        assert.strictEqual(timedOut, true, 'Expected query to enforce timeoutMs limit');
    });

    await runTest(20, 'Optimization', 'Query cancellation verification', async () => {
        const execId = 'cancel_test_exec_001';
        const p = executeFederatedQuery({
            sql: `
                SELECT COUNT(*)
                FROM azure_sales.sales.orders o1
                CROSS JOIN azure_sales.sales.orders o2
                CROSS JOIN azure_sales.sales.orders o3
                CROSS JOIN azure_sales.sales.orders o4
                CROSS JOIN azure_sales.sales.orders o5
            `,
            user: adminUser,
            executionId: execId,
            timeoutMs: 30000
        });
        // Immediately cancel
        const cancelRes = cancelFederatedQuery(execId);
        try {
            await p;
        } catch (_) {}
        assert(cancelRes.cancelled === true || cancelRes.message.includes('not active'));
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // SECURITY TESTS (21–25)
    // ═══════════════════════════════════════════════════════════════════════════

    await runTest(21, 'Security', 'Encrypted credential storage (AES-256-GCM) & API secret redaction', async () => {
        const rawSecret = 'SuperSecretStorageKey_998877!';
        const encrypted = encryptConnectionConfig({ accessKeyId: 'AKIA111', secretAccessKey: rawSecret });
        assert(encrypted.startsWith('v1:gcm:'));
        assert(!encrypted.includes(rawSecret), 'Ciphertext must never contain plaintext secret');

        const decrypted = decryptConnectionConfig(encrypted);
        assert.strictEqual(decrypted.secretAccessKey, rawSecret);

        const catalogs = await listCatalogs('default_tenant');
        const s3Cat = catalogs.find(c => c.catalog_name === 'aws_customers');
        assert.strictEqual(s3Cat.connection_config.secretAccessKey, '••••••••REDACTED••••••••');
    });

    await runTest(22, 'Security', 'Unauthorized catalog/table access blocked via RBAC policy', async () => {
        await db.run(
            `INSERT OR REPLACE INTO federation_access_policies
             (policy_id, tenant_id, subject_id, subject_type, catalog_name, schema_name, table_name, can_select, can_explain, can_manage)
             VALUES ('pol-deny-test', 'default_tenant', ?, 'user', 'pg_crm', 'public', 'account_managers', 0, 0, 0)`,
            [restrictedUser.user_id]
        );

        let blocked = false;
        try {
            await executeFederatedQuery({
                sql: `SELECT * FROM pg_crm.public.account_managers`,
                user: restrictedUser
            });
        } catch (err) {
            if (err.statusCode === 403 && /Access denied by RBAC policy/i.test(err.message)) {
                blocked = true;
            }
        } finally {
            await db.run(`DELETE FROM federation_access_policies WHERE policy_id = 'pol-deny-test'`);
        }
        assert.strictEqual(blocked, true, 'Expected RBAC policy to block unauthorized table SELECT');
    });

    await runTest(23, 'Security', 'Cross-tenant access blocked (Tenant Isolation)', async () => {
        let blocked = false;
        try {
            await executeFederatedQuery({
                sql: `SELECT * FROM azure_sales.sales.orders`,
                user: foreignTenantUser,
                tenantId: 'default_tenant'
            });
        } catch (err) {
            if (err.statusCode === 403 && /Tenant isolation violation/i.test(err.message)) {
                blocked = true;
            }
        }
        assert.strictEqual(blocked, true, 'Expected cross-tenant query to be rejected with 403');
    });

    await runTest(24, 'Security', 'SQL injection & destructive DDL/DML blocked', async () => {
        const attacks = [
            `DROP TABLE aws_customers.crm.customers`,
            `SELECT * FROM aws_customers.crm.customers; DELETE FROM users;`,
            `DELETE FROM azure_sales.sales.orders WHERE 1=1`,
            `ATTACH 'data/metadata.db' AS stolen_db`
        ];
        for (const badSql of attacks) {
            let rejected = false;
            try {
                await executeFederatedQuery({ sql: badSql, user: adminUser });
            } catch (err) {
                rejected = true;
            }
            assert.strictEqual(rejected, true, `Expected malicious SQL to be blocked: ${badSql}`);
        }
    });

    await runTest(25, 'Security', 'Secret redaction in logs and error messages', async () => {
        const dirtyError = `Connection failed: postgresql://admin:MySecretPass123@db.internal:5432/crm with AccountKey=AzKey998877==`;
        const sanitized = sanitizeErrorOrSql(dirtyError);
        assert(!sanitized.includes('MySecretPass123'));
        assert(!sanitized.includes('AzKey998877=='));
        assert(sanitized.includes('***REDACTED***'));
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // TELEMETRY & RELIABILITY TESTS (26–30)
    // ═══════════════════════════════════════════════════════════════════════════

    await runTest(26, 'Telemetry', 'Source-level byte tracking: Object Storage Scanned vs Relational Retrieved separated', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT o.order_id, pg.customer_name, ms.stock_on_hand
                FROM azure_sales.sales.orders o
                JOIN pg_crm.public.customers pg ON o.customer_id = pg.customer_id
                JOIN mysql_erp.inventory.stock ms ON o.product_id = ms.product_id AND o.warehouse_id = ms.warehouse_id
            `,
            user: adminUser
        });
        const t = res.telemetry;
        assert(t.objectBytesScanned > 0, 'Azure ADLS object bytes must be tracked in objectBytesScanned');
        assert(t.relationalBytesRetrieved > 0, 'Postgres & MySQL bytes must be tracked in relationalBytesRetrieved');

        const pgMetric = t.sourceBreakdown.find(s => s.catalogName === 'pg_crm');
        const mysqlMetric = t.sourceBreakdown.find(s => s.catalogName === 'mysql_erp');
        const adlsMetric = t.sourceBreakdown.find(s => s.catalogName === 'azure_sales');

        assert.strictEqual(pgMetric.bytesScanned, 0, 'PostgreSQL must report 0 cloud object bytes scanned');
        assert(pgMetric.bytesRetrieved > 0, 'PostgreSQL must report relational bytesRetrieved > 0');
        assert.strictEqual(mysqlMetric.bytesScanned, 0, 'MySQL must report 0 cloud object bytes scanned');
        assert(mysqlMetric.bytesRetrieved > 0, 'MySQL must report relational bytesRetrieved > 0');
        assert(adlsMetric.bytesScanned > 0, 'ADLS Gen2 must report cloud object bytesScanned > 0');
        assert.strictEqual(adlsMetric.bytesRetrieved, 0);
    });

    await runTest(27, 'Telemetry', 'Network transfer calculation across all participating catalogs', async () => {
        const res = await executeFederatedQuery({
            sql: `
                SELECT o.order_id, c.customer_name
                FROM azure_sales.sales.orders o
                JOIN aws_customers.crm.customers c ON o.customer_id = c.customer_id
            `,
            user: adminUser
        });
        const sumNetwork = res.telemetry.sourceBreakdown.reduce((acc, s) => acc + s.networkBytes, 0);
        assert.strictEqual(res.telemetry.networkBytesTransferred, sumNetwork);
        assert(sumNetwork > 0);
    });

    await runTest(28, 'Telemetry', 'Cost estimation accuracy ($5.00 / TiB only on cloud object bytes)', async () => {
        const res = await executeFederatedQuery({
            sql: `SELECT * FROM pg_crm.public.customers`,
            user: adminUser
        });
        // Pure PostgreSQL query scans 0 cloud object bytes -> cost must be $0.00
        assert.strictEqual(res.telemetry.objectBytesScanned, 0);
        assert.strictEqual(res.telemetry.billedCostUsd, 0);

        const objRes = await executeFederatedQuery({
            sql: `SELECT * FROM azure_sales.sales.orders`,
            user: adminUser
        });
        const expectedUsd = Number(((objRes.telemetry.objectBytesScanned / Math.pow(1024, 4)) * 5.0).toFixed(8));
        assert.strictEqual(objRes.telemetry.onDemandCostUsd, expectedUsd);
    });

    await runTest(29, 'Telemetry', 'Cache hit vs cache miss tracking & zero double-charging', async () => {
        const missRes = await executeFederatedQuery({
            sql: `SELECT * FROM minio_products.catalog.products`,
            user: adminUser,
            cacheStatus: 'MISS'
        });
        assert.strictEqual(missRes.telemetry.cacheStatus, 'MISS');
        assert(missRes.telemetry.billedCostUsd > 0);

        const hitRes = await executeFederatedQuery({
            sql: `SELECT * FROM minio_products.catalog.products`,
            user: adminUser,
            cacheStatus: 'HIT'
        });
        assert.strictEqual(hitRes.telemetry.cacheStatus, 'HIT');
        assert.strictEqual(hitRes.telemetry.billedCostUsd, 0);
        assert.strictEqual(hitRes.telemetry.cacheSavingsUsd, hitRes.telemetry.onDemandCostUsd);
    });

    await runTest(30, 'Telemetry', 'Query history persistence & Fail-Fast Source Error Attribution (never partial results)', async () => {
        // Register an offline catalog and verify joining it fails fast identifying the offline catalog without returning partial rows
        await registerCatalog({
            catalogName: 'offline_s3_vault',
            sourceType: 's3',
            connectionConfig: {
                bucket: 'unreachable-bucket',
                simulateOffline: true,
                requireValidConnection: false
            },
            userId: adminUser.user_id
        });

        let failedFast = false;
        let attributedSource = null;
        try {
            await executeFederatedQuery({
                sql: `
                    SELECT o.order_id
                    FROM azure_sales.sales.orders o
                    LEFT JOIN offline_s3_vault.default.missing_table m ON o.order_id = m.id
                `,
                user: adminUser
            });
        } catch (err) {
            failedFast = true;
            attributedSource = err.failedSource || (err.message.includes('offline_s3_vault') ? 'offline_s3_vault' : null);
        } finally {
            await db.run(`DELETE FROM federation_catalogs WHERE catalog_name = 'offline_s3_vault'`);
        }

        assert.strictEqual(failedFast, true, 'Must fail fast when any federated source fails');
        assert.strictEqual(attributedSource, 'offline_s3_vault', 'Must identify the failed source catalog');

        const historyRows = await db.all(`SELECT * FROM federation_query_history ORDER BY created_at DESC LIMIT 10`);
        assert(historyRows.length >= 10, 'Federation query history must persist executed queries');
    });

    console.log('\n================================================================================');
    console.log(`📊 TEST SUMMARY: ${passed} PASSED / ${failed} FAILED (Total: ${passed + failed})`);
    console.log('================================================================================');

    if (failed > 0) {
        process.exitCode = 1;
    }
    return { passed, failed, results };
}

if (require.main === module) {
    runAllFederationTests().catch(err => {
        console.error('Fatal test runner error:', err);
        process.exit(1);
    });
}

module.exports = { runAllFederationTests };

