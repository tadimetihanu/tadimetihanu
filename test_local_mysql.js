// test_local_mysql.js
const { runQuery } = require('./src/query/engine');

async function test() {
    console.log("--- Local MySQL Service Discovery ---");
    const host = "localhost";
    const user = "root";
    const pass = "SolixSbds4701%%";
    const port = 3306;

    console.log(`[Test] Detected active mysqld.exe on 3306. Attempting login as root...`);
    
    try {
        const sql = `
            INSTALL mysql; 
            LOAD mysql;
            ATTACH 'host=${host} user=${user} password=${pass} port=${port}' AS local_db (TYPE MYSQL);
            SELECT current_user() as user, version() as version;
        `;
        const results = await runQuery(sql);
        if (results && results.length > 0) {
            console.log(`✅ SUCCESS! Local MySQL is ALREADY RUNNING and credentials work!`);
            console.log(`Version: ${results[0].version}`);
            process.exit(0);
        }
    } catch (err) {
        console.error(`❌ Local Connection Failed:`, err.message);
        console.log(`The service is running but root password might be different.`);
        process.exit(1);
    }
}

test();
