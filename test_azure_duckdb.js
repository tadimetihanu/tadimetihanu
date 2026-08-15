const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const scope = "az://datainseektech/";

const sql = "SELECT * FROM 'az://datainseektech/test_deploy.txt'";

conn.run("SET extension_directory='./data/extensions'; LOAD azure; LOAD httpfs;", (err) => {
    if (err) return console.error('Load Error:', err);
    console.log('Extensions loaded.');

    conn.run(`
        CREATE OR REPLACE SECRET azure_debug (
            TYPE AZURE,
            CONNECTION_STRING '${connStr}',
            SCOPE '${scope}'
        );
    `, (err) => {
        if (err) return console.error('Secret Error:', err);
        console.log('Secret created.');

        conn.all(sql, (err, rows) => {
            if (err) {
                console.error('Query Error:', err);
            } else {
                console.log('Query Results:', rows);
            }
        });
    });
});
