const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const ip = "135.130.64.96"; // Blob IP for inseeksadls
const fileUri = `az://inseeksadls/inseekdata/csvdata/supermarket_sales.csv`;

async function run() {
    console.log('🏁 Starting IP-Based DNS Bypass diagnostic (v2)...');
    
    try {
        await new Promise((res, rej) => conn.run('INSTALL azure; LOAD azure; INSTALL httpfs; LOAD httpfs;', (err) => err ? rej(err) : res()));
        console.log('✅ Extensions loaded.');

        await new Promise((res, rej) => {
            conn.run(`
                CREATE OR REPLACE SECRET (
                    TYPE AZURE,
                    CONNECTION_STRING '${connStr}',
                    ENDPOINT '${ip}'
                );
            `, (err) => err ? rej(err) : res());
        });
        console.log(`✅ Secret initialized with IP Endpoint: ${ip}`);

        console.log(`📡 Fetching from: ${fileUri}`);
        conn.all(`SELECT * FROM read_csv_auto('${fileUri}') LIMIT 5;`, (err, rows) => {
            if (err) {
                console.error('❌ Query failed:', err.message);
            } else {
                console.log('✅ Success! Rows:', rows.length);
                console.table(rows);
            }
        });
    } catch (e) {
        console.error('🔥 Execution error:', e.message);
    }
}

run();
