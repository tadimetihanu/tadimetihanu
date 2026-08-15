const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseekdata;AccountKey=YOUR_AZURE_KEY;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const uri = "az://inseekdata/csvdata/supermarket_sales.csv";

const runTask = (sql) => new Promise((res, rej) => conn.run(sql, (err) => err ? rej(err) : res()));
const fetchTask = (sql) => new Promise((res, rej) => conn.all(sql, (err, r) => err ? rej(err) : res(r)));

async function test() {
    try {
        await runTask('INSTALL azure; LOAD azure;');
        await runTask(`CREATE SECRET (TYPE AZURE, CONNECTION_STRING '${connStr}', SCOPE 'az://inseekdata/');`);
        console.log('Fetching...');
        const r = await fetchTask(`SELECT * FROM read_csv_auto('${uri}') LIMIT 10`);
        console.log('Success!', r.length);
    } catch (e) {
        console.error('Fail:', e.message);
    }
}
test();
