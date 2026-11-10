const { DuckDBExecutor } = require('./DuckDBExecutor');
const { TrinoExecutor } = require('./TrinoExecutor');

/**
 * ExecutionRouter selects the optimal execution engine (`DuckDBExecutor` vs `TrinoExecutor`)
 * based on:
 * 1. Dataset size (`totalEstimatedBytes`)
 * 2. Estimated memory requirements (`estimatedMemoryBytes`)
 * 3. Number of federated sources (`numSources`)
 * 4. Query complexity (joins, aggregations, window functions)
 * 5. Connector capabilities
 * 6. Available execution resources (whether Trino MPP cluster is configured & online)
 */
class ExecutionRouter {
    constructor(options = {}) {
        this.duckdbExecutor = options.duckdbExecutor || new DuckDBExecutor(options.duckdb);
        this.trinoExecutor = options.trinoExecutor || new TrinoExecutor(options.trino);
        // Threshold above which distributed MPP execution is preferred if Trino is online (default 10 GB)
        this.distributedThresholdBytes = Number(
            options.distributedThresholdBytes || process.env.FEDERATION_DISTRIBUTED_THRESHOLD_BYTES || 10 * Math.pow(1024, 3)
        );
    }

    evaluateRoutingDecision(plan, options = {}) {
        const totalBytes =
            Number(plan.estimatedMetrics?.totalEstimatedObjectBytes || 0) +
            Number(plan.estimatedMetrics?.totalEstimatedRelationalBytes || 0);
        const estimatedMemoryBytes = Math.round(totalBytes * 2.2);
        const numSources = (plan.catalogsReferenced || []).length;
        const numJoins = (plan.joinPlan?.joinOperations || []).length;
        const hasWindowFunctions = /\bOVER\s*\(/i.test(plan.executableSql || '');
        const complexityScore = numSources * 10 + numJoins * 15 + (hasWindowFunctions ? 20 : 0);

        const requestedEngine = (options.preferredEngine || 'auto').toLowerCase();
        const trinoAvailable = this.trinoExecutor.isConfigured();

        if (requestedEngine === 'trino') {
            if (!trinoAvailable) {
                throw new Error(
                    'Requested TrinoExecutor, but TRINO_COORDINATOR_URL is not configured. Configure a Trino cluster or use DuckDBExecutor.'
                );
            }
            return {
                selectedEngine: 'TrinoExecutor',
                executionMode: 'DISTRIBUTED_TRINO_MPP',
                isDistributed: true,
                executor: this.trinoExecutor,
                routingFactors: {
                    reason: 'Explicitly requested TrinoExecutor',
                    totalEstimatedBytes: totalBytes,
                    estimatedMemoryBytes,
                    numSources,
                    numJoins,
                    complexityScore,
                    trinoAvailable
                }
            };
        }

        if (requestedEngine === 'auto' && totalBytes >= this.distributedThresholdBytes && trinoAvailable) {
            return {
                selectedEngine: 'TrinoExecutor',
                executionMode: 'DISTRIBUTED_TRINO_MPP',
                isDistributed: true,
                executor: this.trinoExecutor,
                routingFactors: {
                    reason: `Dataset size (${totalBytes} bytes) exceeds single-node threshold (${this.distributedThresholdBytes} bytes) and Trino cluster is configured`,
                    totalEstimatedBytes: totalBytes,
                    estimatedMemoryBytes,
                    numSources,
                    numJoins,
                    complexityScore,
                    trinoAvailable
                }
            };
        }

        return {
            selectedEngine: 'DuckDBExecutor',
            executionMode: 'SINGLE_NODE_DUCKDB',
            isDistributed: false,
            executor: this.duckdbExecutor,
            routingFactors: {
                reason:
                    totalBytes >= this.distributedThresholdBytes && !trinoAvailable
                        ? 'Large dataset detected; executing on DuckDBExecutor with out-of-core spill enabled (Trino cluster not configured)'
                        : 'Workload fits within single-node DuckDB vectorized execution memory envelope',
                totalEstimatedBytes: totalBytes,
                estimatedMemoryBytes,
                numSources,
                numJoins,
                complexityScore,
                trinoAvailable
            }
        };
    }

    async routeAndExecute(plan, options = {}) {
        const decision = this.evaluateRoutingDecision(plan, options);
        const result = await decision.executor.executePlan(plan, options);
        return {
            ...result,
            routingDecision: decision.routingFactors
        };
    }

    async routeAndExplain(plan, options = {}) {
        const decision = this.evaluateRoutingDecision(plan, options);
        const explainResult = await this.duckdbExecutor.explainPlan(plan);
        return {
            ...explainResult,
            selectedEngine: decision.selectedEngine,
            executionMode: decision.executionMode,
            isDistributed: decision.isDistributed,
            routingDecision: decision.routingFactors
        };
    }

    cancelExecution(executionId) {
        return this.duckdbExecutor.cancelExecution(executionId);
    }
}

module.exports = { ExecutionRouter };

