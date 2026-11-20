/**
 * CloudObjectIQ - Intelligent Query Router & Distributed Query Orchestrator
 * Analyzes SQL queries, evaluates dataset metrics, and orchestrates execution across DuckDB, Doris, and Spark.
 */

const { getEngine, listAvailableEngines } = require('./engines');
const { isFeatureEnabled } = require('../utils/feature_flags');
const db = require('../db');
const logger = require('../utils/logger');

class QueryRouter {
  constructor() {
    this.dorisSizeThresholdBytes = Number(process.env.DORIS_SIZE_THRESHOLD_MB || 5000) * 1024 * 1024; // 5GB default
  }

  /**
   * Route and execute a query across the optimal engine
   * @param {Object} params
   * @param {string} params.sql
   * @param {string} params.targetId
   * @param {string} params.userId
   * @param {string} [params.requestedEngine='auto']
   * @param {Object} [params.context={}]
   * @param {number} [params.timeoutMs=300000]
   * @returns {Promise<Object>}
   */
  async routeAndExecute({ sql, targetId, userId, requestedEngine = 'auto', context = {}, timeoutMs = 300000 }) {
    const selectedEngineId = await this.resolveEngine({
      sql,
      targetId,
      requestedEngine: String(requestedEngine || 'auto').toLowerCase().trim(),
      context
    });

    const engine = getEngine(selectedEngineId);
    logger.logInfo('router', `Routing query to [${engine.id.toUpperCase()}] engine: ${sql.substring(0, 80)}...`);

    const result = await engine.executeQuery({
      sql,
      targetId,
      userId,
      context: {
        ...context,
        routedEngine: selectedEngineId,
        requestedEngine
      },
      timeoutMs
    });

    // Ensure engine metadata is stamped on result
    result.routedEngine = selectedEngineId;
    result.requestedEngine = requestedEngine;
    if (result.scanMeta) {
      result.scanMeta.engine = selectedEngineId;
    }

    return result;
  }

  /**
   * Produce query execution plan for the appropriate engine
   */
  async routeAndExplain({ sql, targetId, userId, requestedEngine = 'auto', context = {} }) {
    const selectedEngineId = await this.resolveEngine({
      sql,
      targetId,
      requestedEngine: String(requestedEngine || 'auto').toLowerCase().trim(),
      context
    });

    const engine = getEngine(selectedEngineId);
    const plan = await engine.explainQuery({
      sql,
      targetId,
      userId,
      context: {
        ...context,
        routedEngine: selectedEngineId,
        requestedEngine
      }
    });

    return {
      ...plan,
      routedEngine: selectedEngineId,
      requestedEngine
    };
  }

  /**
   * Resolve target engine using deterministic heuristics and conservative fallback policies
   */
  async resolveEngine({ sql, targetId, requestedEngine, context }) {
    // 1. Explicit Engine Selection
    if (requestedEngine && requestedEngine !== 'auto') {
      if (requestedEngine === 'doris') {
        if (!isFeatureEnabled('ENABLE_DORIS_ENGINE')) {
          throw new Error('Apache Doris distributed engine is currently disabled by system feature flag. Enable ENABLE_DORIS_ENGINE=true to use Doris.');
        }
      }
      return requestedEngine;
    }

    // 2. AUTO Mode Heuristics (Conservative Routing)
    const lowerSql = sql.toLowerCase();

    // Check for Hadoop / ORC queries -> SPARK
    if (lowerSql.includes('read_orc') || lowerSql.includes('.orc') || lowerSql.includes('hdfs://')) {
      return 'spark';
    }

    // Check if Doris is enabled
    const dorisAvailable = isFeatureEnabled('ENABLE_DORIS_ENGINE');
    if (!dorisAvailable) {
      // Conservative default: DuckDB
      return 'duckdb';
    }

    // Evaluate Dataset Size and Joins for Doris routing
    try {
      const estimatedSize = await this._estimateQueryScanSize(sql, targetId);
      const hasDistributedJoins = (lowerSql.match(/join/g) || []).length >= 2;
      const hasHeavyAggregations = lowerSql.includes('group by') && (lowerSql.includes('count(distinct') || lowerSql.includes('approx_count_distinct'));

      if (estimatedSize > this.dorisSizeThresholdBytes || (hasDistributedJoins && estimatedSize > 1024 * 1024 * 1024)) {
        logger.logInfo('router', `Auto-routing to Doris: Estimated size ${(estimatedSize / (1024 * 1024)).toFixed(1)}MB exceeds threshold.`);
        return 'doris';
      }

      if (hasHeavyAggregations && estimatedSize > 2048 * 1024 * 1024) {
        return 'doris';
      }
    } catch (err) {
      console.warn('[Router Heuristics Notice]', err.message);
    }

    // Conservative default: DuckDB
    return 'duckdb';
  }

  /**
   * Estimate total data volume involved in query from metadata catalog
   */
  async _estimateQueryScanSize(sql, targetId) {
    if (!targetId || targetId === 'local') return 0;

    const fileMatches = sql.match(/['"]([^'"]+\.(?:parquet|csv|json|orc))['"]/gi) || [];
    let totalBytes = 0;

    for (const match of fileMatches) {
      const filename = match.replace(/['"]/g, '');
      const meta = await db.get(
        'SELECT file_size FROM metadata_catalog WHERE target_id = ? AND (file_name = ? OR file_path LIKE ?)',
        [targetId, filename, `%${filename}%`]
      );
      if (meta && meta.file_size) {
        totalBytes += Number(meta.file_size);
      }
    }

    return totalBytes;
  }
}

const queryRouter = new QueryRouter();

module.exports = {
  queryRouter,
  routeAndExecute: (params) => queryRouter.routeAndExecute(params),
  routeAndExplain: (params) => queryRouter.routeAndExplain(params),
  resolveEngine: (params) => queryRouter.resolveEngine(params)
};
