const path = require('path');
const db = require('../db');

const SQL_RESERVED_WORDS = new Set([
    'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
    'SEMI', 'ANTI', 'POSITIONAL', 'ASOF', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING',
    'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY',
    'SELECT', 'FROM', 'SET', 'VALUES', 'INTO', 'SAMPLE', 'TABLESAMPLE', 'LATERAL'
]);

function stripCommentsAndStrings(sql) {
    if (!sql || typeof sql !== 'string') return '';
    let out = '';
    const len = sql.length;
    for (let i = 0; i < len; i++) {
        const ch = sql[i];
        const next = i + 1 < len ? sql[i + 1] : '';

        // Single-quoted string literal
        if (ch === "'") {
            out += " '__STR__' ";
            let j = i + 1;
            while (j < len) {
                if (sql[j] === "'") {
                    if (j + 1 < len && sql[j + 1] === "'") {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            i = j;
            continue;
        }

        // Double-quoted identifier
        if (ch === '"') {
            let j = i + 1;
            while (j < len) {
                if (sql[j] === '"') {
                    if (j + 1 < len && sql[j + 1] === '"') {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            out += sql.slice(i, Math.min(len, j + 1));
            i = j;
            continue;
        }

        // Line comment --
        if (ch === '-' && next === '-') {
            let j = i + 2;
            while (j < len && sql[j] !== '\n') j++;
            out += '\n';
            i = j;
            continue;
        }

        // Block comment /* ... */
        if (ch === '/' && next === '*') {
            let j = i + 2;
            while (j + 1 < len && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
            out += ' ';
            i = Math.min(len - 1, j + 1);
            continue;
        }

        out += ch;
    }
    return out.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, 'COUNT(1)');
}

function extractDataSourcePaths(sql) {
    const paths = new Set();
    const refRegex = /(?:from\s+|join\s+|read_[a-z0-9_]+\s*\(\s*|iceberg_[a-z0-9_]+\s*\(\s*)['"]([^'"]+)['"]\s*\)?/gi;
    for (const m of sql.matchAll(refRegex)) {
        if (m[1] && m[1].trim()) {
            paths.add(m[1].trim());
        }
    }
    // Also catch bare s3:// or az:// URIs if any
    const uriRegex = /(?:s3|az|gdrive|https?):\/\/[^\s"',;)\]]+/gi;
    for (const m of sql.matchAll(uriRegex)) {
        if (m[0]) paths.add(m[0].trim());
    }
    return Array.from(paths);
}

function detectFileFormat(sql, paths = []) {
    const combined = (sql + ' ' + paths.join(' ')).toLowerCase();
    if (combined.includes('read_parquet') || combined.includes('.parquet')) return 'parquet';
    if (combined.includes('read_orc') || combined.includes('.orc')) return 'orc';
    if (combined.includes('read_csv') || combined.includes('.csv')) return 'csv';
    if (combined.includes('read_json') || combined.includes('.json')) return 'json';
    if (combined.includes('iceberg_scan') || combined.includes('.iceberg') || combined.includes('iceberg')) return 'iceberg';
    return 'parquet';
}

function detectStorageProvider(target, paths = []) {
    if (target && target.provider_type) {
        const pt = target.provider_type.toLowerCase();
        if (pt.includes('minio')) return 'minio';
        if (pt.includes('adls') || pt.includes('azure')) return 'adls';
        if (pt.includes('s3') || pt.includes('aws')) return 's3';
        if (pt.includes('gdrive') || pt.includes('google')) return 'gdrive';
        if (pt.includes('local')) return 'local';
        return pt;
    }
    const combined = paths.join(' ').toLowerCase();
    if (combined.includes('az://') || combined.includes('dfs.core.windows.net') || combined.includes('blob.core.windows.net')) return 'adls';
    if (combined.includes('s3://') || combined.includes('amazonaws.com')) return 's3';
    if (combined.includes('gdrive://')) return 'gdrive';
    return 's3';
}

function detectQueryType(cleanSql) {
    const trimmed = cleanSql.trim().toUpperCase();
    if (trimmed.startsWith('DESCRIBE') || trimmed.startsWith('SHOW') || trimmed.startsWith('EXPLAIN')) {
        return 'DESCRIBE';
    }
    if (trimmed.startsWith('INSERT') || trimmed.startsWith('CREATE') || trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE')) {
        return 'MUTATION';
    }
    if (/\b(GROUP\s+BY|SUM\s*\(|AVG\s*\(|COUNT\s*\(|MIN\s*\(|MAX\s*\(|APPROX_COUNT_DISTINCT)\b/i.test(cleanSql)) {
        return 'AGGREGATE';
    }
    if (/\b(JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN)\b/i.test(cleanSql)) {
        return 'JOIN';
    }
    if (/\bWHERE\b/i.test(cleanSql)) {
        return 'FILTER';
    }
    return 'SELECT';
}

/**
 * Extract structured execution plan features from SQL text and metadata catalog.
 */
async function extractQueryPlanFeatures(sql, target = null, tenantId = 'default') {
    const cleanSql = stripCommentsAndStrings(sql || '');
    const tokens = cleanSql.split(/\s+/).filter(Boolean);
    const tokenCount = tokens.length;
    const queryLength = (sql || '').length;

    // Join count
    const joinMatches = cleanSql.match(/\b(JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|NATURAL\s+JOIN)\b/gi);
    const joinCount = joinMatches ? joinMatches.length : 0;

    // Filter count (WHERE/HAVING condition operators)
    let filterCount = 0;
    const whereMatch = cleanSql.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|\bWINDOW\b|$)/i);
    if (whereMatch && whereMatch[1]) {
        const whereClause = whereMatch[1];
        const conditions = whereClause.match(/\b(AND|OR)\b|[=<>!]{1,2}|\bLIKE\b|\bIN\b|\bBETWEEN\b/gi);
        filterCount = conditions ? conditions.length : 1;
    }
    const havingMatch = cleanSql.match(/\bHAVING\b([\s\S]*?)(?:\bORDER\b|\bLIMIT\b|$)/i);
    if (havingMatch && havingMatch[1]) {
        const havingConds = havingMatch[1].match(/\b(AND|OR)\b|[=<>!]{1,2}|\bLIKE\b|\bIN\b/gi);
        filterCount += havingConds ? havingConds.length : 1;
    }

    // Aggregations count
    const aggMatches = cleanSql.match(/\b(COUNT|SUM|AVG|MIN|MAX|APPROX_COUNT_DISTINCT|STDDEV|VARIANCE|MEDIAN|QUANTILE)\s*\(/gi);
    const aggregationCount = aggMatches ? aggMatches.length : 0;

    // Group by and Order by
    const hasGroupBy = /\bGROUP\s+BY\b/i.test(cleanSql) ? 1 : 0;
    const hasOrderBy = /\bORDER\s+BY\b/i.test(cleanSql) ? 1 : 0;

    // Limit value
    let limitValue = -1;
    const limitMatch = cleanSql.match(/\bLIMIT\s+(\d+)\b/i);
    if (limitMatch && limitMatch[1]) {
        limitValue = parseInt(limitMatch[1], 10);
    }

    // Wildcard SELECT *
    const hasWildcard = /\bSELECT\s+(?:DISTINCT\s+)?\*|\.\*/i.test(cleanSql) ? 1 : 0;

    // CTE count
    const cteMatches = cleanSql.match(/\bWITH\b|\b,\s*[a-zA-Z0-9_]+\s+AS\s*\(/gi);
    const cteCount = cteMatches ? cteMatches.length : 0;

    // Projections count estimate (expressions between SELECT and FROM)
    let projectionCount = 1;
    const selectFromMatch = cleanSql.match(/\bSELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\bFROM\b/i);
    if (selectFromMatch && selectFromMatch[1]) {
        const selectCols = selectFromMatch[1].split(',');
        projectionCount = selectCols.length;
    }

    // Data source paths and catalog lookup
    const paths = extractDataSourcePaths(sql);
    const storageProvider = detectStorageProvider(target, paths);
    const fileFormat = detectFileFormat(sql, paths);
    const queryType = detectQueryType(cleanSql);

    let fileCount = Math.max(1, paths.length);
    let totalFileSize = 0;

    // Query catalog for file sizes if target or paths exist
    if (paths.length > 0) {
        try {
            for (const p of paths) {
                const base = path.basename(p);
                const catRow = await db.get(`
                    SELECT file_size, format 
                    FROM metadata_catalog 
                    WHERE file_name = ? OR file_path LIKE ?
                    LIMIT 1
                `, [base, `%${base}%`]);

                if (catRow && Number(catRow.file_size) > 0) {
                    totalFileSize += Number(catRow.file_size);
                } else {
                    // Default fallback estimated file size based on format
                    totalFileSize += (fileFormat === 'parquet' ? 25 * 1024 * 1024 : 50 * 1024 * 1024);
                }
            }
        } catch (_) {
            totalFileSize = fileCount * 25 * 1024 * 1024;
        }
    } else {
        totalFileSize = 25 * 1024 * 1024;
    }

    return {
        tenant_id: tenantId || 'default',
        query_type: queryType,
        storage_provider: storageProvider,
        file_format: fileFormat,
        file_count: fileCount,
        total_file_size_bytes: totalFileSize,
        join_count: joinCount,
        filter_count: filterCount,
        projection_count: projectionCount,
        aggregation_count: aggregationCount,
        has_wildcard: hasWildcard,
        has_group_by: hasGroupBy,
        has_order_by: hasOrderBy,
        limit_value: limitValue,
        has_limit: limitValue >= 0 ? 1 : 0,
        cte_count: cteCount,
        query_length: queryLength,
        token_count: tokenCount,
        paths
    };
}

module.exports = {
    stripCommentsAndStrings,
    extractDataSourcePaths,
    detectFileFormat,
    detectStorageProvider,
    detectQueryType,
    extractQueryPlanFeatures
};

