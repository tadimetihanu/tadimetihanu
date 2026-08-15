// test_docker_mysql.js
const { runQuery } = require('./src/query/engine');

async function test() {
    console.log("--- Docker MySQL (Port 3307) Verification ---");
    const host = "localhost";
    const user = "root";
    const pass = "SolixSbds4701%%";
    const port = 3307;
    const db = "lumina_db";

    try {
        const sql = `
            INSTALL mysql; 
            LOAD mysql;
            ATTACH 'host=${host} user=${user} password=${pass} port=${port} database=${db}' AS docker_db (TYPE MYSQL);
            SELECT 1 as connected, version() as version;
        `;
        const results = await runQuery(sql);
        if (results && results.length > 0) {
            console.log(`✅ SUCCESS! Docker MySQL is running and connected!`);
            console.log(`Version: ${results[0].version}`);
            process.exit(0);
        }
    } catch (err) {
        console.error(`❌ Docker Connection Failed:`, err.message);
        process.exit(1);
    }
}

test();
