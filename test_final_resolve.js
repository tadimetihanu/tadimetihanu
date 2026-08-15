const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const fileUri = "az://inseeksadls/inseekdata/csvdata/supermarket_sales.csv";

async function run() {
    console.log('🏁 Starting V90 Final Diagnostic Fetch...');
    
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
        console.log('✅ Secret initialized with CONNECTION_STRING for Account inseeksadls.');

        console.log(`📡 Fetching from: ${fileUri}`);
        conn.all(`SELECT * FROM read_csv_auto('${fileUri}') LIMIT 5;`, (err, rows) => {
            if (err) {
                console.error('❌ Query failed:', err.message);
                
                // FINAL ATTEMPT WITH ABFSS://
                console.log('🔄 Trying abfss:// protocol as ultimate fallback...');
                const abfssUri = "abfss://inseekdata@inseeksadls.dfs.core.windows.net/csvdata/supermarket_sales.csv";
                conn.all(`SELECT * FROM read_csv_auto('${abfssUri}') LIMIT 5;`, (err2, rows2) => {
                    if (err2) {
                        console.error('❌ abfss:// fallback also failed:', err2.message);
                    } else {
                        console.log('✅ abfss:// success! Rows:', rows2.length);
                        console.table(rows2);
                    }
                });
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
