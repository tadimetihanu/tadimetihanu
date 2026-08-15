const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function run(sql) {
    return new Promise((res, rej) => conn.all(sql, (e, r) => e ? rej(e) : res(r)));
}

async function main() {
    // Load extensions
    for (const sql of ['INSTALL azure', 'LOAD azure', 'INSTALL httpfs', 'LOAD httpfs']) {
        await run(sql);
    }
    console.log('✅ Extensions loaded\n');

    // ── Test 1: inseeksadls / inseekdata (ADLS targets) ──
    const cs1 = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
    await run(`CREATE OR REPLACE SECRET adls1 (TYPE AZURE, CONNECTION_STRING '${cs1}', SCOPE 'az://inseekdata/')`);
    console.log('Test 1: az://inseekdata/csvdata/supermarket_sales.csv');
    try {
        const r = await run(`SELECT * FROM read_csv_auto('az://inseekdata/csvdata/supermarket_sales.csv') LIMIT 2`);
        console.log('✅ ADLS (inseeksadls/inseekdata) SUCCESS -', r.length, 'rows\n');
    } catch(e) { console.log('❌', e.message, '\n'); }

    // ── Test 2: datainseek / datainseektech ──
    const cs2 = "DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
    await run(`CREATE OR REPLACE SECRET azure2 (TYPE AZURE, CONNECTION_STRING '${cs2}', SCOPE 'az://datainseektech/')`);
    console.log('Test 2: az://datainseektech/ (listing)');
    try {
        const r = await run(`SELECT * FROM read_csv_auto('az://datainseektech/**/*.csv') LIMIT 2`);
        console.log('✅ Azure Cloud (datainseek/datainseektech) SUCCESS -', r.length, 'rows\n');
    } catch(e) { console.log('❌', e.message, '\n'); }

    // ── Test 3: MinIO ──
    await run(`CREATE OR REPLACE SECRET s3m (TYPE S3, KEY_ID 'minioadmin', SECRET 'minioadmin', REGION 'us-east-1', ENDPOINT 'localhost:9010', URL_STYLE 'path', USE_SSL false)`);
    await run(`SET s3_url_style='path'`);
    console.log('Test 3: s3://datalake/supermarket_sales.csv');
    try {
        const r = await run(`SELECT * FROM read_csv_auto('s3://datalake/supermarket_sales.csv') LIMIT 2`);
        console.log('✅ MinIO SUCCESS -', r.length, 'rows\n');
    } catch(e) { console.log('❌', e.message, '\n'); }
}

main().catch(console.error);
