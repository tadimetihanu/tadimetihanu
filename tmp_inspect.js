const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();
conn.run('INSTALL httpfs; LOAD httpfs;', () => {
    conn.all("DESCRIBE SELECT * FROM 'data/datalake/weather.parquet' LIMIT 1", (err, res) => {
        if (err) console.error(err);
        else console.log(JSON.stringify(res, null, 2));
    });
});
