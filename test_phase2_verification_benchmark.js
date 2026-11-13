const assert = require('assert');
const db = require('./src/db');
const {
    analyzeQueryIntelligence,
    runQueryBenchmark,
    getDuckDbExecutionPlan,
    compareExecutionPlans
} = require('./src/services/query_optimizer');

async function runTest(name, fn) {
    process.stdout.write(`  ⏳ Testing: ${name}... `);
    try {
        await fn();
        console.log('✅ PASSED');
    } catch (err) {
        console.log('❌ FAILED');
        console.error(err);
        process.exit(1);
    }
}

async function main() {
    console.log('======================================================================');
    console.log('  CloudObjectIQ Phase 2: Query Optimization Verification & Benchmark');
    console.log('======================================================================\n');

    await db.initDatabase();

    // ── Test 1: Plan Comparison with Identical Query ─────────────────────────
    await runTest('Identical Query Plan Comparison & DuckDB Optimizer Notice', async () => {
        const sql = "SELECT product_id, product_name FROM read_parquet('10M/products.parquet')";
        const planOrig = await getDuckDbExecutionPlan(sql, null, 'user-1');
        const planOpt = await getDuckDbExecutionPlan(sql, null, 'user-1');
        const comparison = compareExecutionPlans(planOrig, planOpt);

        assert.strictEqual(comparison.is_identical, true, 'Identical queries must produce identical plans');
        assert.ok(comparison.identical_notice.includes('Native DuckDB optimizer already applied this optimization'));
        assert.ok(comparison.original_operators.length > 0);
        assert.ok(comparison.original_projected_columns.length > 0);
    });

    // ── Test 2: Projection Pushdown Metrics ───────────────────────────────────
    await runTest('Projection Pushdown Metrics: Columns, Pruning & Non-Negative Savings', async () => {
        const sql = "SELECT * FROM read_parquet('10M/products.parquet') LIMIT 100";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        const cProj = res.cards.projection;

        assert.strictEqual(cProj.detected, true);
        assert.strictEqual(cProj.total_available_columns, 5, 'products has 5 columns');
        assert.strictEqual(cProj.required_columns_count, 4, '4 columns selected');
        assert.strictEqual(cProj.columns_eliminated_count, 1, '1 column (list_price) eliminated');
        assert.ok(cProj.estimated_bytes_eliminated > 0, 'Bytes eliminated must be positive');
        assert.ok(cProj.estimated_scan_reduction_pct >= 0, 'Must never report negative scan reduction');
        assert.strictEqual(Object.is(cProj.estimated_scan_reduction_pct, -0), false, 'Must never be -0');
    });

    // ── Test 3: Partition Pruning Verification Consistency ────────────────────
    await runTest('Partition Pruning & Plan Card Consistency (Files, Scanned, Skipped, Pct)', async () => {
        const sql = "SELECT order_id, order_amount FROM read_parquet('10M/sales_orders.parquet') WHERE order_date >= DATE '2026-01-01'";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-1');
        const cPart = res.cards.partition;
        const cPlan = res.cards.execution_plan;

        assert.strictEqual(cPart.status, 'FILTER_ACTIVE');
        assert.strictEqual(cPart.total_files, 4);
        assert.strictEqual(cPart.scanned_files, 1);
        assert.strictEqual(cPart.skipped_files, 3);
        assert.strictEqual(cPart.pruning_pct, 75.0);

        // Consistency assertion: Plan Card partition metrics must match Partition Card exactly
        assert.strictEqual(cPlan.partition_metrics.total_files, cPart.total_files);
        assert.strictEqual(cPlan.partition_metrics.scanned_files, cPart.scanned_files);
        assert.strictEqual(cPlan.partition_metrics.skipped_files, cPart.skipped_files);
        assert.strictEqual(cPlan.partition_metrics.pruning_pct, cPart.pruning_pct);
    });

    // ── Test 4: Benchmark Workflow & SQL Result Equivalence ───────────────────
    await runTest('Benchmark Workflow: Captures Duration, Scan, Memory, Cache, and Result Equivalence', async () => {
        const originalSql = "SELECT product_id, product_name, product_category, product_tier, list_price FROM read_parquet('10M/products.parquet') LIMIT 50";
        const optimizedSql = "SELECT product_id, product_name, product_category, product_tier FROM read_parquet('10M/products.parquet') LIMIT 50";

        const bench = await runQueryBenchmark({
            originalSql,
            optimizedSql,
            targetId: null,
            tenantId: 'tenant-test',
            userId: 'user-bench'
        });

        assert.strictEqual(bench.success, true);
        assert.ok(bench.original.duration_ms >= 0);
        assert.ok(bench.original.scan_bytes > 0);
        assert.ok(bench.original.scan_formatted);
        assert.ok(bench.original.total_files >= 1);
        assert.ok(bench.original.cache_status);
        assert.ok(bench.optimized.duration_ms >= 0);
        assert.ok(bench.optimized.scan_bytes > 0);
        assert.ok(bench.optimized.scan_formatted);
        assert.ok(bench.savings.scan_reduction_pct >= 0);

        // Verification of Result Equivalence
        assert.ok(bench.result_equivalence, 'Must return result_equivalence');
        assert.strictEqual(bench.result_equivalence.row_count_match, true, 'Row counts must match');
        assert.strictEqual(bench.result_equivalence.sample_data_match, true, 'Sample data columns must match');
        assert.strictEqual(bench.result_equivalence.verified, true, 'Equivalence must be verified');
        assert.ok(bench.result_equivalence.badge_text.includes('EQUIVALENT'));

        // Execution Plan Comparison inside Benchmark
        assert.ok(bench.execution_plans.comparison);
        assert.ok(bench.execution_plans.comparison.original_operators.length > 0);
        assert.ok(bench.execution_plans.comparison.optimized_operators.length > 0);
    });

    // ── Test 5: Multi-Table Joins & Aggregations Extraction ────────────────────
    await runTest('Plan Extraction: Joins, Aggregations, Table Scans, and Pushdowns', async () => {
        const sql = `
            SELECT o.region_id, COUNT(*), SUM(o.order_amount)
            FROM sales_orders o
            JOIN regions r ON o.region_id = r.region_id
            WHERE o.order_date >= DATE '2026-01-01'
            GROUP BY o.region_id
        `;
        const plan = await getDuckDbExecutionPlan(sql, null, 'user-join');

        assert.ok(plan.operators.includes('Hash Join') || plan.operators.includes('Filter'));
        assert.ok(plan.join_operators.length > 0, 'Should detect join operator');
        assert.ok(plan.aggregation_operators.length > 0, 'Should detect aggregation operator');
        assert.ok(plan.table_scans.length >= 1, 'Should extract table scans');
        assert.ok(plan.filter_pushdown_status.includes('Active / Enabled'));
    });

    // ── Test 6: ML Prediction Integration in Analysis ─────────────────────────
    await runTest('ML Prediction Integration: Model Version, Confidence & Predictions', async () => {
        const sql = "SELECT * FROM read_parquet('10M/sales_orders.parquet') LIMIT 100";
        const res = await analyzeQueryIntelligence(sql, null, 'tenant-ml');

        assert.ok(res.summary.predicted);
        assert.ok(res.summary.predicted.model_version.includes('XGBoost'));
        assert.ok(res.summary.predicted.confidence_score > 0);
        assert.ok(res.summary.predicted.scan_reduction_pct > 0);
        assert.ok(res.summary.predicted.cost_savings_usd >= 0);
    });

    console.log('\n======================================================================');
    console.log('  🎉 ALL PHASE 2 VERIFICATION & BENCHMARK TESTS PASSED!');
    console.log('======================================================================\n');
}

main().catch(err => {
    console.error('Fatal error in test suite:', err);
    process.exit(1);
});

