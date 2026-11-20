/**
 * CloudObjectIQ - Query Engine Registry & Factory
 * Manages engine lifecycle, feature flag gating, and capability discovery.
 */

const DuckDBEngine = require('./duckdb');
const SparkEngine = require('./spark');
const DorisEngine = require('./doris');
const { isFeatureEnabled } = require('../../utils/feature_flags');

class EngineRegistry {
  constructor() {
    this.engines = new Map();
    this._initializeDefaultEngines();
  }

  _initializeDefaultEngines() {
    // 1. DuckDB: Primary in-memory single-node engine (always enabled)
    this.engines.set('duckdb', new DuckDBEngine());

    // 2. Spark: Distributed batch, Hadoop & ORC engine (enabled)
    this.engines.set('spark', new SparkEngine());

    // 3. Apache Doris: Optional distributed MPP engine (feature-flagged)
    this.engines.set('doris', new DorisEngine());
  }

  /**
   * Retrieve an engine instance by ID with feature flag validation
   * @param {string} engineId - 'duckdb' | 'doris' | 'spark'
   * @returns {BaseQueryEngine}
   */
  getEngine(engineId = 'duckdb') {
    const id = String(engineId || 'duckdb').toLowerCase().trim();

    if (id === 'doris') {
      if (!isFeatureEnabled('ENABLE_DORIS_ENGINE')) {
        throw new Error(
          "Apache Doris distributed engine is currently disabled by system feature flag (ENABLE_DORIS_ENGINE=false). " +
          "To enable, set ENABLE_DORIS_ENGINE=true or switch to 'duckdb'."
        );
      }
    }

    const engine = this.engines.get(id);
    if (!engine) {
      throw new Error(`Unknown query engine: '${engineId}'. Supported engines: ${Array.from(this.engines.keys()).join(', ')}`);
    }

    return engine;
  }

  /**
   * Return metadata for all registered engines, indicating if enabled
   * @returns {Array<Object>}
   */
  listAvailableEngines() {
    const isDorisEnabled = isFeatureEnabled('ENABLE_DORIS_ENGINE');
    const isDqeEnabled = isFeatureEnabled('ENABLE_DQE');
    const isAutoEnabled = isFeatureEnabled('ENABLE_AUTO_ROUTING');

    return [
      {
        id: 'auto',
        name: 'Intelligent Auto-Routing',
        description: 'Dynamically routes between DuckDB, Doris, and Spark based on dataset size, joins, and SQL complexity',
        enabled: isAutoEnabled || isDqeEnabled,
        distributed: true,
        recommendedFor: 'Adaptive multi-engine query optimization'
      },
      {
        id: 'duckdb',
        name: 'DuckDB (In-Memory)',
        description: 'Vectorized single-node engine optimized for queries < 5GB, Parquet, and CSV',
        enabled: true,
        distributed: false,
        recommendedFor: 'Interactive queries, exploratory data analysis'
      },
      {
        id: 'doris',
        name: 'Apache Doris (Distributed MPP)',
        description: 'Massively Parallel Processing (MPP) distributed engine for large-scale joins, aggregations, and high concurrency',
        enabled: isDorisEnabled,
        distributed: true,
        recommendedFor: 'Enterprise queries > 5GB, distributed joins, large aggregations'
      },
      {
        id: 'spark',
        name: 'Apache Spark (Batch / Hadoop)',
        description: 'Fault-tolerant distributed batch processing for ORC, Hadoop HDFS, and heavy ETL',
        enabled: true,
        distributed: true,
        recommendedFor: 'Hadoop data, ORC files, long-running batch jobs'
      }
    ];
  }

  /**
   * Check health of all registered engines
   * @returns {Promise<Record<string, Object>>}
   */
  async checkAllHealth() {
    const health = {};
    for (const [id, engine] of this.engines.entries()) {
      try {
        if (id === 'doris' && !isFeatureEnabled('ENABLE_DORIS_ENGINE')) {
          health[id] = { healthy: false, disabled: true, message: 'Disabled by feature flag' };
          continue;
        }
        health[id] = await engine.getHealthStatus();
      } catch (err) {
        health[id] = { healthy: false, error: err.message };
      }
    }
    return health;
  }
}

const engineRegistry = new EngineRegistry();

module.exports = {
  engineRegistry,
  getEngine: (id) => engineRegistry.getEngine(id),
  listAvailableEngines: () => engineRegistry.listAvailableEngines(),
  checkAllHealth: () => engineRegistry.checkAllHealth()
};
