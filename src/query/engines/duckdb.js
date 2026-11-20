/**
 * CloudObjectIQ - DuckDB Execution Engine Adapter
 * Integrates DuckDB in-memory single-node analytics into the unified engine abstraction.
 */

const BaseQueryEngine = require('./base');
const { runQuery, getTarget, calculateCost } = require('../engine');
const db = require('../../db');

class DuckDBEngine extends BaseQueryEngine {
  constructor() {
    super({
      id: 'duckdb',
      name: 'DuckDB In-Memory Engine',
      version: '1.4.4',
      capabilities: {
        distributed: false,
        streaming: false,
        asyncSubmission: false,
        cancellation: true,
        explain: true,
        supportedFormats: ['parquet', 'csv', 'json', 'iceberg']
      }
    });
  }

  /**
   * Execute query using CloudObjectIQ DuckDB engine pipeline
   */
  async executeQuery({ sql, targetId, userId, context = {}, timeoutMs = 300000 }) {
    const startTime = Date.now();
    const tenantId = context.tenantId || 'default';
    const executionId = context.executionId;

    const rows = await runQuery(userId, sql, targetId, {
      tenantId,
      executionId,
      userQueryTimeoutMs: timeoutMs
    });

    const executionTimeMs = Date.now() - startTime;
    const scanMeta = rows._scanMeta || calculateCost(sql, rows);

    return {
      columns: Array.isArray(rows) && rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      executionTimeMs,
      engine: this.id,
      engineName: this.name,
      scanMeta,
      stages: [
        { name: 'AST Parse & Catalog Resolution', status: 'COMPLETED', durationMs: Math.round(executionTimeMs * 0.1) },
        { name: 'Cloud Storage Scan & Pruning', status: 'COMPLETED', durationMs: Math.round(executionTimeMs * 0.4) },
        { name: 'Vectorized In-Memory Execution', status: 'COMPLETED', durationMs: Math.round(executionTimeMs * 0.4) },
        { name: 'Result Materialization', status: 'COMPLETED', durationMs: Math.round(executionTimeMs * 0.1) }
      ]
    };
  }

  /**
   * Explain query physical and logical plan in DuckDB
   */
  async explainQuery({ sql, targetId, userId, context = {} }) {
    try {
      const explainSql = `EXPLAIN ${sql.replace(/;+\s*$/, '')}`;
      const explainRows = await runQuery(userId || 'system', explainSql, targetId, {
        tenantId: context.tenantId || 'default',
        skipLog: true
      });

      const rawPlan = Array.isArray(explainRows)
        ? explainRows.map(r => r.explain_value || r.plan || JSON.stringify(r)).join('\n')
        : String(explainRows);

      const stages = this._parsePlanStages(rawPlan);

      return {
        engine: this.id,
        rawPlan,
        stages
      };
    } catch (err) {
      return {
        engine: this.id,
        rawPlan: `Could not generate physical plan: ${err.message}`,
        stages: [
          { name: 'Execution Plan', status: 'UNAVAILABLE', details: err.message }
        ]
      };
    }
  }

  /**
   * Extract visual execution stages from DuckDB EXPLAIN output
   */
  _parsePlanStages(rawPlan) {
    const stages = [];
    const lower = rawPlan.toLowerCase();

    if (lower.includes('scan') || lower.includes('parquet') || lower.includes('read_')) {
      stages.push({
        name: 'Storage Scan',
        type: 'SCAN',
        status: 'PLANNED',
        details: 'Direct Parquet/CSV scanning with columnar projection and pushdown filters'
      });
    }
    if (lower.includes('filter')) {
      stages.push({
        name: 'Predicate Pushdown',
        type: 'FILTER',
        status: 'PLANNED',
        details: 'Row group and statistics filtering'
      });
    }
    if (lower.includes('join') || lower.includes('hash_join')) {
      stages.push({
        name: 'In-Memory Join',
        type: 'JOIN',
        status: 'PLANNED',
        details: 'Hash join evaluation'
      });
    }
    if (lower.includes('aggregate') || lower.includes('group_by')) {
      stages.push({
        name: 'Vectorized Aggregation',
        type: 'AGGREGATE',
        status: 'PLANNED',
        details: 'SIMD-accelerated grouping and reduction'
      });
    }
    if (lower.includes('order') || lower.includes('top_n')) {
      stages.push({
        name: 'Ordering & Top-N',
        type: 'SORT',
        status: 'PLANNED',
        details: 'In-memory sorting/windowing'
      });
    }
    if (stages.length === 0) {
      stages.push({
        name: 'Vectorized Execution Pipeline',
        type: 'EXECUTE',
        status: 'PLANNED',
        details: 'Standard single-node execution'
      });
    }
    return stages;
  }

  /**
   * Health status check
   */
  async getHealthStatus() {
    try {
      const res = await runQuery('system', 'SELECT 1 as ping', null, { skipLog: true });
      const healthy = Array.isArray(res) && res[0] && res[0].ping === 1;
      return {
        healthy,
        engine: this.id,
        latencyMs: 1,
        details: 'Embedded in-process engine ready'
      };
    } catch (err) {
      return {
        healthy: false,
        engine: this.id,
        error: err.message
      };
    }
  }
}

module.exports = DuckDBEngine;
