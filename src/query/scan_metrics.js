const fs = require('fs');
const path = require('path');
const { parseWithCtes } = require('./out_of_core');

// Price per GiB scanned ($5.50 / GiB, enterprise cloud lakehouse standard)
const COST_PER_GIB_USD = 5.50;

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
        const physicalFileBytes = Math.max(knownFileBytes || 0, sumCompressedCols);
        const footerBytes = Math.max(
            4096,
            physicalFileBytes > sumCompressedCols
                ? (physicalFileBytes - sumCompressedCols)
                : Math.min(65536, Math.round(sumCompressedCols * 0.004) + 4096)
        );

        const stats = {
            physicalFileBytes: Math.max(physicalFileBytes, sumCompressedCols + footerBytes),
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

/**
 * Computes accurate physical scanned bytes and cloud burn USD for a completed DuckDB query
 * using real Parquet per-column compressed metadata, row-group pruning, local SSD cache stats,
 * and metadata_catalog object sizes.
 */
async function computeQueryScanMetrics({ originalSql, executableSql, rows, targetId, allSqlCmd, db }) {
    const rawOrig = String(originalSql || '');
    const rawExec = String(executableSql || rawOrig);

    // Schema inspection (DESCRIBE) reads only file footer / schema metadata
    if (/^\s*DESCRIBE\b/i.test(rawOrig)) {
        const estimatedScan = 8192;
        const estimatedCost = (estimatedScan / (1024 * 1024 * 1024)) * COST_PER_GIB_USD;
        return { estimatedScan, estimatedCost };
    }

    const refs = _extractDataSourceRefs(rawExec);
    if (refs.length === 0) {
        return { estimatedScan: 0, estimatedCost: 0 };
    }

    const pureLimitN = refs.length === 1 ? _detectPureLimitPreview(rawExec) : null;
    let totalScannedBytes = 0;

    for (const ref of refs) {
        const { physPath, aliases } = ref;
        const lowerPath = physPath.toLowerCase();
        const isParquetSingle = lowerPath.endsWith('.parquet') && !/[*?[\]]/.test(physPath);

        const localBytes = _getLocalPathBytes(physPath);
        const catalogBytes = localBytes > 0 ? localBytes : await _lookupCatalogBytes(db, targetId, physPath);
        const knownBytes = Math.max(localBytes, catalogBytes);

        if (isParquetSingle && typeof allSqlCmd === 'function') {
            const pqStats = await _getParquetColumnStats(allSqlCmd, physPath, knownBytes);
            if (pqStats && pqStats.colBytesMap.size > 0) {
                const rawScopes = _getSqlScopesForPath(rawExec, physPath);
                const cleanedScopes = rawScopes.map(_stripCommentsAndStrings);
                const selectAll = cleanedScopes.some(sc => _hasWildcardSelectInScope(sc, aliases));

                let colScannedBytes = 0;
                if (selectAll) {
                    colScannedBytes = pqStats.sumCompressedCols;
                } else {
                    for (const [colLower, cBytes] of pqStats.colBytesMap.entries()) {
                        if (_isColumnReferencedInScopes(colLower, cleanedScopes, aliases)) {
                            colScannedBytes += cBytes;
                        }
                    }
                }

                // Apply pure LIMIT N row-group early stop (e.g. SELECT * FROM file.parquet LIMIT 100)
                if (pureLimitN !== null && pqStats.totalRows > 0 && pqStats.numRowGroups > 1) {
                    const rowsPerRg = Math.max(1, Math.ceil(pqStats.totalRows / pqStats.numRowGroups));
                    const rgsRead = Math.min(pqStats.numRowGroups, Math.max(1, Math.ceil(pureLimitN / rowsPerRg)));
                    colScannedBytes = Math.round(colScannedBytes * (rgsRead / pqStats.numRowGroups));
                }

                const fileScan = Math.min(pqStats.physicalFileBytes, pqStats.footerBytes + colScannedBytes);
                totalScannedBytes += fileScan;
                continue;
            }
        }

        // Non-Parquet (CSV/JSON/ORC/Iceberg/Globs) or fallback when parquet_metadata is unavailable
        if (knownBytes > 0) {
            if (pureLimitN !== null && /\.(csv|tsv|txt|json|ndjson)$/i.test(lowerPath)) {
                // Streaming text reader stops early after buffering enough rows
                const approxRowBytes = 256;
                totalScannedBytes += Math.min(knownBytes, Math.max(65536, pureLimitN * approxRowBytes));
            } else {
                totalScannedBytes += knownBytes;
            }
        } else {
            // Last-resort fallback based on serialized result payload
            const payloadBytes = JSON.stringify(rows || [], (k, v) => typeof v === 'bigint' ? v.toString() : v).length * 2;
            totalScannedBytes += Math.max(payloadBytes, 65536);
        }
    }

    const estimatedScan = Math.max(0, Math.round(totalScannedBytes));
    const estimatedCost = (estimatedScan / (1024 * 1024 * 1024)) * COST_PER_GIB_USD;
    return { estimatedScan, estimatedCost };
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
        return { estimatedScan: 0, estimatedCost: 0 };
    }
    let sumLocal = 0;
    for (const r of refs) {
        sumLocal += _getLocalPathBytes(r.physPath);
    }
    const estimatedScan = sumLocal > 0
        ? sumLocal
        : JSON.stringify(rows || [], (k, v) => typeof v === 'bigint' ? v.toString() : v).length * 2;
    const estimatedCost = (estimatedScan / (1024 * 1024 * 1024)) * COST_PER_GIB_USD;
    return { estimatedScan, estimatedCost };
}

function invalidateParquetStatsCache() {
    _parquetStatsCache.clear();
}

module.exports = {
    computeQueryScanMetrics,
    calculateCost,
    invalidateParquetStatsCache
};
