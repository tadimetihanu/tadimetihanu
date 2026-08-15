const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=dfs.core.windows.net";
const fileUri = "https://inseeksadls.blob.core.windows.net/inseekdata/csvdata/supermarket_sales.csv";

async function run() {
    console.log('🏁 Starting Direct DuckDB Azure Fetch...');
    
    try {
        await new Promise((res, rej) => conn.run('INSTALL azure; LOAD azure; INSTALL httpfs; LOAD httpfs;', (err) => err ? rej(err) : res()));
        console.log('✅ Extensions loaded.');

        await new Promise((res, rej) => {
            conn.run(`
                CREATE OR REPLACE SECRET (
                    TYPE AZURE,
                    CONNECTION_STRING '${connStr}'
                );
            `, (err) => err ? rej(err) : res());
        });
        console.log('✅ Secret initialized.');

        console.log(`📡 Fetching from: ${fileUri}`);
        conn.all(`SELECT * FROM read_csv_auto('${fileUri}') LIMIT 5;`, (err, rows) => {
            if (err) {
                console.error('❌ Query failed:', err.message);
                
                // Fallback to az:// protocol if https:// failed
                console.log('🔄 Trying az:// protocol as fallback...');
                const azUri = "az://inseekdata/csvdata/supermarket_sales.csv";
                conn.all(`SELECT * FROM read_csv_auto('${azUri}') LIMIT 5;`, (err2, rows2) => {
                    if (err2) {
                        console.error('❌ az:// fallback also failed:', err2.message);
                    } else {
                        console.log('✅ az:// success! Rows:', rows2.length);
                        console.table(rows2);
                    }
                });
            } else {
                console.log('✅ HTTPS success! Rows:', rows.length);
                console.table(rows);
            }
        });
    } catch (e) {
        console.error('🔥 Execution error:', e.message);
    }
}

run();
