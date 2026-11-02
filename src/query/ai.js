// AI Assistant — Powered by Render PostgreSQL Metadata Catalog & DuckDB Schema Discovery
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

async function suggestQuery(userId, userPrompt, targetId, fileName) {
    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) throw new Error('Invalid Target');

    // Load registered objects & cached schemas from PostgreSQL metadata_catalog
    const catalogRows = await db.all(
        'SELECT file_path, file_name, format, schema_json FROM metadata_catalog WHERE target_id = ? ORDER BY created_at DESC',
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
        const firstRow = catalogRows[0];
        if (firstRow) {
            return `SELECT * FROM ${formatTableSourceExpr(firstRow.file_path, firstRow.format)} LIMIT 50;`;
        }
        const firstFile = allFiles[0];
        if (firstFile) {
            return `SELECT * FROM ${formatTableSourceExpr(firstFile)} LIMIT 50;`;
        }
        return `SELECT 1 AS status;`;
    }

    try {
        const { runQuery } = require('./engine');
        const queryableExts = new Set(['parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'iceberg']);

        // Prioritize files mentioned in the prompt, then structured catalog files
        const promptLower = (userPrompt || '').toLowerCase();
        const candidateRows = (catalogRows.length > 0 ? catalogRows : passedFiles.map(fp => ({
            file_path: fp,
            format: fp.split('.').pop().toLowerCase(),
            schema_json: null
        }))).filter(r => queryableExts.has((r.format || r.file_path.split('.').pop() || '').toLowerCase()));

        candidateRows.sort((a, b) => {
            const aHit = promptLower.includes(a.file_path.toLowerCase().replace(/\.[a-z0-9]+$/i, '')) ? 1 : 0;
            const bHit = promptLower.includes(b.file_path.toLowerCase().replace(/\.[a-z0-9]+$/i, '')) ? 1 : 0;
            return bHit - aHit;
        });

        const schemaContexts = [];
        for (const row of candidateRows.slice(0, 12)) {
            let cols = null;
            if (row.schema_json) {
                try {
                    cols = JSON.parse(row.schema_json);
                } catch (_) {}
            }
            if (!Array.isArray(cols) || cols.length === 0) {
                try {
                    const srcExpr = formatTableSourceExpr(row.file_path, row.format);
                    const descRows = await runQuery(userId, `DESCRIBE SELECT * FROM ${srcExpr} LIMIT 1`, targetId);
                    cols = descRows.map(c => ({
                        name: c.column_name,
                        type: c.column_type,
                        nullable: c.null === 'YES'
                    }));
                    if (cols.length > 0) {
                        await db.run(
                            'UPDATE metadata_catalog SET schema_json = ? WHERE target_id = ? AND file_path = ?',
                            [JSON.stringify(cols), targetId, row.file_path]
                        ).catch(() => {});
                    }
                } catch (_) {}
            }

            const srcExpr = formatTableSourceExpr(row.file_path, row.format);
            if (Array.isArray(cols) && cols.length > 0) {
                const colStr = cols.map(c => `${c.name || c.column_name} (${c.type || c.column_type})`).join(', ');
                schemaContexts.push(`Dataset ${srcExpr} -> columns: [${colStr}]`);
            } else {
                schemaContexts.push(`Dataset ${srcExpr}`);
            }
        }

        const schemaPrompt = schemaContexts.join('\n') || 'No structured datasets found in catalog.';

        const sysMsg = `You are a DuckDB SQL Generator for CloudObjectIQ.
Convert the user prompt into a single valid DuckDB SELECT query.
CRITICAL RULES:
1. NEVER use raw cloud URIs like s3://, r2://, or az:// — direct URIs are blocked by the Metadata Catalog security policy!
2. ALWAYS reference datasets using their exact logical catalog expression from the list below (for example: read_parquet('farms.parquet'), iceberg_scan('employees.iceberg'), read_csv_auto('farms.csv'), read_json_auto('128KB.json')).
3. Available files in target '${target.target_name}': ${allFiles.join(', ')}.
4. Use ONLY real column names from SCHEMA CONTEXT below. Never invent placeholder names like 'filename.parquet'.

SCHEMA CONTEXT:
${schemaPrompt}

5. Return ONLY the raw executable SQL statement with no markdown fences or explanation.`;

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

        // Strip any accidental s3://<bucket>/ or r2://<bucket>/ prefix if the LLM still emitted one
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
