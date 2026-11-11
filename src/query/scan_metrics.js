const fs = require('fs');
const path = require('path');
const { parseWithCtes } = require('./out_of_core');

// Cloud Lakehouse standard pricing: $5.00 USD per TiB (1 TiB = 1024^4 bytes)
const COST_PER_TIB_USD = 5.00;
const TIB_BYTES = 1024 * 1024 * 1024 * 1024; // 1,099,511,627,776 bytes
const CURRENCY = 'USD';
const PRICING_UNIT = '$5.00 / TiB';

const SQL_RESERVED_WORDS = new Set([
    'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
    'SEMI', 'ANTI', 'POSITIONAL', 'ASOF', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING',
    'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY',
    'SELECT', 'FROM', 'SET', 'VALUES', 'INTO', 'SAMPLE', 'TABLESAMPLE', 'LATERAL'
]);

const _parquetStatsCache = new Map();

function _stripCommentsAndStrings(sql) {
    let out = '';
    const len = sql.length;
    for (let i = 0; i < len; i++) {
        const ch = sql[i];
        const next = i + 1 < len ? sql[i + 1] : '';

        // Single-quoted string literal -> placeholder so paths/literals aren't matched as column names
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

        // Double-quoted identifier -> keep content so quoted column/alias names still match
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
    // Neutralize COUNT(*) so '*' inside COUNT(*) is never treated as wildcard SELECT *
    return out.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, 'COUNT(1)');
}

function _extractDataSourceRefs(executableSql) {
    const refsByPath = new Map();
    const refRegex = /(?:from\s+|join\s+|read_[a-z0-9_]+\s*\(\s*|iceberg_[a-z0-9_]+\s*\(\s*)['"]([^'"]+)['"]\s*\)?(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*|"[^"]+"))?/gi;

    for (const m of executableSql.matchAll(refRegex)) {
        const rawPath = (m[1] || '').trim();
        if (!rawPath) continue;

        let alias = (m[2] || '').trim().replace(/^"+|"+$/g, '');
        if (alias && SQL_RESERVED_WORDS.has(alias.toUpperCase())) {
            alias = '';
        }

        if (!refsByPath.has(rawPath)) {
            refsByPath.set(rawPath, {
                physPath: rawPath,
                aliases: new Set(),
                occurrences: 0
            });
        }
        const entry = refsByPath.get(rawPath);
        entry.occurrences += 1;
        if (alias) entry.aliases.add(alias);
    }

    return Array.from(refsByPath.values());
}

function _getSqlScopesForPath(executableSql, physPath) {
    const parsed = parseWithCtes(executableSql);
    if (!parsed) return [executableSql];

    const matchingScopes = [];
    for (const cte of parsed.ctes) {
        if (cte.body.includes(physPath)) {
            matchingScopes.push(cte.body);
        }
    }
    if (parsed.mainQuery.includes(physPath)) {
        matchingScopes.push(parsed.mainQuery);
    }
    return matchingScopes.length > 0 ? matchingScopes : [executableSql];
}

function _hasWildcardSelectInScope(cleanedScopeSql, aliases) {
    // Check alias.* (e.g. s.*)
    for (const a of aliases) {
        const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const aliasStarRe = new RegExp(`(?:^|[^A-Za-z0-9_$])"?${esc}"?\\s*\\.\\s*\\*`, 'i');
        if (aliasStarRe.test(cleanedScopeSql)) return true;
    }

    // Check bare SELECT * or SELECT ..., * FROM (excluding multiplication like qty * price)
    if (/\bSELECT\s+(?:DISTINCT\s+)?\*(?=\s*(?:,|\bFROM\b|$))/i.test(cleanedScopeSql)) {
        return true;
    }
    if (/,\s*\*(?=\s*(?:,|\bFROM\b))/i.test(cleanedScopeSql)) {
        return true;
    }
    return false;
}

function _isColumnReferencedInScopes(colName, cleanedScopes, aliases) {
    const escCol = colName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const scope of cleanedScopes) {
        // 1. Qualified with any alias of this table: alias.colName
        for (const a of aliases) {
            const escAlias = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const qualRe = new RegExp(`(?:^|[^A-Za-z0-9_$])"?${escAlias}"?\\s*\\.\\s*"?${escCol}"?(?:$|[^A-Za-z0-9_$])`, 'i');
            if (qualRe.test(scope)) return true;
        }

        // 2. Unqualified column reference (not preceded by '.' and not an output 'AS alias')
        const unqualRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])"?${escCol}"?(?:$|[^A-Za-z0-9_$])`, 'i');
        const strippedQuals = scope
            .replace(/\bAS\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi, ' ')
            .replace(/"?[A-Za-z_][A-Za-z0-9_$]*"?\s*\.\s*"?[A-Za-z_][A-Za-z0-9_$]*"?/g, ' __QUAL__ ');
        if (unqualRe.test(strippedQuals)) return true;
    }

    return false;
}

function _detectPureLimitPreview(executableSql) {
    const cleaned = _stripCommentsAndStrings(executableSql).trim().replace(/;+\s*$/, '');
    if (/^\s*WITH\b/i.test(cleaned)) return null;
    if (/\b(WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|UNION|INTERSECT|EXCEPT|DISTINCT)\b/i.test(cleaned)) {
        return null;
    }
    if (/\b(COUNT|SUM|AVG|MIN|MAX|MEDIAN|QUANTILE|STDDEV|VARIANCE|LIST|STRING_AGG|APPROX_COUNT_DISTINCT)\s*\(/i.test(cleaned)) {
        return null;
    }
    const m = cleaned.match(/\bLIMIT\s+(\d+)\s*$/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

async function _lookupCatalogBytes(db, targetId, physPath) {
    if (!db) return 0;
    try {
        // Strip cloud URI prefix s3://bucket/key or az://bucket/key
        let cleanKey = physPath.replace(/^(?:s3|r2|az|gdrive):\/\/[^/]+\//i, '').replace(/^\/+/, '');
        const baseName = path.posix.basename(cleanKey.replace(/\\/g, '/'));

        if (/[*?[\]]/.test(cleanKey)) {
            const prefix = cleanKey.split(/[*?[\]]/)[0];
            const row = await db.get(
                `SELECT COALESCE(SUM(file_size), 0) AS total_bytes FROM metadata_catalog WHERE (target_id = ? OR ? IS NULL) AND file_path LIKE ?`,
                [targetId || null, targetId || null, `${prefix}%`]
            );
            if (row && Number(row.total_bytes) > 0) return Number(row.total_bytes);
        }

        let row = await db.get(
            `SELECT file_size FROM metadata_catalog WHERE target_id = ? AND (file_path = ? OR file_name = ?) LIMIT 1`,
            [targetId, cleanKey, cleanKey]
        );
        if (!row) {
            row = await db.get(
                `SELECT file_size FROM metadata_catalog WHERE target_id = ? AND file_name = ? LIMIT 1`,
                [targetId, baseName]
            );
        }
        if (!row) {
            row = await db.get(
                `SELECT file_size FROM metadata_catalog WHERE file_path = ? OR file_name = ? LIMIT 1`,
                [cleanKey, baseName]
            );
        }
        return row ? Number(row.file_size || 0) : 0;
    } catch (_) {
        return 0;
    }
}

function _getLocalPathBytes(physPath) {
    try {
        const localCandidate = physPath.replace(/\//g, path.sep);
        if (!/^(?:s3|r2|az|gdrive|https?):\/\//i.test(physPath)) {
            if (/[*?[\]]/.test(physPath)) {
                const dirPart = path.dirname(localCandidate);
                const pattern = path.basename(localCandidate)
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.');
                const re = new RegExp(`^${pattern}$`, 'i');
                if (fs.existsSync(dirPart)) {
                    let sum = 0;
                    for (const f of fs.readdirSync(dirPart)) {
                        if (re.test(f)) {
                            try { sum += fs.statSync(path.join(dirPart, f)).size; } catch (_) {}
                        }
                    }
                    return sum;
                }
            } else if (fs.existsSync(localCandidate)) {
                const st = fs.statSync(localCandidate);
                if (st.isFile()) return st.size;
                if (st.isDirectory()) {
                    // Sum data files inside directory (e.g. local Iceberg / partitioned dataset)
                    let sum = 0;
                    const walk = (d) => {
                        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
                            const full = path.join(d, ent.name);
                            if (ent.isDirectory()) walk(full);
                            else if (ent.isFile()) sum += fs.statSync(full).size;
                        }
                    };
                    walk(localCandidate);
                    return sum;
                }
            }
        }
    } catch (_) {}
    return 0;
}

async function _getParquetColumnStats(allSqlCmd, physPath, knownFileBytes) {
    const cacheKey = `${physPath}::${knownFileBytes || 0}`;
    if (_parquetStatsCache.has(cacheKey)) {
        return _parquetStatsCache.get(cacheKey);
    }

    try {
        const safePath = physPath.replace(/\\/g, '/').replace(/'/g, "''");
        const colRows = await allSqlCmd(`
            SELECT
                path_in_schema,
                CAST(SUM(total_compressed_size) AS BIGINT) AS comp_bytes,
                CAST(COUNT(DISTINCT row_group_id) AS BIGINT) AS num_row_groups
            FROM parquet_metadata('${safePath}')
            GROUP BY path_in_schema
        `);
        const rgRows = await allSqlCmd(`
            SELECT CAST(COALESCE(SUM(rg_rows), 0) AS BIGINT) AS total_rows
            FROM (
                SELECT row_group_id, MAX(row_group_num_rows) AS rg_rows
                FROM parquet_metadata('${safePath}')
                GROUP BY row_group_id
            ) _rg
        `);

        const colBytesMap = new Map();
        let sumCompressedCols = 0;
        let numRowGroups = 1;

        for (const r of (colRows || [])) {
            const rawCol = String(r.path_in_schema || '');
            const topCol = rawCol.split(/[.,]/)[0].trim().replace(/^"+|"+$/g, '').toLowerCase();
            const cBytes = Math.max(0, Number(r.comp_bytes || 0));
            const rgs = Math.max(1, Number(r.num_row_groups || 1));
            if (rgs > numRowGroups) numRowGroups = rgs;
            if (topCol) {
                colBytesMap.set(topCol, (colBytesMap.get(topCol) || 0) + cBytes);
                sumCompressedCols += cBytes;
            }
        }

        const totalRows = Math.max(0, Number(rgRows?.[0]?.total_rows || 0));
        const hasExactFileBytes = Number(knownFileBytes) > sumCompressedCols;
        const footerBytes = hasExactFileBytes
            ? Math.min(65536, Math.max(64, Number(knownFileBytes) - sumCompressedCols))
            : Math.min(65536, Math.max(256, Math.round(sumCompressedCols * 0.05)));
        const physicalFileBytes = hasExactFileBytes
            ? Number(knownFileBytes)
            : (sumCompressedCols + footerBytes);

        const stats = {
            physicalFileBytes,
            sumCompressedCols,
            footerBytes,
            numRowGroups,
            totalRows,
            colBytesMap
        };

        if (_parquetStatsCache.size > 500) {
            const oldestKey = _parquetStatsCache.keys().next().value;
            _parquetStatsCache.delete(oldestKey);
        }
        _parquetStatsCache.set(cacheKey, stats);
        return stats;
    } catch (_) {
        return null;
    }
}

function _compareStatVal(a, b) {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isFinite(numA) && Number.isFinite(numB) && String(a).trim() !== '' && String(b).trim() !== '') {
        return numA - numB;
    }
    return String(a).localeCompare(String(b));
}

async function _estimateSurvivingRowGroupRatio(allSqlCmd, safePath, rawScopes, numRowGroups, colBytesMap, aliases) {
    const defaultRes = {
        ratio: 1.0,
        survivingRowGroups: numRowGroups || 1,
        totalRowGroups: numRowGroups || 1,
        pushedFilters: []
    };
    if ( typeof allSqlCmd !== 'function') return defaultRes;

    try {
        const combined = rawScopes.join(' ');
        const whereMatch = combined.match(/\bWHERE\s+([\s\S]+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
        if (!whereMatch) return defaultRes;

        const whereClause = whereMatch[1].trim();
        const predicateRegex = /(?:([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_$]*)\s*(=|>=|<=|>|<)\s*('[^']*'|-?\d+(?:\.\d+)?)/gi;
        const matchedPredicates = [];

        for (const m of whereClause.matchAll(predicateRegex)) {
            const qual = (m[1] || '').toLowerCase();
            const col = (m[2] || '').toLowerCase();
            const op = m[3];
            const rawVal = m[4].replace(/^'|'$/g, '');

            if (!colBytesMap || !colBytesMap.has(col)) continue;
            if (qual && aliases && aliases.size > 0) {
                const lowerAliases = new Set(Array.from(aliases).map(a => a.toLowerCase()));
                if (!lowerAliases.has(qual)) continue;
            }
            matchedPredicates.push({ col, op, val: rawVal, expr: `${col} ${op} ${m[4]}` });
        }

        if (matchedPredicates.length === 0) return defaultRes;

        const pushedFilters = matchedPredicates.map(p => p.expr);

        // Evaluate all matched predicates across row groups using Parquet min/max statistics
        const survivingByRg = new Map();
        for (let rgId = 0; rgId < numRowGroups; rgId++) {
            survivingByRg.set(rgId, true);
        }

        for (const pred of matchedPredicates) {
            const metaRows = await allSqlCmd(`
                SELECT row_group_id, stats_min_value, stats_max_value, stats_min, stats_max
                FROM parquet_metadata('${safePath}')
                WHERE LOWER(path_in_schema) = '${pred.col}'
            `);
            if (!metaRows || metaRows.length === 0) continue;

            for (const rg of metaRows) {
                const rgId = Number(rg.row_group_id);
                if (!survivingByRg.get(rgId)) continue;
                const minV = rg.stats_min_value ?? rg.stats_min;
                const maxV = rg.stats_max_value ?? rg.stats_max;
                if (minV === null || maxV === null || minV === undefined || maxV === undefined) continue;

                let canMatch = true;
                if (pred.op === '=') {
                    canMatch = _compareStatVal(pred.val, minV) >= 0 && _compareStatVal(pred.val, maxV) <= 0;
                } else if (pred.op === '>') {
                    canMatch = _compareStatVal(maxV, pred.val) > 0;
                } else if (pred.op === '>=') {
                    canMatch = _compareStatVal(maxV, pred.val) >= 0;
                } else if (pred.op === '<') {
                    canMatch = _compareStatVal(minV, pred.val) < 0;
                } else if (pred.op === '<=') {
                    canMatch = _compareStatVal(minV, pred.val) <= 0;
                }
                if (!canMatch) {
                    survivingByRg.set(rgId, false);
                }
            }
        }

        let survivingCount = 0;
        for (const v of survivingByRg.values()) {
            if (v) survivingCount++;
        }
        const ratio = Math.max(0.05, Math.min(1.0, survivingCount / numRowGroups));
        return {
            ratio,
            survivingRowGroups: survivingCount,
            totalRowGroups: numRowGroups,
            pushedFilters
        };
    } catch (_) {
        return defaultRes;
    }
}

/**
 * Computes accurate physical scanned bytes and cloud burn USD for a completed DuckDB query
 * using real Parquet per-column compressed metadata, row-group pruning, local SSD cache stats,
 * and metadata_catalog object sizes.
 *
 * Clearly distinguishes and labels:
 * - compressedObjectBytes: Total physical size of compressed Parquet object(s) in S3 / ADLS Gen2
 * - bytesTransferred: Actual network bytes transferred from remote object storage during execution
 * - logicalBytesScanned: Parquet footer + projected column bytes across surviving row groups after predicate pushdown
 */
async function computeQueryScanMetrics({
    originalSql,
    executableSql,
    rows,
    targetId,
    allSqlCmd,
    db,
    cacheReport,
    executionId,
    referencedTables = []
}) {
    const rawOrig = String(originalSql || '');
    const rawExec = String(executableSql || rawOrig);
    const execId = executionId || require('crypto').randomUUID();

    // Schema inspection (DESCRIBE) reads only file footer / schema metadata
    if (/^\s*DESCRIBE\b/i.test(rawOrig)) {
        const estimatedScan = 8192;
        const onDemandCostUsd = (estimatedScan / TIB_BYTES) * COST_PER_TIB_USD;
        return {
            executionId: execId,
            estimatedScan,
            logicalScannedBytes: estimatedScan,
            compressedObjectBytes: estimatedScan,
            bytesTransferred: 0,
            totalDatasetBytes: estimatedScan,
            pruningSavedPct: 0,
            storageBytesDownloaded: 0,
            cacheStatus: 'LOCAL',
            cacheHits: 0,
            cacheMisses: 0,
            estimatedCost: onDemandCostUsd,
            billedCostUsd: 0,
            onDemandCostUsd,
            cacheSavingsUsd: onDemandCostUsd,
            currency: CURRENCY,
            pricingUnit: PRICING_UNIT,
            perFileBreakdown: [],
            sourceBreakdown: []
        };
    }

    const refs = _extractDataSourceRefs(rawExec);
    if (refs.length === 0) {
        return {
            executionId: execId,
            estimatedScan: 0,
            logicalScannedBytes: 0,
            compressedObjectBytes: 0,
            bytesTransferred: 0,
            totalDatasetBytes: 0,
            pruningSavedPct: 0,
            storageBytesDownloaded: 0,
            cacheStatus: 'LOCAL',
            cacheHits: 0,
            cacheMisses: 0,
            estimatedCost: 0,
            billedCostUsd: 0,
            onDemandCostUsd: 0,
            cacheSavingsUsd: 0,
            currency: CURRENCY,
            pricingUnit: PRICING_UNIT,
            perFileBreakdown: [],
            sourceBreakdown: []
        };
    }

    const pureLimitN = refs.length === 1 ? _detectPureLimitPreview(rawExec) : null;
    let totalLogicalScannedBytes = 0;
    let totalDatasetBytes = 0;
    let totalUncachedLogicalBytes = 0;
    let totalBytesTransferred = 0;
    const perFileBreakdown = [];
    const sourceBreakdown = [];

    const perFileCache = new Map();
    if (cacheReport && Array.isArray(cacheReport.perFile)) {
        for (const item of cacheReport.perFile) {
            if (item.physPath) perFileCache.set(item.physPath, item);
            if (item.originalUri) perFileCache.set(item.originalUri, item);
            if (item.objectKey) perFileCache.set(item.objectKey, item);
        }
    }

    // Map referencedTables by resolvedPath, storageUri, or basename
    const tableMetaByPath = new Map();
    for (const tbl of (referencedTables || [])) {
        if (tbl.resolvedPath) tableMetaByPath.set(tbl.resolvedPath, tbl);
        if (tbl.storageUri) tableMetaByPath.set(tbl.storageUri, tbl);
        if (tbl.filePath) tableMetaByPath.set(tbl.filePath, tbl);
    }

    for (const ref of refs) {
        const { physPath, aliases } = ref;
        const lowerPath = physPath.toLowerCase();
        const isParquetSingle = lowerPath.endsWith('.parquet') && !/[*?[\]]/.test(physPath);

        const matchedTableMeta =
            tableMetaByPath.get(physPath) ||
            Array.from(tableMetaByPath.values()).find(t =>
                physPath.endsWith(t.filePath) ||
                (t.alias && aliases.has(t.alias))
            ) || null;

        const effectiveTargetId = matchedTableMeta?.targetId || targetId;
        const localBytes = _getLocalPathBytes(physPath);
        const catalogBytes = localBytes > 0 ? localBytes : await _lookupCatalogBytes(db, effectiveTargetId, physPath);
        const knownBytes = Math.max(localBytes, catalogBytes, Number(matchedTableMeta?.fileSize || 0));

        let fileTotalBytes = knownBytes;
        let fileLogicalScan = 0;
        let projectedColumns = [];
        let totalColumnsCount = 0;
        let pushedFilters = [];
        let survivingRowGroups = 1;
        let totalRowGroups = 1;

        if (isParquetSingle && typeof allSqlCmd === 'function') {
            const pqStats = await _getParquetColumnStats(allSqlCmd, physPath, knownBytes);
            if (pqStats && pqStats.colBytesMap.size > 0) {
                fileTotalBytes = pqStats.physicalFileBytes;
                totalColumnsCount = pqStats.colBytesMap.size;
                totalRowGroups = pqStats.numRowGroups;
                survivingRowGroups = pqStats.numRowGroups;

                const rawScopes = _getSqlScopesForPath(rawExec, physPath);
                const cleanedScopes = rawScopes.map(_stripCommentsAndStrings);
                const selectAll = cleanedScopes.some(sc => _hasWildcardSelectInScope(sc, aliases));

                let colScannedBytes = 0;
                if (selectAll) {
                    colScannedBytes = pqStats.sumCompressedCols;
                    projectedColumns = Array.from(pqStats.colBytesMap.keys());
                } else {
                    for (const [colLower, cBytes] of pqStats.colBytesMap.entries()) {
                        if (_isColumnReferencedInScopes(colLower, cleanedScopes, aliases)) {
                            colScannedBytes += cBytes;
                            projectedColumns.push(colLower);
                        }
                    }
                    // For COUNT(*) where no specific column is referenced, DuckDB reads metadata/minimal column
                    if (projectedColumns.length === 0) {
                        const firstCol = pqStats.colBytesMap.entries().next().value;
                        if (firstCol) {
                            projectedColumns.push(firstCol[0]);
                            colScannedBytes = Math.min(firstCol[1], pqStats.footerBytes);
                        }
                    }
                }

                // Apply predicate pushdown row-group pruning estimation
                const safePath = physPath.replace(/\\/g, '/').replace(/'/g, "''");
                const rgPrune = await _estimateSurvivingRowGroupRatio(
                    allSqlCmd,
                    safePath,
                    rawScopes,
                    pqStats.numRowGroups,
                    pqStats.colBytesMap,
                    aliases
                );
                survivingRowGroups = rgPrune.survivingRowGroups;
                totalRowGroups = rgPrune.totalRowGroups;
                pushedFilters = rgPrune.pushedFilters;
                colScannedBytes = Math.round(colScannedBytes * rgPrune.ratio);

                // Apply pure LIMIT N row-group early stop
                if (pureLimitN !== null && pqStats.totalRows > 0 && pqStats.numRowGroups > 1) {
                    const rowsPerRg = Math.max(1, Math.ceil(pqStats.totalRows / pqStats.numRowGroups));
                    const rgsRead = Math.min(pqStats.numRowGroups, Math.max(1, Math.ceil(pureLimitN / rowsPerRg)));
                    survivingRowGroups = Math.min(survivingRowGroups, rgsRead);
                    colScannedBytes = Math.round(colScannedBytes * (rgsRead / pqStats.numRowGroups));
                }

                fileLogicalScan = Math.min(pqStats.physicalFileBytes, pqStats.footerBytes + colScannedBytes);
            }
        }

        // Non-Parquet or fallback when parquet_metadata is unavailable
        if (fileLogicalScan === 0) {
            if (knownBytes > 0) {
                if (pureLimitN !== null && /\.(csv|tsv|txt|json|ndjson)$/i.test(lowerPath)) {
                    const approxRowBytes = 256;
                    fileLogicalScan = Math.min(knownBytes, Math.max(65536, pureLimitN * approxRowBytes));
                } else {
                    fileLogicalScan = knownBytes;
                }
                fileTotalBytes = knownBytes;
            } else {
                const payloadBytes = JSON.stringify(rows || [], (k, v) => typeof v === 'bigint' ? v.toString() : v).length * 2;
                fileLogicalScan = Math.max(payloadBytes, 65536);
                fileTotalBytes = fileLogicalScan;
            }
        }

        const compressedObjectBytes = Math.max(fileTotalBytes, fileLogicalScan);
        totalLogicalScannedBytes += fileLogicalScan;
        totalDatasetBytes += compressedObjectBytes;

        // Check cache status & network bytes transferred
        const cachedItem =
            perFileCache.get(physPath) ||
            (matchedTableMeta?.storageUri && perFileCache.get(matchedTableMeta.storageUri)) ||
            (matchedTableMeta?.filePath && perFileCache.get(matchedTableMeta.filePath)) ||
            perFileCache.get(path.posix.basename(physPath));

        const isRemoteUri = /^(?:s3|r2|az|abfss|https?):\/\//i.test(physPath);
        const isLocallyCached = cachedItem
            ? (cachedItem.cacheHit === true)
            : (localBytes > 0 && !isRemoteUri && !matchedTableMeta?.isRemoteSource);

        let fileBytesTransferred = 0;
        if (cachedItem && Number(cachedItem.downloadedBytes) > 0) {
            fileBytesTransferred = Number(cachedItem.downloadedBytes);
        } else if (isRemoteUri || (matchedTableMeta?.isRemoteSource && !isLocallyCached)) {
            fileBytesTransferred = fileLogicalScan;
        }
        totalBytesTransferred += fileBytesTransferred;

        if (!isLocallyCached) {
            totalUncachedLogicalBytes += fileLogicalScan;
        }

        const sourceOnDemandCostUsd = (fileLogicalScan / TIB_BYTES) * COST_PER_TIB_USD;
        const sourceBilledCostUsd = isLocallyCached ? 0 : sourceOnDemandCostUsd;

        perFileBreakdown.push({
            path: physPath,
            logicalScan: fileLogicalScan,
            totalBytes: compressedObjectBytes,
            bytesTransferred: fileBytesTransferred,
            isCached: isLocallyCached,
            projectedColumns,
            totalColumns: totalColumnsCount,
            pushedFilters,
            survivingRowGroups,
            totalRowGroups
        });

        sourceBreakdown.push({
            fullName: matchedTableMeta?.fullName || path.posix.basename(physPath),
            catalogName: matchedTableMeta?.catalogName || 'default',
            schemaName: matchedTableMeta?.schemaName || 'default',
            tableName: matchedTableMeta?.tableName || path.posix.basename(physPath),
            targetId: effectiveTargetId,
            targetName: matchedTableMeta?.targetName || 'Storage Target',
            providerType: matchedTableMeta?.providerType || (physPath.startsWith('az://') ? 'adls' : 's3'),
            provider: matchedTableMeta?.providerType || (physPath.startsWith('az://') ? 'adls' : 's3'),
            bucket: matchedTableMeta?.bucket || '',
            storageUri: matchedTableMeta?.storageUri || physPath,
            compressedObjectBytes,
            bytesTransferred: fileBytesTransferred,
            logicalBytesScanned: fileLogicalScan,
            logicalScannedBytes: fileLogicalScan,
            projectedColumns,
            totalColumns: totalColumnsCount,
            pushedFilters,
            survivingRowGroups,
            totalRowGroups,
            pruningSavedPct: compressedObjectBytes > 0
                ? Math.max(0, Math.min(99, Math.round(((compressedObjectBytes - fileLogicalScan) / compressedObjectBytes) * 100)))
                : 0,
            cacheStatus: isLocallyCached ? 'HIT' : (fileBytesTransferred > 0 ? 'MISS' : 'LOCAL'),
            estimatedCostUsd: sourceOnDemandCostUsd,
            billedCostUsd: sourceBilledCostUsd
        });
    }

    const logicalScannedBytes = Math.max(0, Math.round(totalLogicalScannedBytes));
    totalDatasetBytes = Math.max(totalDatasetBytes, logicalScannedBytes);

    const pruningSavedPct = totalDatasetBytes > 0
        ? Math.max(0, Math.min(99, Math.round(((totalDatasetBytes - logicalScannedBytes) / totalDatasetBytes) * 100)))
        : 0;

    const storageBytesDownloaded = Math.max(
        totalBytesTransferred,
        cacheReport ? Number(cacheReport.bytesDownloaded || 0) : 0
    );
    const cacheHits = cacheReport ? Number(cacheReport.hits || 0) : 0;
    const cacheMisses = cacheReport ? Number(cacheReport.misses || 0) : 0;

    let cacheStatus = 'LOCAL';
    if (cacheReport && (cacheHits > 0 || cacheMisses > 0)) {
        if (cacheHits > 0 && cacheMisses === 0) cacheStatus = 'HIT';
        else if (cacheMisses > 0 && cacheHits === 0) cacheStatus = 'MISS';
        else cacheStatus = 'PARTIAL';
    } else if (storageBytesDownloaded > 0) {
        cacheStatus = 'MISS';
    }

    const onDemandCostUsd = (logicalScannedBytes / TIB_BYTES) * COST_PER_TIB_USD;
    // When served from local SSD cache, cloud storage scan charges are 0 (no double-charging)
    const billedCostUsd = (totalUncachedLogicalBytes / TIB_BYTES) * COST_PER_TIB_USD;
    const cacheSavingsUsd = Math.max(0, onDemandCostUsd - billedCostUsd);

    return {
        executionId: execId,
        estimatedScan: logicalScannedBytes,
        logicalScannedBytes,
        compressedObjectBytes: totalDatasetBytes,
        bytesTransferred: storageBytesDownloaded,
        totalDatasetBytes,
        pruningSavedPct,
        storageBytesDownloaded,
        cacheStatus,
        cacheHits,
        cacheMisses,
        estimatedCost: onDemandCostUsd,
        billedCostUsd,
        onDemandCostUsd,
        cacheSavingsUsd,
        currency: CURRENCY,
        pricingUnit: PRICING_UNIT,
        perFileBreakdown,
        sourceBreakdown
    };
}

/**
 * Synchronous fallback helper preserved for backwards-compatible exports;
 * prefers attached `_scanMeta` computed during `runQuery`.
 */
function calculateCost(sql, rows) {
    if (rows && rows._scanMeta) {
        return rows._scanMeta;
    }
    const refs = _extractDataSourceRefs(String(sql || ''));
    if (refs.length === 0) {
        return {
            estimatedScan: 0,
            estimatedCost: 0,
            logicalScannedBytes: 0,
            billedCostUsd: 0,
            onDemandCostUsd: 0,
            currency: CURRENCY,
            pricingUnit: PRICING_UNIT
        };
    }
    let sumLocal = 0;
    for (const r of refs) {
        sumLocal += _getLocalPathBytes(r.physPath);
    }
    const estimatedScan = sumLocal > 0
        ? sumLocal
        : JSON.stringify(rows || [], (k, v) => typeof v === 'bigint' ? v.toString() : v).length * 2;
    const estimatedCost = (estimatedScan / TIB_BYTES) * COST_PER_TIB_USD;
    return {
        estimatedScan,
        estimatedCost,
        logicalScannedBytes: estimatedScan,
        billedCostUsd: estimatedCost,
        onDemandCostUsd: estimatedCost,
        currency: CURRENCY,
        pricingUnit: PRICING_UNIT
    };
}

function invalidateParquetStatsCache() {
    _parquetStatsCache.clear();
}

module.exports = {
    computeQueryScanMetrics,
    calculateCost,
    invalidateParquetStatsCache
};
