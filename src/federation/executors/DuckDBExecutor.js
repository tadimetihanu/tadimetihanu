const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const _activeExecutions = new Map();

function normalizeDuckRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'bigint') {
            out[k] = Number(v);
        } else if (v instanceof Date) {
            out[k] = v.toISOString().split('T')[0];
        } else {
            out[k] = v;
        }
    }
    return out;
}

class DuckDBExecutor {
    constructor(options = {}) {
        this.memoryLimit = options.memoryLimit || process.env.DUCKDB_FEDERATION_MEMORY_LIMIT || '2GB';
        this.threads = Number(options.threads || process.env.DUCKDB_FEDERATION_THREADS || 4);
        this.defaultTimeoutMs = Number(options.timeoutMs || 60000);
        this.spillDir = path.join(process.cwd(), 'data', '.duckdb_spill').replace(/\\/g, '/');
        if (!fs.existsSync(this.spillDir)) {
            fs.mkdirSync(this.spillDir, { recursive: true });
        }
    }

    getEngineMetadata() {
        return {
            engineName: 'DuckDBExecutor',
            executionMode: 'SINGLE_NODE_DUCKDB',
            isDistributed: false,
            description: 'Single-node vectorized in-memory/out-of-core DuckDB federation engine with connector predicate & projection pushdown',
            memoryLimit: this.memoryLimit,
            threads: this.threads
        };
    }

    /**
     * Cancels an active running federated query by executionId.
     */
    cancelExecution(executionId) {
        const entry = _activeExecutions.get(executionId);
        if (!entry) {
            return { cancelled: false, message: `Execution ${executionId} is not active or already completed` };
        }
        entry.cancelled = true;
        try {
            if (entry.conn && typeof entry.conn.interrupt === 'function') {
                entry.conn.interrupt();
            }
            if (entry.rejectFn) {
                entry.rejectFn(new Error(`Query execution ${executionId} was cancelled by user`));
            }
        } catch (_) {}
        _activeExecutions.delete(executionId);
        return { cancelled: true, executionId, message: `Query execution ${executionId} cancelled` };
    }

    getActiveExecutions() {
        return Array.from(_activeExecutions.keys());
    }

    /**
     * Executes a planned federated query on a single DuckDB instance with source-level telemetry,
     * retry handling for transient I/O errors, timeout enforcement, and strict fail-fast source error attribution.
     */
    async executePlan(plan, options = {}) {
        const executionId = options.executionId || `fed_${Date.now()}`;
        const timeoutMs = Number(options.timeoutMs || this.defaultTimeoutMs);
        const maxRetries = Number(options.maxRetries !== undefined ? options.maxRetries : 1);
        const startTime = Date.now();

        const duck = new duckdb.Database(':memory:');
        const conn = duck.connect();

        const runSql = (sql) =>
            new Promise((resolve, reject) => {
                conn.run(sql, (err) => (err ? reject(err) : resolve()));
            });

        const allSql = (sql) =>
            new Promise((resolve, reject) => {
                conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || [])));
            });

        const execState = { executionId, conn, duck, cancelled: false, rejectFn: null };
        _activeExecutions.set(executionId, execState);

        let timeoutHandle = null;
        try {
            await runSql(`SET memory_limit='${this.memoryLimit}';`);
            await runSql(`SET threads=${this.threads};`);
            await runSql(`SET temp_directory='${this.spillDir}';`);

            // Step 1: Verify and measure each source scan independently so that if any source fails,
            // we NEVER return incomplete results and we pinpoint the exact failed catalog & source type.
            const sourceMetrics = [];
            for (const scan of plan.scanDescriptors) {
                if (execState.cancelled) {
                    throw new Error(`Query execution ${executionId} was cancelled by user`);
                }
                const scanStart = Date.now();
                let attempt = 0;
                let rowsProcessed = 0;
                while (true) {
                    try {
                        const countRes = await allSql(`SELECT COUNT(*) AS cnt FROM ${scan.duckdbExpression}`);
                        rowsProcessed = Number(countRes[0]?.cnt || 0);
                        break;
                    } catch (scanErr) {
                        attempt++;
                        if (attempt > maxRetries || /Simulation|unreachable|refused|terminated|lost connection|does not exist/i.test(scanErr.message)) {
                            const enrichedErr = new Error(
                                `Federated Source Failure [${scan.catalogName} (${scan.sourceType.toUpperCase()}) on ${scan.fqn}]: ${scanErr.message}`
                            );
                            enrichedErr.failedSource = scan.catalogName;
                            enrichedErr.failedSourceType = scan.sourceType;
                            enrichedErr.failedTable = scan.fqn;
                            throw enrichedErr;
                        }
                    }
                }
                const scanDurationMs = Math.max(1, Date.now() - scanStart);

                // Calculate actual vs estimated bytes based on whether source is Cloud Object Storage vs Relational DB
                const isObjectStorage = scan.costCategory === 'CLOUD_OBJECT_BYTES_SCANNED';
                const rowFraction = scan.estimatedRows > 0 ? Math.min(1, rowsProcessed / scan.estimatedRows) : 1;
                const effectiveBytes = Math.max(
                    rowsProcessed > 0 ? 128 : 0,
                    Math.round(scan.physicalSizeBytes * scan.columnPruningRatio * (scan.pushedPredicates.length > 0 ? rowFraction : 1))
                );

                const bytesScanned = isObjectStorage ? effectiveBytes : 0;
                const bytesRetrieved = !isObjectStorage ? effectiveBytes : 0;
                const networkBytes = effectiveBytes;
                const sourceCostUsd = isObjectStorage
                    ? Number(((bytesScanned / Math.pow(1024, 4)) * 5.0).toFixed(8))
                    : 0;

                sourceMetrics.push({
                    catalogId: scan.catalogId,
                    catalogName: scan.catalogName,
                    schemaName: scan.schemaName,
                    tableName: scan.tableName,
                    fqn: scan.fqn,
                    sourceType: scan.sourceType,
                    format: scan.format,
                    metricCategory: scan.costCategory,
                    bytesScanned,
                    bytesRetrieved,
                    networkBytes,
                    rowsProcessed,
                    scanDurationMs,
                    peakMemoryBytes: Math.max(65536, effectiveBytes * 2),
                    pushedPredicates: scan.pushedPredicates,
                    pushedProjections: scan.pushedProjections,
                    cacheStatus: options.cacheStatus || 'MISS',
                    isEstimate: scan.pushedProjections.includes('*') && scan.pushedPredicates.length === 0 ? 0 : 1,
                    estimatedCostUsd: sourceCostUsd
                });
            }

            // Step 2: Execute the unified federated query with timeout & cancellation guard
            const rawRows = await new Promise((resolve, reject) => {
                execState.rejectFn = reject;
                timeoutHandle = setTimeout(() => {
                    try {
                        if (typeof conn.interrupt === 'function') conn.interrupt();
                    } catch (_) {}
                    reject(new Error(`Federated query timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                conn.all(plan.rewrittenSql, (err, res) => {
                    clearTimeout(timeoutHandle);
                    if (execState.cancelled) {
                        return reject(new Error(`Query execution ${executionId} was cancelled by user`));
                    }
                    if (err) {
                        return reject(err);
                    }
                    resolve(res || []);
                });
            });

            // Step 3: Also capture DuckDB physical EXPLAIN output for transparency
            let physicalPlanText = '';
            try {
                const explainRows = await allSql(`EXPLAIN ${plan.rewrittenSql}`);
                physicalPlanText = explainRows
                    .map(r => `${r.explain_key || 'PHYSICAL_PLAN'}:\n${r.explain_value || ''}`)
                    .join('\n');
            } catch (_) {
                physicalPlanText = `SINGLE_NODE_DUCKDB_PLAN:\n${plan.rewrittenSql}`;
            }

            const normalizedRows = rawRows.map(normalizeDuckRow);
            const totalDurationMs = Math.max(1, Date.now() - startTime);

            return {
                executionId,
                engineUsed: 'DuckDBExecutor',
                executionMode: 'SINGLE_NODE_DUCKDB',
                isDistributed: false,
                rows: normalizedRows,
                rowCount: normalizedRows.length,
                durationMs: totalDurationMs,
                sourceMetrics,
                physicalPlanText
            };
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            _activeExecutions.delete(executionId);
            await new Promise((r) => duck.close(() => r()));
        }
    }

    /**
     * Generates a complete EXPLAIN plan without returning the full result dataset.
     */
    async explainPlan(plan) {
        const duck = new duckdb.Database(':memory:');
        const conn = duck.connect();
        const allSql = (sql) =>
            new Promise((resolve, reject) => {
                conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || [])));
            });

        try {
            const explainRows = await allSql(`EXPLAIN ${plan.rewrittenSql}`);
            const physicalPlanText = explainRows
                .map(r => `${r.explain_key || 'PHYSICAL_PLAN'}:\n${r.explain_value || ''}`)
                .join('\n');

            return {
                engineUsed: 'DuckDBExecutor',
                executionMode: 'SINGLE_NODE_DUCKDB',
                isDistributed: false,
                originalSql: plan.originalSql,
                rewrittenSql: plan.rewrittenSql,
                catalogsReferenced: plan.catalogsReferenced,
                sourceCatalogAccess: plan.scanDescriptors.map(s => ({
                    catalogName: s.catalogName,
                    schemaName: s.schemaName,
                    tableName: s.tableName,
                    fqn: s.fqn,
                    alias: s.alias,
                    sourceType: s.sourceType,
                    format: s.format,
                    pushedPredicates: s.pushedPredicates,
                    pushedProjections: s.pushedProjections,
                    estimatedRows: s.estimatedRows,
                    physicalSizeBytes: s.physicalSizeBytes,
                    estimatedScanBytes: s.estimatedScanBytes,
                    costCategory: s.costCategory
                })),
                joinOperations: plan.joinPlan.joinOperations,
                recommendedJoinOrder: plan.joinPlan.recommendedJoinOrder,
                dynamicFilters: plan.joinPlan.dynamicFilters,
                overallJoinStrategy: plan.joinPlan.overallJoinStrategy,
                estimatedMetrics: plan.estimatedMetrics,
                visualDag: plan.visualDag,
                logicalPlan: {
                    root: 'RESULT_PROJECTION',
                    joinStrategy: plan.joinPlan.overallJoinStrategy,
                    joins: plan.joinPlan.joinOperations,
                    scans: plan.scanDescriptors.map(s => ({
                        table: s.fqn,
                        sourceType: s.sourceType,
                        pushedPredicates: s.pushedPredicates,
                        pushedProjections: s.pushedProjections
                    }))
                },
                physicalPlan: physicalPlanText
            };
        } finally {
            await new Promise((r) => duck.close(() => r()));
        }
    }
}

module.exports = { DuckDBExecutor };

