const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function run() {
    try {
        console.log('Installing iceberg...');
        await new Promise((res, rej) => conn.run('INSTALL iceberg; LOAD iceberg;', (e) => e ? rej(e) : res()));
        console.log('Iceberg extension loaded.');
        
        console.log('Testing COPY syntax...');
        // This is a dummy test to see if the syntax is recognized
        try {
            await new Promise((res, rej) => conn.run("COPY (SELECT 1 AS id) TO 'test_iceberg' (FORMAT ICEBERG);", (e) => e ? rej(e) : res()));
            console.log('COPY TO ICEBERG is supported.');
        } catch (e) {
            console.log('COPY TO ICEBERG failed:', e.message);
        }
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        conn.close();
    }
}

run();
