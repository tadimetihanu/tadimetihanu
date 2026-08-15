const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

conn.all("SELECT * FROM duckdb_extensions() WHERE extension_name = 'hive'", (err, res) => {
    if (err) console.error(err);
    else {
        console.log('HIVE STATUS:', res);
        conn.run('INSTALL hive; LOAD hive;', (err2) => {
            if (err2) console.error('INSTALL ERROR:', err2.message);
            else console.log('HIVE LOADED SUCCESSFULLY');
        });
    }
});
