const db = require('./src/db/index.js');
const { runQuery } = require('./src/query/engine');
const { createIcebergTable, appendIcebergRecords, listFiles } = require('./src/drivers/storage');
const bcrypt = require('bcryptjs');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ PASS: ${message}`);
        passCount++;
    } else {
        console.error(`  ❌ FAIL: ${message}`);
        failCount++;
    }
}

async function runTestSuite() {
    console.log('====================================================');
    console.log('🧪 CLOUDOBJECTIQ COMPREHENSIVE AUTOMATED TEST SUITE');
    console.log('====================================================\n');

    // ── TEST 1: Control Plane Database Initialization ──
    console.log('▶ [TEST 1] Control Plane Database Initialization');
    await db.initDatabase();
    assert(db.initDatabase !== undefined, 'Database initialization function loaded');
    const users = await db.all('SELECT * FROM users');
    assert(users.length > 0, `Users table populated with ${users.length} accounts`);
    const adminUser = await db.get('SELECT * FROM users WHERE email = ?', ['admin@cloudobjectiq.com']);
    const isBcryptHash = typeof adminUser.password_hash === 'string' && adminUser.password_hash.startsWith('$2');
    assert(isBcryptHash, 'Admin bcrypt password hash validated');

    // ── TEST 2: Multi-Cloud Targets & Permissions ──
    console.log('\n▶ [TEST 2] Multi-Cloud Storage Targets & Permissions');
    const targets = await db.all('SELECT * FROM targets');
    assert(targets.length >= 4, `Found ${targets.length} registered storage lake targets`);
    const primaryTarget = targets[0];
    assert(primaryTarget.target_id !== undefined, `Primary target selected: ${primaryTarget.target_name} (${primaryTarget.provider_type})`);

    // Test permission insert/update
    await db.run(`
        INSERT OR REPLACE INTO permissions (subject_id, subject_type, target_id, can_read, can_write, can_delete)
        VALUES (?, ?, ?, 1, 1, 1)
    `, [adminUser.user_id, 'user', primaryTarget.target_id]);
    const permRow = await db.get('SELECT * FROM permissions WHERE subject_id = ? AND target_id = ?', [adminUser.user_id, primaryTarget.target_id]);
    assert(permRow !== null && Number(permRow.can_read) === 1 && Number(permRow.can_write) === 1, 'Target permissions matrix write/read verified');

    // ── TEST 3: Metadata Catalog & Sample Data ──
    console.log('\n▶ [TEST 3] Metadata Catalog & Sample Datasets');
    const catalog = await db.all('SELECT * FROM metadata_catalog WHERE target_id = ?', [primaryTarget.target_id]);
    assert(catalog.length > 0, `Found ${catalog.length} cataloged objects in metadata catalog for target`);
    const hasDatasets = catalog.some(c => c.format === 'iceberg' || c.format === 'parquet' || c.format === 'csv');
    assert(hasDatasets, 'Lakehouse datasets (Iceberg / Parquet) registered in metadata catalog');

    // ── TEST 4: DuckDB Vectorized Analytical Engine ──
    console.log('\n▶ [TEST 4] DuckDB Vectorized Analytics Engine');
    const salesQuery = "SELECT category, count(*) AS count, avg(amount) AS avg_amount FROM 'sales_data.parquet' GROUP BY category LIMIT 5";
    const salesResults = await runQuery(adminUser.user_id, salesQuery, primaryTarget.target_id);
    assert(Array.isArray(salesResults) && salesResults.length > 0, `Aggregated query executed successfully: ${salesResults.length} groups returned`);

    // ── TEST 5: Apache Iceberg Table Creation Lifecycle ──
    console.log('\n▶ [TEST 5] Apache Iceberg Table Creation Lifecycle');
    const testIcebergName = `test_orders_${Date.now()}.iceberg`;
    const createIcebergResult = await createIcebergTable(
        primaryTarget.target_id,
        testIcebergName,
        "SELECT 1001 AS order_id, 'Electronics' AS category, 299.99 AS amount, 501 AS customer_id, 'Credit Card' AS payment_method, DATE '2026-08-30' AS order_date",
        "Test Iceberg table for automated verification"
    );
    assert(createIcebergResult && createIcebergResult.tableName === testIcebergName, `Iceberg table created: ${testIcebergName}`);
    assert(createIcebergResult.rowCount === 1, `Initial row count verified: 1 row`);

    // Verify initial Iceberg query
    const initialIcebergScan = await runQuery(adminUser.user_id, `SELECT * FROM iceberg_scan('${testIcebergName}')`, primaryTarget.target_id);
    assert(initialIcebergScan.length === 1, `Iceberg scan returned 1 record as expected`);

    // ── TEST 6: Apache Iceberg Record Insertion (`INSERT INTO`) Lifecycle ──
    console.log('\n▶ [TEST 6] Apache Iceberg Record Insertion (`INSERT INTO`) Lifecycle');
    const appendSql = `INSERT INTO '${testIcebergName}' SELECT 1002 AS order_id, 'Hardware' AS category, 450.00 AS amount, 502 AS customer_id, 'PayPal' AS payment_method, DATE '2026-08-30' AS order_date;`;
    const appendResult = await appendIcebergRecords(primaryTarget.target_id, testIcebergName, appendSql);
    assert(appendResult.success === true, `Appended record via SQL with automatic prefix stripping`);
    assert(appendResult.addedRows === 1, `Added rows verified: 1`);
    assert(appendResult.totalRows === 2, `Total rows updated to: 2`);
    assert(appendResult.version === 2, `Metadata version incremented to: v2`);
    assert(appendResult.dataFile === '00001-0-data.parquet', `New data file created: ${appendResult.dataFile}`);

    // Verify unified multi-file Iceberg query
    const updatedIcebergScan = await runQuery(adminUser.user_id, `SELECT * FROM iceberg_scan('${testIcebergName}') ORDER BY order_id ASC`, primaryTarget.target_id);
    assert(updatedIcebergScan.length === 2, `Unified Iceberg scan across multiple parquet data files returned ${updatedIcebergScan.length} rows`);
    const ids = updatedIcebergScan.map(r => Number(r.order_id));
    assert(ids.includes(1001) && ids.includes(1002), 'Both original (1001) and newly inserted (1002) records verified');

    // ── TEST 7: Query History & Audit Logging ──
    console.log('\n▶ [TEST 7] Query History & Audit Logging');
    const queryLogs = await db.all('SELECT * FROM query_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [adminUser.user_id]);
    assert(queryLogs.length > 0, `Query history logged ${queryLogs.length} recent query executions`);

    console.log('\n====================================================');
    console.log(`🏁 TEST SUITE COMPLETE: ${passCount} PASSED, ${failCount} FAILED`);
    console.log('====================================================\n');

    if (failCount > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTestSuite().catch(err => {
    console.error('Fatal Test Suite Error:', err);
    process.exit(1);
});
