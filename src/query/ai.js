// AI Assistant — Enhanced with SQL Parser and Prefix Enforcement
require('dotenv').config();
const { OpenAI } = require('openai');
const { Parser } = require('node-sql-parser');
const Database = require('better-sqlite3');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();
const metaDb = new Database('./data/metadata.db');

async function suggestQuery(userId, userPrompt, targetId, fileName) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

    const target = metaDb.prepare('SELECT * FROM targets WHERE target_id = ?').get(targetId);
    if (!target) throw new Error('Invalid Target');

    let allowedPrefix;
    if (target.provider_type === 'azure' || target.provider_type === 'adls') {
        // Broad scope prefix: az://CONTAINER/
        allowedPrefix = `az://${target.bucket}/`;
    } else {
        allowedPrefix = `s3://${target.bucket}/`;
    }

    try {
        // ── Schema Discovery ─────────────────────────────────
        const { runQuery } = require('./engine');
        const files = (fileName || "").split(',').map(f => f.trim()).filter(Boolean);
        const schemaContexts = await Promise.all(files.slice(0, 5).map(async (file) => {
            try {
                const fullUri = file.includes('://') ? file : `${allowedPrefix}${file}`;
                const cols = await runQuery(userId, `DESCRIBE SELECT * FROM '${fullUri}' LIMIT 1`, targetId);
                const colStr = cols.map(c => `${c.column_name} (${c.column_type})`).join(', ');
                return `File '${file}' schema: [${colStr}]`;
            } catch (e) { return null; }
        }));
        const schemaPrompt = schemaContexts.filter(Boolean).join('\n') || 'Schema unknown.';

        const sysMsg = `You are a DuckDB SQL Generator for CloudObjectIQ.
            Convert the user prompt into a valid DuckDB SQL query.
            CRITICAL RULES:
            1. All table names in the FROM clause MUST use the full cloud URI starting with "${allowedPrefix}". 
               Example: SELECT * FROM '${allowedPrefix}filename.parquet'
            2. Available files: ${fileName}.
            3. Use the schema context below to use CORRECT column names. DO NOT hallucinate columns.
               If the schema is "Schema unknown.", you MUST assume the user knows the columns or just use SELECT *. 
               UNDER NO CIRCUMSTANCES should you generate mock data, use UNION ALL, or simulate rows!

            SCHEMA CONTEXT:
            ${schemaPrompt}

            4. Use single quotes for file paths.
            5. Return ONLY the raw SQL. No markdown, no commentary.`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: sysMsg },
                { role: "user", content: `Prompt: ${userPrompt}` }
            ],
            temperature: 0,
        });

        let sql = response.choices[0].message.content.trim();
        // Robust SQL extraction
        if (sql.includes('```')) {
            sql = sql.split('```')[1];
            if (sql.startsWith('sql')) sql = sql.substring(3);
        }
        sql = sql.trim();

        // ── SQL Parser Validation ──────────────────────────────
        try {
            const ast = parser.astify(sql);
            const tables = Array.isArray(ast) ? ast.flatMap(a => a.from || []) : (ast.from || []);
            
            // 1. Only SELECT allowed
            const type = Array.isArray(ast) ? ast[0].type : ast.type;
            if (type !== 'select') throw new Error('Only SELECT queries are permitted');

            // 2. Prefix Enforcement
            for (const t of tables) {
                const tablePath = t.table || '';
                // If it is a string literal (quoted), get it without quotes
                const cleanPath = tablePath.replace(/['"]/g, '');
                if (cleanPath.includes('://') && !cleanPath.startsWith(allowedPrefix)) {
                    throw new Error(`Unauthorized path access: ${cleanPath}`);
                }
            }
        } catch (parseErr) {
            console.warn('⚠️ SQL Check:', parseErr.message);
            if (parseErr.message.includes('Unauthorized path')) throw parseErr;
        }

        return sql;
    } catch (err) {
        console.error('[AI] Error:', err.message);
        throw err;
    }
}

module.exports = { suggestQuery };
