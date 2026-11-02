// AI Assistant — Full-Catalog Schema Context (Parquet, CSV, JSON, Iceberg) via Render PostgreSQL
require('dotenv').config();
const { OpenAI } = require('openai');
const db = require('../db');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function formatTableSourceExpr(filePath, format) {
    const ext = (format || filePath.split('.').pop() || '').toLowerCase();
    const safePath = filePath.replace(/'/g, "''");
    if (ext === 'iceberg' || filePath.toLowerCase().endsWith('.iceberg')) {
        return `iceberg_scan('${safePath}')`;
    }
    if (ext === 'parquet') return `read_parquet('${safePath}')`;
    if (ext === 'csv' || ext === 'tsv') return `read_csv_auto('${safePath}')`;
    if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return `read_json_auto('${safePath}')`;
    return `'${safePath}'`;
}

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3)
        .map(t => t.replace(/(?:ers|er|ies|es|s)$/, ''));
}

function extractFileFromSql(sql) {
    if (!sql) return '';
    const m = String(sql).match(/(?:from\s+|read_[a-z0-9_]+\s*\(\s*|iceberg_[a-z0-9_]+\s*\(\s*)['"]([^'"]+)['"]/i);
    return m ? m[1].trim() : '';
}

async function suggestQuery(userId, userPrompt, targetId, fileName, context = {}) {
    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) throw new Error('Invalid Target');

    const selectedFile = (context.selectedFile || extractFileFromSql(context.currentSql) || '').trim();
    const activeFormat = (context.activeFormat && context.activeFormat !== 'all')
        ? String(context.activeFormat).toLowerCase().trim()
        : '';

    // Load ALL registered objects & cached schemas from PostgreSQL metadata_catalog (alphabetical, not biased toward newest Iceberg rows)
    const catalogRows = await db.all(
        'SELECT file_path, file_name, format, file_size, schema_json FROM metadata_catalog WHERE target_id = ? ORDER BY file_path ASC',
        [targetId]
    );

    const passedFiles = (fileName || '')
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);

    const allFiles = catalogRows.length > 0
        ? catalogRows.map(r => r.file_path)
        : passedFiles;

    const k = (process.env.OPENAI_API_KEY || '').trim();
    const hasRealKey = k && !k.startsWith('your_') && k !== 'dummy_key' && k !== 'YOUR_OPENAI_KEY' && k !== 'null';

    if (!hasRealKey) {
        const chosen = selectedFile || allFiles[0];
        if (chosen) {
            return `SELECT * FROM ${formatTableSourceExpr(chosen)} LIMIT 50;`;
        }
        return `SELECT 1 AS status;`;
    }

    try {
        const { runQuery } = require('./engine');
        const queryableExts = new Set(['parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'iceberg']);
        const promptLower = String(userPrompt || '').toLowerCase();
        const promptStems = tokenize(userPrompt);
        const mentionsIceberg = promptLower.includes('iceberg');

        const candidateRows = (catalogRows.length > 0 ? catalogRows : passedFiles.map(fp => ({
            file_path: fp,
            file_name: fp.split('/').pop(),
            format: fp.split('.').pop().toLowerCase(),
            file_size: 0,
            schema_json: null
        }))).filter(r => queryableExts.has((r.format || r.file_path.split('.').pop() || '').toLowerCase()));

        // Parse cached schemas first
        const enriched = candidateRows.map(row => {
            const fmt = (row.format || row.file_path.split('.').pop() || '').toLowerCase();
            let cols = null;
            if (row.schema_json) {
                try {
                    const parsed = JSON.parse(row.schema_json);
                    if (Array.isArray(parsed) && parsed.length > 0) cols = parsed;
                } catch (_) {}
            }
            return { ...row, fmt, cols };
        });

        // Score relevance across ALL formats (Parquet, CSV, JSON, Iceberg)
        function scoreDataset(item) {
            let score = 0;
            const pathLower = item.file_path.toLowerCase();
            const baseNoExt = pathLower.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
            const fileStems = tokenize(baseNoExt);
            const colNames = (item.cols || []).map(c => String(c.name || c.column_name || '').toLowerCase());
            const colStems = tokenize(colNames.join(' '));

            // 1. Direct filename mention in prompt
            if (promptLower.includes(pathLower) || (baseNoExt.length >= 3 && promptLower.includes(baseNoExt))) {
                score += 100;
            }
            for (const ps of promptStems) {
                if (fileStems.some(fs => fs.startsWith(ps) || ps.startsWith(fs))) score += 35;
                if (colStems.some(cs => cs === ps || cs.startsWith(ps) || ps.startsWith(cs))) score += 20;
            }

            // 2. Active selected file in UI editor/sidebar
            if (selectedFile && (item.file_path === selectedFile || item.file_name === selectedFile)) {
                score += 45;
            }

            // 3. Active format filter chip in sidebar (parquet / csv / json / iceberg)
            if (activeFormat && item.fmt === activeFormat) {
                score += 25;
            }

            // 4. Format mention in prompt (e.g., "parquet", "csv", "json", "iceberg")
            if (promptLower.includes(item.fmt)) {
                score += 30;
            }

            // 5. Prefer primary Parquet/CSV/JSON files over auto-generated analytics_YYYYMMDD_*.iceberg copies unless Iceberg requested/selected
            const isAutoAnalyticsSnapshot = /^analytics_\d{8}_\d+\.iceberg$/i.test(item.file_path);
            if (isAutoAnalyticsSnapshot && !mentionsIceberg && selectedFile !== item.file_path) {
                score -= 40;
            } else if (!mentionsIceberg && item.fmt === 'parquet') {
                score += 5;
            }

            return score;
        }

        enriched.sort((a, b) => scoreDataset(b) - scoreDataset(a));

        // Lazily populate up to 5 uncached schemas via DuckDB DESCRIBE (and cache into PostgreSQL)
        let liveDescribes = 0;
        for (const item of enriched) {
            if (!item.cols && liveDescribes < 5) {
                liveDescribes++;
                try {
                    const safePath = item.file_path.replace(/'/g, "''");
                    const descExpr = (item.fmt === 'json' || item.fmt === 'jsonl' || item.fmt === 'ndjson')
                        ? `read_json_auto('${safePath}', sample_size=100)`
                        : formatTableSourceExpr(item.file_path, item.fmt);
                    const descRows = await Promise.race([
                        runQuery(userId, `DESCRIBE SELECT * FROM ${descExpr} LIMIT 1`, targetId),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('Schema timeout')), 5000))
                    ]);
                    if (Array.isArray(descRows) && descRows.length > 0) {
                        item.cols = descRows.map(c => ({
                            name: c.column_name,
                            type: c.column_type,
                            nullable: c.null === 'YES'
                        }));
                        await db.run(
                            'UPDATE metadata_catalog SET schema_json = ? WHERE target_id = ? AND file_path = ?',
                            [JSON.stringify(item.cols), targetId, item.file_path]
                        ).catch(() => {});
                    }
                } catch (_) {}
            }
        }

        // Re-sort after any newly discovered schemas
        enriched.sort((a, b) => scoreDataset(b) - scoreDataset(a));

        // Build full catalog schema context (includes ALL Parquet, CSV, JSON, and Iceberg datasets!)
        const schemaContexts = enriched.map(item => {
            const srcExpr = formatTableSourceExpr(item.file_path, item.fmt);
            if (Array.isArray(item.cols) && item.cols.length > 0) {
                const colStr = item.cols.slice(0, 40).map(c => `${c.name || c.column_name} (${c.type || c.column_type})`).join(', ');
                return `- [${item.fmt.toUpperCase()}] ${srcExpr} -> columns: [${colStr}]`;
            }
            return `- [${item.fmt.toUpperCase()}] ${srcExpr}`;
        });

        const schemaPrompt = schemaContexts.join('\n') || 'No structured datasets found in catalog.';

        const activeContextNote = [
            selectedFile ? `Currently selected dataset in user's editor: ${formatTableSourceExpr(selectedFile)}` : '',
            activeFormat ? `Active format filter in UI sidebar: ${activeFormat.toUpperCase()}` : ''
        ].filter(Boolean).join('\n');

        const sysMsg = `You are a DuckDB SQL Generator for CloudObjectIQ.
Convert the user prompt into a single valid DuckDB SELECT query across Parquet, CSV, JSON, or Apache Iceberg datasets.
CRITICAL RULES:
1. NEVER use raw cloud URIs like s3://, r2://, or az:// — direct URIs are blocked by the Metadata Catalog policy!
2. ALWAYS use the exact DuckDB table expression shown in SCHEMA CONTEXT:
   - Parquet: read_parquet('file.parquet')
   - CSV: read_csv_auto('file.csv')
   - JSON: read_json_auto('file.json')
   - Iceberg: iceberg_scan('table.iceberg')
3. DATASET SELECTION PRIORITY:
   - If the user's prompt names a specific file or format (e.g., parquet, csv, json, iceberg, titanic, farms, fertilizer, visitor, logs), query that matching dataset.
   - If the prompt is generic or only mentions column names (e.g., "distinct states", "count rows", "show farmer names") AND a dataset is currently selected in the user's editor (shown below) that has those columns, query that selected dataset!
   - When both a primary file (like read_parquet('farms.parquet') or read_csv_auto('farms.csv')) and an auto-generated snapshot (like analytics_YYYYMMDD_*.iceberg) have the same columns, ALWAYS prefer the primary Parquet/CSV/JSON file unless the user explicitly asks for Iceberg or has selected that Iceberg table.
4. Use ONLY real column names from SCHEMA CONTEXT below. Never invent placeholder filenames.
${activeContextNote ? `\nACTIVE WORKSPACE CONTEXT:\n${activeContextNote}\n` : ''}
SCHEMA CONTEXT (All datasets in '${target.target_name}'):
${schemaPrompt}

5. Return ONLY the raw executable SQL statement with no markdown fences or commentary.`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: sysMsg },
                { role: 'user', content: `Prompt: ${userPrompt}` }
            ],
            temperature: 0
        });

        let sql = response.choices[0].message.content.trim();
        if (sql.includes('```')) {
            sql = sql.split('```')[1];
            if (sql.toLowerCase().startsWith('sql')) sql = sql.substring(3);
        }
        sql = sql.trim();

        const bucketEsc = (target.bucket || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (bucketEsc) {
            sql = sql.replace(new RegExp(`(?:s3|r2|az)://${bucketEsc}/`, 'gi'), '');
        }

        if (!/^\s*(SELECT|WITH|DESCRIBE|SUMMARIZE|EXPLAIN)\b/i.test(sql)) {
            throw new Error('Only read-only SELECT queries are permitted');
        }

        return sql;
    } catch (err) {
        console.error('[AI] Error:', err.message);
        throw err;
    }
}

module.exports = { suggestQuery };
