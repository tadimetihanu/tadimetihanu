const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=dfs.core.windows.net";
const abfssUri = "abfss://inseekdata@inseeksadls.dfs.core.windows.net/csvdata/supermarket_sales.csv";

const runTask = (sql) => new Promise((res, rej) => conn.run(sql, (err) => err ? rej(err) : res()));
const fetchTask = (sql) => new Promise((res, rej) => conn.all(sql, (err, r) => err ? rej(err) : res(r)));

async function testCase() {
    console.log('🚀 [START] Final Verified ADLS Gen2 Fetch Case...');
    
    try {
        await runTask('INSTALL azure; LOAD azure; INSTALL httpfs; LOAD httpfs;');
        console.log('✅ Extensions loaded.');

        await runTask(`
            CREATE OR REPLACE SECRET (
                TYPE AZURE,
                CONNECTION_STRING '${connStr}',
                SCOPE 'abfss://inseekdata@inseeksadls.dfs.core.windows.net/'
            );
        `);
        console.log('✅ Secret initialized (Native WinHTTP Connection).');

        console.log(`📡 Fetching from: ${abfssUri}`);
        const rows = await fetchTask(`SELECT * FROM read_csv_auto('${abfssUri}') LIMIT 5;`);
        
        console.log('✨ [SUCCESS] Data retrieved successfully!');
        console.log('Rows available: ' + rows.length);
        console.table(rows);
    } catch (e) {
        console.error('❌ [FAILURE] Test case failed:', e.message);
    }
}

testCase();
