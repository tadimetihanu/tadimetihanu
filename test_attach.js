const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const conn = db.connect();

async function run() {
    try {
        console.log('Installing/Loading iceberg...');
        await new Promise((res, rej) => conn.run('INSTALL iceberg; LOAD iceberg;', (e) => e ? rej(e) : res()));
        
        console.log('Attempting ATTACH to local folder...');
        try {
            await new Promise((res, rej) => conn.run("ATTACH 'iceberg_catalog' AS ice (TYPE ICEBERG);", (e) => e ? rej(e) : res()));
            console.log('ATTACH Successful!');
            
            console.log('Attempting CREATE TABLE...');
            await new Promise((res, rej) => conn.run("CREATE TABLE ice.test_table (id INT, val VARCHAR);", (e) => e ? rej(e) : res()));
            console.log('CREATE TABLE Successful!');
            
            console.log('Attempting INSERT...');
            await new Promise((res, rej) => conn.run("INSERT INTO ice.test_table VALUES (1, 'Hello Iceberg');", (e) => e ? rej(e) : res()));
            console.log('INSERT Successful!');
        } catch (e) {
            console.log('Operation failed:', e.message);
        }
    } catch (e) {
        console.error('Core Error:', e.message);
    } finally {
        conn.close();
    }
}

run();
