const crypto = require('crypto');
const db = require('../db');

const LAKEHOUSE_RATE_PER_TIB_USD = 5.0;
const BYTES_PER_TIB = Math.pow(1024, 4);

/**
 * Records federated execution telemetry and cost analytics into:
 * 1. `federation_query_history`
 * 2. `federation_execution_metrics` (one row per source table scan)
 * 3. `query_history` and `query_logs` (so existing Live Burn & Admin Analytics stay in sync)
 *
 * CRITICAL ACCOUNTING RULES:
 * - Cloud Object Storage scans (S3, ADLS Gen2, MinIO, Apache Iceberg) are tracked as `object_bytes_scanned`
 *   and billed at $5.00 / TiB (`CLOUD_OBJECT_BYTES_SCANNED`).
 * - Relational Database queries (PostgreSQL, MySQL) are tracked separately as `relational_bytes_retrieved`
 *   (`RELATIONAL_BYTES_RETRIEVED`) and are NEVER conflated with cloud object-storage bytes scanned.
 * - Clearly labels whether metrics are exact measurements or estimates (`is_estimate`).
 */
async function recordFederationTelemetry({
    executionId,
    tenantId = 'default_tenant',
    userId = 'system',
    originalSql,
    rewrittenSql = '',
    engineUsed = 'DuckDBExecutor',
    executionMode = 'SINGLE_NODE_DUCKDB',
    joinStrategy = 'SINGLE_SOURCE_SCAN',
    catalogsReferenced = [],
    status = 'success',
    rowCount = 0,
    durationMs = 0,
    sourceMetrics = [],
    explainPlan = null,
    errorMessage = null,
    failedSource = null
}) {
    const queryId = crypto.randomUUID();

    let objectBytesScanned = 0;
    let relationalBytesRetrieved = 0;
    let networkBytesTransferred = 0;
    let peakMemoryBytes = 0;
    let isCostEstimate = 0;

    for (const sm of sourceMetrics) {
        if (sm.metricCategory === 'CLOUD_OBJECT_BYTES_SCANNED') {
            objectBytesScanned += Number(sm.bytesScanned || 0);
        } else {
            relationalBytesRetrieved += Number(sm.bytesRetrieved || 0);
        }
        networkBytesTransferred += Number(sm.networkBytes || 0);
        peakMemoryBytes = Math.max(peakMemoryBytes, Number(sm.peakMemoryBytes || 0));
        if (sm.isEstimate) isCostEstimate = 1;
    }

    const onDemandCostUsd = Number(((objectBytesScanned / BYTES_PER_TIB) * LAKEHOUSE_RATE_PER_TIB_USD).toFixed(8));
    const allCached = sourceMetrics.length > 0 && sourceMetrics.every(s => s.cacheStatus === 'HIT' || s.cacheStatus === 'LOCAL');
    const billedCostUsd = allCached ? 0 : onDemandCostUsd;
    const cacheStatus = allCached ? 'HIT' : 'MISS';

    // 1. Insert into `federation_query_history`
    await db.run(
        `INSERT INTO federation_query_history (
            query_id, execution_id, tenant_id, user_id, sql_query, rewritten_sql,
            engine_used, execution_mode, join_strategy, catalogs_referenced,
            status, row_count, duration_ms, object_bytes_scanned, relational_bytes_retrieved,
            network_bytes_transferred, peak_memory_bytes, estimated_cost_usd, on_demand_cost_usd,
            cache_status, is_cost_estimate, explain_plan_json, error_message, failed_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            queryId,
            executionId,
            tenantId,
            userId,
            originalSql,
            rewrittenSql,
            engineUsed,
            executionMode,
            joinStrategy,
            JSON.stringify(catalogsReferenced),
            status,
            rowCount,
            durationMs,
            objectBytesScanned,
            relationalBytesRetrieved,
            networkBytesTransferred,
            peakMemoryBytes,
            billedCostUsd,
            onDemandCostUsd,
            cacheStatus,
            isCostEstimate,
            explainPlan ? JSON.stringify(explainPlan) : null,
            errorMessage,
            failedSource
        ]
    );

    // 2. Insert source-level breakdown into `federation_execution_metrics`
    const savedSourceMetrics = [];
    for (const sm of sourceMetrics) {
        const metricId = crypto.randomUUID();
        await db.run(
            `INSERT INTO federation_execution_metrics (
                metric_id, execution_id, tenant_id, catalog_id, catalog_name,
                schema_name, table_name, source_type, metric_category,
                bytes_scanned, bytes_retrieved, network_bytes, rows_processed,
                scan_duration_ms, peak_memory_bytes, pushed_predicates, pushed_projections,
                cache_status, is_estimate, estimated_cost_usd
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                metricId,
                executionId,
                tenantId,
                sm.catalogId || '',
                sm.catalogName,
                sm.schemaName || '',
                sm.tableName || '',
                sm.sourceType,
                sm.metricCategory,
                Number(sm.bytesScanned || 0),
                Number(sm.bytesRetrieved || 0),
                Number(sm.networkBytes || 0),
                Number(sm.rowsProcessed || 0),
                Number(sm.scanDurationMs || 0),
                Number(sm.peakMemoryBytes || 0),
                JSON.stringify(sm.pushedPredicates || []),
                JSON.stringify(sm.pushedProjections || []),
                sm.cacheStatus || 'MISS',
                sm.isEstimate ? 1 : 0,
                Number(sm.estimatedCostUsd || 0)
            ]
        );
        savedSourceMetrics.push({ metricId, ...sm });
    }

    // 3. Synchronize with existing Live Burn tables (`query_history` and `query_logs`)
    // Only `objectBytesScanned` is recorded in `scan_bytes` / `data_scanned_bytes` so relational DB bytes are never billed as object storage!
    const targetLabel = catalogsReferenced.length > 0 ? `federation:${catalogsReferenced.join('+')}` : 'federation';
    try {
        await db.run(
            `INSERT INTO query_history (
                id, execution_id, user_id, target_id, sql_query, duration_ms,
                row_count, cost_usd, on_demand_cost_usd, scan_bytes, storage_downloaded_bytes, cache_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                crypto.randomUUID(),
                executionId,
                userId,
                targetLabel,
                originalSql,
                durationMs,
                rowCount,
                billedCostUsd,
                onDemandCostUsd,
                objectBytesScanned,
                networkBytesTransferred,
                cacheStatus
            ]
        );
        await db.run(
            `INSERT INTO query_logs (
                execution_id, user_id, target_id, query_text, row_count,
                execution_time_ms, status, data_scanned_bytes, storage_downloaded_bytes,
                cache_status, calculated_cost_usd, on_demand_cost_usd
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                executionId,
                userId,
                targetLabel,
                originalSql,
                rowCount,
                durationMs,
                status,
                objectBytesScanned,
                networkBytesTransferred,
                cacheStatus,
                billedCostUsd,
                onDemandCostUsd
            ]
        );
    } catch (syncErr) {
        console.warn('[Federation Live Burn Sync Notice]:', syncErr.message);
    }

    return {
        queryId,
        executionId,
        engineUsed,
        executionMode,
        joinStrategy,
        catalogsReferenced,
        status,
        rowCount,
        durationMs,
        objectBytesScanned,
        relationalBytesRetrieved,
        networkBytesTransferred,
        peakMemoryBytes,
        billedCostUsd,
        onDemandCostUsd,
        cacheSavingsUsd: Math.max(0, Number((onDemandCostUsd - billedCostUsd).toFixed(8))),
        cacheStatus,
        isCostEstimate: Boolean(isCostEstimate),
        ratePerTibUsd: LAKEHOUSE_RATE_PER_TIB_USD,
        sourceBreakdown: savedSourceMetrics
    };
}

module.exports = {
    recordFederationTelemetry,
    LAKEHOUSE_RATE_PER_TIB_USD
};

