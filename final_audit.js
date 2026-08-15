const duckdb = require('duckdb');

async function test_all() {
    console.log('🚀 Final Global Connectivity Audit...');
    const db = new duckdb.Database(':memory:');
    const conn = db.connect();
    const run = (sql) => new Promise((res, rej) => conn.all(sql, (err, rows) => err ? rej(err) : res(rows)));

    try {
        await run('INSTALL azure; LOAD azure; INSTALL httpfs; LOAD httpfs; SET s3_url_style=\'path\';');
        console.log('✅ Extensions Loaded');

        // ADLS / inseeksadls
        const cs1 = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
        await run(`CREATE OR REPLACE SECRET adls1 (TYPE AZURE, CONNECTION_STRING '${cs1}', SCOPE 'az://inseekdata/')`);
        const r1 = await run("SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') LIMIT 1");
        console.log('✅ inseeksadls/inseekdata: SUCCESS');

        // Azure Cloud / datainseek
        const cs2 = "DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
        await run(`CREATE OR REPLACE SECRET adls2 (TYPE AZURE, CONNECTION_STRING '${cs2}', SCOPE 'az://datainseektech/')`);
        const r2 = await run("SELECT * FROM read_csv_auto('az://datainseektech/ingestion_1772342036579.csv') LIMIT 1");
        console.log('✅ datainseek/datainseektech: SUCCESS');
        
        // MinIO
        await run("CREATE OR REPLACE SECRET minio (TYPE S3, KEY_ID 'minioadmin', SECRET 'minioadmin', REGION 'us-east-1', ENDPOINT 'localhost:9010', URL_STYLE 'path', USE_SSL false)");
        const r3 = await run("SELECT * FROM read_csv_auto('s3://datalake/supermarket_sales.csv') LIMIT 1");
        console.log('✅ MinIO Local: SUCCESS');

    } catch (e) {
        console.error('❌ FAILED:', e.message);
    } finally {
        process.exit(0);
    }
}

test_all();
