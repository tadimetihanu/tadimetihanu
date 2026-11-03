const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGG_FUNC_REGEX = /\b(COUNT|SUM|AVG|MIN|MAX|LIST|STRING_AGG|ARRAY_AGG|GROUP_CONCAT|MEDIAN|QUANTILE|QUANTILE_CONT|QUANTILE_DISC|STDDEV|STDDEV_SAMP|STDDEV_POP|VARIANCE|VAR_SAMP|VAR_POP|COVAR_POP|COVAR_SAMP|CORR|REGR_[A-Z0-9_]+|ANY_VALUE|FIRST|LAST|ARG_MIN|ARG_MAX|MIN_BY|MAX_BY|APPROX_COUNT_DISTINCT|BOOL_AND|BOOL_OR|EVERY|BIT_AND|BIT_OR|BIT_XOR|MODE|HISTOGRAM|FAVG|FSUM|KAHAN_SUM|PRODUCT|KURTOSIS|SKEWNESS|ENTROPY)\s*\(/i;

function stripTrailingSemicolons(sql) {
    return String(sql || '').trim().replace(/;+\s*$/, '').trim();
}

function quoteIdent(ident) {
    const clean = String(ident || '').replace(/^"+|"+$/g, '');
    return `"${clean.replace(/"/g, '""')}"`;
}

/**
 * Advances past string literals, quoted identifiers, and SQL comments.
 * Returns the index of the last character of the literal/comment if matched, or -1.
 */
function skipSqlLiteralOrComment(sql, i) {
    const len = sql.length;
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    // Single-quoted string
    if (ch === "'") {
        let j = i + 1;
        while (j < len) {
            if (sql[j] === "'") {
                if (j + 1 < len && sql[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                return j;
            }
            j++;
        }
        return len - 1;
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
                return j;
            }
            j++;
        }
        return len - 1;
    }

    // Line comment --
    if (ch === '-' && next === '-') {
        let j = i + 2;
        while (j < len && sql[j] !== '\n') j++;
        return j;
    }

    // Block comment /* ... */
    if (ch === '/' && next === '*') {
        let j = i + 2;
        while (j + 1 < len && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
        return Math.min(len - 1, j + 1);
    }

    return -1;
}

function skipWhitespaceAndComments(sql, startIdx) {
    let i = startIdx;
    const len = sql.length;
    while (i < len) {
        if (/\s/.test(sql[i])) {
            i++;
            continue;
        }
        if ((sql[i] === '-' && sql[i + 1] === '-') || (sql[i] === '/' && sql[i + 1] === '*')) {
            i = skipSqlLiteralOrComment(sql, i) + 1;
            continue;
        }
        break;
    }
    return i;
}

function readWordAt(sql, idx) {
    const m = sql.slice(idx).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    return m ? m[0] : '';
}

function splitTopLevelCommas(str) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
        const skipped = skipSqlLiteralOrComment(str, i);
        if (skipped !== -1) {
            i = skipped;
            continue;
        }
        if (str[i] === '(') depth++;
        else if (str[i] === ')' && depth > 0) depth--;
        else if (str[i] === ',' && depth === 0) {
            parts.push(str.slice(start, i).trim());
            start = i + 1;
        }
    }
    const tail = str.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
}

/**
 * Parses a top-level non-recursive WITH clause:
 * WITH c1 AS (...), c2 AS (...) SELECT ...
 */
function parseWithCtes(rawSql) {
    const sql = stripTrailingSemicolons(rawSql);
    let i = skipWhitespaceAndComments(sql, 0);
    const firstWord = readWordAt(sql, i);
    if (firstWord.toUpperCase() !== 'WITH') return null;
    i = skipWhitespaceAndComments(sql, i + 4);

    const maybeRec = readWordAt(sql, i);
    if (maybeRec.toUpperCase() === 'RECURSIVE') return null;

    const ctes = [];
    const len = sql.length;

    while (i < len) {
        i = skipWhitespaceAndComments(sql, i);
        let cteName = '';
        if (sql[i] === '"') {
            const endQuote = skipSqlLiteralOrComment(sql, i);
            cteName = sql.slice(i + 1, endQuote).replace(/""/g, '"');
            i = endQuote + 1;
        } else {
            cteName = readWordAt(sql, i);
            if (!cteName) return null;
            i += cteName.length;
        }

        i = skipWhitespaceAndComments(sql, i);
        // Bail out if CTE uses explicit column list: WITH cte(a, b) AS (...)
        if (sql[i] === '(') return null;

        const asWord = readWordAt(sql, i);
        if (asWord.toUpperCase() !== 'AS') return null;
        i = skipWhitespaceAndComments(sql, i + 2);

        // Optional [NOT] MATERIALIZED
        const optWord1 = readWordAt(sql, i).toUpperCase();
        if (optWord1 === 'NOT') {
            i = skipWhitespaceAndComments(sql, i + 3);
            const optWord2 = readWordAt(sql, i).toUpperCase();
            if (optWord2 !== 'MATERIALIZED') return null;
            i = skipWhitespaceAndComments(sql, i + 12);
        } else if (optWord1 === 'MATERIALIZED') {
            i = skipWhitespaceAndComments(sql, i + 12);
        }

        if (sql[i] !== '(') return null;
        const bodyStart = i + 1;
        let depth = 1;
        let j = bodyStart;
        while (j < len && depth > 0) {
            const skipped = skipSqlLiteralOrComment(sql, j);
            if (skipped !== -1) {
                j = skipped + 1;
                continue;
            }
            if (sql[j] === '(') depth++;
            else if (sql[j] === ')') depth--;
            j++;
        }
        if (depth !== 0) return null;

        const body = sql.slice(bodyStart, j - 1).trim();
        ctes.push({ name: cteName, body });

        i = skipWhitespaceAndComments(sql, j);
        if (sql[i] === ',') {
            i++;
            continue;
        }
        break;
    }

    const mainQuery = sql.slice(i).trim();
    if (!ctes.length || !mainQuery) return null;
    return { ctes, mainQuery };
}

/**
 * Strips a trailing `[AS] alias` from a SELECT item at parenthesis depth 0,
 * returning { expr, alias }.
 */
function splitSelectItemAlias(item) {
    const trimmed = item.trim();
    const tokens = [];
    let depth = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const skipped = skipSqlLiteralOrComment(trimmed, i);
        if (skipped !== -1) {
            if (depth === 0 && trimmed[i] === '"') {
                tokens.push({ type: 'quoted', start: i, end: skipped + 1, text: trimmed.slice(i + 1, skipped).replace(/""/g, '"') });
            }
            i = skipped;
            continue;
        }
        if (trimmed[i] === '(') {
            depth++;
            tokens.push({ type: 'paren_open', start: i, end: i + 1 });
        } else if (trimmed[i] === ')') {
            if (depth > 0) depth--;
            tokens.push({ type: 'paren_close', start: i, end: i + 1 });
        } else if (depth === 0 && /[A-Za-z_]/.test(trimmed[i])) {
            const w = readWordAt(trimmed, i);
            tokens.push({ type: 'word', start: i, end: i + w.length, text: w });
            i += w.length - 1;
        } else if (depth === 0 && !/\s/.test(trimmed[i])) {
            tokens.push({ type: 'sym', start: i, end: i + 1, text: trimmed[i] });
        }
    }

    if (tokens.length >= 3) {
        const last = tokens[tokens.length - 1];
        const prev = tokens[tokens.length - 2];
        if ((last.type === 'word' || last.type === 'quoted') && last.end === trimmed.length) {
            if (prev.type === 'word' && prev.text.toUpperCase() === 'AS') {
                return {
                    expr: trimmed.slice(0, prev.start).trim(),
                    alias: last.text
                };
            }
        }
    }

    // Bare trailing alias without AS: e.g. `COUNT(DISTINCT x) total_orders`
    if (tokens.length >= 2) {
        const last = tokens[tokens.length - 1];
        const prev = tokens[tokens.length - 2];
        const reservedTail = new Set(['END', 'NULL', 'TRUE', 'FALSE', 'ASC', 'DESC', 'ALL', 'DISTINCT']);
        if (
            (last.type === 'word' || last.type === 'quoted') &&
            last.end === trimmed.length &&
            !(last.type === 'word' && reservedTail.has(last.text.toUpperCase())) &&
            prev.type === 'paren_close'
        ) {
            return {
                expr: trimmed.slice(0, last.start).trim(),
                alias: last.text
            };
        }
    }

    return { expr: trimmed, alias: null };
}

/**
 * Checks if an expression (after stripping alias) is a direct COUNT(DISTINCT <inner>) [FILTER (WHERE <f>)].
 */
function parseDirectCountDistinctExpr(expr) {
    let s = expr.trim();
    let i = skipWhitespaceAndComments(s, 0);
    const w = readWordAt(s, i);
    if (w.toUpperCase() !== 'COUNT') return null;
    i = skipWhitespaceAndComments(s, i + 5);
    if (s[i] !== '(') return null;

    // Find matching ')'
    let depth = 1;
    let j = i + 1;
    while (j < s.length && depth > 0) {
        const sk = skipSqlLiteralOrComment(s, j);
        if (sk !== -1) { j = sk + 1; continue; }
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
    }
    if (depth !== 0) return null;

    const insideCount = s.slice(i + 1, j - 1).trim();
    const afterCount = s.slice(j).trim();

    let filterExpr = null;
    if (afterCount) {
        let k = skipWhitespaceAndComments(afterCount, 0);
        const fw = readWordAt(afterCount, k);
        if (fw.toUpperCase() !== 'FILTER') return null;
        k = skipWhitespaceAndComments(afterCount, k + 6);
        if (afterCount[k] !== '(') return null;
        let fDepth = 1;
        let m = k + 1;
        while (m < afterCount.length && fDepth > 0) {
            const sk = skipSqlLiteralOrComment(afterCount, m);
            if (sk !== -1) { m = sk + 1; continue; }
            if (afterCount[m] === '(') fDepth++;
            else if (afterCount[m] === ')') fDepth--;
            m++;
        }
        if (fDepth !== 0 || afterCount.slice(m).trim() !== '') return null;
        const insideFilter = afterCount.slice(k + 1, m - 1).trim();
        const whereMatch = insideFilter.match(/^WHERE\s+([\s\S]+)$/i);
        if (!whereMatch) return null;
        filterExpr = whereMatch[1].trim();
    }

    let icIdx = skipWhitespaceAndComments(insideCount, 0);
    const distWord = readWordAt(insideCount, icIdx);
    if (distWord.toUpperCase() !== 'DISTINCT') return null;
    const distinctTarget = insideCount.slice(icIdx + 8).trim();
    if (!distinctTarget) return null;

    // Skip multi-argument COUNT(DISTINCT a, b)
    if (splitTopLevelCommas(distinctTarget).length !== 1) return null;

    return { innerExpr: distinctTarget, filterExpr };
}

/**
 * Analyzes a single-level SELECT ... FROM ... [WHERE ...] [GROUP BY ...] [HAVING ...] [ORDER BY ...] [LIMIT ...] [OFFSET ...]
 * to determine if it contains direct COUNT(DISTINCT ...) aggregates suitable for out-of-core bucketed execution.
 */
function analyzeDistinctSelect(rawSql) {
    const sql = stripTrailingSemicolons(rawSql);
    let i = skipWhitespaceAndComments(sql, 0);
    const firstWord = readWordAt(sql, i).toUpperCase();
    if (firstWord !== 'SELECT') return null;

    const selectAfterIdx = skipWhitespaceAndComments(sql, i + 6);
    const secondWord = readWordAt(sql, selectAfterIdx).toUpperCase();
    if (secondWord === 'DISTINCT' || secondWord === 'ALL') return null;

    // Scan depth-0 major clause positions
    const clauses = [{ name: 'SELECT', bodyStart: selectAfterIdx, kwStart: i }];
    let depth = 0;

    for (let pos = selectAfterIdx; pos < sql.length; pos++) {
        const sk = skipSqlLiteralOrComment(sql, pos);
        if (sk !== -1) { pos = sk; continue; }
        if (sql[pos] === '(') { depth++; continue; }
        if (sql[pos] === ')') { if (depth > 0) depth--; continue; }
        if (depth !== 0) continue;

        if (pos > 0 && /[A-Za-z0-9_$]/.test(sql[pos - 1])) continue;
        const w = readWordAt(sql, pos);
        if (!w) continue;
        const uw = w.toUpperCase();

        // Bail out on set operations or unsupported top-level clauses
        if (uw === 'UNION' || uw === 'INTERSECT' || uw === 'EXCEPT' || uw === 'WINDOW' || uw === 'QUALIFY') {
            return null;
        }

        if (uw === 'FROM' || uw === 'WHERE' || uw === 'HAVING' || uw === 'LIMIT' || uw === 'OFFSET') {
            clauses.push({ name: uw, kwStart: pos, bodyStart: pos + w.length });
            pos += w.length - 1;
        } else if (uw === 'GROUP' || uw === 'ORDER') {
            const afterW = skipWhitespaceAndComments(sql, pos + w.length);
            const byW = readWordAt(sql, afterW).toUpperCase();
            if (byW === 'BY') {
                clauses.push({ name: `${uw} BY`, kwStart: pos, bodyStart: afterW + 2 });
                pos = afterW + 1;
            }
        }
    }

    const clauseMap = {};
    for (let c = 0; c < clauses.length; c++) {
        const cur = clauses[c];
        const nextKwStart = c + 1 < clauses.length ? clauses[c + 1].kwStart : sql.length;
        if (clauseMap[cur.name] !== undefined) return null; // duplicate clause
        clauseMap[cur.name] = sql.slice(cur.bodyStart, nextKwStart).trim();
    }

    if (!clauseMap['SELECT'] || !clauseMap['FROM']) return null;

    const selectItemsRaw = splitTopLevelCommas(clauseMap['SELECT']);
    if (!selectItemsRaw.length) return null;

    const parsedItems = [];
    const distinctItems = [];

    for (let idx = 0; idx < selectItemsRaw.length; idx++) {
        const rawItem = selectItemsRaw[idx];
        if (rawItem === '*' || /\.\*\s*$/.test(rawItem)) return null;
        if (/\bOVER\s*\(/i.test(rawItem)) return null;

        const { expr, alias } = splitSelectItemAlias(rawItem);
        const cd = parseDirectCountDistinctExpr(expr);
        if (cd) {
            const dIndex = distinctItems.length;
            const info = {
                selectIdx: idx,
                dIndex,
                rawItem,
                expr,
                alias,
                innerExpr: cd.innerExpr,
                filterExpr: cd.filterExpr
            };
            distinctItems.push(info);
            parsedItems.push({ type: 'count_distinct', ...info });
        } else {
            // If COUNT(DISTINCT ...) appears nested inside a larger expression (e.g. 100.0 * COUNT(DISTINCT x) / COUNT(*)), skip custom decomposition
            if (/\bCOUNT\s*\(\s*DISTINCT\b/i.test(expr)) return null;
            const isAgg = AGG_FUNC_REGEX.test(expr);
            parsedItems.push({ type: isAgg ? 'agg' : 'expr', selectIdx: idx, rawItem, expr, alias });
        }
    }

    if (distinctItems.length === 0) return null;

    const fromWhereSql = clauseMap['FROM'] + (clauseMap['WHERE'] ? `\nWHERE ${clauseMap['WHERE']}` : '');
    const rawGroupBy = clauseMap['GROUP BY'];

    let groupMode = 'none';
    let explicitGroupExprs = [];

    if (rawGroupBy === undefined) {
        // Ungrouped aggregation: every non-distinct item must also be an aggregate
        if (parsedItems.some(it => it.type === 'expr')) return null;
        groupMode = 'ungrouped';
    } else if (/^ALL$/i.test(rawGroupBy.trim())) {
        groupMode = 'all';
    } else {
        if (/\b(GROUPING\s+SETS|ROLLUP|CUBE)\b/i.test(rawGroupBy)) return null;
        groupMode = 'explicit';
        const parts = splitTopLevelCommas(rawGroupBy);
        if (!parts.length) return null;
        for (const p of parts) {
            if (/^\d+$/.test(p)) {
                const posIdx = Number(p) - 1;
                if (posIdx < 0 || posIdx >= parsedItems.length) return null;
                explicitGroupExprs.push(parsedItems[posIdx].expr);
            } else {
                explicitGroupExprs.push(p);
            }
        }
    }

    return {
        parsedItems,
        distinctItems,
        fromWhereSql,
        rawGroupBy,
        groupMode,
        explicitGroupExprs,
        havingSql: clauseMap['HAVING'] || null,
        orderBySql: clauseMap['ORDER BY'] || null,
        limitSql: clauseMap['LIMIT'] || null,
        offsetSql: clauseMap['OFFSET'] || null
    };
}

/**
 * Executes an analyzed COUNT(DISTINCT) query out-of-core using hash-bucketed Parquet staging
 * and writes the exact final result to `destParquetPath` (or returns rows if destParquetPath is null).
 */
async function executeBucketedDistinctQuery(runCmd, allCmd, analysis, workDir, stepPrefix, destParquetPath) {
    const normWork = workDir.replace(/\\/g, '/');
    const basePath = `${normWork}/${stepPrefix}_base.parquet`;
    const dkeysPath = `${normWork}/${stepPrefix}_dkeys.parquet`;
    const NUM_BUCKETS = 8;

    // 1. Build base SELECT replacing COUNT(DISTINCT ...) with COUNT(*) FILTER (WHERE FALSE)
    const replacedSelectList = analysis.parsedItems.map((it, idx) => {
        if (it.type === 'count_distinct') {
            const outAlias = it.alias ? quoteIdent(it.alias) : quoteIdent(`count(DISTINCT ${it.innerExpr})`);
            return `COUNT(*) FILTER (WHERE FALSE) AS ${outAlias}`;
        }
        return it.rawItem;
    });

    let extraGroupPrefix = '';
    if (analysis.groupMode === 'explicit') {
        extraGroupPrefix = analysis.explicitGroupExprs
            .map((ge, gi) => `(${ge}) AS "_ciq_eg_${gi}", `)
            .join('');
    }

    const innerBaseSql =
        `SELECT ${extraGroupPrefix}${replacedSelectList.join(',\n       ')}\n` +
        `FROM ${analysis.fromWhereSql}` +
        (analysis.rawGroupBy !== undefined ? `\nGROUP BY ${analysis.rawGroupBy}` : '');

    const copyBaseSql = `COPY (\n  SELECT ROW_NUMBER() OVER () AS "_ciq_grp_id", _ciq_b.*\n  FROM (\n${innerBaseSql}\n  ) _ciq_b\n) TO '${basePath}' (FORMAT PARQUET, COMPRESSION SNAPPY)`;
    await runCmd(copyBaseSql);

    // Inspect exact output column names produced by DuckDB
    const descRows = await allCmd(`DESCRIBE SELECT * FROM read_parquet('${basePath}')`);
    const egCount = analysis.groupMode === 'explicit' ? analysis.explicitGroupExprs.length : 0;
    // descRows: [0] = _ciq_grp_id, [1..egCount] = _ciq_eg_*, [1+egCount ..] = user SELECT columns
    const userColNames = descRows.slice(1 + egCount).map(r => r.column_name);

    // Check if base result has 0 rows -> fast path!
    const cntRows = await allCmd(`SELECT COUNT(*) AS c FROM read_parquet('${basePath}')`);
    const baseRowCount = Number(cntRows?.[0]?.c || 0);

    const distinctValCols = analysis.distinctItems.map((d, k) => {
        if (d.filterExpr) {
            return `(CASE WHEN (${d.filterExpr}) THEN (${d.innerExpr}) ELSE NULL END) AS "_dv_${k}"`;
        }
        return `(${d.innerExpr}) AS "_dv_${k}"`;
    });

    if (baseRowCount > 0) {
        // 2. Materialize compact (_ciq_grp_id, _dv_0, _dv_1, ...) Parquet file on SSD
        if (analysis.groupMode === 'ungrouped') {
            const copyDkeysSql =
                `COPY (\n  SELECT CAST(1 AS BIGINT) AS "_ciq_grp_id", ${distinctValCols.join(', ')}\n` +
                `  FROM ${analysis.fromWhereSql}\n) TO '${dkeysPath}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 32768)`;
            await runCmd(copyDkeysSql);
        } else {
            const srcGroupProj = [];
            const joinConds = [];

            if (analysis.groupMode === 'all') {
                for (const it of analysis.parsedItems) {
                    if (it.type === 'expr') {
                        const gkIdx = srcGroupProj.length;
                        const bgCol = quoteIdent(userColNames[it.selectIdx]);
                        srcGroupProj.push(`(${it.expr}) AS "_gk_${gkIdx}"`);
                        joinConds.push(`_src."_gk_${gkIdx}" IS NOT DISTINCT FROM _bg.${bgCol}`);
                    }
                }
            } else {
                for (let gi = 0; gi < egCount; gi++) {
                    const ge = analysis.explicitGroupExprs[gi];
                    srcGroupProj.push(`(${ge}) AS "_gk_${gi}"`);
                    joinConds.push(`_src."_gk_${gi}" IS NOT DISTINCT FROM _bg."_ciq_eg_${gi}"`);
                }
            }

            if (srcGroupProj.length === 0) {
                const copyDkeysSql =
                    `COPY (\n  SELECT CAST(1 AS BIGINT) AS "_ciq_grp_id", ${distinctValCols.join(', ')}\n` +
                    `  FROM ${analysis.fromWhereSql}\n) TO '${dkeysPath}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 32768)`;
                await runCmd(copyDkeysSql);
            } else {
                const dvRefs = analysis.distinctItems.map((_, k) => `_src."_dv_${k}"`).join(', ');
                const copyDkeysSql =
                    `COPY (\n  SELECT _bg."_ciq_grp_id", ${dvRefs}\n` +
                    `  FROM (\n    SELECT ${srcGroupProj.join(', ')}, ${distinctValCols.join(', ')}\n` +
                    `    FROM ${analysis.fromWhereSql}\n  ) _src\n` +
                    `  JOIN read_parquet('${basePath}') _bg\n    ON ${joinConds.join(' AND ')}\n` +
                    `) TO '${dkeysPath}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 32768)`;
                await runCmd(copyDkeysSql);
            }
        }

        // 3. For each COUNT(DISTINCT) expression, evaluate 8 disjoint hash buckets sequentially
        for (let k = 0; k < analysis.distinctItems.length; k++) {
            for (let b = 0; b < NUM_BUCKETS; b++) {
                const bPath = `${normWork}/${stepPrefix}_dc_${k}_b${b}.parquet`;
                const bucketSql =
                    `COPY (\n` +
                    `  SELECT "_ciq_grp_id", COUNT(*) AS "_b_cnt"\n` +
                    `  FROM (\n` +
                    `    SELECT DISTINCT "_ciq_grp_id", "_dv_${k}"\n` +
                    `    FROM read_parquet('${dkeysPath}')\n` +
                    `    WHERE "_dv_${k}" IS NOT NULL AND (hash("_dv_${k}") % CAST(${NUM_BUCKETS} AS UBIGINT)) = CAST(${b} AS UBIGINT)\n` +
                    `  ) _u\n` +
                    `  GROUP BY "_ciq_grp_id"\n` +
                    `) TO '${bPath}' (FORMAT PARQUET, COMPRESSION SNAPPY)`;
                await runCmd(bucketSql);
            }
        }
    }

    // 4. Reconstruct final SELECT with exact column order, types, and optional HAVING / ORDER BY / LIMIT / OFFSET
    const distinctBySelectIdx = new Map();
    for (const d of analysis.distinctItems) {
        distinctBySelectIdx.set(d.selectIdx, d.dIndex);
    }

    const finalProj = userColNames.map((colName, idx) => {
        const qCol = quoteIdent(colName);
        if (distinctBySelectIdx.has(idx) && baseRowCount > 0) {
            const k = distinctBySelectIdx.get(idx);
            return `CAST(COALESCE(_dc_${k}."_cnt", 0) AS BIGINT) AS ${qCol}`;
        }
        return `_bg.${qCol}`;
    });

    let joinDistinctSql = '';
    if (baseRowCount > 0) {
        for (let k = 0; k < analysis.distinctItems.length; k++) {
            const globPath = `${normWork}/${stepPrefix}_dc_${k}_b*.parquet`;
            joinDistinctSql +=
                `\nLEFT JOIN (\n` +
                `  SELECT "_ciq_grp_id", CAST(SUM("_b_cnt") AS BIGINT) AS "_cnt"\n` +
                `  FROM read_parquet('${globPath}')\n` +
                `  GROUP BY "_ciq_grp_id"\n` +
                `) _dc_${k} ON _bg."_ciq_grp_id" = _dc_${k}."_ciq_grp_id"`;
        }
    }

    let assembledSql =
        `SELECT ${finalProj.join(', ')}\n` +
        `FROM read_parquet('${basePath}') _bg` +
        joinDistinctSql;

    if (analysis.havingSql || analysis.orderBySql || analysis.limitSql || analysis.offsetSql) {
        assembledSql =
            `SELECT * FROM (\n${assembledSql}\n) _final_aggs` +
            (analysis.havingSql ? `\nWHERE ${analysis.havingSql}` : '') +
            (analysis.orderBySql ? `\nORDER BY ${analysis.orderBySql}` : '') +
            (analysis.limitSql ? `\nLIMIT ${analysis.limitSql}` : '') +
            (analysis.offsetSql ? `\nOFFSET ${analysis.offsetSql}` : '');
    }

    // Cleanup intermediate dkeys right away to keep SSD usage low
    try { if (fs.existsSync(dkeysPath)) fs.unlinkSync(dkeysPath); } catch (_) {}

    if (destParquetPath) {
        const normDest = destParquetPath.replace(/\\/g, '/');
        await runCmd(`COPY (\n${assembledSql}\n) TO '${normDest}' (FORMAT PARQUET, COMPRESSION SNAPPY)`);
        // Clean up base & bucket files once destParquetPath is written
        try { if (fs.existsSync(basePath)) fs.unlinkSync(basePath); } catch (_) {}
        for (let k = 0; k < analysis.distinctItems.length; k++) {
            for (let b = 0; b < NUM_BUCKETS; b++) {
                const bp = `${normWork}/${stepPrefix}_dc_${k}_b${b}.parquet`;
                try { if (fs.existsSync(bp)) fs.unlinkSync(bp); } catch (_) {}
            }
        }
        return null;
    }

    return await allCmd(assembledSql);
}

/**
 * Determines whether a SQL query should proactively run through the Out-of-Core Spill Executor
 * on memory-constrained containers (<= 1200 MB RAM) to avoid hitting DuckDB OOM mid-pipeline.
 */
function shouldProactivelyStageOutOfCore(sql, containerMB) {
    if (containerMB > 1200) return false;
    const hasCountDistinct = /\bCOUNT\s*\(\s*DISTINCT\b/i.test(sql);
    if (!hasCountDistinct) return false;
    const distinctMatches = sql.match(/\bCOUNT\s*\(\s*DISTINCT\b/gi) || [];
    const hasJoin = /\bJOIN\b/i.test(sql);
    const hasWith = /^\s*WITH\b/i.test(sql);
    return hasJoin || distinctMatches.length >= 2 || hasWith;
}

function _sqlReferencesIdent(sqlText, identName) {
    const escaped = String(identName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, 'i');
    return re.test(sqlText);
}

/**
 * Executes a multi-CTE or heavy COUNT(DISTINCT) SQL query out-of-core by staging intermediate CTEs
 * as SNAPPY Parquet files on SSD and evaluating COUNT(DISTINCT) via 8 disjoint hash buckets.
 */
async function executeOutOfCore(runCmd, allCmd, rawSql, spillRootDir) {
    const runId = `ooc_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const workDir = path.join(spillRootDir, runId);
    fs.mkdirSync(workDir, { recursive: true });

    const stagedCtes = [];

    try {
        const parsedWith = parseWithCtes(rawSql);

        if (parsedWith) {
            for (let idx = 0; idx < parsedWith.ctes.length; idx++) {
                const cte = parsedWith.ctes[idx];
                const safeName = cte.name.replace(/[^a-zA-Z0-9_]/g, '_');
                const cteParquet = path.join(workDir, `cte_${idx}_${safeName}.parquet`).replace(/\\/g, '/');
                const distinctPlan = analyzeDistinctSelect(cte.body);

                if (distinctPlan) {
                    console.log(`🧊 [Out-of-Core] Bucketed DISTINCT staging for CTE '${cte.name}' (${distinctPlan.distinctItems.length} distinct agg(s))...`);
                    await executeBucketedDistinctQuery(runCmd, allCmd, distinctPlan, workDir, `cte_${idx}`, cteParquet);
                } else {
                    console.log(`🧊 [Out-of-Core] Materializing CTE '${cte.name}' to SSD Parquet...`);
                    await runCmd(`COPY (\n${stripTrailingSemicolons(cte.body)}\n) TO '${cteParquet}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE 32768)`);
                }

                const qView = quoteIdent(cte.name);
                await runCmd(`CREATE OR REPLACE TEMP VIEW ${qView} AS SELECT * FROM read_parquet('${cteParquet}')`);
                stagedCtes.push({ name: cte.name, qView, parquetPath: cteParquet, cleaned: false });

                // Reclaim SSD space immediately for any earlier staged CTE no longer referenced downstream
                const remainingSql = parsedWith.ctes.slice(idx + 1).map(c => c.body).join('\n') + '\n' + parsedWith.mainQuery;
                for (const prev of stagedCtes) {
                    if (!prev.cleaned && !_sqlReferencesIdent(remainingSql, prev.name)) {
                        try { await runCmd(`DROP VIEW IF EXISTS ${prev.qView}`); } catch (_) {}
                        try { if (fs.existsSync(prev.parquetPath)) fs.unlinkSync(prev.parquetPath); } catch (_) {}
                        prev.cleaned = true;
                    }
                }
            }

            const mainDistinctPlan = analyzeDistinctSelect(parsedWith.mainQuery);
            if (mainDistinctPlan) {
                return await executeBucketedDistinctQuery(runCmd, allCmd, mainDistinctPlan, workDir, 'main', null);
            }
            return await allCmd(parsedWith.mainQuery);
        }

        // Flat (non-WITH) query
        const flatDistinctPlan = analyzeDistinctSelect(rawSql);
        if (flatDistinctPlan) {
            console.log(`🧊 [Out-of-Core] Bucketed DISTINCT execution for flat query (${flatDistinctPlan.distinctItems.length} distinct agg(s))...`);
            return await executeBucketedDistinctQuery(runCmd, allCmd, flatDistinctPlan, workDir, 'flat', null);
        }

        return await allCmd(rawSql);
    } finally {
        for (let i = stagedCtes.length - 1; i >= 0; i--) {
            if (!stagedCtes[i].cleaned) {
                try { await runCmd(`DROP VIEW IF EXISTS ${stagedCtes[i].qView}`); } catch (_) {}
            }
        }
        try {
            if (fs.existsSync(workDir)) {
                fs.rmSync(workDir, { recursive: true, force: true });
            }
        } catch (_) {}
    }
}

module.exports = {
    parseWithCtes,
    analyzeDistinctSelect,
    shouldProactivelyStageOutOfCore,
    executeOutOfCore
};
