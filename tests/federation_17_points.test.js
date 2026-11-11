const assert = require('assert');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const db = require(path.join(repoRoot, 'src/db'));
const storage = require(path.join(repoRoot, 'src/drivers/storage'));
const engine = require(path.join(repoRoot, 'src/query/engine'));
const {
    deriveLogicalCoordinates,
    registerCatalogEntry,
    discoverParquetSchemaWithDuckDB,
    getCatalogTree,
    resolveFederatedSql
} = require(path.join(repoRoot, 'src/query/catalog_resolver'));

const { S3Client } = require('@aws-sdk/client-s3');
const { BlobServiceClient } = require('@azure/storage-blob');
const duckdb = require(path.join(repoRoot, 'node_modules/duckdb'));

async function run17PointFederationSuite() {
    console.log('================================================================');
    console.log('🚀 CLOUDOBJECTIQ CROSS-SOURCE FEDERATION: 17-POINT MASTER SUITE');
    console.log('================================================================\n');

    await db.initDatabase();

    const scratchDir = 'C:/Users/user/.gemini/antigravity/brain/b8c9b40e-cd6d-4a08-8b0a-137a1cc80902/scratch/federation_data';
    const s3Dir = path.join(scratchDir, 's3', 'crm');
    const adlsDir = path.join(scratchDir, 'adls', 'sales');
    fs.mkdirSync(s3Dir, { recursive: true });
    fs.mkdirSync(adlsDir, { recursive: true });

    const customersParquetPath = path.join(s3Dir, 'customers.parquet').replace(/\\/g, '/');
    const ordersParquetPath = path.join(adlsDir, 'orders.parquet').replace(/\\/g, '/');
    const ordersLargeParquetPath = path.join(adlsDir, 'orders_large.parquet').replace(/\\/g, '/');

    // Generate real Parquet datasets with known records and row groups
    const tempDuck = new duckdb.Database(':memory:');
    await new Promise((resolve, reject) => {
        tempDuck.exec(`
            CREATE TABLE customers_src AS
            SELECT * FROM (VALUES
                (1, 'Alice Smith', 'Enterprise', 'US', 'alice@acme.com'),
                (2, 'Bob Jones', 'Mid-Market', 'UK', 'bob@globex.co.uk'),
                (3, 'Charlie Patel', 'Enterprise', 'IN', 'charlie@inditech.in'),
                (4, 'Diana Prince', 'SMB', 'CA', 'diana@themyscira.ca'),
                (5, 'Evan Wright', 'Enterprise', 'DE', 'evan@berlin-ai.de')
            ) AS t(customer_id, customer_name, segment, country, email);
            COPY customers_src TO '${customersParquetPath}' (FORMAT PARQUET, ROW_GROUP_SIZE 2);

            CREATE TABLE orders_src AS
            SELECT * FROM (VALUES
                (101, 1, '2026-01-15', 12500.50, 'COMPLETED'),
                (102, 1, '2026-02-20', 8400.00, 'COMPLETED'),
                (103, 2, '2026-02-28', 3200.75, 'COMPLETED'),
                (104, 3, '2026-03-05', 45000.00, 'COMPLETED'),
                (105, 5, '2026-03-10', 19800.25, 'PENDING'),
                (106, 99, '2026-03-12', 950.00, 'ORPHAN_ORDER')
            ) AS t(order_id, customer_id, order_date, amount, status);
            COPY orders_src TO '${ordersParquetPath}' (FORMAT PARQUET, ROW_GROUP_SIZE 2);

            CREATE TABLE orders_large_src AS
            SELECT
                i AS order_id,
                (i % 5) + 1 AS customer_id,
                CAST(i * 10.5 AS DOUBLE) AS amount,
                CASE WHEN i % 2 = 0 THEN 'COMPLETED' ELSE 'PENDING' END AS status
            FROM range(1, 6145) t(i);
            COPY orders_large_src TO '${ordersLargeParquetPath}' (FORMAT PARQUET, ROW_GROUP_SIZE 2048);
        `, (err) => err ? reject(err) : resolve());
    });

    // Clean and seed targets for S3 and ADLS
    await db.run(`DELETE FROM metadata_catalog WHERE catalog_name IN ('aws_customers', 'azure_sales')`);
    await db.run(`DELETE FROM targets WHERE target_id IN ('tgt-suite-s3', 'tgt-suite-adls', 'tgt-suite-tenant-b')`);

    const awsSec = db.encryptTargetSecrets({ access_key: 'AKIA_PROD_DEMO', secret_key: 'SECRET_PROD_DEMO' });
    await db.run(`
        INSERT INTO targets (
            target_id, target_name, provider_type, endpoint, bucket, region,
            access_key, secret_key, catalog_name, default_schema, base_prefix, tenant_id, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
        'tgt-suite-s3', 'AWS Customers S3 Lake', 'AWS S3', '', 'aws-customers-bucket', 'us-east-1',
        awsSec.access_key, awsSec.secret_key, 'aws_customers', 'crm', '', 'default'
    ]);

    const azSec = db.encryptTargetSecrets({ credentials: 'DefaultEndpointsProtocol=https;AccountName=adlsact;AccountKey=bXlLZXk=;EndpointSuffix=core.windows.net' });
    await db.run(`
        INSERT INTO targets (
            target_id, target_name, provider_type, endpoint, bucket, region,
            credentials, catalog_name, default_schema, base_prefix, tenant_id, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
        'tgt-suite-adls', 'Azure Sales ADLS Gen2 Lake', 'Azure ADLS Gen2', '', 'sales-container', 'eastus2',
        azSec.credentials, 'azure_sales', 'sales', '', 'default'
    ]);

    await db.run(`
        INSERT INTO targets (
            target_id, target_name, provider_type, endpoint, bucket, region,
            access_key, secret_key, catalog_name, default_schema, base_prefix, tenant_id, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
        'tgt-suite-tenant-b', 'Tenant B Isolated Lake', 'AWS S3', '', 'tenant-b-bucket', 'us-west-2',
        awsSec.access_key, awsSec.secret_key, 'tenant_b_cat', 'finance', '', 'tenant_beta'
    ]);

    const custEntry = await registerCatalogEntry({
        targetId: 'tgt-suite-s3',
        fileName: 'crm/customers.parquet',
        filePath: customersParquetPath,
        fileFormat: 'parquet',
        sizeBytes: fs.statSync(customersParquetPath).size,
        catalogName: 'aws_customers',
        schemaName: 'crm',
        tableName: 'customers',
        tenantId: 'default'
    });

    const ordersEntry = await registerCatalogEntry({
        targetId: 'tgt-suite-adls',
        fileName: 'sales/orders.parquet',
        filePath: ordersParquetPath,
        fileFormat: 'parquet',
        sizeBytes: fs.statSync(ordersParquetPath).size,
        catalogName: 'azure_sales',
        schemaName: 'sales',
        tableName: 'orders',
        tenantId: 'default'
    });

    await registerCatalogEntry({
        targetId: 'tgt-suite-adls',
        fileName: 'sales/orders_large.parquet',
        filePath: ordersLargeParquetPath,
        fileFormat: 'parquet',
        sizeBytes: fs.statSync(ordersLargeParquetPath).size,
        catalogName: 'azure_sales',
        schemaName: 'sales',
        tableName: 'orders_large',
        tenantId: 'default'
    });

    const defaultAdminUser = { user_id: 1, email: 'admin@cloudobjectiq.com', role: 'admin', tenant_id: 'default' };

    // ─────────────────────────────────────────────────────────────
    // TEST 1: S3 Connection Validation
    // ─────────────────────────────────────────────────────────────
    const origS3Send = S3Client.prototype.send;
    S3Client.prototype.send = async function(cmd) {
        return { Contents: [{ Key: 'crm/customers.parquet', Size: 1024 }] };
    };
    const s3ConnRes = await storage.testConnection({
        provider_type: 's3',
        bucket: 'aws-customers-bucket',
        access_key: 'AKIA_VALID',
        secret_key: 'SECRET_VALID',
        region: 'us-east-1'
    });
    assert.strictEqual(s3ConnRes.success, true);
    assert.strictEqual(s3ConnRes.bucket, 'aws-customers-bucket');
    console.log('✅ TEST 1 PASSED: S3 Storage Connection validation successful');

    // ─────────────────────────────────────────────────────────────
    // TEST 2: ADLS Connection Validation
    // ─────────────────────────────────────────────────────────────
    const origGetContainerClient = BlobServiceClient.prototype.getContainerClient;
    BlobServiceClient.prototype.getContainerClient = function(containerName) {
        return {
            getProperties: async () => ({}),
            listBlobsFlat: () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { name: 'sales/orders.parquet', properties: { contentLength: 2048 } };
                }
            })
        };
    };
    const adlsConnRes = await storage.testConnection({
        provider_type: 'adls',
        bucket: 'sales-container',
        credentials: 'DefaultEndpointsProtocol=https;AccountName=adlsact;AccountKey=bXlLZXk=;EndpointSuffix=core.windows.net'
    });
    assert.strictEqual(adlsConnRes.success, true);
    assert.strictEqual(adlsConnRes.bucket, 'sales-container');
    console.log('✅ TEST 2 PASSED: Azure ADLS Gen2 Storage Connection validation successful');

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Parquet Schema Discovery
    // ─────────────────────────────────────────────────────────────
    const discCust = await discoverParquetSchemaWithDuckDB(`read_parquet('${customersParquetPath}')`);
    assert(Array.isArray(discCust.columns) && discCust.columns.length === 5, 'Schema must detect 5 columns in customers.parquet');
    const colNames = discCust.columns.map(c => c.name);
    assert(colNames.includes('customer_id') && colNames.includes('customer_name') && colNames.includes('country'));
    assert.strictEqual(discCust.rowCount, 5);
    console.log(`✅ TEST 3 PASSED: Parquet Schema Discovery verified (${discCust.columns.length} columns, ${discCust.rowCount} rows)`);

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Single-Source Queries
    // ─────────────────────────────────────────────────────────────
    const singleS3 = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT customer_id, customer_name, country FROM aws_customers.crm.customers ORDER BY customer_id`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(singleS3.length, 5);
    assert.strictEqual(singleS3[0].customer_name, 'Alice Smith');

    const singleAdls = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT order_id, customer_id, amount FROM azure_sales.sales.orders ORDER BY order_id`,
        'tgt-suite-adls',
        { user: defaultAdminUser }
    );
    assert.strictEqual(singleAdls.length, 6);
    console.log('✅ TEST 4 PASSED: Single-source queries on aws_customers.crm.customers and azure_sales.sales.orders');

    // ─────────────────────────────────────────────────────────────
    // TEST 5: S3 + ADLS INNER JOIN
    // ─────────────────────────────────────────────────────────────
    const innerJoin = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT c.customer_id, c.customer_name, c.country, o.order_id, o.amount, o.status
         FROM aws_customers.crm.customers c
         INNER JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
         ORDER BY o.order_id`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(innerJoin.length, 5, 'Expected exactly 5 matching rows');
    assert.strictEqual(Number(innerJoin[0].order_id), 101);
    assert.strictEqual(innerJoin[0].customer_name, 'Alice Smith');
    assert.strictEqual(innerJoin._scanMeta.isFederated, true);
    console.log('✅ TEST 5 PASSED: S3 + ADLS INNER JOIN verified against expected truth (5 rows returned)');

    // ─────────────────────────────────────────────────────────────
    // TEST 6: LEFT JOIN
    // ─────────────────────────────────────────────────────────────
    const leftJoin = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT c.customer_id, c.customer_name, o.order_id
         FROM aws_customers.crm.customers c
         LEFT JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
         ORDER BY c.customer_id, o.order_id`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(leftJoin.length, 6, 'Expected 6 rows (5 matched + customer 4 unmatched)');
    const unmatchedCust = leftJoin.find(r => Number(r.customer_id) === 4);
    assert(unmatchedCust && unmatchedCust.order_id === null, 'Customer 4 must have null order_id');
    console.log('✅ TEST 6 PASSED: Cross-source LEFT JOIN verified (6 rows returned with null-preservation)');

    // ─────────────────────────────────────────────────────────────
    // TEST 7: RIGHT JOIN
    // ─────────────────────────────────────────────────────────────
    const rightJoin = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT c.customer_name, o.order_id, o.customer_id AS order_cid
         FROM aws_customers.crm.customers c
         RIGHT JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
         ORDER BY o.order_id`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(rightJoin.length, 6, 'Expected 6 rows (5 matched + order 106 unmatched)');
    const unmatchedOrder = rightJoin.find(r => Number(r.order_id) === 106);
    assert(unmatchedOrder && unmatchedOrder.customer_name === null, 'Order 106 must have null customer_name');
    console.log('✅ TEST 7 PASSED: Cross-source RIGHT JOIN verified (6 rows returned with null-preservation)');

    // ─────────────────────────────────────────────────────────────
    // TEST 8: FULL OUTER JOIN
    // ─────────────────────────────────────────────────────────────
    const fullOuter = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT c.customer_id AS cid, c.customer_name, o.order_id
         FROM aws_customers.crm.customers c
         FULL OUTER JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
         ORDER BY COALESCE(c.customer_id, 999), COALESCE(o.order_id, 999)`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(fullOuter.length, 7, 'Expected 7 rows (5 matched + 1 unmatched customer + 1 unmatched order)');
    console.log('✅ TEST 8 PASSED: Cross-source FULL OUTER JOIN verified (7 rows returned)');

    // ─────────────────────────────────────────────────────────────
    // TEST 9: Aggregations, Grouping, Filtering, and Sorting
    // ─────────────────────────────────────────────────────────────
    const aggResult = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT c.segment, COUNT(o.order_id) AS order_cnt, ROUND(SUM(o.amount), 2) AS total_val
         FROM aws_customers.crm.customers c
         INNER JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id
         WHERE o.status IN ('COMPLETED', 'PENDING')
         GROUP BY c.segment
         ORDER BY total_val DESC`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(aggResult.length, 2);
    assert.strictEqual(aggResult[0].segment, 'Enterprise');
    assert.strictEqual(Number(aggResult[0].order_cnt), 4);
    assert.strictEqual(Number(aggResult[0].total_val), 85700.75);
    console.log('✅ TEST 9 PASSED: Aggregations (GROUP BY, SUM, COUNT), WHERE filtering, and ORDER BY verified');

    // ─────────────────────────────────────────────────────────────
    // TEST 10: Filter Pushdown Validation
    // ─────────────────────────────────────────────────────────────
    const unfOrders = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT order_id, customer_id, amount FROM azure_sales.sales.orders_large`,
        'tgt-suite-adls',
        { user: defaultAdminUser }
    );
    const fltOrders = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT order_id, customer_id, amount FROM azure_sales.sales.orders_large WHERE order_id <= 500`,
        'tgt-suite-adls',
        { user: defaultAdminUser }
    );
    const fltMeta = fltOrders._scanMeta;
    const unfMeta = unfOrders._scanMeta;
    assert.strictEqual(fltMeta.sourceBreakdown[0].survivingRowGroups, 1);
    assert.strictEqual(fltMeta.sourceBreakdown[0].totalRowGroups, 3);
    assert(fltMeta.logicalScannedBytes < unfMeta.logicalScannedBytes, 'Filtered query must scan fewer logical bytes');
    console.log(`✅ TEST 10 PASSED: Filter pushdown validated (row groups: ${fltMeta.sourceBreakdown[0].survivingRowGroups}/3, scanned ${fltMeta.logicalScannedBytes} B vs ${unfMeta.logicalScannedBytes} B)`);

    // ─────────────────────────────────────────────────────────────
    // TEST 11: Column Projection Validation
    // ─────────────────────────────────────────────────────────────
    const allColsCust = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT * FROM aws_customers.crm.customers`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    const projColsCust = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT customer_id, country FROM aws_customers.crm.customers`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert(
        projColsCust._scanMeta.logicalScannedBytes < allColsCust._scanMeta.logicalScannedBytes,
        'Column projection must scan strictly fewer logical bytes than SELECT *'
    );
    assert.strictEqual(projColsCust._scanMeta.sourceBreakdown[0].projectedColumns.length, 2);
    assert.strictEqual(projColsCust._scanMeta.sourceBreakdown[0].totalColumns, 5);
    console.log(`✅ TEST 11 PASSED: Column projection validated (2/5 cols: ${projColsCust._scanMeta.logicalScannedBytes} B vs 5/5 cols: ${allColsCust._scanMeta.logicalScannedBytes} B)`);

    // ─────────────────────────────────────────────────────────────
    // TEST 12: Source-Level Telemetry Accuracy
    // ─────────────────────────────────────────────────────────────
    const ijMeta = innerJoin._scanMeta;
    assert(ijMeta.executionId && ijMeta.executionId.length >= 16);
    assert.strictEqual(ijMeta.sourceBreakdown.length, 2);
    const s3Src = ijMeta.sourceBreakdown.find(s => s.catalogName === 'aws_customers');
    const adlsSrc = ijMeta.sourceBreakdown.find(s => s.catalogName === 'azure_sales');
    assert(s3Src && adlsSrc);
    assert.strictEqual(ijMeta.compressedObjectBytes, s3Src.compressedObjectBytes + adlsSrc.compressedObjectBytes);
    assert.strictEqual(ijMeta.logicalScannedBytes, s3Src.logicalBytesScanned + adlsSrc.logicalBytesScanned);
    const persistedLog = await db.get(`SELECT * FROM query_logs WHERE execution_id = ?`, [ijMeta.executionId]);
    assert(persistedLog);
    assert.strictEqual(Number(persistedLog.compressed_object_bytes), ijMeta.compressedObjectBytes);
    console.log('✅ TEST 12 PASSED: Source-level telemetry accuracy & database audit trail verified');

    // ─────────────────────────────────────────────────────────────
    // TEST 13: Invalid Credentials Rejection
    // ─────────────────────────────────────────────────────────────
    S3Client.prototype.send = async function() {
        const err = new Error('The security token included in the request is invalid');
        err.name = 'InvalidAccessKeyId';
        err.$metadata = { httpStatusCode: 401 };
        throw err;
    };
    try {
        await storage.testConnection({
            provider_type: 's3',
            bucket: 'aws-customers-bucket',
            access_key: 'AKIA_INVALID',
            secret_key: 'WRONG_SECRET'
        });
        assert.fail('Should have thrown AUTH_FAILURE');
    } catch (err) {
        assert.strictEqual(err.code, 'AUTH_FAILURE');
        assert.strictEqual(err.statusCode, 401);
    }
    console.log('✅ TEST 13 PASSED: Invalid credentials rejected with AUTH_FAILURE (401)');

    // ─────────────────────────────────────────────────────────────
    // TEST 14: Permission Denied Rejection
    // ─────────────────────────────────────────────────────────────
    S3Client.prototype.send = async function() {
        const err = new Error('Access Denied');
        err.name = 'AccessDenied';
        err.$metadata = { httpStatusCode: 403 };
        throw err;
    };
    try {
        await storage.testConnection({
            provider_type: 's3',
            bucket: 'aws-customers-bucket',
            access_key: 'AKIA_VALID_BUT_NO_PERM',
            secret_key: 'SECRET_KEY'
        });
        assert.fail('Should have thrown PERMISSION_DENIED');
    } catch (err) {
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(err.statusCode, 403);
    }
    // Restore S3Client prototype
    S3Client.prototype.send = origS3Send;
    BlobServiceClient.prototype.getContainerClient = origGetContainerClient;
    console.log('✅ TEST 14 PASSED: Permission failures handled with PERMISSION_DENIED (403)');

    // ─────────────────────────────────────────────────────────────
    // TEST 15: Concurrent Query Isolation
    // ─────────────────────────────────────────────────────────────
    const concurrentExecutions = await Promise.all([
        engine.runQuery(defaultAdminUser.user_id, `SELECT COUNT(*) AS cnt FROM aws_customers.crm.customers`, 'tgt-suite-s3', { user: defaultAdminUser }),
        engine.runQuery(defaultAdminUser.user_id, `SELECT COUNT(*) AS cnt FROM azure_sales.sales.orders`, 'tgt-suite-adls', { user: defaultAdminUser }),
        engine.runQuery(defaultAdminUser.user_id, `SELECT SUM(amount) AS sum_amt FROM azure_sales.sales.orders`, 'tgt-suite-adls', { user: defaultAdminUser }),
        engine.runQuery(defaultAdminUser.user_id, `SELECT c.customer_name FROM aws_customers.crm.customers c INNER JOIN azure_sales.sales.orders o ON c.customer_id = o.customer_id WHERE o.order_id = 101`, 'tgt-suite-s3', { user: defaultAdminUser })
    ]);
    const execIdSet = new Set(concurrentExecutions.map(r => r._scanMeta.executionId));
    assert.strictEqual(execIdSet.size, 4, 'All concurrent queries must have unique execution IDs');
    assert.strictEqual(Number(concurrentExecutions[0][0].cnt), 5);
    assert.strictEqual(Number(concurrentExecutions[1][0].cnt), 6);
    assert.strictEqual(Number(concurrentExecutions[2][0].sum_amt), 89851.5);
    assert.strictEqual(concurrentExecutions[3][0].customer_name, 'Alice Smith');
    console.log('✅ TEST 15 PASSED: Concurrent query isolation verified across simultaneous execution handles');

    // ─────────────────────────────────────────────────────────────
    // TEST 16: Multi-Tenant Security Isolation
    // ─────────────────────────────────────────────────────────────
    const tenantBUser = { user_id: 99, email: 'user@tenantb.com', role: 'user', tenant_id: 'tenant_beta' };
    try {
        // Tenant Beta user attempting to query default tenant target
        await engine.runQuery(
            tenantBUser.user_id,
            `SELECT * FROM aws_customers.crm.customers`,
            'tgt-suite-s3',
            { user: tenantBUser }
        );
        assert.fail('Should have blocked cross-tenant query');
    } catch (err) {
        assert(err.code === 'TENANT_ISOLATION_VIOLATION' || err.statusCode === 403, 'Cross-tenant query must be rejected with 403');
    }
    console.log('✅ TEST 16 PASSED: Multi-tenant security isolation enforced (Cross-tenant query blocked)');

    // ─────────────────────────────────────────────────────────────
    // TEST 17: Existing Non-Federated SQL Regression Safety
    // ─────────────────────────────────────────────────────────────
    const standardSqlResult = await engine.runQuery(
        defaultAdminUser.user_id,
        `SELECT 42 AS answer, 'CloudObjectIQ' AS platform`,
        'tgt-suite-s3',
        { user: defaultAdminUser }
    );
    assert.strictEqual(Number(standardSqlResult[0].answer), 42);
    assert.strictEqual(standardSqlResult[0].platform, 'CloudObjectIQ');
    assert.strictEqual(standardSqlResult._scanMeta.isFederated, false);
    console.log('✅ TEST 17 PASSED: Existing non-federated SQL query execution verified with zero regressions');

    console.log('\n================================================================');
    console.log('🎉 ALL 17 / 17 FEDERATION CRITERIA TESTED AND VERIFIED PASSING!');
    console.log('================================================================');
    process.exit(0);
}

run17PointFederationSuite().catch(err => {
    console.error('❌ MASTER SUITE FAILED:', err);
    process.exit(1);
});
