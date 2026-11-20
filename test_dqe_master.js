/**
 * CloudObjectIQ - Distributed Query Execution (DQE) Master Verification Suite
 * Tests unified engine abstraction, feature flags, routing heuristics, and telemetry integration.
 */

const assert = require('assert');
const { isFeatureEnabled, setFeatureFlag, getAllFeatureFlags } = require('./src/utils/feature_flags');
const { engineRegistry, getEngine, listAvailableEngines, checkAllHealth } = require('./src/query/engines');
const { queryRouter, routeAndExecute, routeAndExplain, resolveEngine } = require('./src/query/router');
const DorisEngine = require('./src/query/engines/doris');
const DuckDBEngine = require('./src/query/engines/duckdb');
const SparkEngine = require('./src/query/engines/spark');

async function runDqeMasterTests() {
  console.log('🧪 Starting CloudObjectIQ Distributed Query Execution (DQE) Test Suite...\n');

  // Test 1: Feature Flags Defaults
  console.log('Test 1: Verifying Feature Flag Defaults');
  assert.strictEqual(isFeatureEnabled('ENABLE_DORIS_ENGINE'), false, 'Doris must be disabled by default');
  assert.strictEqual(isFeatureEnabled('ENABLE_DQE'), false, 'DQE must be disabled by default');
  assert.strictEqual(isFeatureEnabled('ENABLE_AUTO_ROUTING'), false, 'Auto routing must be disabled by default');
  console.log('  ✅ Pass: Safe feature flag defaults verified (Doris, DQE, and AUTO disabled by default).\n');

  // Test 2: Engine Registry & Gating
  console.log('Test 2: Verifying Engine Registry & Feature Gating');
  const duckdb = getEngine('duckdb');
  assert.ok(duckdb instanceof DuckDBEngine, 'Should resolve DuckDBEngine');
  assert.strictEqual(duckdb.id, 'duckdb');

  const spark = getEngine('spark');
  assert.ok(spark instanceof SparkEngine, 'Should resolve SparkEngine');
  assert.strictEqual(spark.id, 'spark');

  // Doris should throw when disabled
  let threwWhenDisabled = false;
  try {
    getEngine('doris');
  } catch (err) {
    threwWhenDisabled = true;
    assert.ok(err.message.includes('ENABLE_DORIS_ENGINE'), 'Error must specify feature flag');
  }
  assert.strictEqual(threwWhenDisabled, true, 'Doris engine must not be accessible when disabled');

  // Enable Doris dynamically
  setFeatureFlag('ENABLE_DORIS_ENGINE', true);
  const doris = getEngine('doris');
  assert.ok(doris instanceof DorisEngine, 'Should resolve DorisEngine when flag is enabled');
  assert.strictEqual(doris.id, 'doris');
  console.log('  ✅ Pass: Engine Registry and Feature Flag gating validated.\n');

  // Test 3: Engine Discovery Matrix
  console.log('Test 3: Listing Available Engines');
  const engines = listAvailableEngines();
  assert.strictEqual(engines.length, 4, 'Must list auto, duckdb, doris, and spark');
  const dorisEntry = engines.find(e => e.id === 'doris');
  assert.strictEqual(dorisEntry.enabled, true, 'Doris should show as enabled when flag is set');
  console.log('  ✅ Pass: Engine discovery matrix formatted properly.\n');

  // Test 4: Intelligent Query Routing Heuristics
  console.log('Test 4: Verifying Query Routing Heuristics');
  // ORC -> Spark
  const engineOrc = await resolveEngine({ sql: "SELECT * FROM read_orc('hdfs://warehouse/data.orc')", requestedEngine: 'auto' });
  assert.strictEqual(engineOrc, 'spark', 'ORC queries must route to Spark');

  // Small parquet -> DuckDB
  const engineSmall = await resolveEngine({ sql: "SELECT count(*) FROM 'customers.parquet'", requestedEngine: 'auto' });
  assert.strictEqual(engineSmall, 'duckdb', 'Standard parquet queries must route to DuckDB');

  // Explicit DuckDB
  const engineExplicit = await resolveEngine({ sql: "SELECT 1", requestedEngine: 'duckdb' });
  assert.strictEqual(engineExplicit, 'duckdb', 'Explicit DuckDB request honored');
  console.log('  ✅ Pass: Heuristic and explicit engine routing validated.\n');

  // Test 5: End-to-End DuckDB Execution via Unified DQE Router
  console.log('Test 5: Testing End-to-End Query Execution via Router');
  const execResult = await routeAndExecute({
    sql: 'SELECT 42 as answer, "CloudObjectIQ" as platform',
    targetId: 'local',
    userId: 'system-test',
    requestedEngine: 'duckdb',
    context: { tenantId: 'test-tenant' }
  });

  assert.strictEqual(execResult.rowCount, 1, 'Should return 1 row');
  assert.strictEqual(execResult.rows[0].answer, 42);
  assert.strictEqual(execResult.rows[0].platform, 'CloudObjectIQ');
  assert.strictEqual(execResult.routedEngine, 'duckdb');
  assert.ok(Array.isArray(execResult.stages), 'Must include visual pipeline stages');
  assert.ok(execResult.scanMeta !== undefined, 'Must attach scanMeta');
  console.log(`  ✅ Pass: Query returned ${execResult.rowCount} row in ${execResult.executionTimeMs}ms with ${execResult.stages.length} execution stages.\n`);

  // Test 6: Query Plan & Physical Stage Generation
  console.log('Test 6: Testing Explain Plan Stage Parsing');
  const explainResult = await routeAndExplain({
    sql: "SELECT sum(answer) FROM (SELECT 42 as answer) WHERE answer > 10 GROUP BY answer",
    targetId: 'local',
    userId: 'system-test',
    requestedEngine: 'duckdb'
  });

  assert.ok(explainResult.rawPlan, 'Must have raw physical plan');
  assert.ok(explainResult.stages.length > 0, 'Must have parsed visual stages');
  console.log(`  ✅ Pass: EXPLAIN generated ${explainResult.stages.length} visual stages for DuckDB.\n`);

  // Test 7: Doris Physical Plan Parser
  console.log('Test 7: Testing Doris Plan Parser');
  const sampleDorisPlan = `
    PLAN FRAGMENT 0
      OUTPUT EXPRS: sum(v1)
      PARTITION: UNPARTITIONED
      RESULT SINK
      AGGREGATE (merge finalize)
        output: sum(v1)
        group by: 
      EXCHANGE
    PLAN FRAGMENT 1
      OUTPUT EXPRS: 
      PARTITION: HASH_PARTITIONED: id
      STREAM DATA SINK
      AGGREGATE (update serialize)
        output: sum(v1)
        group by: 
      HASH JOIN (INNER JOIN)
        hash predicates: a.id = b.id
        TABLE: OlapScanNode
        TABLE: FileScanNode
  `;
  const dorisStages = doris._parseDorisStages(sampleDorisPlan);
  assert.ok(dorisStages.some(s => s.type === 'SCAN'), 'Must detect Scan stages');
  assert.ok(dorisStages.some(s => s.type === 'JOIN'), 'Must detect Distributed Hash Join');
  assert.ok(dorisStages.some(s => s.type === 'AGGREGATE'), 'Must detect MPP Aggregation');
  assert.ok(dorisStages.some(s => s.type === 'EXCHANGE'), 'Must detect Network Shuffle Exchange');
  console.log(`  ✅ Pass: Doris physical plan parsed into ${dorisStages.length} structured stages.\n`);

  // Test 8: Health Checks
  console.log('Test 8: Checking Multi-Engine Health Matrix');
  const health = await checkAllHealth();
  assert.ok(health.duckdb !== undefined, 'DuckDB health reported');
  assert.ok(health.spark !== undefined, 'Spark health reported');
  assert.ok(health.doris !== undefined, 'Doris health reported');
  console.log('  DuckDB Health:', health.duckdb.healthy ? 'HEALTHY' : 'UNHEALTHY');
  console.log('  Spark Health:', health.spark.healthy ? 'HEALTHY' : 'UNHEALTHY');
  console.log('  Doris Health:', health.doris.healthy ? 'HEALTHY' : 'OFFLINE / NOT RUNNING (Dev Mode)');
  console.log('  ✅ Pass: Multi-engine health telemetry functional.\n');

  // Restore flag to default
  setFeatureFlag('ENABLE_DORIS_ENGINE', false);
  console.log('🎉 All DQE Master Verification Tests Passed Successfully!');
}

runDqeMasterTests().catch(err => {
  console.error('❌ DQE Test Failure:', err);
  process.exit(1);
});
