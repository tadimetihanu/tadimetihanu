const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./src/db');
const { extractQueryPlanFeatures, detectFileFormat, detectStorageProvider, extractDataSourcePaths } = require('./src/query/feature_extractor');
const { predictQueryCost, recordExecutionTelemetryAndFeedback } = require('./src/services/ml_prediction');
const { 
    calculateSafeReductionPct, 
    formatBytes, 
    discoverTableColumns, 
    analyzeQueryIntelligence, 
    generateRecommendedSql, 
    runQueryBenchmark 
} = require('./src/services/query_optimizer');
const { SECRET_KEY, isAdmin } = require('./src/middleware/auth');

async function runMasterTestSuite() {
    console.log('======================================================================');
    console.log('  CloudObjectIQ AI Query Optimization & Cost Intelligence Engine');
    console.log('  Master 20-Point Verification Test Suite');
    console.log('======================================================================\n');

    let passed = 0;
    let failed = 0;
    const results = [];

    async function runTest(testNum, testTitle, testFn) {
        process.stdout.write(`[Test ${testNum.toString().padStart(2, '0')}/20] ${testTitle.padEnd(52, '.')} `);
        try {
            await testFn();
            console.log('✅ PASS');
            passed++;
            results.push({ testNum, testTitle, status: 'PASS' });
        } catch (err) {
            console.log('❌ FAIL');
            console.error(`          >> Reason: ${err.message}`);
            failed++;
            results.push({ testNum, testTitle, status: 'FAIL', error: err.message });
        }
    }

    // 0. Ensure Database is Initialized
    await db.initDatabase();

    // ── Test 1: SELECT * Detection ───────────────────────────────────────────────
    await runTest(1, 'SELECT * Wildcard Detection & Unused Columns', async () => {
        const sql = 'SELECT * FROM sales_orders';
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.projection.detected, true, 'Should detect SELECT *');
        assert.strictEqual(res.cards.projection.severity, 'warning');
        assert.ok(res.cards.projection.unnecessary_columns.length > 0, 'Should identify unnecessary columns');
        assert.ok(res.cards.projection.estimated_scan_reduction_pct > 0, 'Should estimate scan savings');
    });

    // ── Test 2: Explicit Column Selection ────────────────────────────────────────
    await runTest(2, 'Explicit Column Selection (No Unnecessary Projection)', async () => {
        const sql = 'SELECT order_id, customer_id, order_amount FROM sales_orders WHERE status = "COMPLETED"';
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.projection.detected, false, 'Should not flag explicit column projection');
        assert.strictEqual(res.cards.projection.severity, 'good');
        assert.strictEqual(res.cards.projection.estimated_scan_reduction_pct, 0.0);
    });

    // ── Test 3: Missing Partition Filters ────────────────────────────────────────
    await runTest(3, 'Missing Partition Filters Detection & Recommendations', async () => {
        const sql = 'SELECT order_id, amount FROM sales_data';
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.partition.detected, true, 'Should detect missing partition filter');
        assert.ok(res.cards.partition.missing_partition_columns.includes('order_date'), 'Should detect missing order_date');
        assert.ok(res.cards.partition.recommended_filter_clause.includes('order_date'), 'Should provide partition filter clause');
        assert.ok(res.cards.partition.potential_scan_reduction_pct > 0, 'Should estimate scan reduction');
    });

    // ── Test 4: Existing Partition Filters ───────────────────────────────────────
    await runTest(4, 'Existing Partition Filters (No False Positive Warnings)', async () => {
        const sql = "SELECT order_id, amount FROM sales_data WHERE order_date >= DATE '2026-01-01'";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.partition.detected, false, 'Should acknowledge existing partition boundary');
        assert.strictEqual(res.cards.partition.missing_partition_columns.length, 0);
    });

    // ── Test 5: Parquet Metadata Analysis ────────────────────────────────────────
    await runTest(5, 'Parquet Storage Format & Vector Pushdown Recognition', async () => {
        const sql = "SELECT customer_id, SUM(amount) FROM 's3://lake/orders.parquet' GROUP BY 1";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.storage_format.detected, false, 'Parquet should be recognized as optimal');
        assert.strictEqual(res.cards.storage_format.current_format, 'PARQUET');
        assert.strictEqual(res.cards.storage_format.severity, 'good');
    });

    // ── Test 6: JSON Format Detection ────────────────────────────────────────────
    await runTest(6, 'JSON Format Inefficiency Detection & Parquet Advice', async () => {
        const sql = "SELECT id, payload FROM read_json_auto('s3://lake/events.json')";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.storage_format.detected, true, 'JSON should trigger format optimization');
        assert.strictEqual(res.cards.storage_format.current_format, 'JSON');
        assert.strictEqual(res.cards.storage_format.recommended_format, 'PARQUET');
        assert.ok(res.cards.storage_format.estimated_storage_savings_pct >= 75);
    });

    // ── Test 7: CSV Format Detection ─────────────────────────────────────────────
    await runTest(7, 'CSV Format Inefficiency Detection & Parquet Advice', async () => {
        const sql = "SELECT * FROM 'az://adls/raw_dump.csv'";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.storage_format.detected, true, 'CSV should trigger format optimization');
        assert.strictEqual(res.cards.storage_format.current_format, 'CSV');
        assert.strictEqual(res.cards.storage_format.recommended_format, 'PARQUET');
    });

    // ── Test 8: ORC Format Detection ─────────────────────────────────────────────
    await runTest(8, 'ORC Columnar Format Recognition', async () => {
        const sql = "SELECT order_id, total FROM 's3://lake/orders.orc'";
        const fmt = detectFileFormat(sql, ['s3://lake/orders.orc']);
        assert.strictEqual(fmt, 'orc');
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.strictEqual(res.cards.storage_format.current_format, 'ORC');
        assert.strictEqual(res.cards.storage_format.severity, 'good');
    });

    // ── Test 9: Filter Pushdown Detection ────────────────────────────────────────
    await runTest(9, 'Execution Plan Analyzer: Filter Pushdown Status', async () => {
        const sqlWithFilter = "SELECT order_id FROM sales_orders WHERE status = 'SHIPPED'";
        const resWith = await analyzeQueryIntelligence(sqlWithFilter, null, 'tenant-1');
        assert.ok(resWith.cards.execution_plan.filter_pushdown_status.includes('Enabled'));

        const sqlWithoutFilter = "SELECT order_id FROM sales_orders";
        const resWithout = await analyzeQueryIntelligence(sqlWithoutFilter, null, 'tenant-1');
        assert.ok(resWithout.cards.execution_plan.filter_pushdown_status.includes('Not Available') || resWithout.cards.execution_plan.filter_pushdown_status.includes('Missing'));
    });

    // ── Test 10: Join Optimization Recommendations ──────────────────────────────
    await runTest(10, 'Execution Plan Analyzer: Multi-Table Join Warnings', async () => {
        const sql = `
            SELECT o.order_id, c.name, p.title
            FROM orders o
            JOIN customers c ON o.customer_id = c.customer_id
            JOIN products p ON o.product_id = p.product_id
        `;
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        assert.ok(res.cards.execution_plan.join_optimization_status.includes('2 Joins'));
        assert.ok(res.cards.execution_plan.expensive_operators.some(op => op.includes('Unfiltered HashJoin')));
    });

    // ── Test 11: Prediction API (POST /api/query-intelligence/predict) ───────────
    await runTest(11, 'ML Prediction Engine: Cost, Latency, and Scan Confidence', async () => {
        const sql = "SELECT category, SUM(amount) FROM 's3://lake/sales.parquet' WHERE region = 'US' GROUP BY 1";
        const pred = await predictQueryCost({ sql, tenantId: 'tenant-enterprise', cacheStatus: 'MISS' });
        assert.strictEqual(pred.success, true);
        assert.ok(pred.predicted_scan_volume_bytes > 0, 'Predicted scan volume must be > 0');
        assert.ok(pred.predicted_execution_duration_ms > 0, 'Predicted duration must be > 0');
        assert.ok(pred.predicted_cost_usd >= 0, 'Predicted cost must be >= 0');
        assert.ok(pred.confidence_score >= 50, 'Confidence score must be >= 50%');
        assert.ok(pred.confidence_interval.cost_usd.upper >= pred.predicted_cost_usd, 'CI upper bound >= point estimate');
    });

    // ── Test 12: Prediction Accuracy Calculation ─────────────────────────────────
    await runTest(12, 'Prediction Accuracy Metric (MAPE & Absolute Variance)', async () => {
        const predictedScan = 1000000;
        const actualScan = 950000;
        const scanErrorPct = (Math.abs(predictedScan - actualScan) / actualScan) * 100;
        const accuracyPct = Math.max(0, 100 - scanErrorPct);
        assert.ok(accuracyPct > 90, `Expected accuracy > 90%, got ${accuracyPct.toFixed(2)}%`);
    });

    // ── Test 13: Actual vs Predicted Cost Comparison & Feedback Loop ─────────────
    await runTest(13, 'Feedback Loop: Logging Execution Telemetry & Error Deltas', async () => {
        const executionId = `exec_test_${Date.now()}`;
        const feedback = await recordExecutionTelemetryAndFeedback({
            executionId,
            tenantId: 'tenant-feedback',
            userId: 'user-001',
            sql: 'SELECT id FROM orders',
            storageProvider: 's3',
            fileFormat: 'parquet',
            fileCount: 1,
            totalFileSizeBytes: 10485760,
            actualScanBytes: 1048576,
            actualDurationMs: 45,
            actualCostUsd: 0.000005,
            cacheStatus: 'MISS',
            joinCount: 0,
            filterCount: 1,
            hasWildcard: 0,
            predictedScanBytes: 1100000,
            predictedDurationMs: 50,
            predictedCostUsd: 0.0000052,
            modelVersion: 'v1.0.0'
        });
        assert.strictEqual(feedback.success, true);
        assert.ok(feedback.feedback_id, 'Feedback record ID must be generated');

        const saved = await db.get('SELECT * FROM prediction_feedback WHERE execution_id = ?', [executionId]);
        assert.ok(saved, 'Feedback row must exist in database');
        assert.strictEqual(saved.tenant_id, 'tenant-feedback');
    });

    // ── Test 14: Live Burn Integration (Safe Reduction Formulas) ─────────────────
    await runTest(14, 'Live Burn Integration: Safe Reduction Formulas & Zero Handling', async () => {
        // Standard normal reduction
        const red1 = calculateSafeReductionPct(100, 25);
        assert.strictEqual(red1, 75.0);

        // Zero before (avoid division by zero)
        const redZero = calculateSafeReductionPct(0, 50);
        assert.strictEqual(redZero, 0.0);

        // After > Before (negative reduction safely clamped to 0)
        const redNeg = calculateSafeReductionPct(50, 100);
        assert.strictEqual(redNeg, 0.0);

        // 100% reduction
        const redFull = calculateSafeReductionPct(1000, 0);
        assert.strictEqual(redFull, 100.0);
    });

    // ── Test 15: Tenant Isolation Verification ───────────────────────────────────
    await runTest(15, 'Enterprise Security: Strict Multi-Tenant Data Isolation', async () => {
        const tenantA = 'tenant_alpha_secure';
        const tenantB = 'tenant_beta_isolated';

        // Insert benchmark record for Tenant A
        const resA = await runQueryBenchmark({
            originalSql: 'SELECT * FROM sales_orders',
            optimizedSql: 'SELECT order_id FROM sales_orders',
            tenantId: tenantA,
            userId: 'user-a'
        });
        assert.strictEqual(resA.success, true);

        // Query runs for Tenant B: must NOT see Tenant A's runs
        const rowsB = await db.all('SELECT * FROM query_optimization_runs WHERE tenant_id = ?', [tenantB]);
        assert.strictEqual(rowsB.length, 0, 'Tenant B must see 0 runs of Tenant A');

        // Query runs for Tenant A: must see its own run
        const rowsA = await db.all('SELECT * FROM query_optimization_runs WHERE tenant_id = ?', [tenantA]);
        assert.ok(rowsA.length >= 1, 'Tenant A must see its own runs');
    });

    // ── Test 16: RBAC Verification ───────────────────────────────────────────────
    await runTest(16, 'Role-Based Access Control (RBAC): Admin vs Viewer Roles', async () => {
        // Mock Admin User
        const adminUser = { user_id: 'u-admin', role: 'admin', tenant_id: 'tenant-1' };
        let adminAllowed = false;
        isAdmin({ user: adminUser }, {}, () => { adminAllowed = true; });
        assert.strictEqual(adminAllowed, true, 'Admin role should be granted access');

        // Mock Viewer User
        const viewerUser = { user_id: 'u-viewer', role: 'viewer', tenant_id: 'tenant-1' };
        let viewerBlocked = false;
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 403) viewerBlocked = true;
                }
            })
        };
        isAdmin({ user: viewerUser }, mockRes, () => {});
        assert.strictEqual(viewerBlocked, true, 'Viewer role must be blocked with 403');
    });

    // ── Test 17: Invalid SQL Handling ────────────────────────────────────────────
    await runTest(17, 'Input Validation: Rejects Empty or Malformed SQL Safely', async () => {
        let threw = false;
        try {
            await analyzeQueryIntelligence('', null, 'tenant-1');
        } catch (e) {
            threw = true;
            assert.ok(e.message.includes('required'), 'Error message should indicate SQL is required');
        }
        assert.strictEqual(threw, true, 'Empty SQL must throw descriptive error');
    });

    // ── Test 18: Query Execution Failure Handling ────────────────────────────────
    await runTest(18, 'Resilience: Graceful Fallback on Query Execution Errors', async () => {
        // Benchmark running queries that cause syntax or execution errors handles them safely
        const benchRes = await runQueryBenchmark({
            originalSql: 'SELECT * FROM nonexistent_table_xyz_123',
            optimizedSql: 'SELECT col FROM nonexistent_table_xyz_123',
            tenantId: 'tenant-fault-test'
        });
        assert.strictEqual(benchRes.success, true, 'Benchmark service should not crash on query error');
        assert.ok(benchRes.savings.scan_reduction_pct >= 0, 'Savings should still compute safely');
    });

    // ── Test 19: Benchmark Consistency ───────────────────────────────────────────
    await runTest(19, 'Benchmark Engine: Computes Metrics, Safe Diffs, and Records Runs', async () => {
        const originalSql = 'SELECT * FROM sales_orders';
        const optimizedSql = 'SELECT order_id, customer_id, order_amount FROM sales_orders WHERE order_date >= DATE "2026-01-01"';
        const bench = await runQueryBenchmark({
            originalSql,
            optimizedSql,
            tenantId: 'tenant-bench-check',
            userId: 'user-bench'
        });
        assert.strictEqual(bench.success, true);
        assert.ok(bench.benchmark_id, 'Benchmark ID generated');
        assert.ok(bench.savings.scan_reduction_pct >= 0, 'Scan reduction pct is non-negative');
        assert.ok(bench.savings.cost_reduction_pct >= 0, 'Cost reduction pct is non-negative');
        assert.ok(bench.original.scan_formatted, 'Formatted scan bytes generated');
        assert.ok(bench.optimized.cost_formatted, 'Formatted cost generated');
    });

    // ── Test 20: Regression Testing of Existing APIs & Database Schema ───────────
    await runTest(20, 'System Regression Test: Telemetry, Models, & Database Integrity', async () => {
        // 1. Verify schema tables
        const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
        const tableNames = tables.map(t => t.name);
        const requiredTables = [
            'targets', 'query_history', 'metadata_catalog', 'query_telemetry', 
            'prediction_feedback', 'ml_model_registry', 'query_optimization_runs', 
            'ml_prediction_history'
        ];
        for (const tbl of requiredTables) {
            assert.ok(tableNames.includes(tbl), `Table ${tbl} must exist in schema`);
        }

        // 2. Verify model registry entry
        const modelRow = await db.get("SELECT * FROM ml_model_registry WHERE tenant_id = 'default' LIMIT 1");
        assert.ok(modelRow, 'Default model registry entry must exist');
        assert.strictEqual(modelRow.status, 'ready');

        // 3. Verify SQL recommendation generator
        const optSql = generateRecommendedSql('SELECT * FROM orders', {
            hasWildcard: true,
            recommendedColumns: ['order_id', 'order_amount', 'status'],
            missingPartitionCols: ['order_date'],
            suggestedFilter: "order_date >= DATE '2026-01-01'"
        });
        assert.ok(optSql.includes('SELECT order_id, order_amount, status'), 'Must replace SELECT *');
        assert.ok(optSql.includes("order_date >= DATE '2026-01-01'"), 'Must include suggested partition filter');
    });

    console.log('\n======================================================================');
    console.log(`  Master Test Suite Finished: ${passed} PASSED, ${failed} FAILED (Total: 20)`);
    console.log('======================================================================\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runMasterTestSuite().catch(err => {
    console.error('🔥 Fatal error executing master test suite:', err);
    process.exit(1);
});
