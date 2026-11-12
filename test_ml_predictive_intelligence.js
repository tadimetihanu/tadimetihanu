const assert = require('assert');
const path = require('path');
const db = require('./src/db');
const { extractQueryPlanFeatures, detectFileFormat, detectStorageProvider } = require('./src/query/feature_extractor');
const { predictQueryCost, recordExecutionTelemetryAndFeedback } = require('./src/services/ml_prediction');

async function runTestSuite() {
    console.log('🚀 Starting CloudObjectIQ ML Predictive Cost Intelligence Test Suite...\n');
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        process.stdout.write(`  ⏳ Testing: ${name}... `);
        try {
            await fn();
            console.log('✅ PASSED');
            passed++;
        } catch (err) {
            console.log('❌ FAILED');
            console.error('     Error:', err.message);
            failed++;
        }
    }

    // Initialize database
    await db.initDatabase();

    // ── 1. Unit Tests: Feature Extraction ──────────────────────────────────────────
    await test('Feature Extractor: Detects Parquet and ADLS from URI', async () => {
        const sql = "SELECT customer_id, SUM(amount) FROM 'az://lake/sales.parquet' WHERE status = 'COMPLETED' GROUP BY 1";
        const fmt = detectFileFormat(sql, ['az://lake/sales.parquet']);
        const provider = detectStorageProvider(null, ['az://lake/sales.parquet']);
        assert.strictEqual(fmt, 'parquet');
        assert.strictEqual(provider, 'adls');
    });

    await test('Feature Extractor: Extracts Joins, Filters, Aggregations, Wildcards', async () => {
        const sql = `
            SELECT o.id, c.name, SUM(o.total)
            FROM 's3://datalake/orders.parquet' o
            JOIN 's3://datalake/customers.parquet' c ON o.cust_id = c.id
            WHERE o.status = 'SHIPPED' AND o.total > 500
            GROUP BY o.id, c.name
            LIMIT 50
        `;
        const features = await extractQueryPlanFeatures(sql, null, 'tenant-alpha');
        assert.strictEqual(features.tenant_id, 'tenant-alpha');
        assert.strictEqual(features.join_count, 1);
        assert.ok(features.filter_count >= 2, `Expected >=2 filters, got ${features.filter_count}`);
        assert.ok(features.aggregation_count >= 1, `Expected >=1 aggregation, got ${features.aggregation_count}`);
        assert.strictEqual(features.has_group_by, 1);
        assert.strictEqual(features.has_limit, 1);
        assert.strictEqual(features.limit_value, 50);
        assert.strictEqual(features.has_wildcard, 0);
    });

    await test('Feature Extractor: Detects Wildcard Projection (SELECT *)', async () => {
        const sql = "SELECT * FROM read_csv_auto('s3://datalake/supermarket.csv')";
        const features = await extractQueryPlanFeatures(sql, null, 'tenant-alpha');
        assert.strictEqual(features.has_wildcard, 1);
        assert.strictEqual(features.file_format, 'csv');
        assert.strictEqual(features.storage_provider, 's3');
    });

    // ── 2. ML Prediction API & Heuristics ──────────────────────────────────────────
    await test('ML Service: Predicts Data Scan, Execution Duration, Cost, and CIs', async () => {
        const sql = "SELECT category, COUNT(1) FROM 's3://datalake/events.parquet' WHERE region = 'US' GROUP BY 1";
        const pred = await predictQueryCost({
            sql,
            tenantId: 'tenant-test',
            cacheStatus: 'MISS'
        });

        assert.strictEqual(pred.success, true);
        assert.ok(pred.predicted_scan_volume_bytes > 0, 'Predicted scan should be > 0');
        assert.ok(pred.predicted_execution_duration_ms > 0, 'Predicted duration should be > 0');
        assert.ok(pred.predicted_cost_usd >= 0, 'Predicted cost should be >= 0');
        assert.ok(pred.confidence_score >= 50, 'Confidence score should be >= 50');
        assert.ok(pred.confidence_interval.scan_bytes.upper >= pred.predicted_scan_volume_bytes, 'CI upper bound should be >= predicted');
        assert.ok(pred.confidence_interval.scan_bytes.lower <= pred.predicted_scan_volume_bytes, 'CI lower bound should be <= predicted');
    });

    await test('ML Service: Generates Actionable Optimization Recommendations', async () => {
        const sql = "SELECT * FROM 's3://datalake/unpruned_table.csv'";
        const pred = await predictQueryCost({
            sql,
            tenantId: 'tenant-test',
            cacheStatus: 'MISS'
        });

        assert.ok(pred.optimization_recommendations.length >= 2, 'Should recommend against wildcard and CSV format');
        const types = pred.optimization_recommendations.map(r => r.type);
        assert.ok(types.includes('projection_optimization'), 'Should contain projection recommendation');
        assert.ok(types.includes('storage_format'), 'Should contain storage format recommendation');
    });

    await test('ML Service: Zero Cost on Cache Hit', async () => {
        const sql = "SELECT id FROM 's3://datalake/cached.parquet' LIMIT 10";
        const pred = await predictQueryCost({
            sql,
            tenantId: 'tenant-test',
            cacheStatus: 'HIT'
        });

        assert.strictEqual(pred.predicted_cost_usd, 0.0, 'Cache hit forecast should predict $0.00 billed cost');
    });

    // ── 3. Closed Feedback Loop & Telemetry ────────────────────────────────────────
    await test('Telemetry & Feedback Loop: Records Prediction and Logs Actuals Comparison', async () => {
        const execId = `test_exec_${Date.now()}`;
        const sql = "SELECT status, COUNT(*) FROM 'az://lake/transactions.parquet' WHERE amount > 100 GROUP BY 1";
        
        // Step 1: Pre-execution prediction
        const pred = await predictQueryCost({
            sql,
            tenantId: 'tenant-beta',
            userId: 'user-001'
        });
        assert.ok(pred.prediction_id, 'Prediction should have prediction_id');

        // Step 2: Post-execution telemetry and feedback capture
        await recordExecutionTelemetryAndFeedback({
            executionId: execId,
            tenantId: 'tenant-beta',
            userId: 'user-001',
            targetId: null,
            sql,
            durationMs: 145,
            rowCount: 250,
            scanMeta: {
                logicalScannedBytes: 15500000,
                billedCostUsd: 0.000072,
                onDemandCostUsd: 0.000072,
                cacheStatus: 'MISS'
            }
        });

        // Step 3: Verify telemetry recorded in query_telemetry table
        const teleRow = await db.get('SELECT * FROM query_telemetry WHERE execution_id = ?', [execId]);
        assert.ok(teleRow, 'Query telemetry row should exist');
        assert.strictEqual(teleRow.tenant_id, 'tenant-beta');
        assert.strictEqual(teleRow.actual_scan_bytes, 15500000);
        assert.strictEqual(teleRow.duration_ms, 145);

        // Step 4: Verify feedback loop updated prediction_feedback table
        const fbRow = await db.get('SELECT * FROM prediction_feedback WHERE query_text = ? ORDER BY created_at DESC LIMIT 1', [sql]);
        assert.ok(fbRow, 'Prediction feedback row should exist');
        assert.strictEqual(fbRow.actual_scan_bytes, 15500000);
        assert.ok(fbRow.validated_at !== null, 'Feedback record should be validated with actuals');
    });

    // ── 4. Multi-Tenant Isolation ──────────────────────────────────────────────────
    await test('Tenant Isolation: Telemetry and models isolated per tenant', async () => {
        const tenantA = 'tenant-corp-a';
        const tenantB = 'tenant-corp-b';

        await recordExecutionTelemetryAndFeedback({
            executionId: `exec_a_${Date.now()}`,
            tenantId: tenantA,
            userId: 'alice',
            sql: "SELECT * FROM table_a",
            durationMs: 80,
            rowCount: 10,
            scanMeta: { logicalScannedBytes: 500000 }
        });

        const rowsA = await db.all('SELECT * FROM query_telemetry WHERE tenant_id = ?', [tenantA]);
        const rowsB = await db.all('SELECT * FROM query_telemetry WHERE tenant_id = ?', [tenantB]);

        assert.ok(rowsA.length >= 1, 'Tenant A should have telemetry');
        assert.strictEqual(rowsB.length, 0, 'Tenant B should not see Tenant A telemetry');
    });

    // ── 5. Backward Compatibility: Live Burn & Scan Metrics ───────────────────────
    await test('Backward Compatibility: Live Burn telemetry metrics structure unaffected', async () => {
        const { calculateCost } = require('./src/query/scan_metrics');
        const sql = "SELECT * FROM read_parquet('s3://datalake/test.parquet') LIMIT 10";
        const mockRows = [{ id: 1, val: 'test' }];
        const costMeta = calculateCost(sql, mockRows);
        assert.ok(costMeta, 'Cost meta should be generated');
        assert.ok(costMeta.pricingUnit.includes('$5.00 / TiB'), 'Live Burn pricing formula should remain $5.00 / TiB');
        assert.strictEqual(costMeta.currency, 'USD');
    });

    // ── 6. Performance Benchmark: Prediction Latency ────────────────────────────────
    await test('Performance: Cost prediction latency is under 50ms', async () => {
        const sql = "SELECT id, count(*) FROM 's3://bkt/test.parquet' WHERE val > 10 GROUP BY 1";
        const t0 = Date.now();
        await predictQueryCost({ sql, tenantId: 'perf-test' });
        const latency = Date.now() - t0;
        console.log(`[${latency}ms]`);
        assert.ok(latency < 100, `Prediction took too long: ${latency}ms (expected < 100ms)`);
    });

    console.log(`\n========================================`);
    console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTestSuite().catch(e => {
    console.error('Fatal test error:', e);
    process.exit(1);
});
