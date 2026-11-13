const assert = require('assert');
const { analyzeQueryIntelligence, runQueryBenchmark } = require('./src/services/query_optimizer');
const db = require('./src/db');

async function main() {
    console.log('======================================================================');
    console.log('  CloudObjectIQ AI Query Optimization - Accuracy & Truthfulness Test');
    console.log('======================================================================');

    await db.initDatabase();

    // ── Case 1: 10M/products.parquet with SELECT * (Unpartitioned Table) ──────
    console.log('\n[Case 1] 10M/products.parquet SELECT * (Flat single file):');
    const q1 = "SELECT * FROM read_parquet('10M/products.parquet') LIMIT 100;";
    const res1 = await analyzeQueryIntelligence(q1);
    console.log('  Status:', res1.status, `[${res1.status_badge.text}]`);
    console.log('  Card 1 (Projection):', res1.cards.projection.detected ? 'OPPORTUNITY FOUND' : 'OPTIMAL');
    console.log('  Card 1 Est Savings:', res1.cards.projection.estimated_scan_reduction_pct + '%');
    console.log('  Card 2 (Partition):', res1.cards.partition.badge_text, '| Status:', res1.cards.partition.status);
    console.log('  Card 4 (Plan Pushdown):', res1.cards.execution_plan.projection_pushdown_status);
    
    // Assertions for Case 1:
    assert.strictEqual(res1.cards.projection.detected, true, 'Should detect SELECT *');
    assert.strictEqual(res1.cards.partition.is_partitioned, false, 'products table is single flat file, NOT partitioned');
    assert.strictEqual(res1.cards.partition.badge_text, 'UNPARTITIONED', 'Badge must be UNPARTITIONED, not FILTER ACTIVE');
    assert.strictEqual(res1.cards.partition.potential_scan_reduction_pct, 0.0, 'No partition pruning savings on unpartitioned table');

    // ── Case 2: 10M/products.parquet with Explicit Columns (Already Optimal) ──
    console.log('\n[Case 2] 10M/products.parquet Explicit Columns (Optimal Query):');
    const q2 = "SELECT product_id, product_name, product_category, product_tier FROM read_parquet('10M/products.parquet') LIMIT 100;";
    const res2 = await analyzeQueryIntelligence(q2);
    console.log('  Status:', res2.status, `[${res2.status_badge.text}]`);
    console.log('  Opportunities:', res2.summary.total_opportunities);
    console.log('  Predicted Scan Savings:', res2.summary.predicted.scan_reduction_pct + '%');
    console.log('  Card 1 (Projection):', res2.cards.projection.detected ? 'OPPORTUNITY FOUND' : 'OPTIMAL');
    console.log('  Card 2 (Partition):', res2.cards.partition.badge_text);

    // Assertions for Case 2:
    assert.strictEqual(res2.summary.total_opportunities, 0, 'Zero opportunities for optimal query');
    assert.strictEqual(res2.status, 'Optimized', 'Status must be Optimized when 0 opportunities');
    assert.strictEqual(res2.cards.projection.detected, false, 'Projection already optimal');
    assert.strictEqual(res2.summary.predicted.scan_reduction_pct, 0.0, 'No scan reduction reported when optimal');

    // ── Case 3: 10M/sales_orders.parquet without Date Filter ──────────────────
    console.log('\n[Case 3] 10M/sales_orders.parquet without Date Filter:');
    const q3 = "SELECT order_id, customer_id, order_date, order_amount FROM read_parquet('10M/sales_orders.parquet') LIMIT 100;";
    const res3 = await analyzeQueryIntelligence(q3);
    console.log('  Status:', res3.status, `[${res3.status_badge.text}]`);
    console.log('  Card 2 (Partition):', res3.cards.partition.badge_text, '| Missing:', res3.cards.partition.missing_partition_columns.join(', '));
    console.log('  Recommended Filter:', res3.cards.partition.recommended_filter_clause);
    
    // Assertions for Case 3:
    assert.strictEqual(res3.cards.partition.detected, true, 'Should detect missing partition filter on sales_orders');
    assert.ok(res3.cards.partition.badge_text.includes('MISSING'), 'Badge should indicate MISSING');
    assert.ok(res3.cards.partition.missing_partition_columns.includes('order_date'));

    // ── Case 4: 10M/sales_orders.parquet with Date Filter (Optimal) ───────────
    console.log('\n[Case 4] 10M/sales_orders.parquet with Date Filter:');
    const q4 = "SELECT order_id, customer_id, order_date, order_amount FROM read_parquet('10M/sales_orders.parquet') WHERE order_date >= DATE '2026-01-01' AND order_date < DATE '2027-01-01' LIMIT 100;";
    const res4 = await analyzeQueryIntelligence(q4);
    console.log('  Status:', res4.status, `[${res4.status_badge.text}]`);
    console.log('  Opportunities:', res4.summary.total_opportunities);
    console.log('  Card 2 (Partition):', res4.cards.partition.badge_text);
    console.log('  Card 4 Filter Pushdown:', res4.cards.execution_plan.filter_pushdown_status);

    // Assertions for Case 4:
    assert.strictEqual(res4.summary.total_opportunities, 0, 'Zero opportunities for query with date filter & explicit projection');
    assert.strictEqual(res4.status, 'Optimized');
    assert.strictEqual(res4.cards.partition.badge_text, 'FILTER ACTIVE');
    assert.ok(res4.cards.execution_plan.filter_pushdown_status.includes('Active / Enabled'));

    // ── Case 5: Execution Plan Verification ───────────────────────────────────
    console.log('\n[Case 5] Execution Plan Comparison Structure:');
    console.log('  Original Plan Type:', res4.execution_plans.original.plan_type);
    console.log('  Optimized Plan Type:', res4.execution_plans.optimized.plan_type);
    console.log('  Original Operators:', res4.execution_plans.original.operators.join(' -> '));
    console.log('  Pushdowns:', res4.execution_plans.original.filter_pushdown_status);

    assert.ok(res4.execution_plans.original.operators.length > 0);
    assert.ok(res4.execution_plans.original.plan_type);

    console.log('\n======================================================================');
    console.log('  ✅ ALL BENCHMARK ACCURACY & TRUTHFULNESS TESTS PASSED!');
    console.log('======================================================================\n');
}

main().catch(err => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
