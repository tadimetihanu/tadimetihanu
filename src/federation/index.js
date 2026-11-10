const crypto = require('crypto');
const {
    initFederationCatalogs,
    listCatalogs,
    registerCatalog,
    getConnectorForCatalog,
    resolveTableMetadata,
    syncCatalogMetadata,
    verifyTableAccess,
    logFederationAudit,
    clearMetadataCache
} = require('./catalogRegistry');
const {
    validateFederatedSqlSafety,
    extractThreePartReferences,
    planFederatedQuery
} = require('./planner');
const { ExecutionRouter } = require('./executors/ExecutionRouter');
const { recordFederationTelemetry } = require('./telemetry');
const { sanitizeErrorOrSql } = require('./crypto');

const defaultRouter = new ExecutionRouter();

/**
 * Executes a federated SQL query end-to-end across multiple catalogs with planning,
 * pushdown optimization, routing, execution, and Live Burn telemetry persistence.
 */
async function executeFederatedQuery({
    sql,
    user,
    tenantId = 'default_tenant',
    preferredEngine = 'auto',
    enablePushdown = true,
    timeoutMs = 60000,
    cacheStatus = 'MISS',
    executionId = null,
    ipAddress = '127.0.0.1'
}) {
    await initFederationCatalogs();
    const execId = executionId || crypto.randomUUID();
    const startTime = Date.now();
    let plan = null;

    try {
        plan = await planFederatedQuery({
            sql,
            user,
            tenantId,
            enablePushdown
        });

        const execResult = await defaultRouter.routeAndExecute(plan, {
            executionId: execId,
            preferredEngine,
            timeoutMs,
            cacheStatus
        });

        const explainSummary = {
            selectedEngine: execResult.engineUsed,
            executionMode: execResult.executionMode,
            isDistributed: execResult.isDistributed,
            joinStrategy: plan.joinPlan.overallJoinStrategy,
            joinOperations: plan.joinPlan.joinOperations,
            recommendedJoinOrder: plan.joinPlan.recommendedJoinOrder,
            dynamicFilters: plan.joinPlan.dynamicFilters,
            sourceCatalogAccess: plan.scanDescriptors,
            visualDag: plan.visualDag,
            physicalPlan: execResult.physicalPlanText,
            routingDecision: execResult.routingDecision
        };

        const telemetry = await recordFederationTelemetry({
            executionId: execId,
            tenantId,
            userId: user?.user_id || 'system',
            originalSql: sql,
            rewrittenSql: plan.rewrittenSql,
            engineUsed: execResult.engineUsed,
            executionMode: execResult.executionMode,
            joinStrategy: plan.joinPlan.overallJoinStrategy,
            catalogsReferenced: plan.catalogsReferenced,
            status: 'success',
            rowCount: execResult.rowCount,
            durationMs: execResult.durationMs,
            sourceMetrics: execResult.sourceMetrics,
            explainPlan: explainSummary
        });

        await logFederationAudit({
            tenantId,
            userId: user?.user_id || 'system',
            action: 'EXECUTE_FEDERATED_QUERY',
            resourceType: 'query',
            resourceId: execId,
            catalogName: plan.catalogsReferenced.join(','),
            status: 'success',
            details: {
                rowCount: execResult.rowCount,
                durationMs: execResult.durationMs,
                engineUsed: execResult.engineUsed,
                joinStrategy: plan.joinPlan.overallJoinStrategy
            },
            ipAddress
        });

        return {
            success: true,
            executionId: execId,
            data: execResult.rows,
            rowCount: execResult.rowCount,
            durationMs: execResult.durationMs,
            engineUsed: execResult.engineUsed,
            executionMode: execResult.executionMode,
            isDistributed: execResult.isDistributed,
            rewrittenSql: plan.rewrittenSql,
            plan: explainSummary,
            telemetry
        };
    } catch (err) {
        const durationMs = Math.max(1, Date.now() - startTime);
        const safeErrMsg = sanitizeErrorOrSql(err.message);
        const failedSource = err.failedSource || null;

        await recordFederationTelemetry({
            executionId: execId,
            tenantId,
            userId: user?.user_id || 'system',
            originalSql: sql || '',
            rewrittenSql: plan?.rewrittenSql || '',
            engineUsed: 'DuckDBExecutor',
            executionMode: 'SINGLE_NODE_DUCKDB',
            joinStrategy: plan?.joinPlan?.overallJoinStrategy || 'NONE',
            catalogsReferenced: plan?.catalogsReferenced || [],
            status: 'error',
            rowCount: 0,
            durationMs,
            sourceMetrics: [],
            errorMessage: safeErrMsg,
            failedSource
        }).catch(() => {});

        await logFederationAudit({
            tenantId,
            userId: user?.user_id || 'system',
            action: 'EXECUTE_FEDERATED_QUERY_ERROR',
            resourceType: 'query',
            resourceId: execId,
            catalogName: failedSource || (plan?.catalogsReferenced || []).join(','),
            status: 'error',
            details: { error: safeErrMsg, failedSource },
            ipAddress
        }).catch(() => {});

        const wrapped = new Error(safeErrMsg);
        wrapped.statusCode = err.statusCode || 400;
        wrapped.executionId = execId;
        wrapped.failedSource = failedSource;
        throw wrapped;
    }
}

/**
 * Generates an EXPLAIN execution plan for a federated SQL query.
 */
async function explainFederatedQuery({
    sql,
    user,
    tenantId = 'default_tenant',
    preferredEngine = 'auto',
    enablePushdown = true
}) {
    await initFederationCatalogs();
    const plan = await planFederatedQuery({
        sql,
        user,
        tenantId,
        enablePushdown
    });
    const explainResult = await defaultRouter.routeAndExplain(plan, { preferredEngine });
    return {
        success: true,
        ...explainResult
    };
}

/**
 * Builds a clean, executable multi-catalog SQL query from Visual Join Builder inputs.
 */
function generateVisualJoinSql({ baseTable, joins = [], selectedColumns = ['*'], whereClause = '', groupBy = '', orderBy = '', limit = 100 }) {
    if (!baseTable || !baseTable.catalog || !baseTable.schema || !baseTable.table) {
        throw new Error('Base table (catalog, schema, table) is required for Visual Join Builder');
    }
    const baseAlias = baseTable.alias || baseTable.table.slice(0, 2);
    const selectClause = Array.isArray(selectedColumns) && selectedColumns.length > 0 ? selectedColumns.join(',\n    ') : '*';

    let sql = `SELECT\n    ${selectClause}\nFROM ${baseTable.catalog}.${baseTable.schema}.${baseTable.table} ${baseAlias}`;

    for (const j of joins) {
        const jType = (j.joinType || 'INNER JOIN').toUpperCase();
        const jAlias = j.alias || j.table.slice(0, 2);
        const onLeft = j.leftColumn.includes('.') ? j.leftColumn : `${baseAlias}.${j.leftColumn}`;
        const onRight = j.rightColumn.includes('.') ? j.rightColumn : `${jAlias}.${j.rightColumn}`;
        if (jType === 'CROSS JOIN') {
            sql += `\nCROSS JOIN ${j.catalog}.${j.schema}.${j.table} ${jAlias}`;
        } else {
            sql += `\n${jType} ${j.catalog}.${j.schema}.${j.table} ${jAlias}\n    ON ${onLeft} = ${onRight}`;
        }
    }

    if (whereClause && whereClause.trim()) {
        sql += `\nWHERE ${whereClause.trim().replace(/^WHERE\s+/i, '')}`;
    }
    if (groupBy && groupBy.trim()) {
        sql += `\nGROUP BY ${groupBy.trim().replace(/^GROUP\s+BY\s+/i, '')}`;
    }
    if (orderBy && orderBy.trim()) {
        sql += `\nORDER BY ${orderBy.trim().replace(/^ORDER\s+BY\s+/i, '')}`;
    }
    if (limit && Number(limit) > 0) {
        sql += `\nLIMIT ${Number(limit)}`;
    }
    return sql + ';';
}

module.exports = {
    initFederationCatalogs,
    listCatalogs,
    registerCatalog,
    getConnectorForCatalog,
    resolveTableMetadata,
    syncCatalogMetadata,
    verifyTableAccess,
    logFederationAudit,
    clearMetadataCache,
    validateFederatedSqlSafety,
    extractThreePartReferences,
    planFederatedQuery,
    executeFederatedQuery,
    explainFederatedQuery,
    generateVisualJoinSql,
    cancelFederatedQuery: (executionId) => defaultRouter.cancelExecution(executionId),
    defaultRouter
};

