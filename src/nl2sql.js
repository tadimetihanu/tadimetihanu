const fetch = global.fetch || require('node-fetch');

/**
 * Generates a DuckDB SQL query from a natural language question using OpenAI.
 * @param {string} question - The user's natural language question.
 * @returns {Promise<string>} - The generated SQL statement.
 */
async function generateSQL(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const prompt = `You are an expert SQL writer for DuckDB. Translate the following natural language question into a single valid DuckDB SQL query. Do not include any explanations, only output the raw SQL.\nQuestion: "${question}"`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Generate DuckDB SQL.' }, { role: 'user', content: prompt }],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  let sql = data.choices[0].message.content.trim();
  // Strip possible markdown code fences
  if (sql.startsWith('```')) {
    sql = sql.replace(/```(?:sql)?\n?/, '').replace(/```$/, '').trim();
  }
  return sql;
}

/**
 * Executes a DuckDB SQL query on MotherDuck.
 * @param {string} sql - The SQL statement to execute.
 * @returns {Promise<any[]>} - Result rows.
 */
async function executeOnMotherDuck(sql) {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) throw new Error('MOTHERDUCK_TOKEN not set');

  const response = await fetch('https://api.motherduck.com/v2/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`MotherDuck API error: ${response.status} ${err}`);
  }
  const result = await response.json();
  return result.data || [];
}

/**
 * Main entry point for NL→SQL service.
 * @param {string} question - Natural language question.
 * @returns {Promise<{sql:string, result:any[]}>}
 */
async function handleNl2Sql(question) {
  const sql = await generateSQL(question);
  const result = await executeOnMotherDuck(sql);
  return { sql, result };
}

module.exports = { handleNl2Sql };
