const {
    getConnectorForCatalog,
    resolveTableMetadata,
    verifyTableAccess
} = require('./catalogRegistry');

const FORBIDDEN_SQL_PATTERNS = [
    { regex: /\b(DROP|TRUNCATE|ALTER|GRANT|REVOKE)\s+(TABLE|VIEW|SCHEMA|DATABASE|CATALOG|INDEX|USER|ROLE)\b/i, reason: 'DDL statements are forbidden in federated queries' },
    { regex: /^\s*(INSERT|UPDATE|DELETE|MERGE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|COPY|ATTACH|DETACH|PRAGMA|INSTALL|LOAD|CALL|SET)\b/i, reason: 'Only read-only SELECT / WITH / EXPLAIN queries are permitted in Cross-Source Federation' },
    { regex: /;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|COPY|ATTACH|DETACH|PRAGMA)\b/i, reason: 'Multi-statement SQL injection attempt blocked' },
    { regex: /\b(pg_sleep|sqlite_version|load_extension|read_text|glob)\s*\(/i, reason: 'Restricted system function call blocked by security guard' }
];

const SQL_KEYWORDS = new Set([
    'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN', 'NATURAL',
    'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'AS', 'SELECT', 'FROM'
]);

/**
 * Validates that a federated SQL query is read-only and free of SQL injection / multi-statement payloads.
 */
function validateFederatedSqlSafety(sql) {
    if (!sql || typeof sql !== 'string' || !sql.trim()) {
        const err = new Error('SQL query cannot be empty');
        err.statusCode = 400;
        throw err;
    }

    // Strip SQL comments for inspection
    const stripped = sql
        .replace(/--[^\r\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .trim();

    if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(stripped)) {
        const err = new Error('Only SELECT, WITH (CTE), and EXPLAIN queries are permitted in Cross-Source Federation');
        err.statusCode = 400;
        throw err;
    }

    // Remove string literals before checking forbidden keywords
    const withoutStrings = stripped.replace(/'([^']|'')*'/g, "''");

    for (const rule of FORBIDDEN_SQL_PATTERNS) {
        if (rule.regex.test(withoutStrings)) {
            const err = new Error(`SQL Security Policy Violation: ${rule.reason}`);
            err.statusCode = 400;
            throw err;
        }
    }

    return stripped;
}

/**
 * Extracts all 3-part table references (`catalog.schema.table`) and their aliases from a SQL query.
 */
function extractThreePartReferences(sql) {
    // Strip string literals and comments during token extraction so literals like 'a.b.c' aren't matched
    const maskedSql = sql
        .replace(/--[^\r\n]*/g, (m) => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
        .replace(/'([^']|'')*'/g, (m) => `'${'x'.repeat(Math.max(0, m.length - 2))}'`);

    const refs = [];
    // Match FROM or JOIN followed by catalog.schema.table [AS] [alias]
    const refRegex = /\b(FROM|(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|RIGHT\s+(?:OUTER\s+)?|FULL\s+(?:OUTER\s+)?|CROSS\s+)?JOIN|,)\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;

    let match;
    while ((match = refRegex.exec(maskedSql)) !== null) {
        const joinKeyword = match[1].trim().toUpperCase().replace(/\s+/g, ' ');
        const catalogName = match[2];
        const schemaName = match[3];
        const tableName = match[4];
        let rawAlias = match[5] || null;
        if (rawAlias && SQL_KEYWORDS.has(rawAlias.toUpperCase())) {
            rawAlias = null;
        }

        refs.push({
            fullMatch: match[0],
            joinKeyword,
            catalogName,
            schemaName,
            tableName,
            alias: rawAlias || tableName,
            explicitAlias: rawAlias,
            fqn: `${catalogName}.${schemaName}.${tableName}`,
            index: match.index
        });
    }

    return refs;
}

/**
 * Extracts referenced columns per table alias for Projection Pushdown (Column Pruning).
 */
function analyzeProjectedColumnsPerAlias(sql, refs, tableMetaMap) {
    const result = new Map();
    const hasSelectStar = /\bSELECT\s+(?:DISTINCT\s+)?\*/i.test(sql);

    for (const ref of refs) {
        const key = `${ref.fqn}#${ref.alias}`;
        const meta = tableMetaMap.get(ref.fqn.toLowerCase());
        const availableCols = (meta?.columns || []).map(c => c.column_name);

        if (hasSelectStar) {
            result.set(key, ['*']);
            continue;
        }

        // Check for `alias.*`
        const aliasStarRegex = new RegExp(`\\b${ref.alias}\\s*\\.\\s*\\*`, 'i');
        if (aliasStarRegex.test(sql)) {
            result.set(key, ['*']);
            continue;
        }

        const colSet = new Set();
        // Match `alias.column_name`
        const aliasColRegex = new RegExp(`\\b${ref.alias}\\s*\\.\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\b`, 'gi');
        let m;
        while ((m = aliasColRegex.exec(sql)) !== null) {
            const col = m[1];
            if (availableCols.length === 0 || availableCols.some(ac => ac.toLowerCase() === col.toLowerCase())) {
                const canonical = availableCols.find(ac => ac.toLowerCase() === col.toLowerCase()) || col;
                colSet.add(canonical);
            }
        }

        // Also check unqualified column names if they match this table's schema
        for (const availCol of availableCols) {
            const unqualRegex = new RegExp(`(?<![.\\w])\\b${availCol}\\b(?![.\\w])`, 'i');
            if (unqualRegex.test(sql)) {
                colSet.add(availCol);
            }
        }

        if (colSet.size === 0) {
            // E.g. `COUNT(*)` query: push down only the first column (or primary key) to minimize scan I/O
            if (availableCols.length > 0) {
                result.set(key, [availableCols[0]]);
            } else {
                result.set(key, ['*']);
            }
        } else {
            result.set(key, Array.from(colSet));
        }
    }

    return result;
}

/**
 * Extracts safe single-table predicates from the top-level WHERE clause for Predicate Pushdown.
 */
function analyzePushedPredicatesPerAlias(sql, refs, tableMetaMap) {
    const result = new Map();
    for (const ref of refs) {
        result.set(`${ref.fqn}#${ref.alias}`, []);
    }

    // Locate top-level WHERE clause (before GROUP BY / HAVING / ORDER BY / LIMIT / WINDOW)
    const whereMatch = sql.match(/\bWHERE\s+([\s\S]*?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bWINDOW\b|;|$)/i);
    if (!whereMatch) return result;

    const whereBody = whereMatch[1].trim();
    // Do not split if OR is present at top level
    if (/\bOR\b/i.test(whereBody)) return result;

    // Split conjunctive AND clauses (avoiding BETWEEN ... AND ...)
    const parts = [];
    let current = '';
    let inBetween = false;
    const tokens = whereBody.split(/(\s+AND\s+)/i);
    for (const tok of tokens) {
        if (/^\s+AND\s+$/i.test(tok)) {
            if (inBetween) {
                current += tok;
                inBetween = false;
            } else {
                parts.push(current.trim());
                current = '';
            }
        } else {
            if (/\bBETWEEN\b/i.test(tok)) inBetween = true;
            current += tok;
        }
    }
    if (current.trim()) parts.push(current.trim());

    // Identify aliases that cannot have WHERE filters pushed below an outer join if they are NULL-extended
    const hasRightOrFullJoin = refs.some(r => /RIGHT|FULL/i.test(r.joinKeyword));

    for (const cond of parts) {
        if (!cond || /\bSELECT\b/i.test(cond)) continue; // skip subquery predicates

        // Check which aliases are referenced in `cond`
        const matchedRefs = [];
        for (const ref of refs) {
            const aliasPattern = new RegExp(`\\b${ref.alias}\\s*\\.\\s*([a-zA-Z_][a-zA-Z0-9_]*)`, 'i');
            if (aliasPattern.test(cond)) {
                matchedRefs.push(ref);
            }
        }

        if (matchedRefs.length === 1) {
            const targetRef = matchedRefs[0];
            // Safe to push down if INNER/FROM, or if the predicate does not test IS NULL on an outer-joined table
            const isOuterNullable = /LEFT|RIGHT|FULL/i.test(targetRef.joinKeyword) || hasRightOrFullJoin;
            if (isOuterNullable && /\bIS\s+NULL\b/i.test(cond)) {
                continue;
            }
            const meta = tableMetaMap.get(targetRef.fqn.toLowerCase());
            const availCols = new Set((meta?.columns || []).map(c => c.column_name.toLowerCase()));
            // Strip the `alias.` prefix so the connector subquery can evaluate the predicate directly on the source table
            const strippedCond = cond.replace(
                new RegExp(`\\b${targetRef.alias}\\s*\\.\\s*([a-zA-Z_][a-zA-Z0-9_]*)`, 'gi'),
                (m, colName) => (availCols.size === 0 || availCols.has(colName.toLowerCase()) ? `"${colName}"` : m)
            );
            result.get(`${targetRef.fqn}#${targetRef.alias}`).push(strippedCond);
        }
    }

    return result;
}

/**
 * Analyzes join operations, join ordering, broadcast vs partitioned join strategy, and dynamic filters.
 */
function buildJoinOptimizationPlan(sql, refs, tableMetaMap) {
    const joinOps = [];
    const dynamicFilters = [];

    // Extract ON conditions
    const joinRegex = /\b(INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?(?:\s+ON\s+([^\r\n]+?)(?=\bINNER\b|\bLEFT\b|\bRIGHT\b|\bFULL\b|\bCROSS\b|\bJOIN\b|\bWHERE\b|\bGROUP\b|\bHAVING\b|\bORDER\b|\bLIMIT\b|;|$))?/gi;

    let m;
    while ((m = joinRegex.exec(sql)) !== null) {
        const rawType = m[1].toUpperCase().replace(/\s+/g, ' ');
        const joinType = rawType === 'JOIN' ? 'INNER JOIN' : rawType;
        const fqn = m[2];
        const alias = m[3] || fqn.split('.').pop();
        const onCondition = (m[4] || '').trim();
        const rightMeta = tableMetaMap.get(fqn.toLowerCase()) || {};
        const rightRows = Number(rightMeta.row_count_estimate || 0);
        const rightBytes = Number(rightMeta.size_bytes || 0);

        let strategy = 'BROADCAST_HASH_JOIN';
        if (joinType.includes('CROSS')) {
            strategy = 'NESTED_LOOP_CROSS_JOIN';
        } else if (rightRows > 100000 || rightBytes > 10 * 1024 * 1024) {
            strategy = 'PARTITIONED_HASH_JOIN';
        }

        if (strategy === 'BROADCAST_HASH_JOIN' && onCondition) {
            dynamicFilters.push({
                buildTable: fqn,
                buildAlias: alias,
                condition: onCondition,
                estimatedBuildRows: rightRows
            });
        }

        joinOps.push({
            joinType,
            rightTable: fqn,
            rightAlias: alias,
            condition: onCondition || (joinType.includes('CROSS') ? 'CARTESIAN (1=1)' : ''),
            strategy,
            estimatedRightRows: rightRows,
            estimatedRightBytes: rightBytes
        });
    }

    // Compute recommended cardinality-ordered join sequence (largest fact table probed against smallest dimension tables)
    const orderedSources = [...refs]
        .map(r => {
            const meta = tableMetaMap.get(r.fqn.toLowerCase()) || {};
            return {
                fqn: r.fqn,
                alias: r.alias,
                catalogName: r.catalogName,
                sourceType: meta.source_type || 'unknown',
                estimatedRows: Number(meta.row_count_estimate || 0),
                estimatedBytes: Number(meta.size_bytes || 0)
            };
        })
        .sort((a, b) => b.estimatedRows - a.estimatedRows);

    const overallJoinStrategy =
        joinOps.length === 0
            ? 'SINGLE_SOURCE_SCAN'
            : joinOps.some(j => j.strategy === 'PARTITIONED_HASH_JOIN')
            ? 'HYBRID_BROADCAST_AND_PARTITIONED_HASH_JOIN'
            : joinOps.every(j => j.strategy === 'NESTED_LOOP_CROSS_JOIN')
            ? 'NESTED_LOOP_CROSS_JOIN'
            : 'BROADCAST_HASH_JOIN';

    return {
        joinOperations: joinOps,
        dynamicFilters,
        recommendedJoinOrder: orderedSources,
        overallJoinStrategy
    };
}

/**
 * Builds the Visual DAG (nodes & edges) for the Frontend Query Execution Plan viewer.
 * Pipeline structure: Source A / Source B / Source C → Table Scan → Filter Pushdown → Join Operations → Aggregation → Final Result
 */
function buildVisualDag(scanDescriptors, joinPlan, sql) {
    const nodes = [];
    const edges = [];

    scanDescriptors.forEach((scan, idx) => {
        const srcId = `src_${idx}`;
        const scanId = `scan_${idx}`;
        const pushId = `push_${idx}`;

        nodes.push({
            id: srcId,
            stage: 'SOURCE',
            label: `${scan.catalogName} (${scan.sourceType.toUpperCase()})`,
            detail: `${scan.catalogName}.${scan.schemaName}.${scan.tableName}`,
            metrics: {
                format: scan.format,
                estimatedRows: scan.estimatedRows,
                physicalSizeBytes: scan.physicalSizeBytes
            }
        });

        nodes.push({
            id: scanId,
            stage: 'TABLE_SCAN',
            label: `Scan ${scan.tableName} AS ${scan.alias}`,
            detail: `Columns: ${(scan.pushedProjections || ['*']).join(', ')}`,
            metrics: {
                projectedColumns: (scan.pushedProjections || ['*']).length,
                totalColumns: scan.totalColumns
            }
        });

        edges.push({ from: srcId, to: scanId, label: scan.format.toUpperCase() });

        if ((scan.pushedPredicates && scan.pushedPredicates.length > 0) || (scan.pushedProjections && !scan.pushedProjections.includes('*'))) {
            nodes.push({
                id: pushId,
                stage: 'PUSHDOWN',
                label: `Predicate & Projection Pushdown`,
                detail: scan.pushedPredicates.length > 0 ? `Filter: ${scan.pushedPredicates.join(' AND ')}` : `Pruned to ${scan.pushedProjections.length} cols`,
                metrics: {
                    predicatesCount: scan.pushedPredicates.length,
                    projections: scan.pushedProjections
                }
            });
            edges.push({ from: scanId, to: pushId, label: 'Pushed Down' });
        }
    });

    let lastStageId = scanDescriptors.length > 0
        ? ((scanDescriptors[0].pushedPredicates?.length > 0 || (scanDescriptors[0].pushedProjections && !scanDescriptors[0].pushedProjections.includes('*'))) ? 'push_0' : 'scan_0')
        : 'root';

    if (joinPlan.joinOperations.length > 0) {
        joinPlan.joinOperations.forEach((jOp, jIdx) => {
            const joinId = `join_${jIdx}`;
            nodes.push({
                id: joinId,
                stage: 'JOIN',
                label: `${jOp.joinType} (${jOp.strategy})`,
                detail: `${jOp.rightTable} ON ${jOp.condition}`,
                metrics: {
                    strategy: jOp.strategy,
                    estimatedRightRows: jOp.estimatedRightRows
                }
            });
            edges.push({ from: lastStageId, to: joinId, label: 'Probe' });
            const rightScanIdx = scanDescriptors.findIndex(
                s => s.fqn.toLowerCase() === jOp.rightTable.toLowerCase() && s.alias.toLowerCase() === jOp.rightAlias.toLowerCase()
            );
            const rIdx = rightScanIdx >= 0 ? rightScanIdx : Math.min(jIdx + 1, scanDescriptors.length - 1);
            const rightNodeId =
                (scanDescriptors[rIdx]?.pushedPredicates?.length > 0 ||
                    (scanDescriptors[rIdx]?.pushedProjections && !scanDescriptors[rIdx].pushedProjections.includes('*')))
                    ? `push_${rIdx}`
                    : `scan_${rIdx}`;
            if (rightNodeId !== lastStageId) {
                edges.push({ from: rightNodeId, to: joinId, label: jOp.strategy === 'BROADCAST_HASH_JOIN' ? 'Broadcast Build' : 'Hash Build' });
            }
            lastStageId = joinId;
        });
    }

    if (/\b(GROUP\s+BY|COUNT\s*\(|SUM\s*\(|AVG\s*\(|MIN\s*\(|MAX\s*\(|OVER\s*\()/i.test(sql)) {
        const aggId = 'agg_stage';
        const hasWindow = /\bOVER\s*\(/i.test(sql);
        nodes.push({
            id: aggId,
            stage: 'AGGREGATION',
            label: hasWindow ? 'Aggregation & Window Functions' : 'Hash Aggregation (GROUP BY)',
            detail: /\bHAVING\b/i.test(sql) ? 'Includes HAVING filter' : 'Grouped Metric Computation',
            metrics: {}
        });
        edges.push({ from: lastStageId, to: aggId, label: 'Rows' });
        lastStageId = aggId;
    }

    if (/\bORDER\s+BY\b/i.test(sql)) {
        const sortId = 'sort_stage';
        nodes.push({
            id: sortId,
            stage: 'SORT',
            label: 'Top-N / Order By Sort',
            detail: 'Ordering final result set',
            metrics: {}
        });
        edges.push({ from: lastStageId, to: sortId, label: 'Sorted' });
        lastStageId = sortId;
    }

    nodes.push({
        id: 'final_result',
        stage: 'RESULT',
        label: 'Final Federated Result',
        detail: 'Streamed to Client & Live Burn Telemetry',
        metrics: {}
    });
    edges.push({ from: lastStageId, to: 'final_result', label: 'Output' });

    return { nodes, edges };
}

/**
 * Plans, validates, optimizes, and rewrites a federated SQL query across multiple catalogs.
 */
async function planFederatedQuery({ sql, user, tenantId = 'default_tenant', enablePushdown = true }) {
    const cleanSql = validateFederatedSqlSafety(sql);
    const isExplainQuery = /^EXPLAIN\s+/i.test(cleanSql);
    const executableSql = isExplainQuery ? cleanSql.replace(/^EXPLAIN\s+(?:ANALYZE\s+)?/i, '').trim() : cleanSql;

    const refs = extractThreePartReferences(executableSql);
    const tableMetaMap = new Map();
    const connectorMap = new Map();

    // Resolve metadata & verify RBAC / Tenant access for every referenced catalog.schema.table
    for (const ref of refs) {
        await verifyTableAccess({
            user,
            tenantId,
            catalogName: ref.catalogName,
            schemaName: ref.schemaName,
            tableName: ref.tableName,
            action: 'select'
        });

        const fqnLower = ref.fqn.toLowerCase();
        if (!tableMetaMap.has(fqnLower)) {
            const meta = await resolveTableMetadata(ref.catalogName, ref.schemaName, ref.tableName, tenantId);
            tableMetaMap.set(fqnLower, meta);
        }
        if (!connectorMap.has(ref.catalogName.toLowerCase())) {
            const { connector, catalog } = await getConnectorForCatalog(ref.catalogName, tenantId);
            connectorMap.set(ref.catalogName.toLowerCase(), { connector, catalog });
        }
    }

    const projectedColsMap = enablePushdown
        ? analyzeProjectedColumnsPerAlias(executableSql, refs, tableMetaMap)
        : new Map();
    const pushedPredsMap = enablePushdown
        ? analyzePushedPredicatesPerAlias(executableSql, refs, tableMetaMap)
        : new Map();

    const scanDescriptors = [];
    let rewrittenSql = executableSql;

    // Build per-reference connector scan expressions and rewrite 3-part names in SQL
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const key = `${ref.fqn}#${ref.alias}`;
        const meta = tableMetaMap.get(ref.fqn.toLowerCase());
        const { connector } = connectorMap.get(ref.catalogName.toLowerCase());

        const requestedCols = projectedColsMap.get(key) || ['*'];
        const pushedPreds = pushedPredsMap.get(key) || [];

        const scanInfo = await connector.executeScan({
            schemaName: meta.schema_name,
            tableName: meta.table_name,
            alias: ref.alias,
            columns: requestedCols,
            predicates: pushedPreds,
            tableMeta: meta
        });

        const totalColsCount = (meta.columns || []).length || 1;
        const projColsCount = scanInfo.pushedProjections.includes('*')
            ? totalColsCount
            : Math.min(totalColsCount, scanInfo.pushedProjections.length);
        const columnPruningRatio = totalColsCount > 0 ? projColsCount / totalColsCount : 1;
        const predicateSelectivityRatio = pushedPreds.length > 0 ? Math.max(0.25, Math.pow(0.65, pushedPreds.length)) : 1.0;

        const estimatedScanBytes = Math.max(
            128,
            Math.round(Number(meta.size_bytes || 1024) * columnPruningRatio * predicateSelectivityRatio)
        );

        scanDescriptors.push({
            index: i,
            fqn: ref.fqn,
            catalogId: meta.catalog_id,
            catalogName: meta.catalog_name,
            schemaName: meta.schema_name,
            tableName: meta.table_name,
            alias: ref.alias,
            sourceType: meta.source_type,
            format: meta.format,
            duckdbExpression: scanInfo.duckdbExpression,
            rawReaderExpression: scanInfo.rawReaderExpression,
            pushedPredicates: scanInfo.pushedPredicates,
            pushedProjections: scanInfo.pushedProjections,
            totalColumns: totalColsCount,
            columnPruningRatio: Number(columnPruningRatio.toFixed(4)),
            predicateSelectivityRatio: Number(predicateSelectivityRatio.toFixed(4)),
            estimatedRows: Number(meta.row_count_estimate || 0),
            physicalSizeBytes: Number(meta.size_bytes || 0),
            estimatedScanBytes,
            costCategory: scanInfo.costCategory
        });
    }

    // Rewrite `catalog.schema.table [AS alias]` in SQL to `${scan.duckdbExpression} AS ${ref.alias}`
    for (const scan of scanDescriptors) {
        const escapedFqn = scan.fqn.replace(/\./g, '\\.');
        const withAliasRegex = new RegExp(
            `\\b${escapedFqn}\\s+(?:AS\\s+)?${scan.alias}\\b`,
            'i'
        );
        const bareFqnRegex = new RegExp(`\\b${escapedFqn}\\b`, 'i');

        if (withAliasRegex.test(rewrittenSql)) {
            rewrittenSql = rewrittenSql.replace(withAliasRegex, `${scan.duckdbExpression} AS ${scan.alias}`);
        } else {
            rewrittenSql = rewrittenSql.replace(bareFqnRegex, `${scan.duckdbExpression} AS ${scan.alias}`);
        }
    }

    const joinPlan = buildJoinOptimizationPlan(executableSql, refs, tableMetaMap);
    const visualDag = buildVisualDag(scanDescriptors, joinPlan, executableSql);

    const uniqueCatalogs = Array.from(new Set(scanDescriptors.map(s => s.catalogName)));
    const uniqueSourceTypes = Array.from(new Set(scanDescriptors.map(s => s.sourceType)));
    const totalEstimatedObjectBytes = scanDescriptors
        .filter(s => s.costCategory === 'CLOUD_OBJECT_BYTES_SCANNED')
        .reduce((acc, s) => acc + s.estimatedScanBytes, 0);
    const totalEstimatedRelationalBytes = scanDescriptors
        .filter(s => s.costCategory === 'RELATIONAL_BYTES_RETRIEVED')
        .reduce((acc, s) => acc + s.estimatedScanBytes, 0);

    return {
        originalSql: sql,
        executableSql,
        rewrittenSql,
        isExplainQuery,
        tenantId,
        catalogsReferenced: uniqueCatalogs,
        sourceTypesReferenced: uniqueSourceTypes,
        scanDescriptors,
        joinPlan,
        visualDag,
        estimatedMetrics: {
            totalEstimatedObjectBytes,
            totalEstimatedRelationalBytes,
            totalEstimatedRows: scanDescriptors.reduce((acc, s) => acc + s.estimatedRows, 0),
            estimatedObjectCostUsd: Number(((totalEstimatedObjectBytes / Math.pow(1024, 4)) * 5.0).toFixed(8))
        }
    };
}

module.exports = {
    validateFederatedSqlSafety,
    extractThreePartReferences,
    planFederatedQuery
};

