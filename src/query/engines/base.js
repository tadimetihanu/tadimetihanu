/**
 * CloudObjectIQ - Base Query Engine Interface (IQueryEngine)
 * Unified abstraction for all analytical and distributed execution engines.
 */

class BaseQueryEngine {
  /**
   * @param {Object} options
   * @param {string} options.id - Unique engine identifier (e.g., 'duckdb', 'doris', 'spark')
   * @param {string} options.name - Human-readable display name
   * @param {string} options.version - Engine version string
   * @param {Object} options.capabilities - Capability flags
   */
  constructor(options = {}) {
    if (new.target === BaseQueryEngine) {
      throw new TypeError('Cannot construct BaseQueryEngine instances directly.');
    }
    this.id = options.id || 'unknown';
    this.name = options.name || 'Generic Engine';
    this.version = options.version || '1.0.0';
    this.capabilities = {
      distributed: false,
      streaming: false,
      asyncSubmission: false,
      cancellation: true,
      explain: true,
      supportedFormats: ['parquet', 'csv'],
      ...options.capabilities
    };
  }

  /**
   * Synchronously or asynchronously execute a SQL query and wait for full completion.
   * Standard output contract must contain:
   * {
   *   columns: string[],
   *   rows: Array<Record<string, any>>,
   *   rowCount: number,
   *   executionTimeMs: number,
   *   engine: string,
   *   scanMeta: Object, // Scanned bytes, total dataset bytes, pruning %
   *   rawPlan?: string,
   *   stages?: Array<Object>
   * }
   * 
   * @param {Object} params
   * @param {string} params.sql
   * @param {Object} params.target - Storage target configuration (S3, R2, ADLS, MinIO)
   * @param {Object} params.context - User, tenant, and execution metadata
   * @param {number} [params.timeoutMs=60000] - Execution timeout
   * @param {Function} [params.onStageUpdate] - Callback for progressive execution stages
   * @returns {Promise<Object>}
   */
  async executeQuery(params) {
    throw new Error(`executeQuery() must be implemented by ${this.constructor.name}`);
  }

  /**
   * Submit query asynchronously and return a query reference identifier.
   * @param {Object} params
   * @returns {Promise<{ queryId: string, status: string }>}
   */
  async submitQuery(params) {
    throw new Error(`submitQuery() not supported by ${this.constructor.name}`);
  }

  /**
   * Get query status for asynchronous execution.
   * @param {string} queryId
   * @returns {Promise<{ queryId: string, status: string, progressPct?: number, error?: string }>}
   */
  async getQueryStatus(queryId) {
    throw new Error(`getQueryStatus() not supported by ${this.constructor.name}`);
  }

  /**
   * Fetch results for an asynchronously completed query.
   * @param {string} queryId
   * @param {Object} [pagination] - { offset, limit }
   * @returns {Promise<Object>}
   */
  async getQueryResults(queryId, pagination) {
    throw new Error(`getQueryResults() not supported by ${this.constructor.name}`);
  }

  /**
   * Cancel an in-flight query.
   * @param {string} queryId
   * @returns {Promise<boolean>}
   */
  async cancelQuery(queryId) {
    throw new Error(`cancelQuery() not supported by ${this.constructor.name}`);
  }

  /**
   * Produce physical or logical query plan.
   * @param {Object} params
   * @param {string} params.sql
   * @param {Object} params.target
   * @param {Object} params.context
   * @returns {Promise<{ engine: string, rawPlan: string, stages: Array<Object> }>}
   */
  async explainQuery(params) {
    throw new Error(`explainQuery() must be implemented by ${this.constructor.name}`);
  }

  /**
   * Retrieve fine-grained execution metrics for a completed query.
   * @param {string} queryId
   * @returns {Promise<Object>}
   */
  async getExecutionMetrics(queryId) {
    return {
      queryId,
      engine: this.id,
      metricsAvailable: false
    };
  }

  /**
   * Health and connectivity status check.
   * @returns {Promise<{ healthy: boolean, latencyMs: number, details?: any, error?: string }>}
   */
  async getHealthStatus() {
    return {
      healthy: true,
      latencyMs: 0,
      engine: this.id
    };
  }

  /**
   * Return engine capability matrix.
   * @returns {Object}
   */
  getCapabilities() {
    return { ...this.capabilities };
  }
}

module.exports = BaseQueryEngine;
