const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
const abfssUri = "abfss://inseekdata@inseeksadls.dfs.core.windows.net/csvdata/supermarket_sales.csv";

const runTask = (sql) => new Promise((res, rej) => conn.run(sql, (err) => err ? rej(err) : res()));
const fetchTask = (sql) => new Promise((res, rej) => conn.all(sql, (err, r) => err ? rej(err) : res(r)));

async function testCase() {
    console.log('🚀 [START] Executing Enterprise Test Case for ADLS Gen2...');
    
    try {
        await runTask('INSTALL azure; LOAD azure; INSTALL httpfs; LOAD httpfs;');
        console.log('✅ Extensions loaded.');

        await runTask(`
            CREATE OR REPLACE SECRET (
                TYPE AZURE,
                CONNECTION_STRING '${connStr}'
            );
        `);
        console.log('✅ Secret initialized (Scoped to inseeksadls).');

        console.log(`📡 Fetching from: ${abfssUri}`);
        const rows = await fetchTask(`SELECT * FROM read_csv_auto('${abfssUri}') LIMIT 5;`);
        
        console.log('✨ [SUCCESS] Data retrieved successfully!');
        process.stdout.write(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error('❌ [FAILURE] Test case failed:', e.message);
        
        if (e.message.includes('DNS')) {
            console.log('🔄 Attempting fallback to az:// URI because of DNS error...');
            const azUri = "az://inseeksadls/inseekdata/csvdata/supermarket_sales.csv";
            try {
               const rows2 = await fetchTask(`SELECT * FROM read_csv_auto('${azUri}') LIMIT 5;`);
               console.log('✅ [SUCCESS] az:// fallback succeeded!');
               process.stdout.write(JSON.stringify(rows2, null, 2));
            } catch (e2) {
               console.error('❌ [CRITICAL] All protocols failed:', e2.message);
            }
        }
    }
}

testCase();
