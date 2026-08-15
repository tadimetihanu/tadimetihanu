const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const fileUri = "az://datainseek/datainseektech/ingestion_1772342036579.csv";

async function run() {
    console.log('🏁 Starting Target 1 (Azure Cloud) Diagnostic Fetch...');
    
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
        console.log('✅ Secret initialized for datainseek.');

        console.log(`📡 Fetching from: ${fileUri}`);
        conn.all(`SELECT * FROM read_csv_auto('${fileUri}') LIMIT 5;`, (err, rows) => {
            if (err) {
                console.error('❌ Query failed:', err.message);
                
                // Fallback: Check if the container is actually just 'csvdata' or something else?
                // No, sticking to what we know.
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
