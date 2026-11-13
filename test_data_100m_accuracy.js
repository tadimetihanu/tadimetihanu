const assert = require('assert');
const { analyzeQueryIntelligence, discoverTableColumns } = require('./src/services/query_optimizer');

async function runTests() {
    console.log('======================================================================');
    console.log('  Testing Schema Accuracy & Hallucination Prevention on Benchmark Data');
    console.log('======================================================================');

    // 1. Check discoverTableColumns for data_100M
    console.log('\n[Check 1] discoverTableColumns for data_100M:');
    const cols100M = await discoverTableColumns('data_100M.parquet');
    console.log('  Discovered Columns:', cols100M);
    assert.deepStrictEqual(cols100M, ['id', 'value', 'category'], 'Columns for data_100M must match exact Parquet schema');

    // 2. Query analysis for SELECT * on data_100M.parquet
    console.log('\n[Check 2] Analysis of SELECT * FROM read_parquet(\'data_100M.parquet\') LIMIT 100;');
    const q100M = "SELECT * FROM read_parquet('data_100M.parquet') LIMIT 100;";
    const res100M = await analyzeQueryIntelligence(q100M);
    
    console.log('  Status:', res100M.status, `[${res100M.status_badge.text}]`);
    console.log('  Total Opportunities:', res100M.summary.total_opportunities);
    console.log('  Card 1 (Projection):', res100M.cards.projection.badge_text);
    console.log('  Card 1 Available Columns:', res100M.cards.projection.total_available_columns);
    console.log('  Card 1 Eliminated Columns:', res100M.cards.projection.columns_eliminated_count);
    console.log('  Card 1 Est Scan Savings:', res100M.cards.projection.estimated_scan_reduction_pct + '%');
    console.log('  Card 2 (Partition):', res100M.cards.partition.badge_text);
    console.log('  Card 3 (Format):', res100M.cards.storage_format.badge_text);
    console.log('  Card 4 (Plan):', res100M.cards.execution_plan.badge_text);
    console.log('  Recommended SQL:', res100M.optimized_sql);

    // Assertions for data_100M
    assert.strictEqual(res100M.cards.projection.badge_text, 'OPTIMAL PROJECTION', 'Should be OPTIMAL PROJECTION since table is narrow (3 cols)');
    assert.strictEqual(res100M.cards.projection.columns_eliminated_count, 0, 'Zero columns eliminated');
    assert.strictEqual(res100M.cards.projection.estimated_scan_reduction_pct, 0.0, 'Zero savings claimed');
    assert.strictEqual(res100M.summary.total_opportunities, 0, 'Zero opportunities for narrow 3-column table');
    assert.strictEqual(res100M.status, 'Optimized', 'Status must be Optimized');
    assert.strictEqual(res100M.optimized_sql.trim(), q100M.trim(), 'Original SQL preserved, no hallucinated rewrites');
    assert.ok(!res100M.optimized_sql.includes('name'), 'Must not hallucinate "name"');
    assert.ok(!res100M.optimized_sql.includes('status'), 'Must not hallucinate "status"');

    // 3. Wide Table (10M/sales_orders.parquet) SELECT *
    console.log('\n[Check 3] Analysis of SELECT * FROM read_parquet(\'10M/sales_orders.parquet\') LIMIT 100;');
    const qSales = "SELECT * FROM read_parquet('10M/sales_orders.parquet') LIMIT 100;";
    const resSales = await analyzeQueryIntelligence(qSales);
    console.log('  Status:', resSales.status);
    console.log('  Card 1 Badge:', resSales.cards.projection.badge_text);
    console.log('  Total Columns:', resSales.cards.projection.total_available_columns);
    console.log('  Required Columns:', resSales.cards.projection.required_columns);
    console.log('  Eliminated Columns:', resSales.cards.projection.columns_eliminated);
    console.log('  Recommended SQL:', resSales.optimized_sql);

    // Verify all recommended columns exist in sales_orders
    const knownSalesCols = ['order_id', 'customer_id', 'product_id', 'region_id', 'order_date', 'quantity', 'unit_price', 'discount', 'order_status', 'order_amount'];
    for (const c of resSales.cards.projection.required_columns) {
        assert.ok(knownSalesCols.includes(c), `Recommended column "${c}" must exist in sales_orders schema`);
    }

    console.log('\n======================================================================');
    console.log('  ✅ ALL SCHEMA ACCURACY & HALLUCINATION PREVENTION CHECKS PASSED!');
    console.log('======================================================================');
    process.exit(0);
}

runTests().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});
