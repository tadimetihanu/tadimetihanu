const assert = require('assert');
const { 
    analyzeQueryIntelligence, 
    generateRecommendedSql, 
    runQueryBenchmark 
} = require('./src/services/query_optimizer');
const { runQuery } = require('./src/query/engine');

async function runTestSuite() {
    console.log('========================================================================');
    console.log('🚀 CLOUDOBJECTIQ ADVANCED SQL OPTIMIZER VERIFICATION SUITE');
    console.log('========================================================================\n');

    // Test Query 1: The Canonical 100M Benchmark Query
    const benchmarkSql = `WITH regional_summary AS (
    SELECT 
        store_id,
        product_category,
        count(*) as total_txns,
        sum(amount) as total_revenue,
        rank() over (partition by store_id order by sum(amount) desc) as cat_rank,
        ntile(4) over (partition by store_id order by sum(amount) desc) as revenue_quartile,
        sum(sum(amount)) over (partition by store_id) as store_total_revenue
    FROM 'D:/minio_data/datalake/performance_100m.parquet'
    WHERE store_id <= 100
    GROUP BY store_id, product_category
),
filtered_stores AS (
    SELECT 
        store_id,
        sum(total_revenue) as net_store_revenue,
        avg(total_revenue) as avg_cat_revenue
    FROM regional_summary
    GROUP BY store_id
)
SELECT 
    f.store_id,
    f.net_store_revenue,
    f.avg_cat_revenue,
    r.total_revenue
FROM filtered_stores f
JOIN regional_summary r ON f.store_id = r.store_id
ORDER BY f.net_store_revenue DESC;`;

    console.log('--- TEST 1: Window Function Optimization Engine ---');
    const analysis = await analyzeQueryIntelligence(benchmarkSql);
    const winMetrics = analysis.cards.execution_plan.window_metrics;

    assert.strictEqual(winMetrics.has_redundant_window, true, 'Must detect redundant window functions');
    assert.strictEqual(winMetrics.redundant_window_operations.length, 3, 'Must detect exactly 3 redundant window functions (RANK, NTILE, SUM)');
    
    const redundantAliases = winMetrics.redundant_window_operations.map(o => o.alias);
    assert(redundantAliases.includes('cat_rank'), 'Must identify cat_rank as redundant');
    assert(redundantAliases.includes('revenue_quartile'), 'Must identify revenue_quartile as redundant');
    assert(redundantAliases.includes('store_total_revenue'), 'Must identify store_total_revenue as redundant');

    // Confirm that the recommended SQL pruned the redundant window functions
    assert(!analysis.optimized_sql.includes('cat_rank'), 'Recommended SQL must NOT contain cat_rank');
    assert(!analysis.optimized_sql.includes('revenue_quartile'), 'Recommended SQL must NOT contain revenue_quartile');
    assert(!analysis.optimized_sql.includes('store_total_revenue'), 'Recommended SQL must NOT contain store_total_revenue');
    console.log('✅ Window Function pruning verified: redundant window functions detected and pruned.');

    console.log('\n--- TEST 2: CTE Optimization Engine (Materialization vs Inlining) ---');
    const cteMetrics = analysis.cards.execution_plan.cte_metrics;
    assert.strictEqual(cteMetrics.has_opportunity, true, 'Must identify CTE materialization opportunity');
    assert.strictEqual(cteMetrics.materialization_candidates.length, 1, 'Must have 1 candidate: regional_summary');
    assert.strictEqual(cteMetrics.materialization_candidates[0].name, 'regional_summary');
    assert.strictEqual(cteMetrics.materialization_candidates[0].ref_count, 2, 'Must recognize 2 references to regional_summary');
    assert(analysis.optimized_sql.includes('WITH regional_summary AS MATERIALIZED'), 'Recommended SQL must include MATERIALIZED keyword');
    console.log('✅ CTE Optimization verified: repeatedly referenced CTE flagged and MATERIALIZED applied.');

    console.log('\n--- TEST 3: Aggregation Optimization Analysis ---');
    const aggMetrics = analysis.cards.execution_plan.aggregation_metrics;
    assert.strictEqual(aggMetrics.has_aggregations, true, 'Must detect aggregations');
    assert(aggMetrics.sum_count > 0, 'Must detect SUM');
    assert(aggMetrics.avg_count > 0, 'Must detect AVG');
    assert(aggMetrics.group_by_columns.length > 0, 'Must detect GROUP BY');
    console.log('✅ Aggregation Optimization verified: standard aggregations (SUM, AVG, GROUP BY) analyzed.');

    // Test Query 3B: Expensive Aggregations (COUNT DISTINCT, MEDIAN, STDDEV_SAMP)
    const expensiveAggSql = `SELECT 
        store_id, 
        count(distinct customer_id) as unique_customers,
        median(amount) as median_spend,
        stddev_samp(amount) as spend_stddev
    FROM 'D:/minio_data/datalake/performance_100m.parquet'
    WHERE store_id <= 10
    GROUP BY store_id`;
    const expAnalysis = await analyzeQueryIntelligence(expensiveAggSql);
    const expAggMetrics = expAnalysis.cards.execution_plan.aggregation_metrics;
    assert.strictEqual(expAggMetrics.has_expensive_aggregations, true, 'Must detect expensive aggregations');
    const expTypes = expAggMetrics.expensive_aggregations.map(a => a.type);
    assert(expTypes.includes('COUNT_DISTINCT'), 'Must flag COUNT DISTINCT');
    assert(expTypes.includes('MEDIAN'), 'Must flag MEDIAN');
    assert(expTypes.includes('STDDEV_SAMP'), 'Must flag STDDEV_SAMP');
    console.log('✅ Expensive Aggregation detection verified (COUNT DISTINCT, MEDIAN, STDDEV_SAMP flagged).');

    console.log('\n--- TEST 4: Cardinality-Aware Sorting Optimization ---');
    const sortMetrics = analysis.cards.execution_plan.sorting_metrics;
    assert.strictEqual(sortMetrics.has_order_by, true, 'Must detect ORDER BY');
    assert.strictEqual(sortMetrics.has_limit, false, 'Must detect absence of LIMIT');
    assert.strictEqual(sortMetrics.is_post_aggregation, true, 'Must recognize post-aggregation sort');
    assert.strictEqual(sortMetrics.is_confirmed_bottleneck, false, 'Must NOT classify post-aggregation sort as a bottleneck');
    assert.strictEqual(sortMetrics.classification, 'INFORMATIONAL', 'Must classify as INFORMATIONAL');
    console.log('✅ Cardinality-aware sorting verified: post-aggregation sort without LIMIT is NOT falsely classified as a bottleneck.');

    // Test Query 4B: Raw unaggregated fact table sort without LIMIT -> Genuine Spill Risk!
    const unaggregatedSortSql = `SELECT transaction_id, customer_id, amount 
    FROM 'D:/minio_data/datalake/performance_100m.parquet' 
    ORDER BY amount DESC`;
    const unaggSortAnalysis = await analyzeQueryIntelligence(unaggregatedSortSql);
    const unaggSortMetrics = unaggSortAnalysis.cards.execution_plan.sorting_metrics;
    assert.strictEqual(unaggSortMetrics.is_confirmed_bottleneck, true, 'Unaggregated fact sort must be a confirmed bottleneck');
    assert.strictEqual(unaggSortMetrics.classification, 'OPPORTUNITY', 'Must classify unaggregated sort as an OPPORTUNITY');
    console.log('✅ Raw unaggregated fact sort correctly flagged as genuine memory spill risk.');

    console.log('\n--- TEST 5: Dashboard Consistency & Categorization ---');
    // Card 4 detected is true because benchmarkSql has window pruning and CTE materialization
    assert.strictEqual(analysis.cards.execution_plan.detected, true, 'Card 4 detected must be true on genuine opportunity');
    assert.strictEqual(analysis.summary.total_opportunities >= 1, true, 'Opportunities Detected KPI must be incremented');

    const card4 = analysis.cards.execution_plan;
    assert(Array.isArray(card4.optimization_opportunities), 'Must have optimization_opportunities array');
    assert(Array.isArray(card4.performance_warnings), 'Must have performance_warnings array');
    assert(Array.isArray(card4.informational_observations), 'Must have informational_observations array');
    assert(Array.isArray(card4.already_optimized_operations), 'Must have already_optimized_operations array');

    assert(card4.optimization_opportunities.length > 0, 'Must contain actionable optimization opportunities');
    assert(card4.informational_observations.length > 0, 'Must contain informational post-aggregation sort observation');
    assert(card4.already_optimized_operations.length > 0, 'Must contain streaming aggregation already optimized note');
    console.log('✅ Dashboard Consistency verified: 4 distinct categories properly populated and KPI updated.');

    console.log('\n--- TEST 6: Benchmark Verification & Result Equivalence on 100M Dataset ---');
    console.log('Executing live benchmark against 100M-row Parquet dataset...');
    const benchmark = await runQueryBenchmark({
        originalSql: analysis.original_sql,
        optimizedSql: analysis.optimized_sql,
        targetId: null
    });

    console.log('Baseline Duration:', benchmark.original.duration_ms + 'ms');
    console.log('Optimized Duration:', benchmark.optimized.duration_ms + 'ms');
    console.log('Baseline Memory:', benchmark.original.memory_formatted);
    console.log('Optimized Memory:', benchmark.optimized.memory_formatted);
    console.log('Baseline Disk Spill:', benchmark.original.temp_disk_formatted);
    console.log('Optimized Disk Spill:', benchmark.optimized.temp_disk_formatted);
    console.log('Baseline Rows:', benchmark.original.rows);
    console.log('Optimized Rows:', benchmark.optimized.rows);
    console.log('Query Cost:', benchmark.original.cost_formatted, '->', benchmark.optimized.cost_formatted);

    assert.strictEqual(benchmark.original.rows, 495, 'Original query must return 495 rows on 100M dataset');
    assert.strictEqual(benchmark.optimized.rows, 495, 'Optimized query must return 495 rows on 100M dataset');
    assert.strictEqual(benchmark.result_equivalence.verified, true, 'Result equivalence must be mathematically verified');
    assert.strictEqual(benchmark.result_equivalence.row_count_match, true, 'Row counts must match');
    assert.strictEqual(benchmark.result_equivalence.sample_data_match, true, 'Sample data values must match');

    // Confirm no hardcoded numbers
    assert.notStrictEqual(benchmark.original.scan_bytes, 25000000, 'Original scan must not be hardcoded 25MB fallback');
    assert.notStrictEqual(benchmark.original.duration_ms, 320, 'Original duration must not be hardcoded 320ms fallback');
    assert.notStrictEqual(benchmark.optimized.scan_bytes, 6500000, 'Optimized scan must not be hardcoded 6.5MB fallback');
    assert.notStrictEqual(benchmark.optimized.duration_ms, 110, 'Optimized duration must not be hardcoded 110ms fallback');

    console.log('✅ Benchmark verification passed: live telemetry captured and result equivalence verified!');

    console.log('\n========================================================================');
    console.log('🎉 ALL ADVANCED SQL OPTIMIZER TESTS PASSED SUCCESSFULLY!');
    console.log('========================================================================\n');
}

runTestSuite().catch(err => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
});
