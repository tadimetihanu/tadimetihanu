const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const run = (sql) => new Promise((resolve) => conn.run(sql, resolve));
const query = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));

async function test() {
    try {
        await run("INSTALL httpfs; LOAD httpfs;");
        await run("SET s3_endpoint='localhost:9010'");
        await run("SET s3_access_key_id='minioadmin'");
        await run("SET s3_secret_access_key='minioadmin'");
        await run("SET s3_region='us-east-1'");
        await run("SET s3_url_style='path'");
        await run("SET s3_use_ssl=false");

        const res = await query("SELECT * FROM 's3://datalake/your_file_name.csv' LIMIT 1");
        console.log("Success:", res);
    } catch (e) {
        console.error("DuckDB Error:", e.message);
    }
}
test();
